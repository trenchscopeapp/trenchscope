// task-1337 — launch hardening of the money path, two parts:
//
//  A. The TOKEN-BALANCE DIFF (round-3 verifier's "recommended next hardening"): the wallet's token
//     accounts ride along in the simulation; a transaction that drains one the plan does not spend is
//     refused at build AND again on the signed bytes at confirm. Fail closed when the balances cannot
//     be read. Plus the verify-1328 minor: the SOL-out and slippage ceilings are downward-only without
//     --mainnet.
//  B. The HIGH-FINDINGS LEDGER: one regression test per HIGH/CRITICAL finding from the task-1310 verify
//     rounds (heavy verify 2026-10-08 #1–#4, heavy re-verify #1–#2, round-2 verify SPL drain), each run
//     through the SIGNER SERVICE — the process boundary the UI talks to — so the refusal is proven on the
//     signer side, not in a screen. These complement (do not replace) the per-defect suites in
//     task-1310-round2.test.ts / trade-executor.test.ts / signer-1328.test.ts / trade-fixture-1328.test.ts.
//
// No network, no wallet, no funds: hand-built wire transactions, throwaway Ed25519 keys, fake RPC.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/clock.ts';
import { SOL_MINT, type PaperOrder } from '../src/paper.ts';
import { defaultCaps, capsOnlyDownward, CapLedger, DEFAULT_MAX_SLIPPAGE_BPS, DEFAULT_MAX_SOL_OUT, type TradeCaps } from '../src/trade/caps.ts';
import { DEVNET_RPC, MAINNET_RPC, rpcNetwork, type TradeRpc } from '../src/trade/rpc-exec.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { WalletLinkStore } from '../src/trade/link-store.ts';
import { LiveExecutor, LiveLedger, type LiveExecutorDeps } from '../src/trade/executor.ts';
import { SignerService } from '../src/trade/signer/service.ts';
import { parseSignerArgs } from '../src/trade/signer/main.ts';
import { decodeTransaction, associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT, type DecodedTransaction } from '../src/trade/tx-decode.ts';
import { parseTokenAccount, parseLookupTable, referencedAccounts, buildTokenWatch, checkTokenDeltas, checkWsolBound, referencedOverCap, postBalances, MAX_TOKEN_WATCH, type TokenWatch } from '../src/trade/token-delta.ts';
import { base58 } from '../src/sources/solana-rpc.ts';
import { base58Decode } from '../src/sources/pda.ts';
import {
  keypair, buildTx, jupiterSwapIxs, jupiterSellIxs, computeBudgetIx, tokenIx, fakeRpc, solUsdSamples, randomKey, tokenAccountData, lookupTableData,
  TEST_MINT, TEST_OUT_AMOUNT, TEST_SLIPPAGE_BPS, type BuiltTx, type Keypair, type IxSpec, type FakeRpcOpts, type FakeTokenAccount,
} from './trade-helpers.ts';

const show = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const T0 = Date.UTC(2026, 9, 10, 12);
const BUY_LAMPORTS = 500_000_000n;

const buyQuote = (over: Record<string, unknown> = {}) => ({
  inputMint: SOL_MINT, outputMint: TEST_MINT, inAmount: BUY_LAMPORTS.toString(), outAmount: TEST_OUT_AMOUNT.toString(), otherAmountThreshold: '1990000',
  swapMode: 'ExactIn', slippageBps: TEST_SLIPPAGE_BPS, priceImpactPct: '0.005', platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '3', ...over,
});
const BUY_ORDER: PaperOrder = { mint: TEST_MINT, symbol: 'USDC', side: 'buy', decimals: 6, amountRaw: BUY_LAMPORTS, slippageBps: TEST_SLIPPAGE_BPS };
const BUY_PARAMS = { mint: TEST_MINT, symbol: 'USDC', side: 'buy' as const, decimals: 6, amountRaw: BUY_LAMPORTS.toString(), slippageBps: TEST_SLIPPAGE_BPS };

interface Opts {
  network?: 'devnet' | 'mainnet';
  rpc?: Partial<FakeRpcOpts>;
  quote?: Record<string, unknown>;
  /** The instructions `/swap` "returns" for the user (default: the honest bound buy). */
  ixs?: (user: Keypair) => IxSpec[];
  version?: 'legacy' | 0;
  lookups?: { table: Buffer; writable: number[]; readonly: number[] }[];
  sign?: (t: BuiltTx, user: Keypair) => string;
  caps?: Partial<TradeCaps>;
  solUsd?: () => unknown;
  /** Pre-fund a daily spend (USD) before the test's trade. */
  spentToday?: number;
}

function mk(o: Opts = {}) {
  const clock = new FakeClock(T0);
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1337-'));
  const user = keypair();
  const net = o.network ?? 'devnet';
  const linkStore = new WalletLinkStore(join(dir, 'wallet-link.json'));
  linkStore.set(user.address, { now: T0 });
  const txs = new Map<string, BuiltTx>();
  const fresh = (): BuiltTx => {
    const t = buildTx({ feePayer: user.pub, ixs: (o.ixs ?? ((u) => jupiterSwapIxs(u, BUY_LAMPORTS)))(user), version: o.version, lookups: o.lookups });
    txs.set(t.unsigned, t);
    return t;
  };
  const rpc = fakeRpc({ url: net === 'mainnet' ? MAINNET_RPC : DEVNET_RPC, ...(o.rpc ?? {}) });
  const ledger = new CapLedger({ clock });
  if (o.spentToday) ledger.record(o.spentToday, T0);
  const liveLedger = new LiveLedger({ clock });
  const killSwitch = new KillSwitch(join(dir, 'trading.panic'));
  let signs = 0;
  const quote = buyQuote(o.quote);
  const deps: LiveExecutorDeps = {
    build: { quoteRaw: async () => quote, buildSwap: async () => ({ swapTransactionBase64: fresh().unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 1234, quote }) } as unknown as LiveExecutorDeps['build'],
    rpc: rpc as unknown as TradeRpc,
    bridge: { signTransaction: async (a: { unsignedTxBase64: string }) => {
      signs++;
      const t = txs.get(a.unsignedTxBase64);
      if (!t) throw new Error('the fake wallet was handed a transaction it never saw');
      return { signedTxBase64: o.sign ? o.sign(t, user) : t.sign(user), provider: 'fake', roundTripMs: 1 };
    } } as unknown as LiveExecutorDeps['bridge'],
    caps: defaultCaps({ network: net, mainnetEnabled: net === 'mainnet', ...(o.caps ?? {}) }),
    ledger, liveLedger, clock,
    solUsd: o.solUsd ?? (() => solUsdSamples(150, clock.now())),
    killSwitch,
  };
  const ex = new LiveExecutor(deps);
  const service = new SignerService({ executor: ex, deps, linkStore, liveLedger, clock });
  return { ex, service, deps, user, rpc, ledger, liveLedger, clock, linkStore, signs: () => signs, done: () => { ledger.close(); liveLedger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A token account the wallet holds (random address + mint unless given). */
function holding(user: Keypair, amount: bigint, over: Partial<FakeTokenAccount> = {}): FakeTokenAccount {
  return { pubkey: base58(randomKey()), mint: base58(randomKey()), owner: user.address, amount, ...over };
}

// ============================================================================================ A. token-balance diff

test('token-delta (pure): SPL account + lookup-table parsers; the watch list WATCHES wrapped SOL (F2), skips foreign owners, and never drops a referenced account to fit the cap (F3)', () => {
  const u = keypair();
  const bonk = holding(u, 1000n);
  const parsed = parseTokenAccount(tokenAccountData(bonk));
  assert.deepEqual(parsed, { mint: bonk.mint, owner: u.address, amount: 1000n });
  assert.equal(parseTokenAccount(Buffer.alloc(100)), null, 'too short');
  const uninit = tokenAccountData(bonk); uninit[108] = 0;
  assert.equal(parseTokenAccount(uninit), null, 'uninitialized');
  const a1 = base58(randomKey()), a2 = base58(randomKey());
  assert.deepEqual(parseLookupTable(lookupTableData([a1, a2])), [a1, a2]);
  assert.equal(parseLookupTable(Buffer.alloc(57)), null, 'ragged table');

  // task-1337 F2: wrapped SOL IS watched now (its loss is SOL-value out, bounded by checkWsolBound).
  const wsol = associatedTokenAddress(u.address, WSOL_MINT, TOKEN_PROGRAM);
  const foreign = holding(keypair(), 5n); // not ours → never watched
  const big = holding(u, 9_000_000n);
  let watch = buildTokenWatch(u.address, [
    { pubkey: wsol, data: tokenAccountData({ mint: WSOL_MINT, owner: u.address, amount: 10n }) },
    { pubkey: foreign.pubkey, data: tokenAccountData(foreign) },
    { pubkey: big.pubkey, data: tokenAccountData(big) },
  ], new Set([wsol]));
  const wsolWatch = watch.find((w) => w.address === wsol);
  assert.ok(wsolWatch && wsolWatch.isWsol === true, 'wrapped SOL is watched and flagged isWsol (task-1337 F2)');
  assert.ok(!watch.some((w) => w.address === foreign.pubkey), 'foreign-owned accounts are never watched');

  // task-1337 F3: a referenced account is NEVER dropped to fit the cap; only the unreferenced tail is bounded.
  const refMany: FakeTokenAccount[] = Array.from({ length: 3 }, () => holding(u, 1n)); // tiny, but referenced
  const unrefMany: FakeTokenAccount[] = Array.from({ length: MAX_TOKEN_WATCH + 10 }, (_, i) => holding(u, BigInt(1000 + i)));
  const referenced = new Set(refMany.map((t) => t.pubkey));
  watch = buildTokenWatch(u.address, [...refMany, ...unrefMany].map((t) => ({ pubkey: t.pubkey, data: tokenAccountData(t) })), referenced);
  assert.equal(watch.length, MAX_TOKEN_WATCH, 'the list is bounded to the cap');
  for (const t of refMany) assert.ok(watch.some((w) => w.address === t.pubkey), 'every referenced account survives the cap');
  assert.ok(watch.filter((w) => !w.referenced).every((w) => w.pre >= 1000n), 'the unreferenced tail keeps the largest balances');
  assert.equal(referencedOverCap(watch), false, 'the referenced count is within the cap here');

  // more referenced accounts than one simulation can carry → referencedOverCap flags it (the executor refuses)
  const tooMany: FakeTokenAccount[] = Array.from({ length: MAX_TOKEN_WATCH + 1 }, () => holding(u, 1n));
  const over = buildTokenWatch(u.address, tooMany.map((t) => ({ pubkey: t.pubkey, data: tokenAccountData(t) })), new Set(tooMany.map((t) => t.pubkey)));
  assert.equal(referencedOverCap(over), true, 'all referenced and over the cap → refuse (never silently drop a referenced account)');
  assert.ok(over.every((w) => w.referenced), 'the list kept the referenced accounts rather than truncating them');

  // referencedAccounts: static keys + every loaded lookup entry; an unreadable table → null
  const tx = { staticKeys: [u.address, a1], lookups: [{ table: 'T', writable: [0], readonly: [1] }] } as unknown as DecodedTransaction;
  assert.deepEqual([...referencedAccounts(tx, new Map([['T', [a2, bonk.pubkey]]]))!].sort(), [u.address, a1, a2, bonk.pubkey].sort());
  assert.equal(referencedAccounts(tx, new Map()), null, 'table not read → unknowable');
  assert.equal(referencedAccounts(tx, new Map([['T', [a2]]])), null, 'index past the table → unknowable');
});

test('token-delta (pure): the rules — buy: nothing decreases; sell: only the order mint, up to the amount; null post = closed (referenced) or untouched (unreferenced); missing post with a balance = unknown', () => {
  const u = keypair();
  const order = base58(randomKey()), other = base58(randomKey());
  const w = (address: string, mint: string, pre: bigint, referenced = true): TokenWatch => ({ address, mint, pre, referenced });
  const A = base58(randomKey()), B = base58(randomKey()), C = base58(randomKey());
  const watch = [w(A, order, 1000n), w(B, other, 50n), w(C, other, 0n, false)];
  const post = (m: Record<string, bigint | null>) => new Map(Object.entries(m));
  assert.equal(checkTokenDeltas('buy', order, 10n, watch, post({ [A]: 1000n, [B]: 50n, [C]: 0n })).ok, true, 'unchanged');
  assert.equal(checkTokenDeltas('buy', order, 10n, watch, post({ [A]: 1500n, [B]: 50n, [C]: 7n })).ok, true, 'increases are fine');
  let r = checkTokenDeltas('buy', order, 10n, watch, post({ [A]: 999n, [B]: 50n, [C]: 0n }));
  assert.equal(r.ok, false); assert.equal((r as { reason: string }).reason, 'token-delta');
  r = checkTokenDeltas('sell', order, 400n, watch, post({ [A]: 600n, [B]: 50n, [C]: 0n }));
  assert.equal(r.ok, true, 'sell spends exactly the order from the order mint'); assert.equal((r as { spent: bigint }).spent, 400n);
  r = checkTokenDeltas('sell', order, 400n, watch, post({ [A]: 599n, [B]: 50n, [C]: 0n }));
  assert.equal(r.ok, false, 'one base unit more than the order'); assert.match((r as { message: string }).message, /spends 401/);
  r = checkTokenDeltas('sell', order, 400n, watch, post({ [A]: 600n, [B]: 49n, [C]: 0n }));
  assert.equal(r.ok, false, 'a sell may not touch another mint'); assert.match((r as { message: string }).message, /does not spend/);
  r = checkTokenDeltas('buy', order, 10n, watch, post({ [A]: null, [B]: 50n, [C]: 0n }));
  assert.equal(r.ok, false, 'a referenced account that comes back null was closed: fully drained');
  assert.equal(checkTokenDeltas('buy', order, 10n, [w(C, other, 5n, false)], post({ [C]: null })).ok, true, 'an unreferenced account cannot change: null = untouched');
  r = checkTokenDeltas('buy', order, 10n, watch, post({ [A]: 1000n }));
  assert.equal(r.ok, false); assert.equal((r as { reason: string }).reason, 'token-delta-unknown');
  assert.equal(checkTokenDeltas('buy', order, 10n, [w(C, other, 0n)], null).ok, true, 'no data but nothing to lose: fine');
  r = checkTokenDeltas('buy', order, 10n, watch, null);
  assert.equal((r as { reason: string }).reason, 'token-delta-unknown', 'no data with holdings: unknown');
  // postBalances maps the simulate accounts[] (offset 1: the wallet is first) onto the watch
  const pb = postBalances(watch, [Buffer.alloc(0), tokenAccountData({ mint: order, owner: u.address, amount: 7n }), null, Buffer.alloc(0)], 1)!;
  assert.equal(pb.get(A), 7n); assert.equal(pb.get(B), null); assert.equal(pb.get(C), 0n);
  assert.equal(postBalances(watch, [Buffer.alloc(0)], 1), null, 'fewer accounts than asked → unknowable');
  assert.equal(postBalances(watch, null, 1), null);
});

test('token-delta (pure): wrapped SOL is tallied as wsolLost (not a per-account refusal); checkWsolBound bounds solOut + wsolLost against the plan (task-1337 F2)', () => {
  const order = base58(randomKey());
  const wsolA = base58(randomKey()), wsolB = base58(randomKey());
  const wsolW = (address: string, pre: bigint): TokenWatch => ({ address, mint: WSOL_MINT, pre, referenced: true, isWsol: true });
  const post = (m: Record<string, bigint | null>) => new Map(Object.entries(m));
  // draining two PRE-EXISTING WSOL accounts does NOT trip token-delta: it is tallied as wsolLost instead
  const watch = [wsolW(wsolA, 10_000_000_000n), wsolW(wsolB, 10_000_000_000n)];
  const r = checkTokenDeltas('buy', order, 0n, watch, post({ [wsolA]: 0n, [wsolB]: 0n }));
  assert.equal(r.ok, true, 'wrapped SOL leaving is not itself a token-delta refusal');
  assert.equal((r as { wsolLost: bigint }).wsolLost, 20_000_000_000n, 'all the wrapped SOL that left is tallied');

  const allowance = 10_000_000n; // the fee overhead allowance (0.01 SOL)
  // the combined SOL-value bound catches the drain: 20 SOL of WSOL out, ~0.5 SOL plan leg → refuse
  let b = checkWsolBound('buy', 5_000n, 20_000_000_000n, 500_000_000n, allowance);
  assert.equal(b.ok, false); assert.equal((b as { reason: string }).reason, 'wsol-drain');
  // a legit wrap/unwrap returns the wrapped SOL to the wallet as native SOL (solOut negative) → within budget
  b = checkWsolBound('buy', -500_000_000n, 500_000_000n, 500_000_000n, allowance);
  assert.equal(b.ok, true, 'wrapping the planned SOL leg and unwrapping it back is within budget');
  assert.equal(checkWsolBound('buy', 999n, 0n, 0n, allowance).ok, true, 'no wrapped SOL touched → cheap pass');
  assert.equal(checkWsolBound('buy', null, 1n, 0n, allowance).ok, false, 'WSOL gone but native delta unknown → refuse');
  // sell: incoming proceeds must never excuse a drain — WSOL out beyond fee dust is refused
  assert.equal(checkWsolBound('sell', -10_000_000_000n, 20_000_000n, 0n, allowance).ok, false, 'a sell cannot drain WSOL under cover of its SOL proceeds');
  assert.equal(checkWsolBound('sell', -10_000_000_000n, allowance, 0n, allowance).ok, true, 'fee-dust WSOL movement on a sell is fine');
});

test('token-delta (executor): a buy whose simulation drains another token account of the wallet is refused at BUILD — the watched account rode along in the simulation, nothing was signed', async () => {
  // honest control first: the same holding, untouched by the simulation
  const ctl = mk();
  try {
    const bonk = holding(ctl.user, 1_000_000n);
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [bonk] }); // post = pre: untouched
    Object.assign(ctl.rpc, rpc, { calls: rpc.calls });
    const v = await ctl.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, true, show(v.policy)); assert.equal(v.precheck.ok, true, show(v.precheck));
    assert.ok(rpc.calls.simulatedAccounts[0].includes(bonk.pubkey), `the holding was simulated: ${show(rpc.calls.simulatedAccounts[0])}`);
    assert.equal(rpc.calls.tokenAccounts, 2, 'both token programs were listed');
    const c = await ctl.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'filled', show(c));
    assert.equal(rpc.calls.simulate, 2); assert.ok(rpc.calls.simulatedAccounts[1].includes(bonk.pubkey), 'and again on the signed bytes');
  } finally { ctl.done(); }
  // the attack: the simulation shows the holding emptied
  const h = mk();
  try {
    const bonk = holding(h.user, 1_000_000n);
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [bonk], postTokenAmount: () => 0n });
    Object.assign(h.rpc, rpc, { calls: rpc.calls });
    const v = await h.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false, 'the plan carries the refusal'); assert.equal(v.policy.reason, 'token-delta', show(v.policy));
    assert.match(v.policy.message ?? '', /1000000 base units/);
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'token-delta');
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal((c as { reason: string }).reason, 'token-delta');
    assert.equal(h.signs(), 0, 'never signed'); assert.equal(rpc.calls.submit, 0, 'never submitted');
    assert.equal(rpc.calls.simulate, 1, 'simulated once (at build); a refused plan is not re-simulated');
  } finally { h.done(); }
});

test('token-delta (executor): a sell may spend exactly the order amount from the order mint\'s account; one unit more, or any other account decreasing, is refused', async () => {
  const sellOut = 10_000_000n; // 0.01 SOL for 1 USDC
  const amount = 1_000_000n;
  const sellQuote = { inputMint: TEST_MINT, outputMint: SOL_MINT, inAmount: amount.toString(), outAmount: sellOut.toString(), otherAmountThreshold: (sellOut - 50_000n).toString(), priceImpactPct: '0.001' };
  const sellParams = { mint: TEST_MINT, symbol: 'USDC', side: 'sell' as const, decimals: 6, amountRaw: amount.toString(), slippageBps: TEST_SLIPPAGE_BPS };
  const run = async (name: string, post: (usdcAta: string, other: string) => Record<string, bigint | undefined>, expectOk: boolean) => {
    const h = mk({ quote: sellQuote, ixs: (u) => jupiterSellIxs(u, TEST_MINT, amount, sellOut) });
    try {
      const usdcAta = associatedTokenAddress(h.user.address, TEST_MINT, TOKEN_PROGRAM);
      const other = holding(h.user, 777n);
      const map = post(usdcAta, other.pubkey);
      const rpc = fakeRpc({ url: DEVNET_RPC, solOut: -(sellOut - 5_000n), tokenAccounts: [{ pubkey: usdcAta, mint: TEST_MINT, owner: h.user.address, amount: 5_000_000n }, other], postTokenAmount: (a) => map[a] });
      Object.assign(h.rpc, rpc, { calls: rpc.calls });
      const v = await h.service.plan(sellParams);
      assert.equal(v.policy.ok, expectOk, `${name}: ${show(v.policy)}`);
      if (!expectOk) { assert.equal(v.policy.reason, 'token-delta', name); assert.equal(h.signs(), 0); }
      else { const c = await h.service.confirm({ hash: v.hash }); assert.equal(c.kind, 'filled', `${name}: ${show(c)}`); }
    } finally { h.done(); }
  };
  await run('spends exactly the order', (ata) => ({ [ata]: 4_000_000n }), true);
  await run('spends nothing (route failed quietly)', () => ({}), true);
  await run('spends one unit more than the order', (ata) => ({ [ata]: 3_999_999n }), false);
  await run('another token account decreases', (ata, other) => ({ [ata]: 4_000_000n, [other]: 0n }), false);
});

test('token-delta (executor): a buy whose simulation drains a PRE-EXISTING wrapped-SOL account beyond the plan\'s SOL leg is refused (wsol-drain) — SOL-value out, not a free pass (task-1337 F2)', async () => {
  // control: a legit buy that leaves the wallet's existing wrapped SOL untouched fills
  const ctl = mk();
  try {
    const wsolAta = associatedTokenAddress(ctl.user.address, WSOL_MINT, TOKEN_PROGRAM);
    const wsolAcct = { pubkey: wsolAta, mint: WSOL_MINT, owner: ctl.user.address, amount: 2_000_000_000n };
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [wsolAcct] }); // post = pre: untouched
    Object.assign(ctl.rpc, rpc, { calls: rpc.calls });
    const v = await ctl.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, true, show(v.policy));
    assert.ok(rpc.calls.simulatedAccounts[0].includes(wsolAta), 'the wrapped-SOL account rode along in the simulation');
    const c = await ctl.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'filled', show(c));
  } finally { ctl.done(); }
  // attack: the simulation empties the pre-existing WSOL account (2 SOL) — far beyond the ~0.5 SOL plan leg
  const h = mk();
  try {
    const wsolAta = associatedTokenAddress(h.user.address, WSOL_MINT, TOKEN_PROGRAM);
    const wsolAcct = { pubkey: wsolAta, mint: WSOL_MINT, owner: h.user.address, amount: 2_000_000_000n };
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [wsolAcct], postTokenAmount: () => 0n });
    Object.assign(h.rpc, rpc, { calls: rpc.calls });
    const v = await h.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false, show(v.policy)); assert.equal(v.policy.reason, 'wsol-drain', show(v.policy));
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused', show(c)); assert.equal((c as { reason: string }).reason, 'wsol-drain');
    assert.equal(h.signs(), 0, 'never signed'); assert.equal(rpc.calls.submit, 0, 'never submitted');
  } finally { h.done(); }
});

test('token-delta (executor): a transaction that references MORE of the wallet\'s token accounts than one simulation can carry is refused, never silently truncated (task-1337 F3)', async () => {
  const h = mk();
  try {
    const held = Array.from({ length: MAX_TOKEN_WATCH + 1 }, () => holding(h.user, 1_000n));
    const ixs = jupiterSwapIxs(h.user, BUY_LAMPORTS);
    for (const t of held) ixs[4].accounts.push(t.pubkey); // the route names every one of them
    const t = buildTx({ feePayer: h.user.pub, ixs });
    (h.deps.build as unknown as { buildSwap: () => Promise<unknown> }).buildSwap = async () => ({ swapTransactionBase64: t.unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 0, quote: buyQuote() });
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: held });
    Object.assign(h.rpc, rpc, { calls: rpc.calls });
    const v = await h.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false, show(v.policy));
    assert.equal(v.policy.reason, 'token-delta-unknown', show(v.policy));
    assert.match(v.policy.message ?? '', /more of the wallet/);
    assert.equal(h.rpc.calls.simulate, 0, 'refused before simulating — the accounts cannot all ride along');
    assert.equal(h.signs(), 0, 'never signed');
  } finally { h.done(); }
});

test('token-delta (executor): a referenced account that the simulation closes is a drain; an account the transaction cannot touch coming back null is untouched', async () => {
  const closedRef = mk({ ixs: (u) => { const ixs = jupiterSwapIxs(u, BUY_LAMPORTS); return ixs; } });
  try {
    const bonk = holding(closedRef.user, 42n);
    // reference the holding in the route's opaque remaining accounts (the policy does not read those)
    const ixs = jupiterSwapIxs(closedRef.user, BUY_LAMPORTS);
    ixs[4].accounts.push(bonk.pubkey);
    const t = buildTx({ feePayer: closedRef.user.pub, ixs });
    (closedRef.deps.build as unknown as { buildSwap: () => Promise<unknown> }).buildSwap = async () => ({ swapTransactionBase64: t.unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 0, quote: buyQuote() });
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [bonk], postTokenAmount: () => null });
    Object.assign(closedRef.rpc, rpc, { calls: rpc.calls });
    const v = await closedRef.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false); assert.equal(v.policy.reason, 'token-delta', show(v.policy));
    assert.match(v.policy.message ?? '', /moves 42 base units/);
  } finally { closedRef.done(); }
  const untouched = mk();
  try {
    const bonk = holding(untouched.user, 42n); // NOT in the transaction
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [bonk], postTokenAmount: () => null });
    Object.assign(untouched.rpc, rpc, { calls: rpc.calls });
    const v = await untouched.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, true, show(v.policy));
  } finally { untouched.done(); }
});

test('token-delta (executor): fail closed — holdings but a node that reports no account data, or an RPC that cannot list token accounts, refuse (token-delta-unknown); no holdings and no data still passes', async () => {
  const noData = mk();
  try {
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [holding(noData.user, 1n)], noAccountData: true });
    Object.assign(noData.rpc, rpc, { calls: rpc.calls });
    const v = await noData.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false); assert.equal(v.policy.reason, 'token-delta-unknown', show(v.policy));
  } finally { noData.done(); }
  const unreadable = mk({ rpc: { readFail: true } });
  try {
    const v = await unreadable.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false); assert.equal(v.policy.reason, 'token-delta-unknown', show(v.policy));
    assert.equal(unreadable.rpc.calls.simulate, 0, 'not even simulated');
  } finally { unreadable.done(); }
  const empty = mk({ rpc: { noAccountData: true } });
  try {
    const v = await empty.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, true, 'nothing to lose → the older harness behaviour is unchanged');
  } finally { empty.done(); }
});

test('token-delta (executor): honest at build, hostile on the SIGNED bytes — the confirm re-reads balances, re-simulates, refuses, refunds, submits nothing', async () => {
  const h = mk({ network: 'mainnet', caps: { perTradeUsd: 100, dailyUsd: 500 } }); // --mainnet --max-usd 100 --daily-usd 500: a $75 trade fits
  try {
    const bonk = holding(h.user, 9_000n);
    const rpc = fakeRpc({ url: MAINNET_RPC, tokenAccounts: [bonk], postTokenAmount: (_a, call) => (call === 0 ? undefined : 0n) });
    Object.assign(h.rpc, rpc, { calls: rpc.calls });
    const v = await h.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, true, show(v.policy)); assert.equal(v.precheck.ok, true, show(v.precheck));
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused', show(c)); assert.equal((c as { reason: string }).reason, 'token-delta');
    assert.match((c as { message: string }).message, /re-simulation/);
    assert.equal(rpc.calls.submit, 0, 'the signed bytes never reached the chain');
    assert.equal(h.ledger.spentToday(), 0, 'the $75 USD reservation was refunded');
    assert.equal(rpc.calls.accountsInfo >= 1, true, 'pre-balances were re-read at confirm');
    assert.equal(rpc.calls.simulate, 2);
  } finally { h.done(); }
});

test('token-delta (executor): a v0 transaction with an address-lookup table — the table is read so an account it loads counts as referenced; an unreadable table refuses', async () => {
  const table = randomKey();
  const readable = mk({ version: 0, lookups: [{ table, writable: [0], readonly: [] }] });
  try {
    const bonk = holding(readable.user, 5n);
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [bonk], postTokenAmount: () => null, accounts: { [base58(table)]: { owner: 'AddressLookupTab1e1111111111111111111111111', data: lookupTableData([bonk.pubkey]) } } });
    Object.assign(readable.rpc, rpc, { calls: rpc.calls });
    const v = await readable.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false); assert.equal(v.policy.reason, 'token-delta', `loaded through the table, closed by the simulation → drained: ${show(v.policy)}`);
    assert.ok(rpc.calls.accountsInfo >= 1, 'the table was fetched');
  } finally { readable.done(); }
  const unreadable = mk({ version: 0, lookups: [{ table, writable: [0], readonly: [] }] });
  try {
    const rpc = fakeRpc({ url: DEVNET_RPC, tokenAccounts: [holding(unreadable.user, 5n)] }); // holdings, but the table is not readable
    Object.assign(unreadable.rpc, rpc, { calls: rpc.calls });
    const v = await unreadable.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false); assert.equal(v.policy.reason, 'token-delta-unknown', show(v.policy));
    assert.match(v.policy.message ?? '', /lookup table/);
    assert.equal(rpc.calls.simulate, 0, 'not simulated');
  } finally { unreadable.done(); }
  const nothingHeld = mk({ version: 0, lookups: [{ table, writable: [0], readonly: [] }] });
  try {
    const v = await nothingHeld.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, true, 'no holdings → the unreadable table cannot matter (nothing to drain)');
  } finally { nothingHeld.done(); }
});

test('caps: without --mainnet, --max-sol-out and --max-slippage-bps are downward-only too (verify-1328 minor); --mainnet honours them up to the hard ceilings', () => {
  assert.equal(capsOnlyDownward(defaultCaps({ maxSlippageBps: 900, maxSolOut: 3 })).maxSlippageBps, DEFAULT_MAX_SLIPPAGE_BPS);
  assert.equal(capsOnlyDownward(defaultCaps({ maxSlippageBps: 900, maxSolOut: 3 })).maxSolOut, DEFAULT_MAX_SOL_OUT);
  assert.equal(capsOnlyDownward(defaultCaps({ maxSlippageBps: 100, maxSolOut: 0.2 })).maxSlippageBps, 100, 'lower is honoured');
  assert.equal(capsOnlyDownward(defaultCaps({ maxSlippageBps: 100, maxSolOut: 0.2 })).maxSolOut, 0.2);
  const a = parseSignerArgs(['--max-slippage-bps', '900', '--max-sol-out', '3']);
  assert.equal(a.caps.maxSlippageBps, 500); assert.equal(a.caps.maxSolOut, 1);
  const m = parseSignerArgs(['--mainnet', '--max-slippage-bps', '900', '--max-sol-out', '3', '--rpc', MAINNET_RPC]);
  assert.equal(m.caps.maxSlippageBps, 900); assert.equal(m.caps.maxSolOut, 3);
  assert.throws(() => parseSignerArgs(['--mainnet', '--max-slippage-bps', '1001', '--rpc', MAINNET_RPC]), /ceiling/);
});

test('simulation: a node that answers simulateTransaction with a JSON-RPC error (devnet simulating a mainnet route) yields a plan whose simulation FAILED and a caps refusal, not an opaque build error; a transport error still fails closed', async () => {
  const { RpcRejectedError } = await import('../src/trade/rpc-exec.ts');
  const rejected = mk();
  try {
    (rejected.rpc as unknown as { simulate: unknown }).simulate = async () => { throw new RpcRejectedError('simulateTransaction', 'invalid transaction: Transaction loads an address table account that doesn\'t exist', -32602, null); };
    const v = await rejected.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, true, 'the static policy passed');
    assert.equal(v.sim.ran, true); assert.equal(v.sim.ok, false); assert.match(v.sim.error ?? '', /invalid transaction/);
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'simulation-failed', show(v.precheck));
    const c = await rejected.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal((c as { reason: string }).reason, 'simulation-failed');
    assert.equal(rejected.signs(), 0);
  } finally { rejected.done(); }
  const transport = mk();
  try {
    (transport.rpc as unknown as { simulate: unknown }).simulate = async () => { throw new Error('socket hang up'); };
    await assert.rejects(transport.service.plan(BUY_PARAMS), (e: { reason: string }) => e.reason === 'build-failed', 'a transport error is still a hard failure (nothing to show)');
  } finally { transport.done(); }
});

// ============================================================================================ A2. the lazily started signer client

test('signer client: a client that has not started yet is ALIVE (the signer spawns on first use); it is dead only after exit/kill/close — the real app could never enter LIVE before this fix', async () => {
  const { SignerClient, SignerUnavailableError } = await import('../src/trade/signer/client.ts');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1337-signer-'));
  const c = new SignerClient({ entry: fileURLToPath(new URL('./signer-fake-host.ts', import.meta.url)), argv: ['--dir', dir], readyTimeoutMs: 20_000 });
  try {
    assert.equal(c.alive, true, 'before start(): the ticket\'s liveUnavailable() must not call this "died"');
    assert.equal(c.pid, null, 'and indeed nothing has been spawned yet');
    const s = await c.status(); // first use spawns + handshakes
    assert.equal(c.alive, true); assert.ok(c.pid); assert.equal(s.network, 'devnet');
    process.kill(c.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(c.alive, false, 'dead after the process is gone');
    await assert.rejects(c.status(), SignerUnavailableError);
    await assert.rejects(c.start(), SignerUnavailableError, 'never respawned');
  } finally { c.close(); rmSync(dir, { recursive: true, force: true }); }
  const never = new SignerClient({ entry: '/nonexistent/signer.ts' });
  assert.equal(never.alive, true, 'alive until it fails');
  await assert.rejects(never.start(), SignerUnavailableError);
  assert.equal(never.alive, false, 'a spawn that fails marks it dead');
  never.close();
});

// ============================================================================================ B. HIGH-findings ledger (signer side)

test('HIGH ledger · heavy verify CRITICAL #1 (impact unit): Jupiter\'s 0.9467 fraction is 94.67% on the plan and the signer refuses it (price-impact); nothing signed', async () => {
  const h = mk({ quote: { priceImpactPct: '0.9467' } });
  try {
    const v = await h.service.plan(BUY_PARAMS);
    assert.ok(Math.abs((v.priceImpactPct ?? 0) - 94.67) < 0.001, `plan shows ${v.priceImpactPct}%`);
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'price-impact');
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal((c as { reason: string }).reason, 'price-impact');
    assert.equal(h.signs(), 0); assert.equal(h.rpc.calls.submit, 0);
  } finally { h.done(); }
  const edge = mk({ quote: { priceImpactPct: '0.0300001' } });
  try { assert.equal((await edge.service.plan(BUY_PARAMS)).precheck.reason, 'price-impact', 'just over 3% refuses'); } finally { edge.done(); }
});

test('HIGH ledger · heavy verify #2 (signed bytes not bound): the wallet returns a different transaction → tx-mismatch at the signer, never submitted, reservation refunded', async () => {
  const h = mk({ network: 'mainnet', caps: { perTradeUsd: 100, dailyUsd: 500 }, sign: (_t, u) => buildTx({ feePayer: u.pub, ixs: jupiterSwapIxs(u, 5_000_000_000n, { outAmount: 20_000_000n }) }).sign(u) });
  try {
    const v = await h.service.plan(BUY_PARAMS);
    assert.equal(v.precheck.ok, true, show(v.precheck));
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal((c as { reason: string }).reason, 'tx-mismatch', show(c));
    assert.equal(h.signs(), 1, 'the wallet was asked once'); assert.equal(h.rpc.calls.submit, 0); assert.equal(h.ledger.spentToday(), 0, 'the $75 reservation was refunded');
  } finally { h.done(); }
});

test('HIGH ledger · heavy verify #3 / re-verify #1 (caps trusted Jupiter\'s numbers): swapUsdValue "0" is ignored — the signer prices 0.5 SOL × $150 locally and refuses the OVER-CAP ticket (per-trade-cap $5); a quote whose inAmount is not the order is quote-mismatch; the daily cap counts prior spend', async () => {
  const over = mk({ network: 'mainnet', quote: { swapUsdValue: '0' } });
  try {
    const v = await over.service.plan(BUY_PARAMS);
    assert.ok(v.notionalUsd && Math.abs(v.notionalUsd - 75) < 0.2, `priced locally: $${v.notionalUsd}`);
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'per-trade-cap', show(v.precheck));
    const c = await over.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal((c as { reason: string }).reason, 'per-trade-cap');
    assert.equal(over.signs(), 0); assert.equal(over.rpc.calls.submit, 0); assert.equal(over.ledger.spentToday(), 0);
  } finally { over.done(); }
  const mism = mk({ network: 'mainnet', quote: { inAmount: '1' } });
  try {
    const v = await mism.service.plan(BUY_PARAMS);
    assert.equal(v.policy.ok, false); assert.equal(v.policy.reason, 'quote-mismatch', show(v.policy));
    assert.equal(mism.rpc.calls.simulate, 0, 'never built or simulated');
  } finally { mism.done(); }
  // a $3 trade (0.02 SOL × $150) fits the per-trade cap but not the remaining daily budget after $18
  const daily = mk({ network: 'mainnet', spentToday: 18, quote: { inAmount: '20000000' }, ixs: (u) => jupiterSwapIxs(u, 20_000_000n), rpc: { solOut: 20_005_000n } });
  try {
    const v = await daily.service.plan({ ...BUY_PARAMS, amountRaw: '20000000' });
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'daily-cap', show(v.precheck));
    const c = await daily.service.confirm({ hash: v.hash });
    assert.equal((c as { reason: string }).reason, 'daily-cap'); assert.equal(daily.signs(), 0);
  } finally { daily.done(); }
});

test('HIGH ledger · heavy verify #4 / re-verify MED #5 (devnet label vs the real chain): the signer classifies the network from the RPC URL it talks to; a mainnet URL containing "devnet" is mainnet and a plan without --mainnet is refused', async () => {
  assert.equal(rpcNetwork('https://mainnet.helius-rpc.com/?api-key=devnet-team-key'), 'mainnet');
  assert.equal(rpcNetwork('https://api.mainnet-beta.solana.com/#testnet'), 'mainnet');
  assert.equal(rpcNetwork(DEVNET_RPC), 'devnet');
  const h = mk({ network: 'devnet', rpc: { url: 'https://mainnet.helius-rpc.com/?api-key=devnet-team-key' } });
  try {
    assert.equal(h.service.status().network, 'mainnet', 'the label says devnet, the endpoint says mainnet → mainnet');
    const v = await h.service.plan(BUY_PARAMS);
    assert.equal(v.network, 'mainnet');
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'mainnet-not-enabled', show(v.precheck));
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal(h.signs(), 0);
  } finally { h.done(); }
  assert.throws(() => parseSignerArgs(['--rpc', 'https://mainnet.helius-rpc.com/?api-key=devnet-team-key']), /devnet endpoint/, 'the production signer refuses to start that way');
});

test('HIGH ledger · heavy re-verify #2 (SOL/USD had no sanity bound): a tiny price, a single source, a Jupiter-only feed or a stale feed all refuse a mainnet plan (no-usd-value)', async () => {
  const cases: [string, () => unknown][] = [
    ['two sources at $0.0001', () => solUsdSamples(0.0001, T0)],
    ['one source', () => [{ price: 150, fetchedAt: T0, source: 'dexscreener' }]],
    ['jupiter only', () => [{ price: 150, fetchedAt: T0, source: 'jupiter' }, { price: 150, fetchedAt: T0, source: 'jupiter-price' }]],
    ['61 s stale', () => solUsdSamples(150, T0 - 61_000)],
    ['a bare number (legacy feed)', () => 150],
  ];
  for (const [name, solUsd] of cases) {
    const h = mk({ network: 'mainnet', solUsd });
    try {
      const v = await h.service.plan(BUY_PARAMS);
      assert.equal(v.precheck.ok, false, name); assert.equal(v.precheck.reason, 'no-usd-value', `${name}: ${show(v.precheck)}`);
      assert.equal(v.solUsd.price, null, name);
    } finally { h.done(); }
  }
});

test('HIGH ledger · round-2 verify HIGH (SPL drain): a /swap response that is a Token Transfer to an attacker, or an honest route plus one, is refused by the static policy before any simulation', async () => {
  const attacker = randomKey();
  const drains: [string, (u: Keypair) => IxSpec[]][] = [
    ['bare SPL Transfer, no route', (u) => [computeBudgetIx(), tokenIx(3, [Buffer.from(base58Decode(associatedTokenAddress(u.address, TEST_MINT, TOKEN_PROGRAM))), attacker, u.pub], (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(2n ** 64n - 1n); return b; })())]],
    ['honest route plus an appended Transfer', (u) => [...jupiterSwapIxs(u, BUY_LAMPORTS), tokenIx(3, [randomKey(), attacker, u.pub], Buffer.alloc(8))]],
    ['honest route plus a Token-2022 TransferChecked', (u) => [...jupiterSwapIxs(u, BUY_LAMPORTS), { program: TOKEN_2022_PROGRAM, accounts: [randomKey(), randomKey(), attacker, u.pub], data: Buffer.alloc(10, 12) }]],
    ['honest route plus a Burn', (u) => [...jupiterSwapIxs(u, BUY_LAMPORTS), tokenIx(8, [randomKey(), randomKey(), u.pub], Buffer.alloc(8))]],
  ];
  for (const [name, ixs] of drains) {
    const h = mk({ network: 'mainnet', ixs });
    try {
      const v = await h.service.plan(BUY_PARAMS);
      assert.equal(v.policy.ok, false, name); assert.equal(v.policy.reason, 'forbidden-instruction', `${name}: ${show(v.policy)}`);
      assert.equal(h.rpc.calls.simulate, 0, `${name}: never simulated`);
      const c = await h.service.confirm({ hash: v.hash });
      assert.equal(c.kind, 'refused', name); assert.equal(h.signs(), 0, name);
    } finally { h.done(); }
  }
});

test('HIGH ledger · wiring: the signer surface has no sign/submit method, and an over-cap or refused plan stays refused however the UI asks', async () => {
  const h = mk({ network: 'mainnet', quote: { swapUsdValue: '0' } });
  try {
    const v = await h.service.plan(BUY_PARAMS);
    for (const m of ['sign', 'submit', 'setCaps', 'arm', 'signIfArmed', 'raiseCaps']) await assert.rejects(h.service.call(m, { hash: v.hash, tx: 'AQAB' }), /unknown method/, m);
    assert.equal((await h.service.call('precheck', { hash: v.hash }) as { reason: string }).reason, 'per-trade-cap');
    const c = await h.service.call('confirm', { hash: v.hash }) as { kind: string; reason: string };
    assert.equal(c.kind, 'refused'); assert.equal(c.reason, 'per-trade-cap');
    assert.equal(h.signs(), 0); assert.equal(h.rpc.calls.submit, 0);
    const d = decodeTransaction(Buffer.from(buildTx({ feePayer: h.user.pub, ixs: jupiterSwapIxs(h.user, BUY_LAMPORTS) }).unsigned, 'base64'));
    assert.ok(d.instructions.length > 0);
  } finally { h.done(); }
});
