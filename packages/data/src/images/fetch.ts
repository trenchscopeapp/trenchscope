// @dexterm/data — SSRF-safe binary GET for coin images (task-1326). Same policy as the LARP detector's
// safeFetch (larp/safe-fetch.ts): http/https only, no credentials, every hostname resolved and refused
// when ANY address is private/loopback/link-local/CGNAT/multicast/reserved, the socket pinned to the
// validated address, redirects followed manually (each hop re-validated, max 3), hard byte and time caps.
// Differences for images: the body is BINARY and capped by Content-Length up front, the Accept header asks
// for the formats we can decode (no webp), and there is no per-origin pacing (a CDN serving 40 icons is
// not a target site; the ImageService bounds concurrency instead). Never throws for a bad image/host:
// returns { ok:false, reason } so the UI can draw the placeholder.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { assertPublicUrl, publicAddresses, bounded, SsrfError, type DnsResolver } from '../larp/safe-fetch.ts';
import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';

const lookupAll = promisify(dnsLookup);
async function defaultResolve(host: string): Promise<string[]> {
  const res = await lookupAll(host, { all: true });
  return res.map((r) => r.address);
}

export interface FetchBytesOptions {
  /** Hard cap on the body (default 2 MiB). A larger Content-Length is refused before any byte is read. */
  maxBytes?: number;
  /** Wall-clock budget across the whole redirect chain (default 8 s). */
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
  resolve?: DnsResolver;
  /** Injectable transport (tests): must honour `signal` and return the raw response. */
  requestImpl?: BytesTransport;
  signal?: AbortSignal;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Body bytes, already capped by the transport to `maxBytes` (+1 so the overflow is detectable). */
  body: Uint8Array;
}

export type BytesTransport = (url: URL, opts: { headers: Record<string, string>; maxBytes: number; signal: AbortSignal }) => Promise<RawResponse>;

export interface FetchBytesResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string | null;
  bytes: Uint8Array;
  redirects: string[];
  /** Why the fetch was refused or failed (policy, cap, network, status); null when ok. */
  reason: string | null;
  elapsedMs: number;
}

const DEFAULTS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 8000, maxRedirects: 3 } as const;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1';
export const IMAGE_USER_AGENT = 'dexterm/0.0.1 (+local terminal screener; coin image thumbnail, read-only)';

/** Node http/https transport with the DNS answer pinned to the validated public address. */
export function pinnedBytesTransport(resolve: DnsResolver): BytesTransport {
  return (url, { headers, maxBytes, signal }) => new Promise<RawResponse>((yes, no) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', agent: false, signal, headers,
      lookup(host, options, cb) {
        void publicAddresses(host, resolve).then((ips) => {
          if (options.all) cb(null, ips.map((address) => ({ address, family: isIP(address) })));
          else cb(null, ips[0], isIP(ips[0]));
        }, (err: Error) => cb(err, '', 4));
      },
    }, (res: IncomingMessage) => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const status = res.statusCode ?? 502;
      const cl = Number(headers['content-length']);
      if (Number.isFinite(cl) && cl > maxBytes) { res.destroy(); yes({ status, headers, body: new Uint8Array(0) }); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (d: Buffer) => {
        if (total > maxBytes) return;
        chunks.push(d); total += d.length;
        if (total > maxBytes) res.destroy(); // over the cap: stop reading; the caller sees length > maxBytes
      });
      res.on('end', () => yes({ status, headers, body: Buffer.concat(chunks, total) }));
      res.on('close', () => yes({ status, headers, body: Buffer.concat(chunks, total) }));
      res.on('error', (e) => { if (total > maxBytes) yes({ status, headers, body: Buffer.concat(chunks, total) }); else no(e); });
    });
    req.on('error', no);
    req.end();
  });
}

/**
 * Rewrite known CDN URLs to ask for a small rendition: DexScreener's image CDN takes width/height query
 * params (the screener's `info.imageUrl` asks for 800×800 PNGs, ~125 KB each; 128×128 is ~10 KB). Any other
 * host is left untouched. Pure.
 */
/** DexScreener's image CDN (the host most coin pictures come from); it honours width/height query params. */
export const DEXSCREENER_IMAGE_CDN = 'https://cdn.dexscreener.com';

export function thumbnailUrl(raw: string, px = 128): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return raw;
    if (u.origin === DEXSCREENER_IMAGE_CDN && u.pathname.startsWith('/cms/images/')) {
      u.searchParams.set('width', String(px));
      u.searchParams.set('height', String(px));
      if (!u.searchParams.has('quality')) u.searchParams.set('quality', '90');
      return u.toString();
    }
    return raw;
  } catch { return raw; }
}

/** Binary SSRF-safe GET with manual, re-validated redirects. Never throws for policy/network failures. */
export async function fetchBytes(rawUrl: string, opts: FetchBytesOptions = {}): Promise<FetchBytesResult> {
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  const resolve = opts.resolve ?? defaultResolve;
  const transport = opts.requestImpl ?? pinnedBytesTransport(resolve);
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timed out')), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  const onOuter = () => ctl.abort(opts.signal?.reason ?? new Error('aborted'));
  if (opts.signal) { if (opts.signal.aborted) onOuter(); else opts.signal.addEventListener('abort', onOuter, { once: true }); }
  const redirects: string[] = [];
  const fail = (reason: string, status = 0, finalUrl = rawUrl): FetchBytesResult =>
    ({ ok: false, status, finalUrl, contentType: null, bytes: new Uint8Array(0), redirects, reason, elapsedMs: Date.now() - started });
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let u: URL;
      try { u = await bounded(assertPublicUrl(current, resolve), ctl.signal); } catch (e) { return fail(ctl.signal.aborted ? 'timed out' : e instanceof SsrfError ? e.reason : String(e)); }
      if (ctl.signal.aborted) return fail('timed out', 0, current);
      let res: RawResponse;
      try {
        res = await transport(u, { headers: { 'user-agent': opts.userAgent ?? IMAGE_USER_AGENT, accept: opts.accept ?? IMAGE_ACCEPT, 'accept-encoding': 'identity' }, maxBytes, signal: ctl.signal });
      } catch (e) {
        return fail(ctl.signal.aborted ? 'timed out' : `fetch failed: ${(e as Error).message}`, 0, current);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.location;
        if (!loc) return fail(`${res.status} redirect without location`, res.status, current);
        if (hop >= maxRedirects) return fail(`too many redirects (> ${maxRedirects})`, res.status, current);
        let next: string;
        try { next = new URL(loc, u).toString(); } catch { return fail('bad redirect location', res.status, current); }
        redirects.push(u.toString());
        current = next;
        continue;
      }
      const ct = res.headers['content-type'] ?? null;
      if (res.status < 200 || res.status >= 300) return fail(`HTTP ${res.status}`, res.status, u.toString());
      if (res.body.length > maxBytes) return fail(`body over the ${maxBytes} byte cap`, res.status, u.toString());
      return { ok: true, status: res.status, finalUrl: u.toString(), contentType: ct, bytes: res.body, redirects, reason: null, elapsedMs: Date.now() - started };
    }
    return fail(`too many redirects (> ${maxRedirects})`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuter);
  }
}
