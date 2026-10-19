// task-1310 ROUND 2 — regressions for the HEAVY re-verification defects (internal QA evidence, not published:
// task-1310-reverify-heavy.md). Each test is written so that the executor at 9363f12 would FILL (or
// crash) where the hardened executor REFUSES. Fakes only: real Solana wire-format transactions signed
// by throwaway in-memory Ed25519 keys; no network, no wallet, no funds, nothing reaches any chain.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { FakeClock } from '../src/clock.ts';
import { SOL_MINT, type PaperOrder } from '../src/paper.ts';
import {
  defaultCaps, checkCaps, planHash, CapLedger, HARD_MAX_PER_TRADE_USD, type TradePlan, type TradeCaps, type TradeNetwork,
} from '../src/trade/caps.ts';
import { DEVNET_RPC, MAINNET_RPC, rpcNetwork, RpcRejectedError } from '../src/trade/rpc-exec.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { LiveExecutor, PLAN_TTL_MS, type LiveExecutorDeps, type BuiltPlan } from '../src/trade/executor.ts';
import {
  decodeTransaction, checkTxPolicy, JUPITER_V6_PROGRAM, JUPITER_ROUTE_DISCRIMINATORS, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, SYSTEM_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM, MEMO_PROGRAM,
} from '../src/trade/tx-decode.ts';
import { resolveSolUsd } from '../src/trade/sol-usd.ts';
import { normalizeSwapQuote } from '../src/sources/jupiter-swap.ts';
import { base58Decode } from '../src/sources/pda.ts';
import { base58 } from '../src/sources/solana-rpc.ts';
import {
  keypair, buildTx, jupiterSwapIxs, tokenIx, systemAssign, systemTransfer, computeBudgetIx, fakeRpc, solUsdSamples, wireWith, signMessage, randomKey,
  type Keypair, type IxSpec, type BuiltTx, type FakeRpcOpts,
} from './trade-helpers.ts';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USER: Keypair = keypair();
const OTHER: Keypair = keypair();
const PK = USER.address;
const T0 = Date.UTC(2026, 9, 8, 12);
const show = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

const rawQ = (o: Record<string, unknown> = {}) => ({
  inputMint: SOL_MINT, outputMint: MINT, inAmount: '500000000', outAmount: '2000000', otherAmountThreshold: '1990000',
  swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: 'Raydium' } }], swapUsdValue: '9', ...o,
});
const ORDER = (o: Partial<PaperOrder> = {}): PaperOrder => ({ mint: MINT, symbol: 'Bonk', side: 'buy', decimals: 5, amountRaw: 500_000_000n, slippageBps: 50, ...o });

interface Opts {
  raw?: Record<string, unknown>;
  ixs?: (user: Keypair) => IxSpec[];
  /** Produce the signed tx from the unsigned one the wallet was handed (default: honest signature by USER). */
  sign?: (t: BuiltTx, unsigned: string) => string;
  signThrow?: Error;
  caps?: TradeCaps;
  rpc?: Partial<FakeRpcOpts>;
  /** SOL/USD feed; default two agreeing $6 sources on mainnet. `number` = legacy bare-number feed. */
  solUsd?: (() => unknown) | number | null;
  feePayer?: Keypair;
  clock?: FakeClock;
  ledger?: CapLedger;
  killSwitch?: KillSwitch;
}

function mk(o: Opts = {}) {
  const clock = o.clock ?? new FakeClock(T0);
  const ledger = o.ledger ?? new CapLedger({ clock });
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-r2-'));
  const txs = new Map<string, BuiltTx>();
  let signs = 0;
  const fresh = (): BuiltTx => {
    // task-1328: the default honest tx is BOUND to the harness quote (amounts + slippage), like a real /swap.
    const q = rawQ(o.raw);
    const t = buildTx({ feePayer: (o.feePayer ?? USER).pub, ixs: (o.ixs ?? ((u) => jupiterSwapIxs(u, BigInt(String(q.inAmount)), { outputMint: MINT, outAmount: BigInt(String(q.outAmount)), slippageBps: Number(q.slippageBps) })))(USER) });
    txs.set(t.unsigned, t);
    return t;
  };
  const rpc = fakeRpc({ url: MAINNET_RPC, ...(o.rpc ?? {}) });
  const caps = o.caps ?? defaultCaps({ network: 'mainnet', mainnetEnabled: true });
  const deps: LiveExecutorDeps = {
    build: {
      quoteRaw: async () => rawQ(o.raw),
      buildSwap: async () => ({ swapTransactionBase64: fresh().unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 0, quote: rawQ(o.raw) }),
    } as unknown as LiveExecutorDeps['build'],
    rpc: rpc as unknown as LiveExecutorDeps['rpc'],
    bridge: {
      signTransaction: async (a: { unsignedTxBase64: string }) => {
        signs++;
        if (o.signThrow) throw o.signThrow;
        const t = txs.get(a.unsignedTxBase64);
        if (!t) throw new Error('fake wallet handed an unknown tx');
        return { signedTxBase64: o.sign ? o.sign(t, a.unsignedTxBase64) : t.sign(USER), provider: 'fake', roundTripMs: 1 };
      },
    } as unknown as LiveExecutorDeps['bridge'],
    caps, ledger, clock,
    solUsd: typeof o.solUsd === 'function' ? o.solUsd : o.solUsd === null ? undefined : () => (typeof o.solUsd === 'number' ? o.solUsd : solUsdSamples(6, clock.now())),
    killSwitch: o.killSwitch ?? new KillSwitch(join(dir, 'trading.panic')),
  };
  const ex = new LiveExecutor(deps);
  return { ex, rpc, ledger, clock, deps, signs: () => signs, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
type H = ReturnType<typeof mk>;
async function run(o: Opts = {}, order: Partial<PaperOrder> = {}, network?: TradeNetwork) {
  const h = mk(o);
  const b = await h.ex.buildPlan({ order: ORDER(order), userPublicKey: PK, network });
  const r = await h.ex.confirmAndSubmit(b, b.hash, PK);
  h.done();
  return { h, b, r };
}
const reason = (r: { kind: string; reason?: string }) => (r.kind === 'refused' ? r.reason : r.kind);

// =============================================================== HIGH #1 — quote binding, decode, policy, SOL leg

test('R2 HIGH#1: quote inAmount that is not the order amount is refused (quote-mismatch), never built/signed', async () => {
  const { h, b, r } = await run({ raw: { inAmount: '1' } }, { amountRaw: 100_000_000_000n }, 'mainnet');
  assert.equal(reason(r), 'quote-mismatch', show(r));
  assert.equal(b.plan.txPolicy.ok, false);
  assert.equal(h.signs(), 0); assert.equal(h.rpc.calls.submit, 0);
});

test('R2 HIGH#1: quote mints that differ from the order are refused (quote-mismatch)', async () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const a = await run({ raw: { outputMint: usdc } }, {}, 'mainnet');
  assert.equal(reason(a.r), 'quote-mismatch', show(a.r));
  const b = await run({ raw: { inputMint: usdc, outputMint: SOL_MINT, inAmount: '999999999999', outAmount: '0' } }, { side: 'sell', amountRaw: 999_999_999_999n }, 'mainnet');
  assert.equal(reason(b.r), 'quote-mismatch', `sell with outAmount 0 / wrong input mint: ${show(b.r)}`);
  const c = await run({ raw: { swapMode: 'ExactOut' } }, {}, 'mainnet');
  assert.equal(reason(c.r), 'quote-mismatch', show(c.r));
});

test('R2 HIGH#1: toBig rejects non-integer amount strings instead of mapping to 0n', async () => {
  for (const bad of ['1.5e11', 'abc', '-100000000000', '', '1.0', ' 1']) {
    assert.throws(() => normalizeSwapQuote(rawQ({ inAmount: bad }) as never, T0), /malformed quote: inAmount/, `inAmount ${JSON.stringify(bad)}`);
  }
  assert.throws(() => normalizeSwapQuote(rawQ({ outAmount: '0x10' }) as never, T0), /malformed quote: outAmount/);
  assert.throws(() => normalizeSwapQuote({ ...rawQ(), inAmount: 500000000 } as never, T0), /malformed quote: inAmount/, 'a JSON number is not accepted either');
  assert.equal(normalizeSwapQuote(rawQ() as never, T0).inAmount, 500_000_000n);
  // At the executor: a hostile quote with inAmount "1.5e11" against a 100 SOL order cannot build a plan at all.
  const h = mk({ raw: { inAmount: '1.5e11' } });
  await assert.rejects(() => h.ex.buildPlan({ order: ORDER({ amountRaw: 100_000_000_000n }), userPublicKey: PK, network: 'mainnet' }), /malformed quote/);
  assert.equal(h.signs(), 0); h.done();
});

test('R2 HIGH#1: a $0 (or negative) mainnet notional is refused at checkCaps', () => {
  // 0.5 SOL leg (under the SOL cap) that somehow prices at $0: the USD gate must still refuse it.
  const plan: TradePlan = { network: 'mainnet', mint: MINT, symbol: 'B', side: 'buy', amountInRaw: 500_000_000n, amountOutRaw: 1n, slippageBps: 50, route: [], priceImpactPct: 0, notionalUsd: 0, simulated: true, simOk: true, simError: null, solOutLamports: 500_005_000n, solLegLamports: 500_000_000n, txPolicy: { ok: true } };
  const caps = defaultCaps({ network: 'mainnet', mainnetEnabled: true });
  assert.equal(checkCaps(plan, caps, 0).reason, 'no-usd-value');
  assert.equal(checkCaps({ ...plan, notionalUsd: -1 }, caps, 0).reason, 'no-usd-value');
  assert.equal(checkCaps({ ...plan, notionalUsd: NaN }, caps, 0).reason, 'no-usd-value');
  assert.equal(checkCaps({ ...plan, notionalUsd: 3 }, caps, 0).ok, true, 'a real notional under the cap passes');
  // 100 SOL leg at any notional: the SOL-out cap refuses before USD is even consulted.
  assert.equal(checkCaps({ ...plan, amountInRaw: 10n ** 11n, solOutLamports: 10n ** 11n, solLegLamports: 10n ** 11n, notionalUsd: 1e-9 }, caps, 0).reason, 'sol-out-cap');
});

test('R2 HIGH#1: the SOL leg comes from the SIMULATED balance delta — a tx that drains more than the plan is refused', async () => {
  // Order says 0.5 SOL; the simulation shows 3 SOL leaving the wallet. Old code priced the quote's number.
  const { h, b, r } = await run({ rpc: { url: DEVNET_RPC, solOut: 3_000_000_000n }, caps: defaultCaps() });
  assert.equal(b.plan.solOutLamports, 3_000_000_000n);
  assert.equal(reason(r), 'sol-out-cap', show(r));
  assert.equal(h.signs(), 0, 'never reaches the wallet');
});

test('R2 HIGH#1: mainnet notional uses the larger of planned and simulated SOL out', async () => {
  // Plan 0.5 SOL ($3 at $6.006) but the sim moves 0.505 SOL (within the fee allowance): priced on 0.505.
  const { b } = await run({ rpc: { solOut: 505_000_000n } }, {}, 'mainnet');
  assert.ok(b.plan.notionalUsd !== null && b.plan.notionalUsd > 3.03 && b.plan.notionalUsd < 3.04, `notional ${b.plan.notionalUsd}`);
});

test('R2 HIGH#1: an RPC that cannot report the balance delta → refused (sol-delta-unknown), any network', async () => {
  const { h, r } = await run({ rpc: { url: DEVNET_RPC, noAccounts: true }, caps: defaultCaps() });
  assert.equal(reason(r), 'sol-delta-unknown', show(r));
  assert.equal(h.signs(), 0);
});

test('R2 §6.2: an instruction to a program off the allow-list is refused (program-not-allowed)', async () => {
  const evil = randomKey();
  const { h, b, r } = await run({ rpc: { url: DEVNET_RPC }, caps: defaultCaps(), ixs: (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), { program: evil, accounts: [u.pub], data: Buffer.from('drain') }] });
  assert.equal(b.plan.txPolicy.ok, false);
  assert.equal(reason(r), 'program-not-allowed', show(r));
  assert.equal(h.rpc.calls.simulate, 0, 'a refused policy is not even simulated');
  assert.equal(h.signs(), 0);
});

test('R2 §6.2: Approve / ApproveChecked / SetAuthority / CloseAccount-to-foreign / System Assign are refused', async () => {
  const cases: [string, (u: Keypair) => IxSpec[]][] = [
    ['Approve', (u) => [computeBudgetIx(), tokenIx(4, [randomKey(), OTHER.pub, u.pub], Buffer.alloc(8))]],
    ['ApproveChecked', (u) => [computeBudgetIx(), tokenIx(13, [randomKey(), randomKey(), OTHER.pub, u.pub], Buffer.alloc(9))]],
    ['SetAuthority', (u) => [computeBudgetIx(), tokenIx(6, [randomKey(), u.pub], Buffer.from([2, 1, ...OTHER.pub]))]],
    ['CloseAccount to a foreign destination', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }).slice(0, -1), tokenIx(9, [randomKey(), OTHER.pub, u.pub])]],
    ['CloseAccount with a foreign authority', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }).slice(0, -1), tokenIx(9, [randomKey(), u.pub, OTHER.pub])]],
    ['System Assign', (u) => [computeBudgetIx(), systemAssign(u.pub, OTHER.pub)]],
  ];
  for (const [name, ixs] of cases) {
    const { h, r } = await run({ rpc: { url: DEVNET_RPC }, caps: defaultCaps(), ixs });
    assert.equal(reason(r), 'forbidden-instruction', `${name}: ${show(r)}`);
    assert.equal(h.signs(), 0, `${name} never reaches the wallet`);
  }
  // The legitimate shape (CloseAccount of the WSOL account back to the user) still passes.
  const ok = await run({ rpc: { url: DEVNET_RPC }, caps: defaultCaps() });
  assert.equal(ok.r.kind, 'filled', show(ok.r));
});

test('R2 §6.2: a program id loaded from an address-lookup table, or a fee payer that is not the wallet, is refused', async () => {
  // (Round 3: the baseline must be a real route; task-1328: and a route BOUND to the plan — the honest default tx.)
  const lookup = await run({ rpc: { url: DEVNET_RPC }, caps: defaultCaps(), sign: (t) => t.sign(USER) });
  assert.equal(lookup.r.kind, 'filled', 'baseline for the next check');
  // Hand-build: programIdIndex 40 (beyond the 2 static keys) with a v0 lookup table.
  const h = mk({ rpc: { url: DEVNET_RPC }, caps: defaultCaps() });
  const t = buildTx({ feePayer: USER.pub, ixs: [computeBudgetIx()], lookups: [{ table: randomKey(), writable: [0, 1], readonly: [2] }] });
  const msg = Buffer.from(t.message);
  const idx = msg.indexOf(Buffer.from([1, 0, 5, 2, 0x40, 0x0d, 0x03, 0x00]), 0); // ix: programIdIndex=1, 0 accounts, 5 data bytes
  assert.ok(idx > 0, 'found the instruction'); msg[idx] = 40;
  (h.deps.build as unknown as { buildSwap: () => Promise<unknown> }).buildSwap = async () => ({ swapTransactionBase64: wireWith(msg, [Buffer.alloc(64)]), lastValidBlockHeight: 1, prioritizationFeeLamports: 0, quote: rawQ() });
  const b = await h.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  assert.equal(b.plan.txPolicy.ok, false);
  assert.match((b.plan.txPolicy as { message: string }).message, /lookup table/);
  h.done();
  const payer = await run({ rpc: { url: DEVNET_RPC }, caps: defaultCaps(), feePayer: OTHER });
  assert.equal(reason(payer.r), 'signer-mismatch', show(payer.r));
});

test('R2 §6.2: absolute SOL-out cap (caps.maxSolOut) applies on every network and cannot exceed its hard ceiling', async () => {
  const { h, r } = await run({ rpc: { url: DEVNET_RPC }, caps: defaultCaps({ maxSolOut: 0.2 }) });
  assert.equal(reason(r), 'sol-out-cap', show(r));
  assert.equal(h.signs(), 0);
  assert.equal(defaultCaps({ maxSolOut: 1e6 }).maxSolOut, 5, 'clamped to HARD_MAX_SOL_OUT');
});

test('R2 §6.2: RE-SIMULATION at submit — a signed tx that now moves more SOL (or fails) is refused, refunded, not submitted', async () => {
  // Build-time sim: 0.5 SOL; submit-time sim of the SIGNED bytes: 2 SOL. Old code never re-simulated.
  const { h, r } = await run({ rpc: { solOut: (_tx, n) => (n === 0 ? 500_005_000n : 2_000_000_000n) } }, {}, 'mainnet');
  assert.equal(reason(r), 'sol-out-cap', show(r));
  assert.equal(h.rpc.calls.simulate, 2, 'simulated twice: at build and at submit');
  assert.equal(h.rpc.calls.submit, 0);
  assert.equal(h.ledger.spentToday(), 0, 'the reservation was refunded (nothing left dexterm)');
  // A re-simulation that FAILS is refused the same way.
  const h2 = mk({ rpc: { url: DEVNET_RPC }, caps: defaultCaps() });
  const b2 = await h2.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  (h2.rpc as unknown as { simulate: unknown }).simulate = async () => ({ ok: false, err: 'InstructionError', logs: [], unitsConsumed: 0, accounts: null });
  const r2 = await h2.ex.confirmAndSubmit(b2, b2.hash, PK);
  assert.equal(reason(r2), 'simulation-failed', show(r2));
  assert.equal(h2.rpc.calls.submit, 0); h2.done();
});

// =============================================================== signature + plan registry (first verifier #8, re-verify LOW #8/#10)

test('R2: the signed tx must carry a VALID Ed25519 signature by the linked wallet — zero/foreign/stripped/bare/trailing all refused, never submitted', async () => {
  const cases: [string, (t: BuiltTx) => string, string][] = [
    ['signature from a different key', (t) => wireWith(t.message, [signMessage(OTHER, t.message)]), 'bad-signature'],
    ['all-zero signature', (t) => wireWith(t.message, [Buffer.alloc(64)]), 'bad-signature'],
    ['signature array stripped', (t) => wireWith(t.message, []), 'bad-signature'],
    ['bare message, no signature prefix', (t) => t.message.toString('base64'), 'tx-mismatch'],
    ['trailing junk bytes', (t) => Buffer.concat([Buffer.from(t.sign(USER), 'base64'), Buffer.from([0, 0, 0])]).toString('base64'), 'tx-mismatch'],
    ['two signatures', (t) => wireWith(t.message, [signMessage(USER, t.message), signMessage(OTHER, t.message)]), 'tx-mismatch'],
    ['a different message re-signed by the user', () => { const t2 = buildTx({ feePayer: USER.pub, ixs: jupiterSwapIxs(USER, 500_000_000n, { outputMint: MINT }) }); return t2.sign(USER); }, 'tx-mismatch'],
  ];
  for (const [name, sign, want] of cases) {
    const { h, r } = await run({ sign }, {}, 'mainnet');
    assert.equal(reason(r), want, `${name}: ${show(r)}`);
    assert.equal(h.rpc.calls.submit, 0, `${name}: never submitted`);
    assert.equal(h.ledger.spentToday(), 0, `${name}: refunded`);
  }
});

test('R2: an in-process caller that rebinds txDigest + hash on its own BuiltPlan is refused (plan registry)', async () => {
  const h = mk({ rpc: { url: DEVNET_RPC }, caps: defaultCaps() });
  const b = await h.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  const t2 = buildTx({ feePayer: USER.pub, ixs: jupiterSwapIxs(USER, 500_000_000n, { outputMint: MINT }) });
  const txDigest = createHash('sha256').update(t2.message).digest('hex');
  const forged: BuiltPlan = { ...b, txDigest, unsignedTxBase64: t2.unsigned, hash: createHash('sha256').update(`${planHash(b.plan)}|${txDigest}`).digest('hex') };
  (h.deps.bridge as unknown as { signTransaction: unknown }).signTransaction = async () => ({ signedTxBase64: t2.sign(USER), provider: 'fake', roundTripMs: 1 });
  const r = await h.ex.confirmAndSubmit(forged, forged.hash, PK);
  assert.equal(reason(r), 'plan-mismatch', show(r));
  assert.equal(h.rpc.calls.submit, 0);
  assert.throws(() => { (b.plan as { amountInRaw: bigint }).amountInRaw = 1n; }, TypeError, 'the plan is frozen');
  h.done();
});

test('R2: a plan is single-use (double keypress → one wallet prompt, one fill) and expires after PLAN_TTL_MS', async () => {
  const h = mk({ rpc: { url: DEVNET_RPC }, caps: defaultCaps() });
  const b = await h.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  const [r1, r2] = await Promise.all([h.ex.confirmAndSubmit(b, b.hash, PK), h.ex.confirmAndSubmit(b, b.hash, PK)]);
  assert.deepEqual([r1.kind, r2.kind].sort(), ['filled', 'refused']);
  assert.equal(h.signs(), 1, 'the wallet was prompted once');
  assert.equal(h.rpc.calls.submit, 1);
  const b2 = await h.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  await h.clock.advance(PLAN_TTL_MS + 1000);
  const r3 = await h.ex.confirmAndSubmit(b2, b2.hash, PK);
  assert.equal(reason(r3), 'plan-expired', show(r3));
  h.done();
});

test('R2 LOW#10: unknown price impact on mainnet and over-ceiling slippage are refused', async () => {
  const a = await run({ raw: { priceImpactPct: undefined } }, {}, 'mainnet');
  assert.equal(reason(a.r), 'price-impact', show(a.r));
  const b = await run({ raw: { slippageBps: 10000, otherAmountThreshold: '0' } }, { slippageBps: 10000 }, 'mainnet');
  assert.equal(reason(b.r), 'slippage', show(b.r));
  assert.equal(defaultCaps({ maxSlippageBps: 99999 }).maxSlippageBps, 1000, 'clamped to HARD_MAX_SLIPPAGE_BPS');
});

// =============================================================== HIGH #2 — SOL/USD feed

test('R2 HIGH#2: resolveSolUsd refuses stale, implausible, single-source, Jupiter-only and disagreeing feeds on mainnet', () => {
  const now = T0;
  const s = (price: number, source: string, age = 0) => ({ price, fetchedAt: now - age, source });
  assert.equal(resolveSolUsd(150, now, 'mainnet').price, null, 'a bare number is not a sample');
  assert.equal(resolveSolUsd(null, now, 'mainnet').price, null);
  assert.equal(resolveSolUsd([s(150, 'dexscreener')], now, 'mainnet').price, null, 'one source is not enough');
  assert.equal(resolveSolUsd([s(150, 'jupiter'), s(150, 'jupiter-price')], now, 'mainnet').price, null, 'Jupiter cannot be the only vendor');
  assert.equal(resolveSolUsd([s(150, 'dexscreener'), s(150, 'jupiter')], now, 'mainnet').price, null, 'Jupiter does not count as the second source');
  assert.equal(resolveSolUsd([s(150, 'dexscreener'), s(150, 'geckoterminal', 61_000)], now, 'mainnet').price, null, 'older than 60 s');
  assert.equal(resolveSolUsd([s(150, 'dexscreener'), s(150, 'geckoterminal', -10_000)], now, 'mainnet').price, null, 'dated in the future');
  assert.equal(resolveSolUsd([s(0.0001, 'dexscreener'), s(0.0001, 'geckoterminal')], now, 'mainnet').price, null, 'below $1');
  assert.equal(resolveSolUsd([s(50_000, 'dexscreener'), s(50_000, 'geckoterminal')], now, 'mainnet').price, null, 'above $10,000');
  assert.equal(resolveSolUsd([s(150, 'dexscreener'), s(156, 'geckoterminal')], now, 'mainnet').price, null, '4% apart');
  assert.equal(resolveSolUsd([s(150, 'dexscreener'), s(150, 'dexscreener')], now, 'mainnet').price, null, 'the same source twice is one source');
  const ok = resolveSolUsd([s(150, 'dexscreener'), s(153, 'geckoterminal'), s(151, 'jupiter')], now, 'mainnet');
  assert.equal(ok.price, 153, 'two independent sources within 3% → the HIGHER one (conservative)');
  assert.deepEqual('sources' in ok ? ok.sources.sort() : [], ['dexscreener', 'geckoterminal']);
  assert.equal(resolveSolUsd([s(150, 'dexscreener')], now, 'devnet').price, 150, 'devnet accepts one fresh sample');
  assert.equal(resolveSolUsd([s(150, 'dexscreener', 61_000)], now, 'devnet').price, null, 'but not a stale one');
});

test('R2 HIGH#2: at the executor, a legacy bare-number feed, a tiny price, or a single source → refused no-usd-value on mainnet', async () => {
  for (const [name, feed] of [
    ['bare number 6', 6],
    ['bare number 0.0001', 0.0001],
    ['two sources at $0.0001', () => solUsdSamples(0.0001, T0)],
    ['one source', () => [{ price: 150, fetchedAt: T0, source: 'dexscreener' }]],
    ['jupiter only', () => [{ price: 150, fetchedAt: T0, source: 'jupiter' }, { price: 150, fetchedAt: T0, source: 'jupiter-price' }]],
    ['stale pair', () => solUsdSamples(150, T0 - 90_000)],
    ['no feed', null],
  ] as [string, Opts['solUsd']][]) {
    const { h, b, r } = await run({ solUsd: feed }, { amountRaw: 500_000_000n }, 'mainnet');
    assert.equal(b.plan.notionalUsd, null, `${name}: no notional`);
    assert.equal(reason(r), 'no-usd-value', `${name}: ${show(r)}`);
    assert.equal(h.signs(), 0, `${name}: never signs`);
  }
  // And the 100 SOL at $0.0001 case from the report: refused, not "$0.01".
  const big = await run({ solUsd: () => solUsdSamples(0.0001, T0), raw: { inAmount: '100000000000' }, rpc: { solOut: 100_000_005_000n } }, { amountRaw: 100_000_000_000n }, 'mainnet');
  assert.equal(big.r.kind, 'refused', show(big.r));
});

// =============================================================== MEDIUM #4 — refund only on a definite rejection

test('R2 MED#4: a transport error on submit keeps the reservation, looks up the known signature, and reports send-unknown (no retry invite)', async () => {
  const { h, r } = await run({ rpc: { submit: async () => { throw new Error('The operation was aborted due to timeout'); } } }, {}, 'mainnet');
  assert.equal(r.kind, 'send-unknown', show(r));
  if (r.kind === 'send-unknown') {
    assert.match(r.error, /do not resend/);
    assert.equal(r.signature.length > 60, true, 'the first signature from the signed bytes is reported');
  }
  assert.equal(h.rpc.calls.status, 1, 'getSignatureStatuses was consulted');
  assert.ok(h.ledger.spentToday() > 3, `the budget stays charged ($${h.ledger.spentToday()})`);
});

test('R2 MED#4: a definite JSON-RPC rejection on submit refunds (nothing was broadcast)', async () => {
  const { h, r } = await run({ rpc: { submit: async () => { throw new RpcRejectedError('sendTransaction', 'Transaction simulation failed: Blockhash not found', -32002, null); } } }, {}, 'mainnet');
  assert.equal(r.kind, 'send-failed', show(r));
  assert.equal(h.ledger.spentToday(), 0, 'refunded');
});

test('R2 MED#4: when the status lookup finds the signature after a transport error, the trade proceeds to confirmation and fills once', async () => {
  const { h, r } = await run({ rpc: {
    submit: async () => { throw new Error('socket hang up'); },
    signatureStatus: async () => ({ confirmationStatus: 'confirmed', err: null, slot: 7 }),
  } }, {}, 'mainnet');
  assert.equal(r.kind, 'filled', show(r));
  assert.ok(h.ledger.spentToday() > 3, 'charged exactly once');
});

test('R2 MED#4: a confirm() that throws or times out after a broadcast is send-unknown, still charged', async () => {
  const a = await run({ rpc: { confirm: async () => { throw new Error('rpc getSignatureStatuses: 503'); } } }, {}, 'mainnet');
  assert.equal(a.r.kind, 'send-unknown', show(a.r));
  assert.ok(a.h.ledger.spentToday() > 3);
  const b = await run({ rpc: { confirm: async (sig) => ({ signature: sig, confirmed: false, err: 'confirmation timed out', slot: null }) } }, {}, 'mainnet');
  assert.equal(b.r.kind, 'send-unknown', show(b.r));
  assert.ok(b.h.ledger.spentToday() > 3);
});

test('R2 LOW#9: a refund credits the day the reservation was taken, even across midnight', async () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 8, 23, 59, 50));
  const ledger = new CapLedger({ clock });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const A = mk({ clock, ledger, signThrow: undefined });
  (A.deps.bridge as unknown as { signTransaction: unknown }).signTransaction = async () => { await gate; throw new Error('user closed the wallet popup'); };
  const bA = await A.ex.buildPlan({ order: ORDER(), userPublicKey: PK, network: 'mainnet' });
  const pA = A.ex.confirmAndSubmit(bA, bA.hash, PK);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(ledger.spentToday() > 3, 'reserved on day D');
  await clock.advance(20_000); // D+1 00:00:10
  assert.equal(ledger.spentToday(), 0, 'D+1 starts at $0');
  ledger.record(18, clock.now()); // D+1 fills
  release();
  const rA = await pA;
  assert.equal(rA.kind, 'send-failed');
  assert.equal(ledger.spentToday(), 18, 'the refund did NOT land on D+1');
  assert.equal(ledger.spentToday(Date.UTC(2026, 9, 8, 12)), 0, 'it credited day D');
  A.done();
});

// =============================================================== MEDIUM #5 — network from a PARSED URL

test('R2 MED#5: rpcNetwork parses the URL; only exact devnet/testnet hostnames are devnet; unknown → mainnet', () => {
  for (const u of ['https://mainnet.helius-rpc.com/?api-key=devnet-team-key', 'https://api.mainnet-beta.solana.com/#testnet', 'https://rpc.example.com/devnet-proxy',
    'https://my-testnet-box.example', 'http://127.0.0.1:8899', '', 'not a url', 'https://api.devnet.solana.com.evil.example', 'https://evil.example/?x=api.devnet.solana.com']) {
    assert.equal(rpcNetwork(u), 'mainnet', u);
  }
  for (const u of [DEVNET_RPC, 'https://api.testnet.solana.com', 'https://API.DEVNET.SOLANA.COM/', 'https://devnet.helius-rpc.com/?api-key=x']) assert.equal(rpcNetwork(u), 'devnet', u);
  assert.equal(rpcNetwork(MAINNET_RPC, 'devnet'), 'devnet', 'an explicit config wins');
  assert.equal(rpcNetwork(DEVNET_RPC, 'mainnet'), 'mainnet');
});

test('R2 MED#5: a mainnet RPC whose URL contains "devnet" gets mainnet caps (10 SOL without --mainnet → refused)', async () => {
  const { b, r } = await run({ caps: defaultCaps(), rpc: { url: 'https://mainnet.helius-rpc.com/?api-key=devnet-team-key', solOut: 10_000_005_000n }, raw: { inAmount: '10000000000' } }, { amountRaw: 10_000_000_000n });
  assert.equal(b.plan.network, 'mainnet');
  assert.equal(reason(r), 'mainnet-not-enabled', show(r));
});

test('R2 MED#5: the network is re-derived at submit — an RPC switched to mainnet after a devnet build is refused', async () => {
  const h = mk({ caps: defaultCaps(), rpc: { url: DEVNET_RPC } });
  const b = await h.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  (h.rpc as { url: string }).url = MAINNET_RPC;
  const r = await h.ex.confirmAndSubmit(b, b.hash, PK);
  assert.equal(reason(r), 'network-mismatch', show(r));
  assert.equal(h.signs(), 0); h.done();
});

// =============================================================== MEDIUM #6/#7 — hard ceilings at the decision point, atomic ledger

test('R2 MED#6: a caps object literal or a mutated caps object cannot raise the hard ceilings at checkCaps', async () => {
  const literal = { network: 'mainnet', mainnetEnabled: true, perTradeUsd: 1e9, dailyUsd: 1e12, maxPriceImpactPct: 100, maxSolOut: 1e9, maxSlippageBps: 1e9 } as TradeCaps;
  const { h, r } = await run({ caps: literal, solUsd: () => solUsdSamples(150, T0), rpc: { solOut: 1_000_000_005_000n }, raw: { inAmount: '1000000000000' } }, { amountRaw: 1_000_000_000_000n }, 'mainnet');
  assert.equal(r.kind, 'refused', `1000 SOL = $150k must not fill: ${show(r)}`);
  assert.equal(h.ledger.spentToday(), 0);
  const plan: TradePlan = { network: 'mainnet', mint: MINT, symbol: 'B', side: 'buy', amountInRaw: 1n, amountOutRaw: 1n, slippageBps: 50, route: [], priceImpactPct: 0, notionalUsd: HARD_MAX_PER_TRADE_USD + 1, simulated: true, simOk: true, simError: null, solOutLamports: 1n, solLegLamports: 1n, txPolicy: { ok: true } };
  assert.equal(checkCaps(plan, literal, 0).reason, 'per-trade-cap', 'perTradeUsd 1e9 is worth exactly the hard ceiling');
  const c = defaultCaps({ network: 'mainnet', mainnetEnabled: true });
  assert.throws(() => { (c as { perTradeUsd: number }).perTradeUsd = 1e9; }, TypeError, 'defaultCaps() is frozen');
});

test('R2 MED#7: tryReserve is atomic across processes — 6 workers × $8 on a $20 cap never admit more than 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-xproc-'));
  const path = join(dir, 'ledger.sqlite');
  new CapLedger({ path }).close();
  const N = 6, trials = 15;
  let worst = 0;
  for (let t = 0; t < trials; t++) {
    const sab = new SharedArrayBuffer(4);
    const ws = Array.from({ length: N }, () => new Worker(new URL('./ledger-worker.ts', import.meta.url), { workerData: { path, sab, usd: 8, cap: 20, day: Date.UTC(2026, 9, 9 + t, 12) } }));
    await Promise.all(ws.map((w) => new Promise((r) => w.once('message', r))));
    Atomics.store(new Int32Array(sab), 0, 1); Atomics.notify(new Int32Array(sab), 0);
    const res = await Promise.all(ws.map((w) => new Promise<boolean>((r) => w.once('message', (m) => r(m as boolean)))));
    await Promise.all(ws.map((w) => w.terminate()));
    worst = Math.max(worst, res.filter(Boolean).length);
  }
  const l = new CapLedger({ path });
  assert.equal((l.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000, 'busy_timeout is set on every connection');
  l.close();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(worst <= 2, `worst trial admitted ${worst} × $8 against a $20 cap`);
  assert.ok(worst >= 1, 'at least one reservation succeeds per trial');
});

// =============================================================== panic (design gap: panic path)

test('R2 PANIC: an engaged kill switch refuses buildPlan; engaged after build (from any process) refuses confirm; a locked ledger too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-panic-'));
  const ks = new KillSwitch(join(dir, 'trading.panic'));
  const h = mk({ caps: defaultCaps(), rpc: { url: DEVNET_RPC }, killSwitch: ks });
  const b = await h.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  new KillSwitch(ks.path).engage('operator said stop'); // a SECOND handle on the same file = another process
  const r = await h.ex.confirmAndSubmit(b, b.hash, PK);
  assert.equal(reason(r), 'panicked', show(r));
  assert.equal(h.signs(), 0);
  await assert.rejects(() => h.ex.buildPlan({ order: ORDER(), userPublicKey: PK }), /PANICKED/);
  assert.equal(ks.release(), true);
  const b2 = await h.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  h.ledger.lock('ledger panic');
  const r2 = await h.ex.confirmAndSubmit(b2, b2.hash, PK);
  assert.equal(reason(r2), 'panicked', show(r2));
  assert.equal(h.ex.precheck(b2).reason, 'panicked');
  h.ledger.unlock();
  const b3 = await h.ex.buildPlan({ order: ORDER(), userPublicKey: PK });
  assert.equal((await h.ex.confirmAndSubmit(b3, b3.hash, PK)).kind, 'filled');
  h.done(); rmSync(dir, { recursive: true, force: true });
});

// =============================================================== decoder unit checks

test('R2 decoder: legacy and v0 round-trip; trailing bytes / huge sigCount are malformed; base58Decode of the System program is 32 zero bytes', () => {
  assert.equal(base58Decode(SYSTEM_PROGRAM).length, 32);
  assert.ok(base58Decode(SYSTEM_PROGRAM).every((b) => b === 0));
  assert.equal(base58(base58Decode(TOKEN_PROGRAM)), TOKEN_PROGRAM);
  for (const version of ['legacy', 0] as const) {
    const t = buildTx({ feePayer: USER.pub, ixs: jupiterSwapIxs(USER, 500_000_000n, { outputMint: MINT }), version, lookups: version === 0 ? [{ table: randomKey(), writable: [1, 2], readonly: [3] }] : undefined });
    const d = decodeTransaction(Buffer.from(t.sign(USER), 'base64'));
    assert.equal(d.version, version);
    assert.equal(d.staticKeys[0], PK);
    assert.equal(d.instructions.length, 6);
    assert.equal(d.lookups.length, version === 0 ? 1 : 0);
    assert.ok(d.message.equals(t.message));
    assert.equal(checkTxPolicy(d, PK).ok, true);
    assert.equal(checkTxPolicy(d, OTHER.address).ok, false, 'another wallet is not the fee payer');
    assert.throws(() => decodeTransaction(Buffer.concat([Buffer.from(t.unsigned, 'base64'), Buffer.from([0])])), /trailing/);
  }
  assert.throws(() => decodeTransaction(Buffer.concat([Buffer.from([0xff, 0x7f]), Buffer.alloc(10)])), /malformed/);
  assert.throws(() => decodeTransaction(Buffer.alloc(0)), /malformed/);
});

// =============================================================== ROUND 3 — the policy must describe a SWAP (verify FAIL @cdd2825)
// An independent verifier (internal QA evidence, not published: task-1310-verify-r2-tools/spl-drain-probe.mjs) showed the
// round-2 policy was a blacklist: it never required the transaction to BE a swap. A hostile /swap response
// carrying a top-level SPL Transfer / TransferChecked / Burn (SPL or Token-2022) of the user's tokens to an
// attacker — with no Jupiter instruction at all, or appended to an honest route — passed policy, passed the
// SOL-only delta check (only the fee leaves the wallet), was SIGNED and SUBMITTED, and booked as `filled`.
// Every drain case below printed `policy: ALLOW executor: filled submitted=1` at cdd2825. The policy is now
// a positive description of a Jupiter swap; each case must be refused BEFORE the wallet is asked to sign.
const u64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const ROUTE = Buffer.from('e517cb977ae3ad2a', 'hex');
const token22Ix = (op: number, accounts: (Buffer | string)[], rest: Buffer = Buffer.alloc(0)): IxSpec =>
  ({ program: TOKEN_2022_PROGRAM, accounts, data: Buffer.concat([Buffer.from([op]), rest]) });
/** A bare Jupiter route instruction (no wrap/unwrap around it) — the minimum that IS a swap. */
const routeIx = (u: Keypair, disc: Buffer = ROUTE): IxSpec =>
  ({ program: JUPITER_V6_PROGRAM, accounts: [TOKEN_PROGRAM, u.pub, randomKey(), randomKey()], data: Buffer.concat([disc, randomKey()]) });
const policyOf = (ixs: IxSpec[], user: Keypair = USER) =>
  checkTxPolicy(decodeTransaction(Buffer.from(buildTx({ feePayer: user.pub, ixs }).unsigned, 'base64')), user.address);

/** Static policy, then the full executor on MAINNET with --mainnet (the verifier's setup): refused before signing. */
async function expectRefused(name: string, ixs: (u: Keypair) => IxSpec[], want: string): Promise<void> {
  const pol = policyOf(ixs(USER));
  assert.equal(pol.ok, false, `${name}: static policy must refuse`);
  assert.equal((pol as { reason: string }).reason, want, `${name}: ${show(pol)}`);
  // A fee-only SOL delta is what a token drain looks like to a SOL-only simulation check.
  const { h, b, r } = await run({ ixs, rpc: { solOut: 5_000n } });
  assert.equal(b.plan.txPolicy.ok, false, `${name}: the plan carries the refusal`);
  assert.equal(reason(r), want, `${name}: ${show(r)}`);
  assert.equal(h.rpc.calls.simulate, 0, `${name}: a refused policy is not even simulated`);
  assert.equal(h.signs(), 0, `${name}: never reaches the wallet`);
  assert.equal(h.rpc.calls.submit, 0, `${name}: never broadcast`);
  assert.equal(h.ledger.spentToday(), 0, `${name}: nothing charged`);
}

test('R3 HIGH (SPL drain): a top-level Transfer / TransferChecked / Burn / BurnChecked — SPL or Token-2022, bare or appended to an honest route — is refused, never signed, never submitted', async () => {
  const userAta = randomKey(), attackerAta = randomKey(), mint = randomKey();
  const MAX = 18_446_744_073_709_551_615n;
  const cases: [string, (u: Keypair) => IxSpec[]][] = [
    ['bare SPL Transfer(3) of the entire balance to the attacker, no route', (u) => [computeBudgetIx(), tokenIx(3, [userAta, attackerAta, u.pub], u64(MAX))]],
    ['bare SPL TransferChecked(12) to the attacker, no route', (u) => [computeBudgetIx(), tokenIx(12, [userAta, mint, attackerAta, u.pub], Buffer.concat([u64(1_000_000_000_000n), Buffer.from([6])]))]],
    ['bare Token-2022 Transfer(3) to the attacker, no route', (u) => [computeBudgetIx(), token22Ix(3, [userAta, attackerAta, u.pub], u64(1_000_000_000_000n))]],
    ['bare Token-2022 TransferChecked(12) to the attacker, no route', (u) => [computeBudgetIx(), token22Ix(12, [userAta, mint, attackerAta, u.pub], Buffer.concat([u64(1n), Buffer.from([6])]))]],
    ["bare SPL Burn(8) of the user's tokens, no route", (u) => [computeBudgetIx(), tokenIx(8, [userAta, mint, u.pub], u64(1_000_000_000_000n))]],
    ['bare SPL BurnChecked(15), no route', (u) => [computeBudgetIx(), tokenIx(15, [userAta, mint, u.pub], Buffer.concat([u64(1n), Buffer.from([6])]))]],
    ['bare Token-2022 Burn(8), no route', (u) => [computeBudgetIx(), token22Ix(8, [userAta, mint, u.pub], u64(1n))]],
    ['bare Token-2022 BurnChecked(15), no route', (u) => [computeBudgetIx(), token22Ix(15, [userAta, mint, u.pub], Buffer.concat([u64(1n), Buffer.from([6])]))]],
    ['honest route PLUS an appended SPL Transfer(3) to the attacker', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), tokenIx(3, [userAta, attackerAta, u.pub], u64(1_000_000_000_000n))]],
    ['honest route PLUS an appended Token-2022 TransferChecked(12)', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), token22Ix(12, [userAta, mint, attackerAta, u.pub], Buffer.concat([u64(1n), Buffer.from([6])]))]],
    ['honest route PLUS an appended SPL Burn(8)', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), tokenIx(8, [userAta, mint, u.pub], u64(1n))]],
    ['honest route with a Transfer(3) slipped in BEFORE the route', (u) => { const ixs = jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }); return [...ixs.slice(0, 4), tokenIx(3, [userAta, attackerAta, u.pub], u64(1n)), ...ixs.slice(4)]; }],
    ['honest route PLUS MintTo(7) (not a swap op)', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), tokenIx(7, [mint, userAta, u.pub], u64(1n))]],
    ['honest route PLUS Revoke(5)', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), tokenIx(5, [userAta, u.pub])]],
    ['honest route PLUS FreezeAccount(10)', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), tokenIx(10, [userAta, mint, u.pub])]],
  ];
  for (const [name, ixs] of cases) await expectRefused(name, ixs, 'forbidden-instruction');
});

test("R3 HIGH (SOL shape): a System Transfer may fund ONLY the wallet's own wrapped-SOL account (synced AND closed back to the wallet in the same tx); any other System instruction is refused", async () => {
  const cases: [string, (u: Keypair) => IxSpec[]][] = [
    ['bare System Transfer of the order SOL to the attacker, no route', (u) => [computeBudgetIx(), systemTransfer(u.pub, OTHER.pub, 500_000_000n)]],
    ['honest route PLUS a System Transfer to the attacker', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), systemTransfer(u.pub, OTHER.pub, 100_000_000n)]],
    ['the wrap transfer funds a wrapped-SOL account that is synced but NEVER closed back to the wallet', (u) => jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }).slice(0, -1)],
    ['the wrap transfer funds an account that is closed to the wallet but never synced (not a wrapped-SOL account)', (u) => { const w = randomKey(); return [computeBudgetIx(), systemTransfer(u.pub, w, 500_000_000n), routeIx(u), tokenIx(9, [w, u.pub, u.pub])]; }],
    ["the wrap transfer funds the ATTACKER's wrapped-SOL account (synced, closed to the attacker)", (u) => { const w = randomKey(); return [computeBudgetIx(), systemTransfer(u.pub, w, 500_000_000n), tokenIx(17, [w]), routeIx(u), tokenIx(9, [w, OTHER.pub, OTHER.pub])]; }],
    ['a System Transfer whose source is not the wallet', (u) => { const w = randomKey(); return [computeBudgetIx(), systemTransfer(OTHER.pub, w, 1n), tokenIx(17, [w]), routeIx(u), tokenIx(9, [w, u.pub, u.pub])]; }],
    ['System TransferWithSeed(11) is not part of a swap', (u) => { const d = Buffer.alloc(12); d.writeUInt32LE(11, 0); return [computeBudgetIx(), { program: SYSTEM_PROGRAM, accounts: [u.pub, randomKey(), OTHER.pub], data: d }, routeIx(u)]; }],
    ['System CreateAccount(0) is not part of a swap', (u) => { const d = Buffer.alloc(52); d.writeUInt32LE(0, 0); return [computeBudgetIx(), { program: SYSTEM_PROGRAM, accounts: [u.pub, randomKey()], data: d }, routeIx(u)]; }],
  ];
  for (const [name, ixs] of cases) await expectRefused(name, ixs, 'forbidden-instruction');
  // The honest wrap shape (transfer → synced → route → closed back to the wallet) still fills on mainnet.
  const ok = await run({});
  assert.equal(ok.r.kind, 'filled', show(ok.r));
});

test('R3 HIGH (swap shape): a swap is exactly ONE Jupiter route — none, two, a non-route Jupiter instruction, a DEX called directly, or account setup for a foreign owner is refused', async () => {
  const notASwap: [string, (u: Keypair) => IxSpec[]][] = [
    ['compute budget only — nothing moves, still not a swap', () => [computeBudgetIx()]],
    ['compute budget + memo, no route', () => [computeBudgetIx(), { program: MEMO_PROGRAM, accounts: [], data: Buffer.from('gm') }]],
    ['two routes (a second leg the plan never showed)', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), routeIx(u)]],
    ['a Jupiter `claim` instead of a route', (u) => [computeBudgetIx(), routeIx(u, Buffer.from('3ec6d6c1d59f6cd2', 'hex'))]],
    ['a Jupiter instruction with a zero discriminator', (u) => [computeBudgetIx(), routeIx(u, Buffer.alloc(8))]],
    ['a Jupiter instruction with empty data', (u) => [computeBudgetIx(), { program: JUPITER_V6_PROGRAM, accounts: [u.pub], data: Buffer.alloc(0) }]],
  ];
  for (const [name, ixs] of notASwap) await expectRefused(name, ixs, 'not-a-swap');
  const dexDirect: [string, (u: Keypair) => IxSpec[]][] = [
    ['Raydium AMM v4 called directly at the top level (DEXes are reached only by CPI from the route)', (u) => [computeBudgetIx(), { program: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', accounts: [u.pub], data: Buffer.from([9]) }]],
    ['honest route PLUS a direct Orca Whirlpool call', (u) => [...jupiterSwapIxs(u, 500_000_000n, { outputMint: MINT }), { program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', accounts: [u.pub], data: Buffer.from([1]) }]],
  ];
  for (const [name, ixs] of dexDirect) await expectRefused(name, ixs, 'program-not-allowed');
  const foreignSetup: [string, (u: Keypair) => IxSpec[]][] = [
    ['ATA CreateIdempotent for a FOREIGN owner', (u) => [computeBudgetIx(), { program: ASSOCIATED_TOKEN_PROGRAM, accounts: [u.pub, randomKey(), OTHER.pub, randomKey(), SYSTEM_PROGRAM, TOKEN_PROGRAM], data: Buffer.from([1]) }, routeIx(u)]],
    ['ATA RecoverNested (op 2)', (u) => [computeBudgetIx(), { program: ASSOCIATED_TOKEN_PROGRAM, accounts: [u.pub, randomKey(), u.pub, randomKey(), SYSTEM_PROGRAM, TOKEN_PROGRAM], data: Buffer.from([2]) }, routeIx(u)]],
    ['Token InitializeAccount3(18) for a FOREIGN owner', (u) => [computeBudgetIx(), tokenIx(18, [randomKey(), randomKey()], OTHER.pub), routeIx(u)]],
    ['Token InitializeAccount(1) for a FOREIGN owner', (u) => [computeBudgetIx(), tokenIx(1, [randomKey(), randomKey(), OTHER.pub, randomKey()]), routeIx(u)]],
  ];
  for (const [name, ixs] of foreignSetup) await expectRefused(name, ixs, 'forbidden-instruction');
  // Positive: every route-family discriminator IS a swap, and account setup for the wallet itself is fine.
  for (const [disc, name] of JUPITER_ROUTE_DISCRIMINATORS) {
    assert.equal(policyOf([computeBudgetIx(), routeIx(USER, Buffer.from(disc, 'hex'))]).ok, true, `${name} (${disc}) is a route`);
  }
  const setup = policyOf([
    computeBudgetIx(),
    { program: ASSOCIATED_TOKEN_PROGRAM, accounts: [USER.pub, randomKey(), USER.pub, randomKey(), SYSTEM_PROGRAM, TOKEN_PROGRAM], data: Buffer.alloc(0) },
    tokenIx(18, [randomKey(), randomKey()], USER.pub), tokenIx(16, [randomKey(), randomKey(), randomKey()], USER.pub), tokenIx(1, [randomKey(), randomKey(), USER.pub, randomKey()]),
    routeIx(USER),
  ]);
  assert.equal(setup.ok, true, `account setup for the wallet itself is part of a swap: ${show(setup)}`);
  assert.equal(policyOf(jupiterSwapIxs(USER, 500_000_000n, { outputMint: MINT })).ok, true, 'the honest wrapAndUnwrapSol shape');
});
