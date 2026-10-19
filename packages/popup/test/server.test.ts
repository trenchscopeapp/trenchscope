import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createPopupServer, type PopupServer } from '../src/server.ts';
import { fixtureRosterVM, fixtureNarrativeVM } from '../src/selftest.ts';
import type { ServerEvent, ThemeTokens, ChartVM } from '../src/protocol.ts';

const THEME: ThemeTokens = {
  bg: '#000', panel: '#010', border: '#020', borderFocus: '#39ff14', text: '#fff', muted: '#0a0', dim: '#060',
  accent: '#0ff', up: '#0f0', down: '#f06', warn: '#ff0', ai: '#d77', rain: ['#1', '#2', '#3', '#4'], rainPump: ['#1', '#2', '#3', '#4'], rainDump: ['#1', '#2', '#3', '#4'],
};

function chartVM(symbol: string): ChartVM {
  return { symbol, name: symbol, mint: 'MINT', interval: '1h', price: 1, chg: { m5: 0, h1: 0, h6: 0, h24: 0 }, liq: 1, vol24: 1, mcap: 1, candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }], openBarT: 1, updatedAt: 1 };
}

async function withServer(fn: (srv: PopupServer, events: ServerEvent[]) => Promise<void>): Promise<void> {
  const events: ServerEvent[] = [];
  const srv = await createPopupServer({ theme: THEME, onEvent: (e) => events.push(e) });
  try { await fn(srv, events); } finally { await srv.close(); }
}

const wsMeta = (html: string): string => /<meta name="dexterm-ws" content="([^"]*)">/.exec(html)?.[1] ?? '';

/** Minimal raw WebSocket client that sets an Origin header (the Node global client cannot). Masks client frames. */
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
        const len0 = buf[1] & 0x7f; let off = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len); const opcode = buf[0] & 0x0f;
        buf = buf.subarray(off + len);
        if (opcode === 1) { try { pushMsg(JSON.parse(payload.toString('utf8'))); } catch { /* ignore */ } }
      }
    }
    function send(o: unknown): void {
      const payload = Buffer.from(JSON.stringify(o));
      const mask = randomBytes(4);
      const masked = Buffer.from(payload); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      let head: Buffer;
      if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
      else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
      sock.write(Buffer.concat([head, mask, masked]));
    }
    function close(): void { try { sock.destroy(); } catch { /* ignore */ } }
    function waitFor(pred: (m: unknown) => boolean, ms = 2000): Promise<unknown> {
      const hit = messages.find(pred); if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws waitFor timeout')), ms); waiters.push({ pred, resolve: res, t }); });
    }
    sock.write(
      `GET /ws?t=${encodeURIComponent(token)} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Origin: ${origin}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });
}

test('serves a page for a valid ticket with a strict CSP, single-use', async () => {
  await withServer(async (srv, events) => {
    const url = srv.issueTicket('chart', 'p1', { data: chartVM('WIF') });
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src ws:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    const html = await res.text();
    assert.match(html, /window\.DT/);          // common.js inlined
    assert.match(html, /CHART/);                 // chart.html inlined
    assert.ok(wsMeta(html).length > 20);         // a per-popup ws token was embedded
    // the ticket is single-use: a replay is a 404 + probe.rejected
    const res2 = await fetch(url);
    assert.equal(res2.status, 404);
    assert.ok(events.some((e) => e.ev === 'probe.rejected' && e.reason === 'bad-ticket'));
  });
});

test('a hostile token name never reaches the page HTML (data is WS-only)', async () => {
  await withServer(async (srv) => {
    const hostile = '</script><img src=x onerror=alert(1)>‮';
    const url = srv.issueTicket('token', 'p2', { data: { ...chartVM(hostile), symbol: hostile, name: hostile } });
    const html = await (await fetch(url)).text();
    assert.ok(!html.includes('onerror=alert'), 'hostile string must not be inlined into the page');
    assert.ok(!html.includes('<img src=x'), 'hostile markup must not appear');
  });
});

test('rejects a bad Host (DNS-rebind guard) and an unknown route', async () => {
  await withServer(async (srv, events) => {
    const port = srv.port;
    // localhost resolves to 127.0.0.1 (loopback) but the Host header mismatches 127.0.0.1:port
    const bad = await fetch(`http://localhost:${port}/popup/chart?p=whatever`).catch(() => null);
    assert.ok(bad === null || bad.status === 404);
    const unknown = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(unknown.status, 404);
    assert.ok(events.some((e) => e.ev === 'probe.rejected' && (e.reason === 'bad-host' || e.reason === 'unknown-route')));
  });
});

test('WebSocket: hello + allow-list (valid event delivered, foreign event dropped), ws token single-use', async () => {
  await withServer(async (srv, events) => {
    const url = srv.issueTicket('chart', 'p3', { data: chartVM('VOID') });
    const html = await (await fetch(url)).text();
    const token = wsMeta(html);
    const origin = srv.origin;
    const c = await wsConnect(srv.port, token, origin);
    assert.equal(c.status, 101);
    const hello = await c.waitFor((m) => (m as { type?: string }).type === 'hello') as { protocol: string; theme: ThemeTokens; rain: unknown };
    assert.equal(hello.protocol, 'dexterm-popup/1');
    assert.ok(hello.theme && hello.rain);
    // ready → server pushes the stored data
    c.send({ type: 'ready', page: 'chart', t: 1 });
    const data = await c.waitFor((m) => (m as { type?: string }).type === 'data') as { payload: ChartVM };
    assert.equal(data.payload.symbol, 'VOID');
    // a valid UI event is forwarded
    c.send({ type: 'event', name: 'bar.hovered', payload: { i: 3 } });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.some((e) => e.ev === 'popup.event' && e.name === 'bar.hovered'));
    // a forbidden event (a trade command dressed as an event) is dropped, never forwarded
    c.send({ type: 'event', name: 'trade.buy', payload: { mint: 'x' } });
    c.send({ type: 'trade', payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.some((e) => e.ev === 'popup.dropped' && e.reason === 'not-allowed'));
    assert.ok(!events.some((e) => e.ev === 'popup.event' && e.name === 'trade.buy'));
    c.close();

    // reusing the same ws token is rejected (single-use)
    const again = await wsConnect(srv.port, token, origin);
    assert.notEqual(again.status, 101);
    again.close();
    assert.ok(events.some((e) => e.ev === 'probe.rejected' && e.reason === 'bad-ws-token'));
  });
});

test('WebSocket upgrade with a foreign Origin is rejected', async () => {
  await withServer(async (srv, events) => {
    const url = srv.issueTicket('feeds', 'p4', {});
    const token = wsMeta(await (await fetch(url)).text());
    const c = await wsConnect(srv.port, token, 'http://evil.example');
    assert.notEqual(c.status, 101);
    c.close();
    assert.ok(events.some((e) => e.ev === 'probe.rejected' && e.reason === 'bad-origin'));
  });
});

// ------------------------------------------------------------------------------------------------ task-1325
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LWC_DIR, LWC_FILE, LWC_ROUTE, validateEventPayload, lwcLogoStyleHash } from '../src/server.ts';
import path from 'node:path';

/** Raw HTTP/1.1 request (so the path is sent exactly as written, no client-side normalisation). */
function rawGet(port: number, target: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; headers: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.on('error', reject);
    sock.on('end', () => {
      const all = Buffer.concat(chunks); const i = all.indexOf('\r\n\r\n');
      const headers = all.subarray(0, i).toString('latin1');
      resolve({ status: Number(/HTTP\/1\.1 (\d+)/.exec(headers)?.[1] ?? 0), headers, body: all.subarray(i + 4) });
    });
    sock.write(`${opts.method ?? 'GET'} ${target} HTTP/1.1\r\nHost: ${opts.host ?? `127.0.0.1:${port}`}\r\nConnection: close\r\n\r\n`);
  });
}

test('task-1325 vendor route: serves exactly the vendored Lightweight Charts file, same-origin, nosniff', async () => {
  await withServer(async (srv) => {
    const want = readFileSync(path.join(LWC_DIR, LWC_FILE));
    const r = await rawGet(srv.port, LWC_ROUTE);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(want), 'byte-identical to vendor/lightweight-charts/' + LWC_FILE);
    assert.match(r.headers, /content-type: text\/javascript/i);
    assert.match(r.headers, /x-content-type-options: nosniff/i);
    assert.match(r.headers, /cross-origin-resource-policy: same-origin/i);
    assert.doesNotMatch(r.headers, /access-control-allow-origin/i, 'never a CORS header');
    assert.match(want.subarray(0, 300).toString(), /Lightweight Charts™ v5\.2\.1/);
    assert.equal(readFileSync(path.join(LWC_DIR, 'VERSION'), 'utf8').trim(), '5.2.1');
  });
});

test('task-1325 vendor route: every other path, traversal, query, method or Host is a 404 (never a file read)', async () => {
  await withServer(async (srv, events) => {
    const bad = [
      '/vendor/../package.json', '/vendor/../../package.json', '/vendor/%2e%2e/package.json', '/vendor/..%2fpackage.json',
      '/vendor/lightweight-charts/' + LWC_FILE, '/vendor/LICENSE', '/vendor/NOTICE', '/vendor/VERSION',
      '/vendor/lightweight-charts.standalone.development.js', '/vendor/', '/vendor', '//vendor/' + LWC_FILE,
      LWC_ROUTE + '?x=1', LWC_ROUTE + '/', LWC_ROUTE + '%00', LWC_ROUTE.toUpperCase(), '/VENDOR/' + LWC_FILE,
      `http://127.0.0.1:${srv.port}${LWC_ROUTE}`, '/src/server.ts', '/pages/chart.js', '/../src/server.ts',
    ];
    for (const p of bad) {
      const r = await rawGet(srv.port, p);
      assert.equal(r.status, 404, p);
      assert.equal(r.body.length, 0, `${p}: empty body`);
    }
    for (const m of ['POST', 'HEAD', 'PUT', 'OPTIONS']) assert.equal((await rawGet(srv.port, LWC_ROUTE, { method: m })).status, 404, m);
    assert.equal((await rawGet(srv.port, LWC_ROUTE, { host: 'evil.example' })).status, 404, 'DNS-rebind guard applies to the vendor route too');
    assert.ok(events.filter((e) => e.ev === 'probe.rejected').length >= bad.length);
  });
});

test('task-1325 chart page: nonce-only scripts (vendored lib by nonce), LWC logo style allowed by exact hash, attribution present', async () => {
  await withServer(async (srv) => {
    const res = await fetch(srv.issueTicket('chart', 'pc', { data: chartVM('WIF') }));
    const csp = res.headers.get('content-security-policy') ?? '';
    const html = await res.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
    assert.ok(nonce.length > 10);
    assert.match(csp, /script-src 'nonce-[^']+';/, 'script-src is nonce-only: no self, no hosts, no unsafe-*');
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
    assert.match(csp, /img-src 'none'/);
    // the external library is loaded same-origin WITH the nonce
    assert.ok(html.includes(`<script nonce="${nonce}" src="${LWC_ROUTE}"></script>`));
    // the logo <style> the library injects is allowed by its exact sha256 (computed from the vendored file)
    const lib = readFileSync(path.join(LWC_DIR, LWC_FILE), 'utf8');
    const styleText = /\.innerText="(a#tv-attr-logo\{[^"]*)"/.exec(lib)?.[1] ?? '';
    assert.ok(styleText.length > 50);
    const hash = `'sha256-${createHash('sha256').update(styleText).digest('base64')}'`;
    assert.equal(lwcLogoStyleHash(lib), hash);
    assert.ok(csp.includes(`style-src 'nonce-${nonce}' ${hash};`));
    // attribution: NOTICE text + link to tradingview.com + the attributionLogo option in the page script
    assert.match(html, /TradingView Lightweight Charts™ · Copyright \(с\) 2025 TradingView, Inc\./);
    assert.match(html, /<a id="tv-link" href="https:\/\/www\.tradingview\.com\/"/);
    assert.match(html, /attributionLogo: true/);
    // other kinds do not get the extra style hash
    const tok = await fetch(srv.issueTicket('token', 'pt', {}));
    assert.doesNotMatch(tok.headers.get('content-security-policy') ?? '', /sha256-/);
  });
});

test('task-1325 validateEventPayload: closed sets only; extra keys stripped; junk → null', () => {
  for (const iv of ['1m', '5m', '15m', '1h', '4h', '1d']) assert.deepEqual(validateEventPayload('chart.interval', { interval: iv }), { interval: iv });
  for (const iv of ['1s', '2h', '1H', '', '../1m', null, 5, { toString: () => '1m' }]) assert.equal(validateEventPayload('chart.interval', { interval: iv }), null, String(iv));
  assert.deepEqual(validateEventPayload('chart.interval', { interval: '5m', evil: '<x>' }), { interval: '5m' }, 'extra keys dropped');
  for (const id of ['ema9', 'ema21', 'vwap', 'volma', 'volume', 'tape']) assert.deepEqual(validateEventPayload('chart.indicator', { id, on: true }), { id, on: true });
  assert.equal(validateEventPayload('chart.indicator', { id: 'rsi', on: true }), null);
  assert.equal(validateEventPayload('chart.indicator', { id: 'ema9', on: 'yes' }), null);
  assert.equal(validateEventPayload('chart.indicator', { id: '__proto__', on: true }), null);
  assert.deepEqual(validateEventPayload('chart.style', { style: 'area' }), { style: 'area' });
  assert.equal(validateEventPayload('chart.style', { style: 'heikin' }), null);
  assert.deepEqual(validateEventPayload('chart.scale', { scale: 'log' }), { scale: 'log' });
  assert.equal(validateEventPayload('chart.scale', { scale: 'inverted' }), null);
  assert.deepEqual(validateEventPayload('chart.painted', { kind: 'data', ms: 12, sentAt: 1 }), { kind: 'data', ms: 12, sentAt: 1 });
  assert.equal(validateEventPayload('chart.painted', { kind: 'data', ms: -1, sentAt: 1 }), null);
  assert.deepEqual(validateEventPayload('bar.hovered', { i: 3 }), { i: 3 });
  assert.equal(validateEventPayload('bar.hovered', { i: '3' }), null);
  assert.equal(validateEventPayload('holder.selected', { address: 'javascript:alert(1)' }), null);
  assert.equal(validateEventPayload('chart.interval', ['1m']), null);
  assert.equal(validateEventPayload('chart.interval', 'interval=1m'), null);
  assert.equal(validateEventPayload('trade.buy', { mint: 'x' }), null, 'an unknown name never validates');
});

test('task-1325 over the WebSocket: valid chart requests delivered (sanitised), junk dropped as bad-payload and never echoed', async () => {
  await withServer(async (srv, events) => {
    const token = wsMeta(await (await fetch(srv.issueTicket('chart', 'pv', { data: chartVM('VOID') }))).text());
    const c = await wsConnect(srv.port, token, srv.origin);
    await c.waitFor((m) => (m as { type?: string }).type === 'hello');
    const MARK = 'ZZ_JUNK_MARKER_<script>';
    c.send({ type: 'event', name: 'chart.interval', payload: { interval: '15m', extra: MARK } });
    c.send({ type: 'event', name: 'chart.indicator', payload: { id: 'vwap', on: true } });
    c.send({ type: 'event', name: 'chart.interval', payload: { interval: MARK } });
    c.send({ type: 'event', name: 'chart.interval', payload: { interval: '1s' } });
    c.send({ type: 'event', name: 'chart.indicator', payload: { id: MARK, on: true } });
    c.send({ type: 'event', name: 'chart.style', payload: MARK });
    c.send({ type: 'event', name: MARK, payload: {} });
    await new Promise((r) => setTimeout(r, 80));
    const delivered = events.filter((e) => e.ev === 'popup.event') as Array<{ name: string; payload: unknown }>;
    assert.deepEqual(delivered.map((e) => [e.name, e.payload]), [['chart.interval', { interval: '15m' }], ['chart.indicator', { id: 'vwap', on: true }]]);
    const dropped = events.filter((e) => e.ev === 'popup.dropped') as Array<{ reason: string; type?: string }>;
    assert.equal(dropped.filter((d) => d.reason === 'bad-payload').length, 4);
    assert.equal(dropped.filter((d) => d.reason === 'not-allowed').length, 1);
    assert.ok(!JSON.stringify(events).includes('ZZ_JUNK_MARKER'), 'junk payloads/names are never echoed into TUI events');
    c.close();
  });
});

test('task-1325 WebSocket close frame carries a valid 2-byte code (was mis-encoded as UTF-8)', async () => {
  await withServer(async (srv) => {
    const token = wsMeta(await (await fetch(srv.issueTicket('chart', 'pz', { data: chartVM('X') }))).text());
    const raw: Buffer[] = [];
    const sock = net.connect(srv.port, '127.0.0.1');
    sock.on('data', (d: Buffer) => raw.push(d));
    sock.write(`GET /ws?t=${encodeURIComponent(token)} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nOrigin: ${srv.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 80));
    srv.closePopup('pz');
    await new Promise((r) => setTimeout(r, 80));
    sock.destroy();
    const all = Buffer.concat(raw);
    const i = all.indexOf(Buffer.from([0x88]));
    assert.ok(i > 0, 'a close frame was sent');
    assert.equal(all[i + 1], 2, 'payload length 2');
    assert.equal(all.readUInt16BE(i + 2), 1000);
  });
});

// ------------------------------------------------------------------ task-1345: the agent roster popup
test('roster popup: page served with a strict CSP, VM pushed on ready', async () => {
  await withServer(async (srv) => {
    const url = srv.issueTicket('roster', 'pr1', { data: fixtureRosterVM() });
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(html, /trenchscope · AGENTS/);
    const token = wsMeta(html);
    const c = await wsConnect(srv.port, token, srv.origin);
    c.send({ type: 'ready', page: 'roster', t: 1 });
    const data = await c.waitFor((m) => (m as { type?: string }).type === 'data') as { payload: { agents: unknown[] } };
    assert.equal(data.payload.agents.length, 3);
    c.close();
  });
});

// ------------------------------------------------------------------ task-1356: the narrative board popup
test('narrative popup: page served with a strict CSP, deterministic board VM pushed on ready', async () => {
  await withServer(async (srv) => {
    const url = srv.issueTicket('narrative', 'pn1', { data: fixtureNarrativeVM() });
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(html, /trenchscope · NARRATIVE/);
    const token = wsMeta(html);
    const c = await wsConnect(srv.port, token, srv.origin);
    c.send({ type: 'ready', page: 'narrative', t: 1 });
    const data = await c.waitFor((m) => (m as { type?: string }).type === 'data') as { payload: { rows: unknown[]; tokens_total: number } };
    assert.equal(data.payload.rows.length, 4);
    assert.equal(data.payload.tokens_total, 42);
    c.close();
  });
});

test('roster popup: pause / resume / kick events are validated and surfaced; junk is dropped', async () => {
  await withServer(async (srv, events) => {
    const token = wsMeta(await (await fetch(srv.issueTicket('roster', 'pr2', { data: fixtureRosterVM() }))).text());
    const c = await wsConnect(srv.port, token, srv.origin);
    c.send({ type: 'ready', page: 'roster', t: 1 });
    await c.waitFor((m) => (m as { type?: string }).type === 'data');
    c.send({ type: 'event', name: 'roster.pause', payload: { agent: 'rogue' } });
    c.send({ type: 'event', name: 'roster.kick', payload: { agent: 'scanbot' } });
    c.send({ type: 'event', name: 'roster.kick', payload: { agent: 'Bad Name' } });     // bad shape → dropped
    c.send({ type: 'event', name: 'roster.pause', payload: {} });                        // missing agent → dropped
    c.send({ type: 'event', name: 'roster.nuke', payload: { agent: 'scanbot' } });       // not allow-listed → dropped
    await new Promise((r) => setTimeout(r, 100));
    const evs = events.filter((e) => e.ev === 'popup.event') as Array<{ name: string; payload: { agent: string } }>;
    assert.ok(evs.some((e) => e.name === 'roster.pause' && e.payload.agent === 'rogue'));
    assert.ok(evs.some((e) => e.name === 'roster.kick' && e.payload.agent === 'scanbot'));
    assert.equal(evs.length, 2, 'only the two well-formed events surfaced');
    assert.ok(events.some((e) => e.ev === 'popup.dropped' && (e as { reason: string }).reason === 'bad-payload'), 'a bad agent name was dropped as bad-payload');
    assert.ok(events.some((e) => e.ev === 'popup.dropped' && (e as { reason: string }).reason === 'not-allowed'), 'roster.nuke was dropped as not-allowed');
    c.close();
  });
});
