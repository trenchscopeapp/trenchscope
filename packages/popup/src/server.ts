// trenchscope popup host — loopback-only popup server (task-1290; TypeScript port of the spike server, which
// shipped 20/20 protocol tests). Zero runtime dependencies beyond node:http / node:crypto.
//
// Security posture (carried over verbatim from research/popup-host §5; see README "Security model"):
//   * listens on 127.0.0.1 only, on a random port; never on 0.0.0.0 / ::.
//   * every popup is opened with a single-use TICKET (32 random bytes, 30 s TTL) in the URL; the page the
//     ticket buys embeds a per-popup WS TOKEN (meta tag) accepted exactly once for the WebSocket upgrade.
//     The TUI hands the URL to the shell over stdin, never argv, so `ps` from another user cannot read it.
//   * strict Host check on every request (DNS-rebind guard), strict Origin check on every WebSocket
//     upgrade; remote address must be loopback. No CORS header is ever set. Unknown/unauthorised requests
//     get an empty 404 and are reported to the TUI as `probe.rejected`.
//   * all JS/CSS is inlined with a CSP nonce; CSP forbids remote content, inline handlers, eval, images, fonts.
//     (task-1358 r2) a PACK WIDGET page gets no nonce at all: its inline blocks and our SDK are allow-listed by sha256,
//     nothing is substituted into the pack html, and loaders are refused before a ticket is issued (widget-html.ts).
//     (task-1358 r3) a widget is TWO documents: `/popup/widget` is OUR wrapper page (nonce CSP, owns the socket, and a
//     `frame-src` that names exactly one route) holding an `<iframe sandbox="allow-scripts">`; `/popup/widget-frame`
//     serves the pack html under the hash CSP with NO network (`connect-src 'none'`), an opaque origin and
//     `frame-ancestors` = our origin. The parent's frame-src governs every navigation of the child (a document may
//     always navigate ITSELF; `sandbox` only stops it navigating others), so a page that tries `location.href = 'https://…'`
//     is refused by the engine — the browser-fallback exfil the r2 verifier found. Data reaches the frame by postMessage.
//   * popup → TUI messages are schema-checked against an allow-list of UI event names; anything else is dropped.
//     Popups can never send trade commands and never receive keys: the server only knows about view-models.
//     (r3) a widget's socket accepts only the generic ready/perf/log/close/focus/drag — never a roster or plan event.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PopupKind, PopupVM, ServerEvent, ThemeTokens, PopupRainConfig, WidgetPage, WidgetTopic, WidgetPayload, ProbeReason } from './protocol.ts';
import { PROTOCOL_VERSION, CHART_INTERVALS, CHART_INDICATORS, CHART_STYLES, CHART_SCALES, WIDGET_TOPICS, WIDGET_HTML_MAX } from './protocol.ts';
import { auditWidgetHtml, inlineHashes, normalizeWidgetHtml } from './widget-html.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.join(here, 'pages');
/** task-1325: the vendored TradingView Lightweight Charts™ build (Apache-2.0), see vendor/lightweight-charts/README.md. */
export const LWC_DIR = path.join(here, '..', 'vendor', 'lightweight-charts');
export const LWC_FILE = 'lightweight-charts.standalone.production.js';
/** The ONE static route the server answers besides ticketed pages: exactly this path, GET, no query string. */
export const LWC_ROUTE = `/vendor/${LWC_FILE}`;
const TICKET_TTL_MS = 30_000;
/** task-1326: the one image route, `GET /img/<32 hex>.png`, no query string. */
export const IMAGE_ROUTE_RE = /^\/img\/([0-9a-f]{32})\.png$/;
export const IMAGE_ROUTE_PREFIX = '/img/';
const MAX_WS_MSG = 4096;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

/** UI events a popup may send. Anything outside this list is dropped and reported as `popup.dropped`. */
export const POPUP_EVENTS = new Set<string>([
  'ready', 'perf', 'log',
  'event:bar.hovered', 'event:interval.changed', 'event:holder.selected', 'event:feed.selected',
  'event:popup.close-request', 'event:popup.focus', 'event:popup.drag',
  // task-1325 chart v2 requests (payloads validated by validateEventPayload below)
  'event:chart.interval', 'event:chart.indicator', 'event:chart.style', 'event:chart.scale', 'event:chart.painted',
  // task-1345 agent roster: per-agent pause / kick, by agent name (the only writes this popup can send)
  'event:roster.pause', 'event:roster.resume', 'event:roster.kick',
  // task-1355 order plans: cancel a plan by id (the ONLY write the plans popup can send — never arm/cap/sign)
  'event:plan.cancel',
  // task-1406 spectator: pause / resume / take over / kill an agent by name (the only writes this popup sends)
  'event:spectator.pause', 'event:spectator.resume', 'event:spectator.takeover', 'event:spectator.kill',
]);
/**
 * task-1358 r3: the ONLY messages a pack widget's socket may send — the generic set every popup has. A widget socket
 * is checked against this set, not POPUP_EVENTS, so `roster.kick` / `plan.cancel` / chart requests are dropped here
 * (the TUI ignored them by popupId already; now the server does too, and never reports them as `popup.event`).
 */
export const WIDGET_EVENTS = new Set<string>(['ready', 'perf', 'log', 'event:popup.close-request', 'event:popup.focus', 'event:popup.drag']);
/** The one route a widget wrapper may frame (an exact-path CSP source: the query string is not part of the match). */
export const WIDGET_FRAME_ROUTE = '/popup/widget-frame';

/** Agent-name shape for roster events (mirrors @dexterm/agents AGENT_NAME_RE; duplicated to avoid a package import). */
const ROSTER_AGENT_RE = /^[a-z][a-z0-9-]{0,23}$/;
/** Plan-id shape (`plan_<base36>_<base36>` from plan.ts); the TUI re-validates against its live list anyway. */
const PLAN_ID_RE = /^plan_[0-9a-z]+_[0-9a-z]+$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);
const finiteIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * task-1325: every allow-listed UI event's payload is checked against a closed schema and REBUILT from the
 * validated fields only (extra keys are discarded). Returns null for anything else — the caller drops the
 * message as `popup.dropped` / 'bad-payload' and never forwards or echoes the payload. Intervals must be one
 * of the six chart timeframes, indicator ids one of CHART_INDICATORS, and so on.
 */
export function validateEventPayload(name: string, payload: unknown): Record<string, unknown> | null {
  const p = payload === undefined ? {} : payload;
  if (!isObj(p)) return null;
  switch (name) {
    case 'bar.hovered': case 'feed.selected':
      return Number.isInteger(p.i) && finiteIn(p.i, 0, 1e6) ? { i: p.i } : null;
    case 'interval.changed': case 'chart.interval':
      return oneOf(CHART_INTERVALS, p.interval) ? { interval: p.interval } : null;
    case 'chart.indicator':
      return oneOf(CHART_INDICATORS, p.id) && typeof p.on === 'boolean' ? { id: p.id, on: p.on } : null;
    case 'chart.style':
      return oneOf(CHART_STYLES, p.style) ? { style: p.style } : null;
    case 'chart.scale':
      return oneOf(CHART_SCALES, p.scale) ? { scale: p.scale } : null;
    case 'chart.painted':
      return (p.kind === 'first' || p.kind === 'data') && finiteIn(p.ms, 0, 600_000) && finiteIn(p.sentAt, 0, 1e15)
        ? { kind: p.kind, ms: p.ms, sentAt: p.sentAt } : null;
    case 'holder.selected':
      return typeof p.address === 'string' && B58.test(p.address) ? { address: p.address } : null;
    case 'popup.close-request': case 'popup.focus': case 'popup.drag':
      return {};
    case 'roster.pause': case 'roster.resume': case 'roster.kick':
    case 'spectator.pause': case 'spectator.resume': case 'spectator.takeover': case 'spectator.kill':
      return typeof p.agent === 'string' && ROSTER_AGENT_RE.test(p.agent) ? { agent: p.agent } : null;
    case 'plan.cancel':
      return typeof p.id === 'string' && PLAN_ID_RE.test(p.id) ? { id: p.id } : null;
    default:
      return null;
  }
}

/** sha256 CSP source for the exact `<style>` text the vendored LWC injects for its attribution logo, or null. */
export function lwcLogoStyleHash(lwcSource: string): string | null {
  const m = /\.innerText="(a#tv-attr-logo\{[^"\\]*)"/.exec(lwcSource);
  return m ? `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'` : null;
}

// (r3) 'widget' is the WRAPPER page — ours, nonce-rendered like the rest; the pack html goes in its iframe
const PAGE_KINDS: PopupKind[] = ['chart', 'token', 'feeds', 'bubbles', 'roster', 'narrative', 'plans', 'widget', 'spectator'];

function b64url(buf: Buffer): string { return buf.toString('base64url'); }
function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function sanitizeForLog(s: unknown, n = 80): string { return String(s ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, n); }
const htmlEscape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// ------------------------------------------------------------------ WebSocket (RFC 6455, server side, text frames)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsEncode(str: string | Buffer, opcode = 1): Buffer {
  // A Buffer is sent as-is (close frames carry a raw 2-byte code). task-1325 fix: the close code used to be
  // round-tripped through a latin1 string and re-encoded as UTF-8 (1000 → 03 c3 a8), which browsers reject
  // as "a broken close frame containing invalid UTF-8".
  const payload = typeof str === 'string' ? Buffer.from(str) : str;
  let head: Buffer;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, payload]);
}
class WsConn {
  private socket: Duplex;
  private buf: Buffer = Buffer.alloc(0);
  closed = false;
  private readonly onMessage: (text: string) => void;
  private readonly onClose: () => void;
  constructor(socket: Duplex, onMessage: (text: string) => void, onClose: () => void) {
    this.socket = socket; this.onMessage = onMessage; this.onClose = onClose;
    socket.on('data', (d: Buffer) => this.feed(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
  }
  feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_WS_MSG) { this.close(1009); return; } // clients MUST mask; cap size
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (opcode === 8) { this.close(1000); return; }
      if (opcode === 9) { this.socket.write(wsEncode(data, 10)); continue; }
      if (opcode === 1) this.onMessage(data.toString('utf8'));
      // binary (2) and continuation frames are ignored on purpose: the protocol is JSON text only
    }
  }
  send(obj: unknown): void { if (!this.closed) this.socket.write(wsEncode(JSON.stringify(obj))); }
  close(code = 1000): void {
    if (this.closed) return;
    try { const b = Buffer.alloc(2); b.writeUInt16BE(code); this.socket.write(wsEncode(b, 8)); } catch { /* socket gone */ }
    this.end();
  }
  end(): void { if (this.closed) return; this.closed = true; try { this.socket.destroy(); } catch { /* ignore */ } this.onClose(); }
}

interface Ticket { popupId: string; kind: PopupKind; params: Record<string, unknown>; exp: number; used: boolean; /** task-1358: the pack page a `widget` ticket buys (kept here, never in hello params). */ widget?: WidgetPage }
interface WsToken { popupId: string; kind: PopupKind; exp: number; used: boolean }
/** task-1358 r3: minted when the wrapper is rendered; buys the pack page for the wrapper's iframe exactly once. */
interface FrameToken { popupId: string; widget: WidgetPage; exp: number; used: boolean }
interface Popup { kind: PopupKind; params: Record<string, unknown>; openedAt: number; conn: WsConn | null; data?: PopupVM; readyAt?: number }

export interface PopupServer {
  readonly port: number;
  readonly origin: string;
  /** Mint a single-use ticket; returns the loopback URL to hand to the shell (over stdin) or the browser. */
  issueTicket(kind: PopupKind, popupId: string, params?: Record<string, unknown>): string;
  send(popupId: string, msg: unknown): void;
  broadcast(msg: unknown, kind?: PopupKind | null): void;
  setData(popupId: string, data: PopupVM): void;
  /** task-1358: push one topic's view model to a pack widget (`{type:'data', topic, payload}`). */
  sendData(popupId: string, topic: WidgetTopic, payload: WidgetPayload): void;
  closePopup(popupId: string): void;
  readonly popups: Map<string, Popup>;
  close(): Promise<void>;
}

export interface PopupServerOptions {
  onEvent?: (ev: ServerEvent) => void;
  theme?: ThemeTokens;
  rain?: PopupRainConfig;
  /** Override the directory the page assets are read from (defaults to this package's src/pages). */
  pagesDir?: string;
  /**
   * task-1326: coin images for the popup header, served from the TUI's local cache ONLY — never hot-linked
   * from a third party (the page CSP forbids remote images; the image host never sees the user's IP). The
   * provider returns OUR re-encoded PNG for a 32-hex cache key, or null → empty 404.
   */
  imageProvider?: (key: string) => Uint8Array | null;
}

/** Start the loopback popup server. Resolves once it is listening on a random 127.0.0.1 port. */
export async function createPopupServer(opts: PopupServerOptions = {}): Promise<PopupServer> {
  const onEvent = opts.onEvent ?? (() => {});
  const theme = opts.theme ?? ({} as ThemeTokens);
  const rain = opts.rain ?? { enabled: true, speedScale: 1, density: 0.55 };
  const pagesDir = opts.pagesDir ?? PAGES_DIR;
  const tickets = new Map<string, Ticket>();
  const wsTokens = new Map<string, WsToken>();
  const frameTokens = new Map<string, FrameToken>();
  const popups = new Map<string, Popup>();
  const commonJs = readFileSync(path.join(pagesDir, 'common.js'), 'utf8');
  const commonCss = readFileSync(path.join(pagesDir, 'common.css'), 'utf8');
  // task-1358: the pack-widget SDK (window.dexterm), inlined ahead of the pack's own markup and allow-listed by its hash.
  const widgetSdkJs = normalizeWidgetHtml(readFileSync(path.join(pagesDir, 'widget-sdk.js'), 'utf8'));
  if (/<\/script[\s/>]/i.test(widgetSdkJs) || widgetSdkJs.includes('__NONCE__')) throw new Error('widget-sdk.js must not close a script element or carry a nonce placeholder');
  const optional = (f: string): string => (existsSync(path.join(pagesDir, f)) ? readFileSync(path.join(pagesDir, f), 'utf8') : '');
  const pages: Record<string, { html: string; js: string; lib: string; css: string }> = {};
  for (const kind of PAGE_KINDS) {
    pages[kind] = {
      html: readFileSync(path.join(pagesDir, `${kind}.html`), 'utf8'),
      js: readFileSync(path.join(pagesDir, `${kind}.js`), 'utf8'),
      // task-1325: optional per-page pure helpers (`chart-lib.js`) and stylesheet (`chart.css`), inlined under the nonce.
      lib: optional(`${kind}-lib.js`),
      css: optional(`${kind}.css`),
    };
  }
  // task-1325: the vendored chart library is read ONCE into memory from a fixed path. The route below never
  // maps a URL onto the filesystem, so there is nothing to traverse: any other path is a 404.
  const lwcJs = readFileSync(path.join(LWC_DIR, LWC_FILE));
  // The NOTICE text verbatim, its lines joined with " · "; the trailing URL becomes the page's link element.
  const lwcNotice = readFileSync(path.join(LWC_DIR, 'NOTICE'), 'utf8').trim().replace(/\s*https:\/\/www\.tradingview\.com\/?$/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' · ');
  const lwcVersion = readFileSync(path.join(LWC_DIR, 'VERSION'), 'utf8').trim();
  const lwcStyleHash = lwcLogoStyleHash(lwcJs.toString('utf8'));
  let port = 0;

  const reject = (req: IncomingMessage, res: ServerResponse, reason: string, code = 404): void => {
    onEvent({ ev: 'probe.rejected', reason: reason as ProbeReason, method: req.method ?? '', path: sanitizeForLog(req.url), remote: `${req.socket.remoteAddress}:${req.socket.remotePort}`, host: sanitizeForLog(req.headers.host), origin: sanitizeForLog(req.headers.origin) });
    res.writeHead(code, { 'content-length': '0', 'cache-control': 'no-store' });
    res.end();
  };
  const baseChecks = (req: IncomingMessage): string | null => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return 'remote-not-loopback';
    if (req.headers.host !== `127.0.0.1:${port}`) return 'bad-host';
    return null;
  };
  const originOk = (req: IncomingMessage): boolean => req.headers.origin === `http://127.0.0.1:${port}`;
  // task-1326: img-src opens exactly our own loopback image route (a path-scoped source), nothing else.
  const imgSrc = (): string => (opts.imageProvider ? `http://127.0.0.1:${port}${IMAGE_ROUTE_PREFIX}` : "'none'");
  const cspTail = (): string => `connect-src ws://127.0.0.1:${port}; img-src ${imgSrc()}; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
  // script-src stays nonce-only: the vendored chart library is an external same-origin <script src> that
  // carries the page nonce, so no 'self' (and no other same-origin script) is needed. The chart page also
  // allows exactly one more inline style by hash: the attribution-logo rule LWC injects (task-1325).
  // (r3) the widget WRAPPER additionally names the one route its iframe may ever show — an exact path on our origin; the
  // engine applies it to every navigation of the child, whoever initiates it, which is what keeps a pack page on loopback.
  const pageCsp = (nonce: string, kind: PopupKind): string => `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'${kind === 'chart' && lwcStyleHash ? ` ${lwcStyleHash}` : ''}; ${cspTail()}${kind === 'widget' ? `; frame-src http://127.0.0.1:${port}${WIDGET_FRAME_ROUTE}` : ''}`;
  /**
   * task-1358 r2/r3: the pack page's CSP (the iframe document) has NO nonce — one hash per inline block (our SDK + the
   * page's own), so no tag can borrow an authorisation and an external script can never match one. No 'strict-dynamic'
   * (it would hand trust to anything a hashed script inserts). r3: the frame has NO network of its own (`connect-src
   * 'none'`, no images, no fonts, no media — the wrapper owns the socket and feeds it by postMessage), may only be shown
   * inside our origin (`frame-ancestors`), and is sandboxed WITHOUT allow-same-origin (opaque origin: no cookies, no
   * storage, no reach into the wrapper). Trusted Types close the runtime sinks where implemented (Chromium) and the
   * sandbox blocks popups, forms, downloads and top navigation; self-navigation is the parent's frame-src's job.
   */
  const frameCsp = (scripts: string[], styles: string[]): string =>
    `default-src 'none'; script-src ${scripts.join(' ')}; style-src ${styles.length ? styles.join(' ') : "'none'"}; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:${port}; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'; sandbox allow-scripts`;
  const secHeaders = (csp: string): Record<string, string> => ({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'content-security-policy': csp,
  });
  const renderPage = (kind: PopupKind, vars: Record<string, string>): { html: string; nonce: string } => {
    const nonce = b64url(randomBytes(16));
    let html = pages[kind].html
      .replace('/*__CSS__*/', () => commonCss + (pages[kind].css ? `\n${pages[kind].css}` : ''))
      .replace('/*__COMMON_JS__*/', () => commonJs)
      .replace('/*__LIB_JS__*/', () => pages[kind].lib)
      .replace('/*__JS__*/', () => pages[kind].js)
      .replaceAll('__NONCE__', nonce);
    for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`__${k}__`, htmlEscape(v));
    return { html, nonce };
  };
  /**
   * task-1358 (r2/r3): the pack page — the document inside the wrapper's iframe. The pack's html is served EXACTLY as
   * installed (CR LF → LF only, as the parser itself does) — no placeholder of any kind is substituted into it, so nothing
   * an author writes can borrow a value from the host. Our own <head> (the widget key + topics + the host origin the SDK
   * talks to, and the SDK) is built here and spliced in ahead of the pack markup; the CSP then allow-lists every inline
   * <script>/<style> of the FINAL document by sha256 (so the SDK's hash and the page's own come from one pass over what
   * is actually sent). r3: NO socket token, popup id or port is in this document any more — the frame has no network and
   * nothing worth stealing; the wrapper holds the credentials. Headers are ours: nothing in the pack html can change
   * them. The audit ran at ticket issue (and at install and open); it runs once more here so this function is safe alone.
   */
  const renderWidgetFrame = (w: WidgetPage): { html: string; csp: string } => {
    const problems = auditWidgetHtml(w.html);
    if (problems.length) throw new Error(`widget ${w.key}: page refused: ${problems.join('; ')}`);
    const meta = (name: string, v: string): string => `<meta name="${name}" content="${htmlEscape(v)}">`;
    const head = meta('dexterm-widget', w.key) + meta('dexterm-topics', w.topics.join(',')) + meta('dexterm-host', `http://127.0.0.1:${port}`) + `<script>${widgetSdkJs}</script>`;
    let html = normalizeWidgetHtml(w.html);
    const i = html.search(/<\/head\s*>/i);
    if (i >= 0) html = html.slice(0, i) + head + html.slice(i);
    else { const j = html.search(/<body[\s>]/i); html = j >= 0 ? html.slice(0, j) + `<head>${head}</head>` + html.slice(j) : `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`; }
    const { scripts, styles } = inlineHashes(html);
    return { html, csp: frameCsp(scripts, styles) };
  };
  /** A single-use, 30 s frame token for the wrapper's iframe `src`; the pack page rides on the token, never in the wrapper. */
  const issueFrameToken = (popupId: string, widget: WidgetPage): string => {
    const f = b64url(randomBytes(32));
    frameTokens.set(f, { popupId, widget, exp: Date.now() + TICKET_TTL_MS, used: false });
    return `http://127.0.0.1:${port}${WIDGET_FRAME_ROUTE}?f=${f}`;
  };

  const server = http.createServer((req, res) => {
    const bad = baseChecks(req);
    if (bad) return reject(req, res, bad);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    // ---- task-1358 r3: the pack page for a widget wrapper's iframe: GET /popup/widget-frame?f=<frame token>. Only an
    // iframe may fetch it (Sec-Fetch-Dest, where the engine sends it — every current one does; a top-level open is refused),
    // only from our own origin, and the token is single-use: a URL lifted from the wrapper is spent by the time anyone reads it.
    if (req.method === 'GET' && url.pathname === WIDGET_FRAME_ROUTE) {
      const dest = req.headers['sec-fetch-dest'], site = req.headers['sec-fetch-site'];
      if ((dest !== undefined && dest !== 'iframe') || (site !== undefined && site !== 'same-origin')) return reject(req, res, 'bad-frame');
      const f = url.searchParams.get('f') ?? '';
      const ft = frameTokens.get(f);
      if (!ft || ft.used || ft.exp < Date.now()) return reject(req, res, 'bad-frame');
      ft.used = true; frameTokens.delete(f);
      let page: { html: string; csp: string };
      try { page = renderWidgetFrame(ft.widget); }
      catch (e) { onEvent({ ev: 'popup.log', popupId: ft.popupId, msg: sanitizeForLog((e as Error).message, 200) }); return reject(req, res, 'bad-frame'); }
      res.writeHead(200, secHeaders(page.csp)); return res.end(page.html);
    }
    // ---- popup page: GET /popup/<kind>?p=<ticket>
    if (req.method === 'GET' && url.pathname.startsWith('/popup/')) {
      const kind = url.pathname.slice('/popup/'.length) as PopupKind;
      const p = url.searchParams.get('p') ?? '';
      const t = tickets.get(p);
      if (!t || t.used || t.exp < Date.now() || t.kind !== kind || !pages[kind] || (kind === 'widget') !== !!t.widget) return reject(req, res, 'bad-ticket');
      t.used = true; tickets.delete(p);
      const wsToken = b64url(randomBytes(32));
      wsTokens.set(wsToken, { popupId: t.popupId, kind, exp: Date.now() + TICKET_TTL_MS, used: false });
      const vars: Record<string, string> = { WS_TOKEN: wsToken, POPUP_ID: t.popupId, PORT: String(port), LWC_NOTICE: lwcNotice, LWC_VERSION: lwcVersion, LWC_SRC: LWC_ROUTE };
      if (kind === 'widget') {
        // r3: the wrapper is OUR page; the pack html never enters it — the iframe fetches it with a one-shot frame token.
        // The audit already refused loaders at ticket issue; a page that fails it again here never gets a frame token.
        const problems = auditWidgetHtml(t.widget!.html);
        if (problems.length) { onEvent({ ev: 'popup.log', popupId: t.popupId, msg: sanitizeForLog(`widget ${t.widget!.key}: page refused: ${problems.join('; ')}`, 200) }); return reject(req, res, 'bad-ticket'); }
        vars.WIDGET_KEY = t.widget!.key; vars.WIDGET_TITLE = t.widget!.title; vars.FRAME_URL = issueFrameToken(t.popupId, t.widget!);
      }
      const r = renderPage(kind, vars);
      res.writeHead(200, secHeaders(pageCsp(r.nonce, kind))); return res.end(r.html);
    }
    // ---- task-1325: the vendored chart library. Exactly one path, GET only, no query string; served from
    // memory (never a filesystem lookup), so `..`, encoded variants and every other file are a 404.
    if (req.method === 'GET' && req.url === LWC_ROUTE) {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': String(lwcJs.length),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
      });
      return res.end(lwcJs);
    }
    // ---- task-1326: a coin image from the local cache. Exact shape only (32 hex + .png, no query string); the
    // key never touches the filesystem path (the provider maps it to its own cache), so there is nothing to traverse.
    if (req.method === 'GET' && opts.imageProvider && req.url && IMAGE_ROUTE_RE.test(req.url)) {
      const key = (IMAGE_ROUTE_RE.exec(req.url) as RegExpExecArray)[1];
      let png: Uint8Array | null = null;
      try { png = opts.imageProvider(key); } catch { png = null; }
      if (!png) return reject(req, res, 'unknown-route');
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(png.byteLength),
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
      });
      return res.end(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
    }
    return reject(req, res, 'unknown-route');
  });

  server.on('upgrade', (req, socket, head) => {
    const fail = (reason: string): void => {
      onEvent({ ev: 'probe.rejected', reason: reason as ProbeReason, method: 'UPGRADE', path: sanitizeForLog(req.url), remote: `${req.socket.remoteAddress}:${req.socket.remotePort}`, host: sanitizeForLog(req.headers.host), origin: sanitizeForLog(req.headers.origin) });
      socket.write('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'); socket.destroy();
    };
    const bad = baseChecks(req);
    if (bad) return fail(bad);
    if (!originOk(req)) return fail('bad-origin');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/ws') return fail('unknown-route');
    const tok = url.searchParams.get('t') ?? '';
    const match = [...wsTokens.entries()].find(([k]) => safeEq(k, tok));
    const entry = match?.[1];
    if (!entry || entry.used || entry.exp < Date.now()) return fail('bad-ws-token');
    entry.used = true; wsTokens.delete(match![0]);
    if (String(req.headers['sec-websocket-version']) !== '13' || !req.headers['sec-websocket-key']) return fail('bad-ws-handshake');
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const popupId = entry.popupId;
    const popup: Popup = popups.get(popupId) ?? { kind: entry.kind, params: {}, openedAt: Date.now(), conn: null };
    const conn = new WsConn(socket, (text) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(text); } catch { onEvent({ ev: 'popup.dropped', popupId, reason: 'bad-json' }); return; }
      const key = msg.type === 'event' ? `event:${String(msg.name)}` : (msg.type as string);
      // task-1325: an unknown name is never echoed back (not even sanitised) — the TUI only learns it was dropped.
      // task-1358 r3: a widget's socket gets the generic set only (never roster / plan / chart events).
      const allowed = popup.kind === 'widget' ? WIDGET_EVENTS : POPUP_EVENTS;
      if (typeof key !== 'string' || !allowed.has(key)) { onEvent({ ev: 'popup.dropped', popupId, reason: 'not-allowed', type: msg.type === 'event' ? 'event:?' : '?' }); return; }
      if (msg.type === 'ready') {
        popup.readyAt = Date.now();
        onEvent({ ev: 'popup.ready', popupId, kind: popup.kind, openToReadyMs: popup.readyAt - popup.openedAt, page: sanitizeForLog(msg.page, 24) });
        if (popup.data) conn.send({ type: 'data', topic: popup.kind, payload: popup.data });
        return;
      }
      if (msg.type === 'perf') { onEvent({ ev: 'popup.perf', popupId, ...pickPerf(msg) }); return; }
      if (msg.type === 'log') { onEvent({ ev: 'popup.log', popupId, msg: sanitizeForLog(msg.msg, 200) }); return; }
      // task-1325: the payload must match the event's closed schema; junk is dropped and never echoed
      // (only the already allow-listed event NAME is reported).
      const payload = validateEventPayload(String(msg.name), msg.payload);
      if (!payload) { onEvent({ ev: 'popup.dropped', popupId, reason: 'bad-payload', type: sanitizeForLog(key, 40) }); return; }
      onEvent({ ev: 'popup.event', popupId, name: String(msg.name), payload });
    }, () => { popups.delete(popupId); onEvent({ ev: 'popup.closed', popupId }); });
    popup.conn = conn;
    popups.set(popupId, popup);
    // params minus the initial view model (that one is pushed as `data` right after `ready`; task-1325: a
    // 1000-bar chart VM was being sent twice). `fallback` carries the browser-fallback reason for the page.
    // (task-1358: a widget ticket's params hold only {key, title, topics}; the html lives on the ticket, never here)
    const { data: _initial, ...helloParams } = popup.params;
    conn.send({ type: 'hello', protocol: PROTOCOL_VERSION, popup: { id: popupId, kind: popup.kind, params: helloParams }, theme, rain });
    if (head && head.length) conn.feed(head);
  });

  // keep connection parsing strict and quick
  server.headersTimeout = 5000; server.requestTimeout = 10_000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 40;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  function broadcast(msg: unknown, kind: PopupKind | null = null): void { for (const p of popups.values()) if (p.conn && (!kind || p.kind === kind)) p.conn.send(msg); }
  function pickPerf(m: Record<string, unknown>): Omit<ServerEvent & { ev: 'popup.perf' }, 'ev' | 'popupId'> {
    return { fps: +(m.fps as number) || 0, frameMs: +(m.frameMs as number) || 0, p95Ms: +(m.p95Ms as number) || 0, long: +(m.long as number) || 0, dpr: +(m.dpr as number) || 0, w: +(m.w as number) || 0, h: +(m.h as number) || 0, pwned: String(m.pwned) };
  }

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    issueTicket(kind, popupId, params = {}) {
      const ticket = b64url(randomBytes(32));
      // task-1358: a widget ticket carries the pack page; it is validated here (shape, size, topics) and kept on the
      // ticket only. The page's `widget` param in hello is the key/title/topics, never the html.
      let widget: WidgetPage | undefined;
      if (kind === 'widget') {
        const w = params.widget as Partial<WidgetPage> | undefined;
        if (!w || typeof w.key !== 'string' || !/^[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,39}(\/[a-z][a-z0-9-]{0,39})?$/.test(w.key) || typeof w.html !== 'string' || !Array.isArray(w.topics)) throw new Error('widget ticket needs { key, title, topics, html }');
        if (w.html.length > WIDGET_HTML_MAX) throw new Error(`widget ${w.key}: page is ${w.html.length} chars (max ${WIDGET_HTML_MAX})`);
        // r2: a page that carries a loader (the __NONCE__ token, <script src>, <link>, a frame, <meta http-equiv>, @import)
        // never gets a ticket — the last of the three refusals (install, open, here), so the server is safe on its own
        const problems = auditWidgetHtml(w.html);
        if (problems.length) throw new Error(`widget ${w.key}: page refused: ${problems.join('; ')}`);
        const topics = w.topics.filter((t): t is WidgetTopic => (WIDGET_TOPICS as readonly string[]).includes(t as string));
        widget = { key: w.key, title: String(w.title ?? w.key).slice(0, 60), topics, html: w.html };
        params = { ...params, widget: { key: widget.key, title: widget.title, topics } };
      } else if (params.widget !== undefined) throw new Error(`a ${kind} ticket cannot carry a widget page`);
      tickets.set(ticket, { popupId, kind, params, exp: Date.now() + TICKET_TTL_MS, used: false, ...(widget ? { widget } : {}) });
      popups.set(popupId, { kind, params, openedAt: Date.now(), data: params.data as PopupVM | undefined, conn: popups.get(popupId)?.conn ?? null });
      return `http://127.0.0.1:${port}/popup/${kind}?p=${ticket}`;
    },
    send(popupId, msg) { popups.get(popupId)?.conn?.send(msg); },
    sendData(popupId, topic, payload) { const p = popups.get(popupId); if (p && p.kind === 'widget' && (WIDGET_TOPICS as readonly string[]).includes(topic)) p.conn?.send({ type: 'data', topic, payload }); },
    broadcast,
    setData(popupId, data) { const p = popups.get(popupId); if (p) { p.data = data; p.conn?.send({ type: 'data', topic: p.kind, payload: data }); } },
    closePopup(popupId) { const p = popups.get(popupId); if (p?.conn) { p.conn.send({ type: 'close' }); p.conn.close(1000); } popups.delete(popupId); },
    popups,
    close() { for (const p of popups.values()) p.conn?.close(1001); return new Promise<void>((r) => server.close(() => r())); },
  };
}
