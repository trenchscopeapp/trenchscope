// LARP detector — SSRF-safe, read-only HTTP GET for untrusted coin sites (task-1315).
// Rules (card constraints): http/https only; GET only; no cookies, no auth, no
// credentials; resolve every host and refuse private/loopback/link-local/CGNAT/
// multicast/reserved IP ranges (IPv4 + IPv6, including IPv4-mapped and NAT64);
// follow redirects MANUALLY, re-validating each Location so a public URL cannot
// bounce into a private one; hard size and time caps across the whole redirect
// chain. DNS and fetch are injectable so the policy is unit-testable offline.
//
// The native transport validates DNS in its socket lookup callback and connects
// to that exact address. It never performs a second, unvalidated DNS resolution.

import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const lookupAll = promisify(dnsLookup);

export class SsrfError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = 'SsrfError'; this.reason = reason; }
}

/** Injectable DNS: host → list of resolved IPs (A + AAAA). */
export type DnsResolver = (host: string) => Promise<string[]>;

export interface SafeFetchOptions {
  /** Max decoded bytes kept from the body (default 512 KiB). The rest is truncated. */
  maxBytes?: number;
  /** Wall-clock budget across the whole redirect chain, ms (default 8000). */
  timeoutMs?: number;
  /** Max redirect hops to follow (default 4). */
  maxRedirects?: number;
  userAgent?: string;
  /** Injectable DNS resolver (tests). Defaults to node:dns lookup (all addresses). */
  resolve?: DnsResolver;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Additional per-hop policy, also applied to redirect destinations. */
  beforeRequest?: (url: URL) => Promise<void>;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  /** URL that actually served the body (after redirects). */
  finalUrl: string;
  contentType: string | null;
  /** Decoded body (utf8), truncated to maxBytes. Empty for non-text content types. */
  body: string;
  bytes: number;
  truncated: boolean;
  /** Redirect chain that was followed (origin URLs, excluding the final). */
  redirects: string[];
  /** Set when ok=false because policy refused the request (scheme / private IP / caps). */
  blocked: string | null;
  elapsedMs: number;
}

const DEFAULTS = { maxBytes: 512 * 1024, timeoutMs: 8000, maxRedirects: 4 } as const;
// Textual content types we will decode. The `[\w.-]+\+(json|xml)` arm covers RFC 6839 structured
// suffixes — notably `application/rdap+json`, which every authoritative RDAP server returns (check_domain
// got an empty body without it) — plus the general `…+xml` family.
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml|rss|atom|javascript|ld\+json|[\w.-]+\+(json|xml))|image\/svg)/i;

/** Parse an IPv4 dotted-quad to its 4 octets, or null if it is not one. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return o.every((x) => x >= 0 && x <= 255) ? o : null;
}

/** Return a reason string if the IPv4 address is in a blocked range, else null. */
function blockedIpv4(ip: string): string | null {
  const o = ipv4Octets(ip);
  if (!o) return null;
  const [a, b] = o;
  if (a === 0) return 'this-network (0.0.0.0/8)';
  if (a === 10) return 'private (10.0.0.0/8)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT (100.64.0.0/10)';
  if (a === 169 && b === 254) return 'link-local (169.254.0.0/16)';
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'private (192.168.0.0/16)';
  if (a === 192 && b === 0 && o[2] === 0) return 'IETF protocol (192.0.0.0/24)';
  if (a === 192 && b === 0 && o[2] === 2) return 'TEST-NET-1 (192.0.2.0/24)';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking (198.18.0.0/15)';
  if (a === 198 && b === 51 && o[2] === 100) return 'TEST-NET-2 (198.51.100.0/24)';
  if (a === 203 && b === 0 && o[2] === 113) return 'TEST-NET-3 (203.0.113.0/24)';
  if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)';
  if (a >= 240) return 'reserved (240.0.0.0/4)';
  return null;
}

/** Expand an IPv6 address to its 8 16-bit groups, or null if unparseable. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  // IPv4-mapped / translated tail (e.g. ::ffff:127.0.0.1) → fold the v4 into two groups.
  const v4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    s = s.slice(0, v4.index + 1) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  if (!s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) { groups = head; }
  else { const fill = 8 - head.length - tail.length; if (fill < 0) return null; groups = [...head, ...Array(fill).fill('0'), ...tail]; }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === '' ? NaN : parseInt(g, 16)));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

/** Return a reason string if the IPv6 address is in a blocked range, else null. */
function blockedIpv6(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return null;
  const isZero = (n: number, upto: number) => g.slice(0, upto).every((x) => x === 0);
  if (g.every((x) => x === 0)) return 'unspecified (::)';
  if (isZero(0, 7) && g[7] === 1) return 'loopback (::1)';
  // ::ffff:0:0/96 IPv4-mapped — the embedded v4 was already folded; treat mapped space as the v4 check's job
  if (isZero(0, 5) && g[5] === 0xffff) return 'IPv4-mapped (::ffff:0:0/96)';
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local (fc00::/7)';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation (2001:db8::/32)';
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return 'NAT64 (64:ff9b::/96)';
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return 'discard-only (100::/64)';
  return null;
}

/** Reason string if this literal/resolved IP must be refused, else null. */
export function blockedIp(ip: string): string | null {
  // Node strips zone ids (fe80::1%eth0); drop any just in case.
  const clean = ip.replace(/%.*$/, '');
  if (!isIP(clean)) return 'invalid IP address';
  if (isIP(clean) === 6) {
    const g = ipv6Groups(clean)!;
    // Only ordinary global unicast. Refuse transition/embedded IPv4 ranges,
    // including NAT64 local-use, IPv4-compatible, Teredo and 6to4.
    if ((g[0] & 0xe000) !== 0x2000) return blockedIpv6(clean) ?? 'non-global IPv6';
    if (g[0] === 0x2002 || (g[0] === 0x2001 && g[1] < 0x0200)) return 'IPv6 special/transition range';
  }
  return clean.includes(':') ? blockedIpv6(clean) : blockedIpv4(clean);
}

/** Validated addresses handed directly to a socket: usable as a regression seam. */
export async function publicAddresses(host: string, resolve: DnsResolver): Promise<string[]> {
  const ips = isIP(host) ? [host] : await resolve(host);
  if (!ips.length) throw new SsrfError('no DNS addresses');
  for (const ip of ips) {
    const reason = blockedIp(ip);
    if (reason) throw new SsrfError(`blocked DNS address: ${reason}`);
  }
  return ips;
}

const nextRequest = new Map<string, number>();
function pinnedFetch(resolve: DnsResolver): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const at = Math.max(Date.now(), nextRequest.get(url.origin) ?? 0);
    if (nextRequest.size > 128) nextRequest.clear();
    nextRequest.set(url.origin, at + 1000);
    if (at > Date.now()) await new Promise<void>((yes, no) => {
      const finish = () => { init?.signal?.removeEventListener('abort', abort); yes(); };
      const timer = setTimeout(finish, at - Date.now());
      const abort = () => { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); no(init?.signal?.reason); };
      init?.signal?.addEventListener('abort', abort, { once: true });
      if (init?.signal?.aborted) abort();
    });
    return new Promise((yes, no) => {
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(url, {
        method: 'GET', agent: false, signal: init?.signal ?? undefined,
        headers: Object.fromEntries(new Headers(init?.headers)),
        // Host header, SNI and TLS verification still use the original hostname.
        lookup(host, options, cb) {
          void publicAddresses(host, resolve).then((ips) => {
            if (options.all) cb(null, ips.map((address) => ({ address, family: isIP(address) })));
            else cb(null, ips[0], isIP(ips[0]));
          }, (err: Error) => cb(err, '', 4));
        },
      }, (res) => {
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          const status = res.statusCode ?? 502;
          if ([204, 205, 304].includes(status)) {
            res.destroy(); yes(new Response(null, { status, headers }));
          } else yes(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
        } catch (error) {
          // Node accepts upstream status codes that WHATWG Response rejects. Never throw out of the callback.
          res.destroy();
          no(error);
        }
      });
      req.on('error', no);
      req.end();
    });
  }) as typeof fetch;
}

export async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); signal.throwIfAborted(); }
  return new Promise((yes, no) => {
    const abort = () => no(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(yes, no).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Default resolver: every A/AAAA for the host. */
async function defaultResolve(host: string): Promise<string[]> {
  const res = await lookupAll(host, { all: true });
  return res.map((r) => r.address);
}

/**
 * Validate scheme/shape and resolve the host, refusing any blocked IP. Throws SsrfError on refusal.
 * Returns the parsed URL (host already lower-cased by WHATWG, numeric IPv4 forms normalised).
 */
export async function assertPublicUrl(raw: string, resolve: DnsResolver): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SsrfError(`unparseable url`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError(`scheme not allowed: ${u.protocol}`);
  if (u.username || u.password) throw new SsrfError('credentials in url not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!host) throw new SsrfError('empty host');
  // If the host is itself an IP literal, check it directly (WHATWG already normalised 0x7f/decimal forms).
  const literal = isIP(host) ? blockedIp(host) : null;
  if (literal) throw new SsrfError(`blocked address ${host}: ${literal}`);
  // Otherwise resolve and refuse if ANY resolved address is blocked.
  if (ipv4Octets(host) === null && !host.includes(':')) {
    let ips: string[];
    try { ips = await resolve(host); } catch (e) { throw new SsrfError(`dns failed for ${host}: ${(e as Error).message}`); }
    if (ips.length === 0) throw new SsrfError(`no addresses for ${host}`);
    for (const ip of ips) { const bad = blockedIp(ip); if (bad) throw new SsrfError(`${host} resolves to blocked ${ip}: ${bad}`); }
  }
  return u;
}

function headerValue(res: { headers: Headers }, name: string): string | null {
  return res.headers.get(name);
}

/** Read a web ReadableStream up to maxBytes, truncating and cancelling the rest. */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!body) return { text: '', bytes: 0, truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
  return { text: buf.toString('utf8'), bytes: total, truncated };
}

/**
 * SSRF-safe GET with manual redirect following. Never throws for network/policy failures —
 * returns { ok:false, blocked } so the caller (and the analyst) can report it as a missing-data fact.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  const resolve = opts.resolve ?? defaultResolve;
  const doFetch = opts.fetchImpl ?? pinnedFetch(resolve);
  const now = opts.now ?? (() => Date.now());
  const ua = opts.userAgent ?? 'dexterm/0.0.1 (+local terminal; keyless read-only larp-check)';
  const started = now();
  const deadline = started + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  const redirects: string[] = [];
  const fail = (blocked: string, status = 0, finalUrl = rawUrl): SafeFetchResult =>
    ({ ok: false, status, finalUrl, contentType: null, body: '', bytes: 0, truncated: false, redirects, blocked, elapsedMs: now() - started });

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u: URL;
    try {
      u = await bounded(assertPublicUrl(current, resolve), signal);
      if (opts.beforeRequest) await bounded(opts.beforeRequest(u), signal);
    } catch (e) { return fail((e as SsrfError).reason ?? String(e)); }
    const remaining = deadline - now();
    if (remaining <= 0) return fail('timeout before request', 0, current);
    let res: Response;
    try {
      res = await bounded(doFetch(u.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { 'user-agent': ua, 'accept-encoding': 'identity', accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1' },
        // never attach or store cookies / credentials.
        credentials: 'omit',
      }), signal);
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'request timed out' : (e as Error).message;
      return fail(`fetch failed: ${msg}`, 0, current);
    }
    // Manual redirect: 3xx with a Location → re-validate and continue.
    if (res.status >= 300 && res.status < 400) {
      const loc = headerValue(res, 'location');
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (!loc) return fail(`${res.status} redirect with no location`, res.status, current);
      let nextUrl: string;
      try { nextUrl = new URL(loc, u).toString(); } catch { return fail(`bad redirect location`, res.status, current); }
      if (hop >= maxRedirects) return fail(`too many redirects (> ${maxRedirects})`, res.status, current);
      redirects.push(u.toString());
      current = nextUrl;
      continue;
    }
    const contentType = headerValue(res, 'content-type');
    const textual = contentType ? TEXTUAL.test(contentType) : true; // no CT → attempt as text
    if (!textual) { try { await res.body?.cancel(); } catch { /* ignore */ } return { ok: res.ok, status: res.status, finalUrl: u.toString(), contentType, body: '', bytes: 0, truncated: false, redirects, blocked: null, elapsedMs: now() - started }; }
    let read: { text: string; bytes: number; truncated: boolean };
    try { read = await bounded(readCapped(res.body, maxBytes), signal); } catch (e) { return fail(`read failed: ${(e as Error).message}`, res.status, u.toString()); }
    return { ok: res.ok, status: res.status, finalUrl: u.toString(), contentType, body: read.text, bytes: read.bytes, truncated: read.truncated, redirects, blocked: null, elapsedMs: now() - started };
  }
  return fail(`too many redirects (> ${maxRedirects})`);
}
