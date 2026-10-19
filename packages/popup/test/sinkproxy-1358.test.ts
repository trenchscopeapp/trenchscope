// task-1358 r4 — the loopback SINK PROXY the native shell's WebViews are routed through: it reaches exactly one
// authority (the popup server), as a CONNECT tunnel or as absolute-form requests rewritten to origin-form (keep-alive,
// and the WebSocket upgrade handed over as a raw tunnel); every other host:port — the r3 verifier's runtime
// `<link rel=preconnect>` target — is answered 403, closed, counted and reported with the target and nothing else.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { createSinkProxy, type SinkProxyRefusal } from '../src/sinkproxy.ts';

/** A stand-in for the popup server: records what it saw, answers GET, upgrades /ws into an echo. */
async function stub(): Promise<{ port: number; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const socks = new Set<net.Socket>(); // an upgraded socket is detached from http's own tracking: close it by hand or srv.close() never settles
  const srv = http.createServer((req, res) => { seen.push(`${req.method} ${req.url} host=${req.headers.host}`); res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' }); res.end('ok'); });
  srv.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });
  srv.on('upgrade', (req, sock, head) => {
    seen.push(`UPGRADE ${req.url}`);
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) sock.write(Buffer.from(`echo:${head.toString()}`)); // bytes that arrived with the head
    sock.on('data', (d: Buffer) => sock.write(Buffer.from(`echo:${d.toString()}`)));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as { port: number }).port, seen, close: () => { for (const s of socks) s.destroy(); srv.closeAllConnections(); return new Promise((r) => srv.close(() => r())); } };
}

/** Raw client: write bytes, collect what comes back for a moment. */
function raw(port: number, payload: string | Buffer, ms = 150): Promise<{ out: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '', closed = false;
    s.on('data', (d: Buffer) => { out += d.toString('latin1'); });
    s.on('close', () => { closed = true; });
    s.on('error', () => {});
    s.on('connect', () => s.write(payload));
    setTimeout(() => { resolve({ out, closed }); s.destroy(); }, ms);
  });
}

test('sink proxy: CONNECT and absolute-form GET reach ONLY the popup server; keep-alive rewrites every head; the WebSocket upgrade becomes a tunnel', async () => {
  const target = await stub();
  const refusals: SinkProxyRefusal[] = [];
  const proxy = await createSinkProxy({ targetPort: target.port, onRefused: (r) => refusals.push(r) });
  try {
    assert.equal(proxy.address, `127.0.0.1:${proxy.port}`);
    // absolute-form, two requests on one connection: both rewritten to origin-form, proxy-connection dropped
    const r1 = await raw(proxy.port, `GET http://127.0.0.1:${target.port}/popup/widget?p=abc HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nProxy-Connection: keep-alive\r\n\r\nGET http://127.0.0.1:${target.port}/vendor/x.js HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`, 250);
    assert.equal((r1.out.match(/HTTP\/1\.1 200 OK/g) ?? []).length, 2, r1.out);
    assert.deepEqual(target.seen, [`GET /popup/widget?p=abc host=127.0.0.1:${target.port}`, `GET /vendor/x.js host=127.0.0.1:${target.port}`], 'origin-form, both requests, nothing else');
    // CONNECT to the server's authority: a tunnel; an HTTP request through it reaches the server
    const r2 = await raw(proxy.port, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\nGET /popup/chart?p=1 HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`, 250);
    assert.match(r2.out, /^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK/);
    assert.equal(target.seen.at(-1), `GET /popup/chart?p=1 host=127.0.0.1:${target.port}`);
    // the WebSocket upgrade in absolute form: the head is rewritten, then the bytes flow both ways untouched
    const r3 = await raw(proxy.port, `GET http://127.0.0.1:${target.port}/ws?t=tok HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\nFRAME1`, 250);
    assert.match(r3.out, /^HTTP\/1\.1 101 Switching Protocols[\s\S]*echo:FRAME1$/);
    assert.equal(target.seen.at(-1), 'UPGRADE /ws?t=tok');
    assert.equal(refusals.length, 0);
    assert.equal(proxy.forwarded, 3);
  } finally { await proxy.close(); await target.close(); }
});

test('sink proxy: every other authority is refused (403, closed, counted, reported) — the preconnect target, another port on loopback, a name, a body, origin-form, junk', async () => {
  const target = await stub();
  const refusals: SinkProxyRefusal[] = [];
  const proxy = await createSinkProxy({ targetPort: target.port, onRefused: (r) => refusals.push(r) });
  // a raw TCP sink standing in for the page-chosen host:port of the r3 finding: it must never see a connection
  let sinkConns = 0;
  const sink = net.createServer(() => { sinkConns++; });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  const sinkPort = (sink.address() as { port: number }).port;
  try {
    const cases: Array<[string, RegExp]> = [
      [`CONNECT 127.0.0.1:${sinkPort} HTTP/1.1\r\nHost: 127.0.0.1:${sinkPort}\r\n\r\n`, new RegExp(`^127\\.0\\.0\\.1:${sinkPort}$`)],
      [`CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n`, /^evil\.example:443$/],
      [`CONNECT localhost:${target.port} HTTP/1.1\r\n\r\n`, /^localhost:/],
      [`GET http://127.0.0.1:${sinkPort}/ HTTP/1.1\r\nHost: x\r\n\r\n`, new RegExp(`^http://127\\.0\\.0\\.1:${sinkPort}/$`)],
      [`GET http://evil.example/collect?q=1 HTTP/1.1\r\nHost: evil.example\r\n\r\n`, /^http:\/\/evil\.example\/collect\?q=1$/],
      [`GET http://127.0.0.1:${target.port}@evil.example/ HTTP/1.1\r\n\r\n`, /@evil\.example/],
      [`GET http://127.0.0.1:${target.port}1/ HTTP/1.1\r\n\r\n`, new RegExp(`:${target.port}1/`)],
      [`GET https://127.0.0.1:${target.port}/ HTTP/1.1\r\n\r\n`, /^https:/],
      [`POST http://127.0.0.1:${target.port}/popup/chart HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc`, /\(body\)$/],
      [`GET /popup/chart?p=1 HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`, /^\/popup\/chart/],
      ['\x16\x03\x01junk\r\n\r\n', /junk/],
    ];
    for (const [payload, re] of cases) {
      const r = await raw(proxy.port, payload);
      assert.match(r.out, /^HTTP\/1\.1 403 Forbidden\r\n/, `refused: ${JSON.stringify(payload.slice(0, 40))} → ${r.out.slice(0, 40)}`);
      assert.ok(r.closed, 'closed after the refusal');
      const last = refusals.at(-1);
      assert.ok(last && re.test(last.target), `reported target ${JSON.stringify(last?.target)} should match ${re}`);
    }
    assert.equal(refusals.length, cases.length);
    assert.equal(proxy.refused, cases.length);
    assert.equal(sinkConns, 0, 'the page-chosen host:port never saw a connection');
    assert.deepEqual(target.seen, [], 'the popup server saw none of it');
    // a non-loopback caller is dropped without a reply (the proxy is for the shell on this machine only) — covered by
    // the loopback remote check; every remote here IS loopback, so a head that never completes just times out
    assert.equal(proxy.forwarded, 0);
  } finally { await proxy.close(); sink.close(); await target.close(); }
});
