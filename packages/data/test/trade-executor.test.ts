// task-1310 T1 — the live executor's SAFE PIPELINE and its refusals (SPEC §6.1/§6.2/§6.5). Fakes for
// build/rpc/bridge keep it offline; the point is the ORDER of checks and that a refused trade NEVER
// reaches the wallet-sign step. Threat-model flavour: a compromised UI that mutates the plan after it
// was shown, or asks past the caps, is refused by the signer-side policy regardless.
//
// Round 2: the fake transactions are REAL Solana wire-format v0 transactions (a Jupiter-shaped swap),
// signed with a throwaway Ed25519 key, because the executor now decodes, policy-checks and
// signature-verifies the bytes. The fake RPC reports pre/post balances for the SOL-delta checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/clock.ts';
import { SOL_MINT, type PaperOrder } from '../src/paper.ts';
import { defaultCaps, CapLedger, type TradeNetwork } from '../src/trade/caps.ts';
import { DEVNET_RPC, MAINNET_RPC } from '../src/trade/rpc-exec.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { LiveExecutor, LiveLedger, type LiveExecutorDeps } from '../src/trade/executor.ts';
import { keypair, buildTx, jupiterSwapIxs, fakeRpc, solUsdSamples, type Keypair, type FakeRpc, type BuiltTx } from './trade-helpers.ts';

/** JSON for assertion messages; the fill carries bigints. */
export const show = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USER: Keypair = keypair();
const PK = USER.address;

function rawQuote(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputMint: SOL_MINT, outputMint: MINT, inAmount: '500000000', outAmount: '2000000',
    otherAmountThreshold: '1990000', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.005',
    platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '3', ...over,
  };
}

function order(): PaperOrder {
  // 0.5 SOL on the SOL leg; at the harness default solUsd of $6 that is a $3 notional.
  return { mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, amountRaw: 500_000_000n, slippageBps: 50 };
}

interface HarnessOpts {
  network?: TradeNetwork; mainnet?: boolean; raw?: Record<string, unknown>; simOk?: boolean; simErr?: unknown;
  /** Local SOL/USD price for the DEFECT-3 notional (default $6 → a $3 trade on 0.5 SOL); null = no feed. */
  solUsd?: number | null;
  /** Override the RPC endpoint independently of the caps label (DEFECT 4). */
  rpcUrl?: string;
  /** Make the wallet return a tx whose message differs from the approved plan (DEFECT 2). */
  badSignedTx?: boolean;
  /** Override the per-trade / daily USD caps (DEFECT 5 — make the daily cap the binding constraint). */
  perTradeUsd?: number;
  dailyUsd?: number;
}
interface Harness { exec: LiveExecutor; signCalls: () => number; submitCalls: () => number; ledger: CapLedger; live: LiveLedger; rpc: FakeRpc; clock: FakeClock; dir: string; }

export function harness(opts: HarnessOpts = {}): Harness {
  const clock = new FakeClock(Date.UTC(2026, 9, 8, 12));
  let signs = 0;
  const ledger = new CapLedger({ clock });
  const live = new LiveLedger({ clock });
  const net = opts.network ?? 'devnet';
  // Every build gets a FRESH transaction (new blockhash/ATAs), like a real /swap; the fake wallet signs
  // exactly the tx it is handed (or, for badSignedTx, a different one with the same shape).
  const txs = new Map<string, BuiltTx>();
  const freshTx = (): BuiltTx => { const t = buildTx({ feePayer: USER.pub, ixs: jupiterSwapIxs(USER, 500_000_000n) }); txs.set(t.unsigned, t); return t; };
  const rpc = fakeRpc({ url: opts.rpcUrl ?? (net === 'mainnet' ? MAINNET_RPC : DEVNET_RPC), simOk: opts.simOk, simErr: opts.simErr });
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-exec-'));
  const deps: LiveExecutorDeps = {
    build: {
      quoteRaw: async () => opts.raw ?? rawQuote(),
      buildSwap: async () => ({ swapTransactionBase64: freshTx().unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 0, quote: opts.raw ?? rawQuote() }),
    } as unknown as LiveExecutorDeps['build'],
    rpc: rpc as unknown as LiveExecutorDeps['rpc'],
    bridge: {
      signTransaction: async (a: { unsignedTxBase64: string }) => {
        signs++;
        const t = opts.badSignedTx ? freshTx() : txs.get(a.unsignedTxBase64);
        if (!t) throw new Error('fake wallet was handed a tx it never saw');
        return { signedTxBase64: t.sign(USER), provider: 'stub', roundTripMs: 1 };
      },
    } as unknown as LiveExecutorDeps['bridge'],
    caps: defaultCaps({ network: net, mainnetEnabled: opts.mainnet ?? false, perTradeUsd: opts.perTradeUsd, dailyUsd: opts.dailyUsd }),
    ledger,
    liveLedger: live,
    clock,
    solUsd: () => (opts.solUsd === null ? null : solUsdSamples(opts.solUsd ?? 6, clock.now())),
    killSwitch: new KillSwitch(join(dir, 'trading.panic')),
  };
  return { exec: new LiveExecutor(deps), signCalls: () => signs, submitCalls: () => rpc.calls.submit, ledger, live, rpc, clock, dir };
}
const cleanup = (h: Harness) => rmSync(h.dir, { recursive: true, force: true });

test('buildPlan: quote -> build -> decode -> simulate yields a plan, unsigned tx and a binding hash', async () => {
  const h = harness();
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK });
  assert.equal(built.plan.simulated, true);
  assert.equal(built.plan.simOk, true);
  assert.equal(built.plan.network, 'devnet');
  assert.equal(built.plan.priceImpactPct, 0.5);
  assert.equal(built.plan.txPolicy.ok, true, 'a Jupiter-shaped swap passes the §6.2 policy');
  assert.equal(built.plan.solOutLamports, 500_005_000n, 'the simulated SOL delta is on the plan');
  assert.ok(built.unsignedTxBase64.length > 0);
  assert.equal(built.hash.length, 64, 'sha256 hex');
  cleanup(h);
});

test('devnet happy path: a good plan signs, submits, confirms and records — daily USD untouched', async () => {
  const h = harness();
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK });
  assert.equal(h.exec.precheck(built).ok, true);
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'filled', show(out));
  if (out.kind === 'filled') assert.equal(out.signature, 'SIG1');
  assert.equal(h.signCalls(), 1, 'the wallet bridge signed exactly once');
  assert.equal(h.submitCalls(), 1);
  assert.equal(h.rpc.calls.simulate, 2, 'simulated at build AND re-simulated at submit');
  assert.equal(h.ledger.spentToday(), 0, 'devnet records no USD against the daily cap');
  assert.equal(h.live.trades().length, 1, 'the fill was recorded');
  cleanup(h);
});

test('mainnet happy path within caps: charges the daily USD ledger', async () => {
  const h = harness({ network: 'mainnet', mainnet: true, raw: rawQuote({ swapUsdValue: '3' }) });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'mainnet' });
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'filled', show(out));
  // 0.500005 SOL actually leaves (fees) × $6.006 (the higher of two agreeing sources) ≈ $3.003
  assert.ok(Math.abs(h.ledger.spentToday() - 3.003) < 0.01, `mainnet fill charged ~$3 to the daily budget (got ${h.ledger.spentToday()})`);
  cleanup(h);
});

test('REFUSE (no sign): simulation failed', async () => {
  const h = harness({ simOk: false, simErr: 'insufficient funds for rent' });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK });
  assert.equal(built.plan.simOk, false);
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'simulation-failed');
  assert.equal(h.signCalls(), 0, 'a failed simulation NEVER reaches the wallet');
  cleanup(h);
});

test('REFUSE (no sign): price impact over 3%', async () => {
  const h = harness({ raw: rawQuote({ priceImpactPct: '0.075' }) }); // Jupiter fraction 0.075 == 7.5%
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK });
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'price-impact');
  assert.equal(h.signCalls(), 0);
  cleanup(h);
});

test('REFUSE (no sign): plan-hash mismatch — a plan edited after it was shown is void', async () => {
  const h = harness();
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK });
  const out = await h.exec.confirmAndSubmit(built, 'a-different-hash-the-user-never-saw', PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'plan-mismatch');
  assert.equal(h.signCalls(), 0, 'a mutated plan NEVER reaches the wallet');
  cleanup(h);
});

test('REFUSE (no sign): a mainnet plan without --mainnet', async () => {
  const h = harness({ network: 'devnet', mainnet: false });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'mainnet' });
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'mainnet-not-enabled');
  assert.equal(h.signCalls(), 0);
  cleanup(h);
});

test('REFUSE (no sign): mainnet over the per-trade USD cap', async () => {
  // Priced locally: 0.5 SOL × $24 = $12 > $5 per-trade cap (swapUsdValue is NOT trusted).
  const h = harness({ network: 'mainnet', mainnet: true, solUsd: 24 });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'mainnet' });
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'per-trade-cap');
  assert.equal(h.signCalls(), 0);
  assert.equal(h.ledger.spentToday(), 0, 'a refused trade charges nothing');
  cleanup(h);
});

test('REFUSE (no sign): mainnet over the remaining daily budget', async () => {
  const h = harness({ network: 'mainnet', mainnet: true, solUsd: 8 }); // 0.5 SOL × $8 = $4
  h.ledger.record(18, Date.UTC(2026, 9, 8, 12)); // $18 already spent today; $4 more would be $22 > $20
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'mainnet' });
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'daily-cap');
  assert.equal(h.signCalls(), 0);
  cleanup(h);
});

// ----------------------------------------------------------------- task-1310 defect regressions

test('DEFECT 1: a 94.67% price-impact quote (Jupiter fraction 0.9467) is normalized and REFUSED', async () => {
  const h = harness({ raw: rawQuote({ priceImpactPct: '0.9467' }) });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK });
  // Normalized to a PERCENT, not left as the raw fraction (0.9467 would have slipped under the 3% cap).
  assert.ok(built.plan.priceImpactPct !== null && Math.abs(built.plan.priceImpactPct - 94.67) < 1e-6, `impact ${built.plan.priceImpactPct}`);
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'price-impact');
  assert.equal(h.signCalls(), 0, 'a 94.67% impact trade NEVER reaches the wallet');
  cleanup(h);
});

test('DEFECT 2: a signed tx whose bytes differ from the approved plan is refused (tx-mismatch), not submitted', async () => {
  const h = harness({ network: 'mainnet', mainnet: true, badSignedTx: true });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'mainnet' });
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'tx-mismatch');
  assert.equal(h.submitCalls(), 0, 'mismatched bytes are never broadcast');
  assert.equal(h.ledger.spentToday(), 0, 'the reservation for a never-sent trade is refunded');
  cleanup(h);
});

test('DEFECT 2: the binding hash covers the tx bytes — a different message means a different hash', async () => {
  const a = harness();
  const b = harness();
  const b1 = await a.exec.buildPlan({ order: order(), userPublicKey: PK });
  const b2 = await b.exec.buildPlan({ order: order(), userPublicKey: PK });
  // Same plan but each harness built a different tx (fresh blockhash/ATAs) → different digest → different hash.
  assert.notEqual(b1.txDigest, b2.txDigest);
  assert.notEqual(b1.hash, b2.hash, 'the bind hash changes when the tx message changes');
  assert.equal(b1.hash.length, 64);
  cleanup(a); cleanup(b);
});

test('DEFECT 3: a fabricated swapUsdValue:0 cannot hide a trade from the USD cap (priced locally)', async () => {
  // The quote lies ($0), but local pricing (0.5 SOL × $24 = $12) catches it against the $5 per-trade cap.
  const h = harness({ network: 'mainnet', mainnet: true, solUsd: 24, raw: rawQuote({ swapUsdValue: '0' }) });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'mainnet' });
  assert.ok(built.plan.notionalUsd !== null && built.plan.notionalUsd > 12 && built.plan.notionalUsd < 12.1, `notional ${built.plan.notionalUsd}`);
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'per-trade-cap');
  assert.equal(h.signCalls(), 0);
  cleanup(h);
});

test('DEFECT 3: no local SOL price on mainnet refuses rather than trusting the quote', async () => {
  const h = harness({ network: 'mainnet', mainnet: true, solUsd: null, raw: rawQuote({ swapUsdValue: '3' }) });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'mainnet' });
  assert.equal(built.plan.notionalUsd, null, 'no trusted price → no notional');
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'no-usd-value');
  cleanup(h);
});

test('DEFECT 4: a devnet LABEL over a mainnet RPC still enforces the USD caps', async () => {
  // Caps say devnet (mainnet disabled), but the RPC endpoint is mainnet — real funds. Must NOT be exempt.
  const h = harness({ network: 'devnet', mainnet: false, rpcUrl: MAINNET_RPC });
  const built = await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'devnet' });
  assert.equal(built.plan.network, 'mainnet', 'effective network derives from the actual RPC endpoint');
  const out = await h.exec.confirmAndSubmit(built, built.hash, PK);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.reason, 'mainnet-not-enabled');
  assert.equal(h.signCalls(), 0, 'a mainnet-RPC trade never signs without --mainnet');
  cleanup(h);
});

test('DEFECT 5: concurrent confirms cannot collectively exceed the daily cap', async () => {
  // Each trade is ~0.5 SOL × $16 ≈ $8 (under a $10 per-trade cap); the $20 DAILY cap admits exactly two
  // (~$16), and the remaining four are refused — the daily cap, not the per-trade cap, is the constraint.
  // Round 2: a plan is single-use, so six confirms need six plans.
  const h = harness({ network: 'mainnet', mainnet: true, solUsd: 16, perTradeUsd: 10, dailyUsd: 20 });
  const plans = [];
  for (let i = 0; i < 6; i++) plans.push(await h.exec.buildPlan({ order: order(), userPublicKey: PK, network: 'mainnet' }));
  const results = await Promise.all(plans.map((b) => h.exec.confirmAndSubmit(b, b.hash, PK)));
  const filled = results.filter((r) => r.kind === 'filled').length;
  const daily = results.filter((r) => r.kind === 'refused' && r.reason === 'daily-cap').length;
  assert.equal(filled, 2, `only two ~$8 trades fit under the $20 daily cap (${JSON.stringify(results.map((r) => r.kind))})`);
  assert.equal(daily, 4, 'the other four are refused on the daily cap');
  assert.ok(h.ledger.spentToday() <= 20, 'the ledger never exceeds the cap');
  assert.ok(h.ledger.spentToday() > 16, 'both fills were charged');
  cleanup(h);
});
