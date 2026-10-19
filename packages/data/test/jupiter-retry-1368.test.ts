// task-1368 — Jupiter 429 / 5xx handling on the trade path. a LIVE ticket died on
// `build-failed: HTTP 429 for https://api.jup.ag/swap/v1/swap`. These tests replay the RECORDED shape of a
// keyless Jupiter rate limit (fixtures/trade/jupiter-429-2026-10-12.json: 429, body `[API Gateway] Too many
// requests`, NO Retry-After, x-ratelimit-reset a few seconds out) plus the standards-form Retry-After variant and
// the 503 the alternate host answered the same minute, through the REAL HttpClient + RateLimiter on a fake clock,
// into the real quote and build adapters and the real SignerService. No network; nothing is signed or sent.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient, HttpError } from '../src/http.ts';
import type { HttpRequest, HttpResponse, Transport } from '../src/http.ts';
import { RateLimiter } from '../src/limiter.ts';
import { JupiterSwap, JupiterHosts, JupiterRateLimitedError, isTransientJupiterError, JUP_RETRY_MAX_TOTAL_MS } from '../src/sources/jupiter-swap.ts';
import { JupiterSwapBuild, QUOTE_REUSE_MS } from '../src/trade/swap-build.ts';
import { SOL_MINT } from '../src/paper.ts';
import { SignerService, SignerError } from '../src/trade/signer/service.ts';
import { serveSigner } from '../src/trade/signer/host.ts';
import { decodeFrame, encodeFrame, encodeHello, newSecret, isResponse, type SignerMessage } from '../src/trade/signer/protocol.ts';
import { LiveExecutor, LiveLedger, type LiveExecutorDeps } from '../src/trade/executor.ts';
import { CapLedger, defaultCaps } from '../src/trade/caps.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { WalletLinkStore } from '../src/trade/link-store.ts';
import { DEVNET_RPC } from '../src/trade/rpc-exec.ts';
import { keypair, buildTx, jupiterSwapIxs, fakeRpc, solUsdSamples, TEST_MINT, type BuiltTx } from './trade-helpers.ts';
import { drive } from './helpers.ts';

interface Recorded429 { responses: { n: number; status: number; headers: Record<string, string>; body?: string; epochNowSeconds?: number }[]; retryAfterVariant: { status: number; headers: Record<string, string>; body: string }; liteApiSameMinute: { status: number; headers: Record<string, string>; body: string } }
const FIX: Recorded429 = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/trade/jupiter-429-2026-10-12.json', import.meta.url)), 'utf8'));
const REC_429 = FIX.responses.find((r) => r.status === 429)!;
/** Fake time = the recorded "now" of the 429, so x-ratelimit-reset is 3 s out exactly as it was. */
const T0 = REC_429.epochNowSeconds! * 1000;
const RESET_MS = Number(REC_429.headers['x-ratelimit-reset']) * 1000 - T0; // 3000

const QUOTE = { inputMint: SOL_MINT, outputMint: TEST_MINT, amount: 10_000_000n, slippageBps: 50, mode: 'ExactIn' as const };
const RAW_QUOTE = { inputMint: SOL_MINT, outputMint: TEST_MINT, inAmount: '10000000', outAmount: '1092439', otherAmountThreshold: '1086977', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '1.09' };

const r429 = (): HttpResponse => ({ status: 429, headers: { ...REC_429.headers }, body: REC_429.body!, latencyMs: 5 });
const r429RetryAfter = (): HttpResponse => ({ status: FIX.retryAfterVariant.status, headers: { ...FIX.retryAfterVariant.headers }, body: FIX.retryAfterVariant.body, latencyMs: 5 });
const r503 = (): HttpResponse => ({ status: 503, headers: { ...FIX.liteApiSameMinute.headers }, body: FIX.liteApiSameMinute.body, latencyMs: 5 });
const r200 = (body: unknown = RAW_QUOTE): HttpResponse => ({ status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '3' }, body: JSON.stringify(body), latencyMs: 5 });
const rStatus = (status: number): HttpResponse => ({ status, headers: {}, body: '{}', latencyMs: 5 });

/** A scripted transport: answers in order, records every request (host + path + fake time). */
function scripted(script: (HttpResponse | Error)[]) {
  const seen: { url: string; method: string; at: number }[] = [];
  const clock = new FakeClock(T0);
  const transport: Transport = async (req: HttpRequest) => {
    seen.push({ url: req.url, method: req.method, at: clock.now() });
    const next = script.shift();
    if (!next) throw new Error(`scripted transport exhausted at ${req.url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  // A generous bucket: pacing here comes only from the 429 handling, never from the rpm budget.
  const limiter = new RateLimiter({ jupiter: { rpm: 6000, safety: 1, burst: 100 } }, clock);
  const health = new HealthRegistry({ clock });
  const http = new HttpClient({ transport, limiter, health, clock, rateLimitPauseMs: 3_000 });
  return { http, clock, limiter, seen, hosts: () => seen.map((s) => new URL(s.url).hostname) };
}

const build = (s: ReturnType<typeof scripted>, random = () => 0) => new JupiterSwapBuild(s.http, undefined, { random });
const fetchFailed = () => new TypeError('fetch failed');

// ------------------------------------------------------------------------------------ the policy

test('isTransientJupiterError: 429 and 5xx retry, a dropped connection and a timeout retry, 4xx and a caller abort do not', () => {
  assert.equal(isTransientJupiterError(new HttpError(429, 'u')), true);
  assert.equal(isTransientJupiterError(new HttpError(503, 'u')), true);
  assert.equal(isTransientJupiterError(new HttpError(500, 'u')), true);
  assert.equal(isTransientJupiterError(new HttpError(400, 'u')), false);
  assert.equal(isTransientJupiterError(new HttpError(401, 'u')), false);
  assert.equal(isTransientJupiterError(fetchFailed()), true);
  assert.equal(isTransientJupiterError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(isTransientJupiterError(Object.assign(new Error('x'), { name: 'AbortError' })), false);
  assert.equal(isTransientJupiterError(new Error('malformed quote')), false);
});

test('recorded 429 on /quote (no Retry-After, x-ratelimit-reset 3 s out): one retry on the OTHER host after the reset; the quote succeeds; the plan is never dropped', async () => {
  const s = scripted([r429(), r200()]);
  const b = build(s);
  const raw = await drive(s.clock, b.quoteRaw(QUOTE), 100);
  assert.equal(raw.outAmount, '1092439');
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag'], 'alternated to lite-api for the retry');
  // The wait honoured the server's reset (3 s), not the 1 s backoff: the retry went out once the bucket's pause ended.
  assert.ok(s.seen[1].at - s.seen[0].at >= RESET_MS, `retry after ${s.seen[1].at - s.seen[0].at} ms (reset ${RESET_MS})`);
  assert.ok(s.seen[1].at - s.seen[0].at < JUP_RETRY_MAX_TOTAL_MS);
  assert.equal(b.host, 'https://lite-api.jup.ag', 'stays on the host that answered');
});

test('429 with Retry-After on the /swap BUILD (POST): retried after Retry-After on the other host; the build succeeds', async () => {
  const s = scripted([r429RetryAfter(), r200({ swapTransaction: 'AQID', lastValidBlockHeight: 7, prioritizationFeeLamports: 10 })]);
  const b = build(s);
  const built = await drive(s.clock, b.buildSwap({ quote: RAW_QUOTE, userPublicKey: keypair().address }), 100);
  assert.equal(built.swapTransactionBase64, 'AQID');
  assert.equal(built.lastValidBlockHeight, 7);
  assert.deepEqual(s.seen.map((x) => x.method), ['POST', 'POST']);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag'], 'api → lite');
  assert.ok(s.seen[1].at - s.seen[0].at >= 2_000, 'the retry waited Retry-After (2 s)');
  assert.ok(s.seen[1].at - s.seen[0].at <= JUP_RETRY_MAX_TOTAL_MS, 'within the total budget');
});

test('bounded: 429 twice in a row → the health gate cools the source down (SPEC §3.3) and the typed error names the host and an honest "retry in Ns" (≈ the cool-down); the third attempt never hits the wire', async () => {
  const s = scripted([r429(), r429(), r200()]);
  const b = build(s);
  const err = await drive(s.clock, b.quoteRaw(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(err instanceof JupiterRateLimitedError, String(err));
  assert.equal(err.status, 429);
  assert.equal(err.attempts, 3);
  assert.equal(s.seen.length, 2, 'the third attempt was refused by the health gate, not sent; the 200 behind it was never requested');
  assert.match(err.message, /^Jupiter is rate limiting this IP \(429 from (api|lite-api)\.jup\.ag\); retry in \d+s$/);
  assert.ok(err.retryAfterMs >= s.http.unavailableFor('jupiter-swap') && err.retryAfterMs >= s.http.pausedFor('jupiter'), 'never shorter than the cool-down or the bucket pause');
  assert.ok(err.retryAfterMs >= 20_000 && err.retryAfterMs <= 60_000, `retryAfterMs ${err.retryAfterMs} ≈ the 30 s health backoff`);
  // While the source is cooling down a new call fails at once with the remaining wait, in the cool-down wording.
  await s.clock.advance(5_000);
  const again = await drive(s.clock, b.quoteRaw(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(again instanceof JupiterRateLimitedError && again.status === 0 && again.attempts === 1, String(again));
  assert.match(again.message, /^Jupiter calls are paused after repeated rate limits \(trenchscope cool-down\); retry in \d+s$/);
  assert.ok(again.retryAfterMs < err.retryAfterMs, 'the wait counts down');
  assert.equal(s.seen.length, 2);
  // After the cool-down the next call goes out and succeeds.
  await s.clock.advance(again.retryAfterMs + 100);
  const raw = await drive(s.clock, b.quoteRaw(QUOTE), 100);
  assert.equal(raw.outAmount, '1092439');
  assert.equal(s.seen.length, 3);
});

test('bounded in TIME: a Retry-After longer than the 10 s budget fails at once (no sleep, one request) with that wait', async () => {
  const long = r429RetryAfter(); long.headers['retry-after'] = '30';
  const s = scripted([long, r200()]);
  const b = build(s);
  const t0 = s.clock.now();
  const err = await drive(s.clock, b.quoteRaw(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(err instanceof JupiterRateLimitedError);
  assert.equal(err.attempts, 1);
  assert.equal(s.seen.length, 1);
  assert.equal(err.retryAfterMs, 30_000);
  assert.ok(s.clock.now() - t0 < 1_000, 'did not sleep out a wait it could not afford');
});

test('the alternate host answering 503 (recorded from lite-api the same minute) alternates straight back; 500 three times rethrows the HttpError, not a rate-limit error', async () => {
  const s = scripted([r429(), r503(), r200()]);
  const raw = await drive(s.clock, build(s).quoteRaw(QUOTE), 100);
  assert.equal(raw.inAmount, '10000000');
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag', 'api.jup.ag']);

  const s2 = scripted([rStatus(500), rStatus(500), rStatus(500)]);
  const err = await drive(s2.clock, build(s2).quoteRaw(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(err instanceof HttpError && err.status === 500, String(err));
  assert.equal(s2.seen.length, 3);
});

test('a dropped connection (undici "fetch failed") retries on the other host; a 400 does not retry at all', async () => {
  const s = scripted([fetchFailed(), r200()]);
  await drive(s.clock, build(s).quoteRaw(QUOTE), 100);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag']);

  const s2 = scripted([rStatus(400), r200()]);
  const err = await drive(s2.clock, build(s2).quoteRaw(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(err instanceof HttpError && err.status === 400);
  assert.equal(s2.seen.length, 1);
});

test('401 keyless refusal keeps the sticky session failover (no wait, not a retry); later calls start on lite-api', async () => {
  const s = scripted([rStatus(401), r200(), r200()]);
  const b = build(s);
  await drive(s.clock, b.quoteRaw(QUOTE), 100);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag']);
  assert.equal(s.seen[1].at, s.seen[0].at, 'no backoff on a refusal');
  await drive(s.clock, b.quoteRaw({ ...QUOTE, amount: 20_000_000n }), 100);
  assert.equal(s.hosts()[2], 'lite-api.jup.ag');
});

test('jitter: the backoff is base × 2^(attempt−1) × [0.5, 1.5), and Retry-After wins when longer', async () => {
  const at = async (random: number) => {
    const s = scripted([rStatus(500), rStatus(500), r200()]);
    await drive(s.clock, build(s, () => random).quoteRaw(QUOTE), 50);
    return [s.seen[1].at - s.seen[0].at, s.seen[2].at - s.seen[1].at];
  };
  assert.deepEqual(await at(0), [500, 1000], 'lowest jitter: 1 s × 0.5, then 2 s × 0.5');
  const hi = await at(0.999);
  assert.ok(hi[0] >= 1_499 && hi[0] < 1_550 && hi[1] >= 2_998 && hi[1] < 3_100, `highest jitter ${hi}`);
  const s = scripted([r429RetryAfter(), r200()]);
  await drive(s.clock, build(s, () => 0).quoteRaw(QUOTE), 50);
  assert.ok(s.seen[1].at - s.seen[0].at >= 2_000, 'Retry-After 2 s beats the 0.5 s backoff');
});

test('a caller abort during the backoff rejects with AbortError and sends nothing more', async () => {
  const s = scripted([r429(), r200()]);
  const ac = new AbortController();
  const p = build(s).quoteRaw(QUOTE, ac.signal).then(() => null, (e: unknown) => e);
  await s.clock.advance(200);
  ac.abort();
  const err = await drive(s.clock, p, 100);
  assert.ok(err instanceof Error && err.name === 'AbortError', String(err));
  assert.equal(s.seen.length, 1);
});

test('JupiterHosts: one host still retries in place; maxAttempts 1 means no retry', async () => {
  const clock = new FakeClock(T0);
  let n = 0;
  const one = new JupiterHosts(['https://api.jup.ag'], { clock, random: () => 0 });
  const p = one.run(async (host) => { n++; if (n < 2) throw new HttpError(503, host); return host; });
  assert.equal(await drive(clock, p, 100), 'https://api.jup.ag');
  assert.equal(n, 2);
  const none = new JupiterHosts(['https://api.jup.ag', 'https://lite-api.jup.ag'], { clock, maxAttempts: 1 });
  await assert.rejects(none.run(async () => { throw new HttpError(503, 'u'); }), (e: unknown) => e instanceof HttpError && e.status === 503);
});

// ------------------------------------------------------------------------------------ one limiter: quote reuse

test('quoteRaw reuses the quote for the same order within QUOTE_REUSE_MS (preview + build = two requests, not three); a new size or an old quote fetches again', async () => {
  const s = scripted([r200(), r200({ ...RAW_QUOTE, outAmount: '1092440' }), r200({ ...RAW_QUOTE, inAmount: '20000000' })]);
  const b = build(s);
  const a = await drive(s.clock, b.quoteRaw(QUOTE), 100);
  await s.clock.advance(QUOTE_REUSE_MS - 1_000);
  const again = await drive(s.clock, b.quoteRaw(QUOTE), 100);
  assert.equal(again, a, 'the same object came back');
  assert.equal(s.seen.length, 1);
  const age = b.quoteAge(QUOTE)!;
  assert.ok(age >= QUOTE_REUSE_MS - 1_000 && age < QUOTE_REUSE_MS, `age ${age} (drive() steps the fake clock)`);
  await s.clock.advance(2_000);
  const fresh = await drive(s.clock, b.quoteRaw(QUOTE), 100);
  assert.equal(fresh.outAmount, '1092440');
  assert.equal(s.seen.length, 2, 'older than the reuse window: fetched again');
  const other = await drive(s.clock, b.quoteRaw({ ...QUOTE, amount: 20_000_000n }), 100);
  assert.equal(other.inAmount, '20000000');
  assert.equal(s.seen.length, 3, 'a different order is a different quote');
  assert.equal(b.quoteAge(QUOTE), null, 'only the latest order is held');
});

test('the PAPER quote adapter (JupiterSwap) follows the same policy: recorded 429 → other host → normalized quote', async () => {
  const s = scripted([r429(), r200()]);
  const js = new JupiterSwap(s.http, undefined, { random: () => 0 });
  const q = await drive(s.clock, js.quote(QUOTE), 100);
  assert.equal(q.outAmount, 1092439n);
  assert.equal(q.priceImpactPct, 0);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag']);
});

// ------------------------------------------------------------------------------------ the signer

/** The real SignerService over the real JupiterSwapBuild on a scripted transport; `queue` is fed per test. */
function signerOn() {
  const queue: (HttpResponse | Error)[] = [];
  const s = scripted(queue);
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1368-'));
  const user = keypair();
  const linkStore = new WalletLinkStore(join(dir, 'wallet-link.json'));
  linkStore.set(user.address, { now: T0 });
  const fresh = (): BuiltTx => buildTx({ feePayer: user.pub, ixs: jupiterSwapIxs(user, 10_000_000n, { outAmount: 1_092_439n }) });
  // The scripted /swap answer carries a real (throwaway-key) transaction so the executor decodes + simulates it.
  const swapOk = (): HttpResponse => r200({ swapTransaction: fresh().unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 0 });
  const mk = (rpcOpts: Partial<Parameters<typeof fakeRpc>[0]> = {}) => {
    const rpc = fakeRpc({ url: DEVNET_RPC, solOut: 10_005_000n, ...rpcOpts });
    const ledger = new CapLedger({ clock: s.clock });
    const liveLedger = new LiveLedger({ clock: s.clock });
    const logs: string[] = [];
    const deps: LiveExecutorDeps = {
      build: new JupiterSwapBuild(s.http, undefined, { random: () => 0 }),
      rpc: rpc as unknown as LiveExecutorDeps['rpc'],
      bridge: { signTransaction: async () => { throw new Error('never signs here'); } } as unknown as LiveExecutorDeps['bridge'],
      caps: defaultCaps({ network: 'devnet' }), ledger, liveLedger, clock: s.clock,
      solUsd: () => solUsdSamples(108, s.clock.now()),
      killSwitch: new KillSwitch(join(dir, 'trading.panic')),
    };
    const service = new SignerService({ executor: new LiveExecutor(deps), deps, linkStore, liveLedger, clock: s.clock, log: (l) => logs.push(l) });
    return { service, logs, rpc, done: () => { ledger.close(); liveLedger.close(); rmSync(dir, { recursive: true, force: true }); } };
  };
  const params = { mint: TEST_MINT, symbol: 'USDC', side: 'buy' as const, decimals: 6, amountRaw: '10000000', slippageBps: 50 };
  return { s, queue, swapOk, mk, params };
}

test('signer plan: a recorded 429 on the quote is retried and the PLAN is built (never `build-failed`); the mint is reported absent on the devnet RPC', async () => {
  const h = signerOn();
  const { service, done } = h.mk();
  try {
    h.queue.push(r429(), r200(), h.swapOk());
    const view = await drive(h.s.clock, service.plan(h.params), 100);
    assert.equal(view.kind, 'swap');
    assert.equal(view.amountOutRaw, '1092439');
    assert.equal(view.sim.ran, true);
    assert.equal(view.mintOnNetwork, false, 'USDC does not exist on the fake devnet RPC');
    assert.deepEqual(h.s.seen.map((x) => `${x.method} ${new URL(x.url).hostname}${new URL(x.url).pathname}`), ['GET api.jup.ag/swap/v1/quote', 'GET lite-api.jup.ag/swap/v1/quote', 'POST lite-api.jup.ag/swap/v1/swap']);
  } finally { done(); }
});

test('signer plan: two recorded 429s (then the health gate) → SignerError `rate-limited` with retryAfterMs (not `build-failed`); nothing registered', async () => {
  const h = signerOn();
  const { service, done } = h.mk();
  try {
    h.queue.push(r429(), r429());
    const err = await drive(h.s.clock, service.plan(h.params).then(() => null, (e: unknown) => e), 100);
    assert.ok(err instanceof SignerError, String(err));
    assert.equal(err.reason, 'rate-limited');
    assert.ok(typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0);
    assert.match(err.message, /Jupiter is rate limiting this IP \(429 from (api|lite-api)\.jup\.ag\); retry in \d+s/);
    assert.equal(service.status().plans, 0);
  } finally { done(); }
});

test('signer quote: a QuoteView (numbers + strings, no bytes) through the signer\'s own limiter; plan then REUSES it — one /quote + one /swap on the wire', async () => {
  const h = signerOn();
  const { service, done } = h.mk();
  try {
    h.queue.push(r200(), h.swapOk());
    const q = await drive(h.s.clock, service.quote(h.params), 100);
    assert.equal(q.outAmountRaw, '1092439');
    assert.equal(q.minOutRaw, '1086977');
    assert.equal(q.inputMint, SOL_MINT);
    assert.equal(q.route[0], 'Meteora');
    assert.equal(q.solUsd.price !== null, true, 'the signer\'s own SOL/USD rides along');
    assert.equal(q.ageMs, 0);
    assert.equal(JSON.stringify(q).includes('swapTransaction'), false);
    await h.s.clock.advance(4_000);
    const view = await drive(h.s.clock, service.plan(h.params), 100);
    assert.equal(view.amountOutRaw, q.outAmountRaw);
    assert.deepEqual(h.s.seen.map((x) => x.method), ['GET', 'POST'], 'the preview quote was reused by the build');
    // A second quote within the window is served from the held one and says how old it is.
    const again = await drive(h.s.clock, service.quote(h.params), 100);
    assert.ok(again.ageMs >= 4_000 && again.ageMs < 5_000, `ageMs ${again.ageMs}`);
    assert.equal(h.s.seen.length, 2);
    // Rate limiting on the quote path is the same typed refusal.
    await h.s.clock.advance(QUOTE_REUSE_MS + 1);
    h.queue.push(r429(), r429());
    const err = await drive(h.s.clock, service.quote(h.params).then(() => null, (e: unknown) => e), 100);
    assert.ok(err instanceof SignerError && err.reason === 'rate-limited');
  } finally { done(); }
});

test('signer plan: a failed simulation is logged IN FULL (the ticket row truncates) and the view carries the whole error', async () => {
  const h = signerOn();
  const long = 'invalid transaction: Transaction loads an address table account that doesn\'t exist (ALT 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU not found on devnet)';
  const { service, logs, done } = h.mk({ simOk: false, simErr: long });
  try {
    h.queue.push(r200(), h.swapOk());
    const view = await drive(h.s.clock, service.plan(h.params), 100);
    assert.equal(view.sim.ok, false);
    assert.equal(view.sim.error, long, 'not truncated');
    assert.equal(view.precheck.ok, false);
    assert.ok(logs.some((l) => l.includes('simulation failed on devnet') && l.includes(long)), logs.join('\n'));
  } finally { done(); }
});

test('over the authenticated channel: the error response carries `reason` and `retryAfterMs`, and `quote` is a served method', async () => {
  const h = signerOn();
  const { service, done } = h.mk();
  const input = new PassThrough();
  const output = new PassThrough();
  const secret = newSecret();
  const replies: SignerMessage[] = [];
  let inSeq = 0;
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const d = decodeFrame(secret, line, inSeq);
      if (d.ok) { inSeq = d.seq + 1; replies.push(d.message); }
    }
  });
  const served = serveSigner({ service, input, output });
  try {
    input.write(encodeHello(secret));
    h.queue.push(r429(), r429());
    input.write(encodeFrame(secret, 0, { id: 1, method: 'plan', params: h.params }));
    await drive(h.s.clock, new Promise<void>((r) => { const t = setInterval(() => { if (replies.some((m) => isResponse(m) && m.id === 1)) { clearInterval(t); r(); } }, 2); }), 100);
    const planReply = replies.find((m) => isResponse(m) && m.id === 1) as { ok: false; error: string; reason?: string; retryAfterMs?: number };
    assert.equal(planReply.ok, false);
    assert.equal(planReply.reason, 'rate-limited');
    assert.ok(typeof planReply.retryAfterMs === 'number' && planReply.retryAfterMs > 0);
    assert.match(planReply.error, /^rate-limited: Jupiter is rate limiting this IP/);
    await h.s.clock.advance(60_000); // past the bucket pause and the health cool-down
    h.queue.push(r200());
    input.write(encodeFrame(secret, 1, { id: 2, method: 'quote', params: h.params }));
    await drive(h.s.clock, new Promise<void>((r) => { const t = setInterval(() => { if (replies.some((m) => isResponse(m) && m.id === 2)) { clearInterval(t); r(); } }, 2); }), 100);
    const quoteReply = replies.find((m) => isResponse(m) && m.id === 2) as { ok: true; result: { outAmountRaw: string } };
    assert.equal(quoteReply.ok, true);
    assert.equal(quoteReply.result.outAmountRaw, '1092439');
  } finally {
    input.end();
    await served;
    done();
  }
});
