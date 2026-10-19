// task-1310 T1 — the loopback wallet bridge + a FAKE-PHANTOM end-to-end (no funds, no network, no real
// wallet). A scripted node "wallet" acts exactly where Phantom would: it reads the page the bridge
// served, produces a REAL Ed25519 signature over the trenchscope challenge (link) and echoes a signed-tx
// blob (sign), and POSTs the result back. Proves: the full link + sign round trip, the Ed25519 proof
// verifying, single-use token, Host/loopback gate, timeout, and replay refusal.
// task-1424: a real loopback server raced against real timers, so the file runs in the serial lane. The
// bridge lifetimes the requests must fit inside (was 300-400 ms) are 1.5 s: a loaded machine could spend
// 300 ms on four loopback POSTs and close the server mid-test. Every asserted outcome is unchanged.
import assert from 'node:assert/strict';
import { serialLane } from '../../../cli/test/serial/lane.ts';
import http from 'node:http';
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { WalletBridge } from '../../src/trade/bridge.ts';
import { base58 } from '../../src/sources/solana-rpc.ts';

const laneTest = serialLane(import.meta.url);

/** A throwaway Ed25519 keypair standing in for a wallet; `pub` is the raw 32-byte public key. */
function keypair(): { pub: Buffer; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pub: Buffer.from(der.subarray(der.length - 32)), priv: privateKey };
}
function b64(b: Buffer): string { return b.toString('base64'); }
const originHeaders = (url: string) => ({ 'content-type': 'application/json', origin: new URL(url).origin });

function extractPre(html: string, id: string): string {
  const m = html.match(new RegExp(`<pre id="${id}">([\\s\\S]*?)</pre>`));
  return m ? m[1] : '';
}
function extractTx(html: string): string {
  const m = html.match(/const TX=("([^"]*)")/);
  return m ? JSON.parse(m[1]) as string : '';
}

/** Capture the URL the bridge opens, without actually acting on it — lets a test drive the server. */
function urlCapture(): { open: (url: string) => void; url: Promise<string> } {
  let resolve!: (u: string) => void;
  const url = new Promise<string>((r) => { resolve = r; });
  return { open: (u) => resolve(u), url };
}

/** The fake Phantom wallet for LINK: read the page, sign the challenge, POST the proof. */
async function fakePhantomLink(url: string, kp: { pub: Buffer; priv: KeyObject }, opts: { tamper?: boolean } = {}): Promise<Response> {
  const page = await (await fetch(url)).text();
  const challenge = extractPre(page, 'c');
  let sig = edSign(null, Buffer.from(challenge, 'utf8'), kp.priv);
  if (opts.tamper) { sig = Buffer.from(sig); sig[0] ^= 0xff; } // corrupt the signature
  const t = new URL(url).searchParams.get('t');
  return fetch(`${new URL(url).origin}/link/result`, {
    method: 'POST', headers: originHeaders(url),
    body: JSON.stringify({ t, publicKey: b64(kp.pub), signature: b64(sig), challenge, provider: 'stub' }),
  });
}

laneTest('e2e LINK: fake Phantom connect + signMessage proof verifies, trenchscope learns only the pubkey', {}, async () => {
  const kp = keypair();
  const bridge = new WalletBridge({ timeoutMs: 4000, open: (url) => { void fakePhantomLink(url, kp); } });
  const res = await bridge.link();
  assert.equal(res.publicKey, base58(kp.pub), 'resolved the wallet base58 address from a verified Ed25519 proof');
  assert.equal(res.publicKeyBase64, b64(kp.pub));
  assert.equal(res.provider, 'stub');
  assert.ok(res.roundTripMs >= 0);
});

laneTest('e2e SIGN: fake Phantom returns a signed tx over the loopback round trip', {}, async () => {
  const unsigned = Buffer.from('an unsigned versioned transaction').toString('base64');
  let seenTx = '';
  const bridge = new WalletBridge({ timeoutMs: 4000, open: async (url) => {
    const page = await (await fetch(url)).text();
    seenTx = extractTx(page);
    const t = new URL(url).searchParams.get('t');
    // A real wallet signs; the fake echoes a 64-byte "signature" + the tx bytes as the "signed" tx.
    const signed = Buffer.concat([Buffer.alloc(64, 7), Buffer.from(seenTx, 'base64')]).toString('base64');
    await fetch(`${new URL(url).origin}/sign/result`, { method: 'POST', headers: originHeaders(url), body: JSON.stringify({ t, signedTx: signed, provider: 'stub' }) });
  } });
  const res = await bridge.signTransaction({ unsignedTxBase64: unsigned, label: 'buy USDC' });
  assert.equal(seenTx, unsigned, 'the page carried the exact unsigned tx to the wallet');
  assert.ok(res.signedTxBase64.length > 0);
  assert.ok(Buffer.from(res.signedTxBase64, 'base64').subarray(64).equals(Buffer.from(unsigned, 'base64')), 'the signed tx wraps the original');
});

laneTest('REJECT: a tampered signature does not verify; the bridge does not resolve', {}, async () => {
  const kp = keypair();
  const cap = urlCapture();
  const bridge = new WalletBridge({ timeoutMs: 1500, open: cap.open });
  const linkP = bridge.link();
  const url = await cap.url;
  const res = await fakePhantomLink(url, kp, { tamper: true });
  const body = await res.json() as { ok: boolean; error: string | null };
  assert.equal(body.ok, false, 'server rejected the bad signature');
  await assert.rejects(linkP, /timed out/, 'with no valid proof the bridge times out rather than linking');
});

laneTest('REJECT: a bad token on the page (GET) is a 404; the real token serves once (single-use)', {}, async () => {
  const kp = keypair();
  const cap = urlCapture();
  const bridge = new WalletBridge({ timeoutMs: 1500, open: cap.open });
  const linkP = bridge.link().catch(() => 'timeout');
  const url = await cap.url;
  const origin = new URL(url).origin;

  const bad = await fetch(`${origin}/link?t=not-the-token`);
  assert.equal(bad.status, 404, 'a wrong page token is a 404');
  const good1 = await fetch(url);
  assert.equal(good1.status, 200, 'the real token serves the page');
  const good2 = await fetch(url);
  assert.equal(good2.status, 404, 'the page token is single-use');
  void kp; await linkP;
});

laneTest('REJECT: wrong Host header is a 404 (loopback/Host gate)', {}, async () => {
  const cap = urlCapture();
  const bridge = new WalletBridge({ timeoutMs: 1500, open: cap.open });
  const linkP = bridge.link().catch(() => 'timeout');
  const url = await cap.url;
  const { port } = new URL(url);
  const status = await new Promise<number>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: '/link', method: 'GET', headers: { host: 'evil.example.com' } }, (res) => { resolve(res.statusCode ?? 0); res.resume(); });
    req.on('error', () => resolve(-1));
    req.end();
  });
  assert.equal(status, 404, 'a spoofed Host is refused');
  await linkP;
});

laneTest('REPLAY refused: the result token is single-use even after a failed first POST', {}, async () => {
  const kp = keypair();
  const cap = urlCapture();
  const bridge = new WalletBridge({ timeoutMs: 1500, open: cap.open });
  const linkP = bridge.link().catch(() => 'timeout');
  const url = await cap.url;
  const origin = new URL(url).origin;
  await fetch(url); // serve the page (burns the GET token)
  const t = new URL(url).searchParams.get('t');
  const challenge = extractPre(await (await fetch(url).catch(() => ({ text: async () => '' } as Response))).text().catch(() => ''), 'c');
  void challenge;

  // First POST: a bad signature → accepted-but-rejected (ok:false), and it CONSUMES the token.
  const bad = Buffer.from(edSign(null, Buffer.from('wrong message'), kp.priv));
  const r1 = await fetch(`${origin}/link/result`, { method: 'POST', headers: originHeaders(url), body: JSON.stringify({ t, publicKey: b64(kp.pub), signature: b64(bad), provider: 'stub' }) });
  assert.equal(r1.status, 200);
  assert.equal(((await r1.json()) as { ok: boolean }).ok, false);

  // Second POST with the same token → 403 (replay refused), even with a would-be-valid payload.
  const r2 = await fetch(`${origin}/link/result`, { method: 'POST', headers: originHeaders(url), body: JSON.stringify({ t, publicKey: b64(kp.pub), signature: b64(bad), provider: 'stub' }) });
  assert.equal(r2.status, 403, 'the result token cannot be replayed');
  await linkP;
});

laneTest('REJECT: a non-JSON content-type is a 415 and an oversized (>16 KB) JSON body is dropped; neither resolves the link', {}, async () => {
  const cap = urlCapture();
  const bridge = new WalletBridge({ timeoutMs: 1500, open: cap.open });
  const linkP = bridge.link().catch(() => 'timeout');
  const url = await cap.url;
  const origin = new URL(url).origin;
  const notJson = await fetch(`${origin}/link/result`, { method: 'POST', headers: { 'content-type': 'text/plain', origin }, body: 'nope' });
  assert.equal(notJson.status, 415, 'non-JSON content-type refused');
  // Oversized: the server destroys the socket at the 16 KB cap (a reset) or answers 400; it never resolves.
  const big = JSON.stringify({ t: 'x'.repeat(20 * 1024) });
  const res = await fetch(`${origin}/link/result`, { method: 'POST', headers: originHeaders(url), body: big }).then((r) => r.status, () => 'reset');
  assert.ok(res === 'reset' || res === 400, `oversized body is refused (${res})`);
  assert.equal(await linkP, 'timeout', 'the link was not resolved');
});

laneTest('DEFECT 7: a JSON body of `null` (or a non-object) is a clean 400, never a crash', {}, async () => {
  const cap = urlCapture();
  const bridge = new WalletBridge({ timeoutMs: 1500, open: cap.open });
  const linkP = bridge.link().catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const url = await cap.url;
  const origin = new URL(url).origin;
  // `JSON.parse('null')` succeeds and returns null; reading `.t` off it used to crash the handler.
  for (const body of ['null', '123', '"x"', '[]']) {
    const res = await fetch(`${origin}/link/result`, { method: 'POST', headers: originHeaders(url), body });
    assert.equal(res.status, 400, `a non-object JSON body (${body}) is a clean 400`);
  }
  // The server is still alive and simply times out — no unhandled crash resolved the link.
  const out = await linkP;
  assert.match(String(out), /timed out/);
});

laneTest('timeout: with no wallet response the bridge rejects within the bound and frees the port', {}, async () => {
  const bridge = new WalletBridge({ timeoutMs: 120, open: () => { /* no wallet ever responds */ } });
  const t0 = Date.now();
  await assert.rejects(() => bridge.link(), /timed out/);
  assert.ok(Date.now() - t0 < 2000, 'rejected promptly at the bound');
});

// ----------------------------------------------------------------- task-1310 round 2 (MEDIUM #3)

/** Deterministic PRNG so a failing fuzz case is reproducible from the printed seed. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000; };
}
function randomJson(r: () => number, depth = 0): unknown {
  const pick = r();
  if (depth > 3 || pick < 0.1) return null;
  if (pick < 0.2) return Math.floor(r() * 1e6) - 5e5;
  if (pick < 0.3) return r() < 0.5 ? 'x'.repeat(Math.floor(r() * 64)) : ['', 'toString', '__proto__', 'constructor', 'valueOf', '\u0000'][Math.floor(r() * 6)];
  if (pick < 0.4) return r() < 0.5;
  if (pick < 0.55) return Array.from({ length: Math.floor(r() * 4) }, () => randomJson(r, depth + 1));
  const o: Record<string, unknown> = {};
  const keys = ['t', 'publicKey', 'signature', 'signedTx', 'provider', 'challenge', 'toString', 'valueOf', '__proto__', 'constructor', 'length', ''];
  for (let i = 0; i < Math.floor(r() * 5); i++) o[keys[Math.floor(r() * keys.length)]] = randomJson(r, depth + 1);
  if (r() < 0.6) o.t = r() < 0.5 ? { toString: 1 } : r() < 0.5 ? 12345 : [{ valueOf: null }];
  return o;
}

laneTest('DEFECT 7 / R2 MED#3: `{"t":{"toString":1}}` and 200 fuzzed JSON bodies never crash the bridge; each is a 400/403; the exchange stays unresolved', {}, async () => {
  // task-1376: 203 sequential POSTs (each on a new connection: `Connection: close`) raced a 1.5 s bridge timeout on a
  // loaded machine, so the server closed mid-fuzz and a POST saw -1. The bridge now lives far longer than the fuzz
  // can take, and the test ends each exchange itself with the GENUINE wallet result instead of waiting for the timer.
  for (const route of ['link', 'sign'] as const) {
    const cap = urlCapture();
    const bridge = new WalletBridge({ timeoutMs: 60_000, open: cap.open });
    const p = (route === 'link' ? bridge.link() : bridge.signTransaction({ unsignedTxBase64: 'AQID' })).then(() => 'resolved', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    const url = await cap.url;
    const origin = new URL(url).origin;
    const post = (body: string) => fetch(`${origin}/${route}/result`, { method: 'POST', headers: originHeaders(url), body }).then((r) => r.status, () => -1);
    // The exact body that killed the real CLI at 9363f12 (String({toString:1}) throws before the token check).
    assert.equal(await post('{"t":{"toString":1}}'), 403, `${route}: a non-string token is a clean 403`);
    assert.equal(await post('{"__proto__":{"t":"x"}}'), 403);
    assert.equal(await post('{"t":[{"valueOf":null}]}'), 403);
    const seed = Date.now() % 100_000;
    const r = rng(seed);
    for (let i = 0; i < 200; i++) {
      const body = r() < 0.9 ? JSON.stringify(randomJson(r)) : ['{', '[', '{"t":', 'nul', '"', '\u0000', '{"t":"' + 'a'.repeat(5000) + '"}'][i % 7];
      const status = await post(body);
      assert.ok(status === 400 || status === 403, `${route} seed=${seed} body ${body.slice(0, 80)} → ${status} (server must answer, never crash)`);
    }
    const alive = await fetch(`${origin}/${route}?t=nope`).then((x) => x.status, () => -1);
    assert.equal(alive, 404, `${route}: the server is still serving after the fuzz`);
    const pending = Symbol('pending');
    assert.equal(await Promise.race([p, new Promise((r) => setTimeout(() => r(pending), 50))]), pending, `${route}: nothing fuzzed resolved the exchange`);
    // Close the bridge explicitly: the real wallet answer still resolves it (the fuzz neither resolved nor burnt it).
    if (route === 'link') await fakePhantomLink(url, keypair());
    else {
      const t = new URL(url).searchParams.get('t');
      const signed = Buffer.concat([Buffer.alloc(64, 7), Buffer.from('AQID', 'base64')]).toString('base64');
      await fetch(`${origin}/sign/result`, { method: 'POST', headers: originHeaders(url), body: JSON.stringify({ t, signedTx: signed, provider: 'stub' }) });
    }
    assert.equal(await p, 'resolved', `${route}: the genuine result after the fuzz resolves and closes the bridge`);
  }
});
