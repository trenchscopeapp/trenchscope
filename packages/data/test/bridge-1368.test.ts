// task-1368 (g) — A tester reached the Phantom sign page and got 4100 ("not authorized"): the page called
// signTransaction() without connect() on a random-port origin Phantom had never trusted. Fix under test:
//   * the bridge listens on a FIXED preferred loopback port (WALLET_BRIDGE_PORT) so link and sign share
//     the origin Phantom stores its trust for; a busy port falls back to a random one, never an error;
//   * the sign page connects first, shows the connected account, refuses an account that is not the
//     linked wallet, and explains 4100 / 4001 in plain English;
//   * the server re-checks the posted account against `expectPublicKey` (belt and braces).
// No real wallet, no network: a scripted node "wallet" drives the loopback round trip as in trade-bridge.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import vm from 'node:vm';
import { WalletBridge, WALLET_BRIDGE_PORT } from '../src/trade/bridge.ts';

const originHeaders = (url: string) => ({ 'content-type': 'application/json', origin: new URL(url).origin });

function urlCapture(): { open: (url: string) => void; url: Promise<string> } {
  let resolve!: (u: string) => void;
  const url = new Promise<string>((r) => { resolve = r; });
  return { open: (u) => resolve(u), url };
}

/** A loopback port that is free right now (bind 0, read, close). */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}
/** Hold a loopback port so the bridge's preferred one is busy. */
async function hold(port: number): Promise<() => Promise<void>> {
  const s = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', r));
  return () => new Promise<void>((r) => s.close(() => r()));
}

const swallow = (p: Promise<unknown>) => p.catch(() => undefined);

test('the default bridge asks for WALLET_BRIDGE_PORT (a fixed origin for Phantom), and the port is a sane constant', () => {
  const b = new WalletBridge({ open: () => { /* never opened */ } });
  assert.equal(b.preferredPort, WALLET_BRIDGE_PORT);
  assert.ok(WALLET_BRIDGE_PORT > 1024 && WALLET_BRIDGE_PORT < 65536);
  assert.notEqual(WALLET_BRIDGE_PORT, 41287, 'not the X login callback port');
  // garbage port options fall back to the constant; 0 is honoured as "random".
  assert.equal(new WalletBridge({ port: -1 }).preferredPort, WALLET_BRIDGE_PORT);
  assert.equal(new WalletBridge({ port: 70000 }).preferredPort, WALLET_BRIDGE_PORT);
  assert.equal(new WalletBridge({ port: 1.5 }).preferredPort, WALLET_BRIDGE_PORT);
  assert.equal(new WalletBridge({ port: 0 }).preferredPort, 0);
});

test('link and sign are served from the SAME preferred port (the origin Phantom remembers), and the Host gate uses it', async () => {
  const port = await freePort();
  const cap1 = urlCapture();
  const b = new WalletBridge({ timeoutMs: 400, port, open: cap1.open });
  const p1 = swallow(b.link());
  const u1 = new URL(await cap1.url);
  assert.equal(u1.port, String(port));
  assert.equal(u1.hostname, '127.0.0.1');
  const page = await fetch(u1);
  assert.equal(page.status, 200, 'the page serves on the preferred port');
  assert.match(await page.text(), new RegExp(`URI: http://127\\.0\\.0\\.1:${port}`), 'the link challenge names the fixed origin');
  await p1; // times out; frees the port

  // the signer process builds its own WalletBridge: a second instance must land on the same origin
  const cap2 = urlCapture();
  const b2 = new WalletBridge({ timeoutMs: 400, port, open: cap2.open });
  const p2 = swallow(b2.signTransaction({ unsignedTxBase64: 'AQID', label: 'probe' }));
  const u2 = new URL(await cap2.url);
  assert.equal(u2.port, String(port), 'sign reuses the preferred port after link released it (keep-alive from the page fetch notwithstanding)');
  const wrongHost = await new Promise<number>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: u2.pathname + u2.search, method: 'GET', headers: { host: `localhost:${port}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', () => resolve(0)); req.end();
  });
  assert.equal(wrongHost, 404, 'the Host check is bound to the fixed port exactly as it was to the random one');
  await p2;
});

test('a busy preferred port is not an error: the bridge falls back to a random port and still serves the page', async () => {
  const port = await freePort();
  const release = await hold(port);
  try {
    const cap = urlCapture();
    let opens = 0;
    const b = new WalletBridge({ timeoutMs: 400, port, open: (u) => { opens++; cap.open(u); } });
    const p = swallow(b.signTransaction({ unsignedTxBase64: 'AQID' }));
    const u = new URL(await cap.url);
    assert.notEqual(u.port, String(port), 'fell back off the busy port');
    assert.notEqual(u.port, '0');
    const r = await fetch(u);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, new RegExp(`PORT=${u.port}[,;]`), 'the page talks back to the port it was actually served from');
    assert.match(html, new RegExp(`<p class="warn">the usual trenchscope port 127\\.0\\.0\\.1:${port} was busy, so this page is on a one-off port \\(${u.port}\\)\\. Phantom may ask you to connect once`), 'the page SAYS it fell back (task-1368 (g) spec)');
    await p;
    assert.equal(opens, 1, 'the page is opened exactly once after a fallback (a second open would burn the single-use token)');
  } finally { await release(); }
});

test('keep-alive regression: a pooled connection to the PREVIOUS bridge on the same origin can never answer the next page (every connection is closed when an exchange ends)', async () => {
  // Found while landing the fixed port: node's fetch (like a browser) pools keep-alive connections per
  // origin; before the fix the next bridge's page request rode the old socket to the OLD server, which
  // did not know the new token and answered 404.
  const port = await freePort();
  const expect = 'DexTerm1111111111111111111111111111111111111';
  for (let round = 0; round < 3; round++) {
    const cap = urlCapture();
    const b = new WalletBridge({ timeoutMs: 2000, port, open: cap.open });
    const p = b.signTransaction({ unsignedTxBase64: 'AQID', expectPublicKey: expect });
    const url = await cap.url;
    assert.equal(new URL(url).port, String(port), `round ${round}: still on the preferred port`);
    const page = await fetch(url); // the global fetch: the SAME pool every round
    assert.equal(page.status, 200, `round ${round}: the page comes from THIS bridge, not a stale socket to the last one`);
    assert.equal(page.headers.get('connection'), 'close', 'the page response forbids keep-alive (no client may pool a socket to a one-shot server)');
    assert.ok((await page.text()).includes(`PORT=${port},`), 'and it is the sign page of this exchange');
    const nf = await fetch(`${new URL(url).origin}/nope`);
    assert.equal(nf.status, 404); assert.equal(nf.headers.get('connection'), 'close', 'even a 404 closes');
    const t = new URL(url).searchParams.get('t');
    const r = await fetch(`${new URL(url).origin}/sign/result`, { method: 'POST', headers: originHeaders(url), body: JSON.stringify({ t, signedTx: 'AQIDBA==', provider: 'stub', publicKey: expect }) });
    assert.equal(r.headers.get('connection'), 'close', 'the result response closes too');
    assert.equal(((await r.json()) as { ok: boolean }).ok, true, 'the page still reads its ✓ response before the socket goes');
    assert.equal((await p).signedTxBase64, 'AQIDBA==');
  }
});

test('port 0 keeps the pre-1368 behaviour: a random port each time', async () => {
  const cap = urlCapture();
  const b = new WalletBridge({ timeoutMs: 200, port: 0, open: cap.open });
  const p = swallow(b.link());
  const u = new URL(await cap.url);
  assert.notEqual(u.port, String(WALLET_BRIDGE_PORT));
  assert.ok(Number(u.port) > 0);
  await p;
});

test('the sign page CONNECTS before it signs, pins the linked wallet, posts the connected account, and explains 4100 / 4001', async () => {
  const cap = urlCapture();
  const b = new WalletBridge({ timeoutMs: 400, port: 0, open: cap.open });
  const expect = 'DexTerm1111111111111111111111111111111111111';
  const p = swallow(b.signTransaction({ unsignedTxBase64: 'AQID', expectPublicKey: expect, label: 'buy X' }));
  const url = await cap.url;
  const html = await (await fetch(url)).text();
  const iConnect = html.indexOf('await prov.connect()');
  const iSign = html.indexOf('await prov.signTransaction(');
  assert.ok(iConnect > 0 && iSign > iConnect, 'connect() runs before signTransaction()');
  assert.ok(html.includes(`EXPECT=${JSON.stringify(expect)}`), 'the page knows the linked wallet');
  assert.match(html, /account!==EXPECT\)throw new Error\('Phantom is on account /, 'a different account is refused on the page with a plain message');
  assert.match(html, /publicKey:account\}/, 'the connected account rides along with the signed tx');
  assert.match(html, /code===4100\)return 'Phantom has not authorized this page \(4100\)/, '4100 is explained');
  assert.match(html, /Trusted apps, allow 127\.0\.0\.1:'\+PORT/, 'the 4100 text names the exact origin to trust');
  assert.match(html, /code===4001\)return 'you rejected the request in Phantom/, '4001 is explained');
  assert.match(html, /connected: <code id="a">/, 'the connected account is shown');
  assert.doesNotMatch(html, new RegExp(new URL(url).searchParams.get('t') ?? '$^'), 'the single-use token is never inlined in the page');
  await p;
});

test('server gate: a result signed by a DIFFERENT account than the linked wallet is refused and burns the exchange', async () => {
  const cap = urlCapture();
  const b = new WalletBridge({ timeoutMs: 400, port: 0, open: cap.open });
  const expect = 'DexTerm1111111111111111111111111111111111111';
  const outcome = b.signTransaction({ unsignedTxBase64: 'AQID', expectPublicKey: expect }).then(() => 'resolved', (e: Error) => e.message);
  const url = await cap.url;
  await fetch(url);
  const t = new URL(url).searchParams.get('t');
  const r = await fetch(`${new URL(url).origin}/sign/result`, { method: 'POST', headers: originHeaders(url), body: JSON.stringify({ t, signedTx: 'AQIDBA==', provider: 'stub', publicKey: 'Other11111111111111111111111111111111111111' }) });
  const j = await r.json() as { ok: boolean; error: string | null };
  assert.equal(j.ok, false);
  assert.match(j.error ?? '', /different wallet account/);
  assert.match(await outcome, /timed out/, 'nothing resolved; the user re-confirms in dexterm');
});

test('server gate: the matching account resolves; an older page that posts no account still resolves (compat)', async () => {
  const expect = 'DexTerm1111111111111111111111111111111111111';
  for (const publicKey of [expect, undefined]) {
    const cap = urlCapture();
    const b = new WalletBridge({ timeoutMs: 1500, port: 0, open: cap.open });
    const p = b.signTransaction({ unsignedTxBase64: 'AQID', expectPublicKey: expect });
    const url = await cap.url;
    await fetch(url);
    const t = new URL(url).searchParams.get('t');
    const body: Record<string, unknown> = { t, signedTx: 'AQIDBA==', provider: 'stub' };
    if (publicKey) body.publicKey = publicKey;
    const r = await fetch(`${new URL(url).origin}/sign/result`, { method: 'POST', headers: originHeaders(url), body: JSON.stringify(body) });
    assert.equal(((await r.json()) as { ok: boolean }).ok, true);
    const res = await p;
    assert.equal(res.signedTxBase64, 'AQIDBA==');
    assert.equal(res.provider, 'stub');
  }
});

// ---------------------------------------------------------------------------------------------------
// The page's own script, DRIVEN: a fake Phantom that throws {code:4100} from signTransaction() unless
// connect() ran first — the exact behaviour that produced the reported 17:34 ET error. The inline script is
// executed in a `vm` context with a minimal DOM, the real bridge on loopback answers the fetches.
// ---------------------------------------------------------------------------------------------------
type FakeEl = { textContent: string; className: string; disabled: boolean; handlers: Record<string, () => Promise<void>>; addEventListener: (ev: string, fn: () => Promise<void>) => void };
function fakeDom(): { byId: Record<string, FakeEl>; document: { getElementById: (id: string) => FakeEl } } {
  const byId: Record<string, FakeEl> = {};
  const el = (id: string): FakeEl => (byId[id] ??= { textContent: '', className: '', disabled: true, handlers: {}, addEventListener(ev, fn) { this.handlers[ev] = fn; } });
  return { byId, document: { getElementById: el } };
}
type FakeProvider = { isPhantom: true; publicKey: { toBase58: () => string } | null; calls: string[]; connect: () => Promise<{ publicKey: { toBase58: () => string } }>; signTransaction: (vt: unknown) => Promise<{ serialize: () => Uint8Array }> };
/** Phantom as it behaves per ORIGIN: signTransaction() is 4100 until connect() has run on this page. `trusts=false` models a user who dismisses the Connect prompt. */
function fakePhantom(account: string, trusts = true): FakeProvider {
  let connected = false;
  const pk = { toBase58: () => account };
  const prov: FakeProvider = {
    isPhantom: true, publicKey: null, calls: [],
    async connect() { prov.calls.push('connect'); if (trusts) { connected = true; prov.publicKey = pk; } return { publicKey: pk }; },
    async signTransaction() {
      prov.calls.push('sign');
      if (!connected) { const e = new Error('The requested method and/or account has not been authorized by the user.') as Error & { code: number }; e.code = 4100; throw e; }
      return { serialize: () => new Uint8Array([9, 9, 9]) };
    },
  };
  return prov;
}
/** Serve the sign page, run its inline script against `prov`, click Approve, and return the fake DOM. */
async function driveSignPage(b: WalletBridge, cap: { url: Promise<string> }, prov: FakeProvider): Promise<{ byId: Record<string, FakeEl>; url: string }> {
  const url = await cap.url;
  const html = await (await fetch(url)).text();
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const script = scripts[scripts.length - 1];           // the page's IIFE (the web3 bundle, when present, comes first)
  assert.ok(script && script.startsWith('(()=>{'), 'found the page script');
  const dom = fakeDom();
  const origin = new URL(url).origin;
  const ctx: Record<string, unknown> = {
    document: dom.document, location: { search: new URL(url).search }, setTimeout, atob, btoa, console, URLSearchParams,
    // a browser sends Origin on a same-origin POST by itself; node's fetch does not
    fetch: (u: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(u, { ...init, headers: { ...(init.headers ?? {}), origin } }),
    solana: prov, dexSolana: { VersionedTransaction: { deserialize: (u: Uint8Array) => ({ bytes: u }) } },
  };
  vm.createContext(ctx);
  ctx.window = ctx;
  vm.runInContext(script, ctx, { filename: 'sign-page.js' });
  assert.equal(dom.byId.go.disabled, false, 'the wallet was found and Approve is enabled');
  assert.equal(dom.byId.p.textContent, 'wallet: phantom');
  await dom.byId.go.handlers.click();                   // = pressing Approve
  return { byId: dom.byId, url };
}

test('fake Phantom (4100 unless connect() first): the page connects, then signs, and the bridge resolves with the signed tx', async () => {
  const expect = 'DexTerm1111111111111111111111111111111111111';
  const prov = fakePhantom(expect);
  // the fake is faithful to the bug: signing without connect() IS the 4100 the tester saw
  await assert.rejects(prov.signTransaction({}), (e: Error & { code: number }) => e.code === 4100 && /not been authorized/.test(e.message));
  prov.calls.length = 0;
  const cap = urlCapture();
  const b = new WalletBridge({ timeoutMs: 1500, port: 0, open: cap.open });
  const p = b.signTransaction({ unsignedTxBase64: 'AQID', expectPublicKey: expect, label: 'buy X' });
  const { byId } = await driveSignPage(b, cap, prov);
  const res = await p;
  assert.deepEqual(prov.calls, ['connect', 'sign'], 'connect() ran, and ran BEFORE signTransaction()');
  assert.equal(res.signedTxBase64, Buffer.from([9, 9, 9]).toString('base64'));
  assert.equal(res.provider, 'phantom');
  assert.equal(byId.a.textContent, expect, 'the connected account is shown');
  assert.equal(byId.r.textContent, '✓ signed. Return to dexterm.');
  assert.equal(byId.r.className, 'ok');
});

test('fake Phantom on the WRONG account: the page refuses before signing, says which accounts differ, and keeps Approve usable', async () => {
  const expect = 'DexTerm1111111111111111111111111111111111111';
  const other = 'Other11111111111111111111111111111111111111';
  const prov = fakePhantom(other);
  const cap = urlCapture();
  const b = new WalletBridge({ timeoutMs: 400, port: 0, open: cap.open });
  const outcome = b.signTransaction({ unsignedTxBase64: 'AQID', expectPublicKey: expect }).then(() => 'resolved', (e: Error) => e.message);
  const { byId } = await driveSignPage(b, cap, prov);
  assert.deepEqual(prov.calls, ['connect'], 'signTransaction() was never called');
  assert.equal(byId.a.textContent, other);
  assert.equal(byId.r.className, 'bad');
  assert.match(byId.r.textContent, /^✗ Phantom is on account Othe…1111 but trenchscope linked DexT…1111\. Switch accounts in Phantom and press Approve again/);
  assert.equal(byId.go.disabled, false, 'Approve stays usable for a retry after switching accounts');
  assert.match(await outcome, /timed out/, 'nothing was signed or resolved');
});

test('fake Phantom that stays untrusted (Connect prompt dismissed): 4100 is explained in plain English and Approve stays usable', async () => {
  const expect = 'DexTerm1111111111111111111111111111111111111';
  const prov = fakePhantom(expect, false);
  const cap = urlCapture();
  const b = new WalletBridge({ timeoutMs: 400, port: 0, open: cap.open });
  const outcome = b.signTransaction({ unsignedTxBase64: 'AQID', expectPublicKey: expect }).then(() => 'resolved', (e: Error) => e.message);
  const { byId, url } = await driveSignPage(b, cap, prov);
  assert.deepEqual(prov.calls, ['connect', 'sign'], 'the page did connect first; Phantom still refused');
  assert.equal(byId.r.className, 'bad');
  assert.match(byId.r.textContent, /^✗ Phantom has not authorized this page \(4100\)\. Press Approve again and accept the Connect prompt/);
  assert.ok(byId.r.textContent.includes(`allow 127.0.0.1:${new URL(url).port}`), 'names the exact origin to trust');
  assert.doesNotMatch(byId.r.textContent, /has not been authorized by the user/, 'the raw Phantom text is replaced, not echoed');
  assert.equal(byId.go.disabled, false, 'Approve stays usable: press it again after connecting');
  assert.equal(byId.s.textContent, '');
  assert.match(await outcome, /timed out/);
});
