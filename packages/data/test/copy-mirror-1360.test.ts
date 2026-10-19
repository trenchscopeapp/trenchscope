// task-1360 Tier 2 — the one-key MIRROR TICKET: a leader BUY alert → a PROPOSED plan sized by the user's own cap,
// refused on lag / drift / liquidity / age / leader-sold / leader-dev / leader-holds, unknowns shown as unknown.
// The proposal is inert: the plan engine holds it as 'proposed', a forged/spoken proof cannot arm it, only the
// existing keypress gate (into an armed mandate) can — exactly as for any typed or spoken plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirror, leaderSoldSince, leaderFillPriceUsd, MIRROR_LIMITS, decodeTx, type CopyAlert, type MirrorContext, type MirrorMarket } from '../src/trade/copy/index.ts';
import { PlanService, PolicyRefusal, MandateError } from '../src/trade/plans/index.ts';
import { SimClock, mkTx, sig, LEADER, MINT_A } from './copy-helpers.ts';

const SOL = 1_000_000_000;
const T0 = 1_700_000_000_000;

/** A leader buy of 1,000,000 raw (= 1.0 token at 6 decimals) for 0.5 SOL at $200/SOL = $100 → fill price $100/token. */
function buyAlert(opts: { blockTime?: number | null; usd?: number | null; side?: 'buy' | 'sell' } = {}): CopyAlert {
  const tx = mkTx({ slot: 500, blockTime: opts.blockTime === undefined ? T0 / 1000 : opts.blockTime, sig: sig(50), wallet: LEADER, tokens: [{ mint: MINT_A, pre: opts.side === 'sell' ? 1_000_000n : 0n, post: opts.side === 'sell' ? 0n : 1_000_000n }], lamports: opts.side === 'sell' ? [SOL, SOL + 0.5 * SOL] : [SOL, SOL - 0.5 * SOL] });
  const trade = decodeTx(tx, LEADER, { solUsd: 200 })[0];
  if (opts.usd === null) { trade.usd = null; trade.solUsdAt = null; }
  return { id: 'a1', t: T0 + 5_000, wallet: LEADER, name: 'leader', trade, lagMs: 5_000 };
}
const GOOD: MirrorMarket = { symbol: 'TRENCH', decimals: 6, priceUsd: 102, priceAt: T0 + 4_000, liqUsd: 80_000, mcapUsd: 102e6, ageMs: 3_600_000 };
function ctx(over: Partial<MirrorContext> = {}, market: Partial<MirrorMarket> | null = {}): MirrorContext {
  return { now: T0 + 5_000, capUsd: 20, market: market === null ? null : { ...GOOD, ...market }, leaderSoldSince: false, leaderIntel: { inDevCluster: false, holdsPct: 0.4 }, ...over };
}

test('mirror: a good leader buy → a sized, inert proposal with the three live numbers and every check listed', () => {
  const a = buyAlert();
  assert.equal(leaderFillPriceUsd(a, 6), 100);
  const r = buildMirror(a, ctx());
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.sizeUsd, 20, 'min(cap $20, 1× $100, 1% of $80k = $800)');
  assert.match(r.sizeWhy, /^min\(your cap \$20\.00, 1× the leader's \$100\.00 \$100\.00, 1% of liquidity \$800\.00\)$/);
  assert.equal(r.lagMs, 5_000); assert.ok(Math.abs(r.driftPct! - 2) < 1e-9); assert.equal(r.leaderPriceUsd, 100);
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [['lag', true], ['drift', true], ['liquidity', true], ['age', true], ['leader-sold', true], ['leader-dev', true], ['leader-holds', true]]);
  assert.equal(r.input.side, 'buy'); assert.equal(r.input.sizeUsd, 20); assert.deepEqual(r.input.entry, { kind: 'immediate' }); assert.equal(r.input.ttlMs, MIRROR_LIMITS.ttlMs);
  assert.equal(r.supply, 1e6); assert.match(r.ref, /^mirror:/);
  // size follows the smallest of the three bounds
  assert.equal(buildMirror(a, ctx({ capUsd: 500, k: 0.5 })).ok && (buildMirror(a, ctx({ capUsd: 500, k: 0.5 })) as { sizeUsd: number }).sizeUsd, 50, 'k × leader');
  assert.equal((buildMirror(a, ctx({ capUsd: 500 }, { liqUsd: 30_000 })) as { sizeUsd: number }).sizeUsd, 100, '1× leader beats 1% liq ($300)');
  assert.equal((buildMirror(a, ctx({ capUsd: 500, k: 5 }, { liqUsd: 30_000 })) as { sizeUsd: number }).sizeUsd, 300, '1% of liquidity');
});

test('mirror: every refusal fires on its own, unknowns are shown as unknown (not refused), a sell is never mirrored', () => {
  const a = buyAlert();
  const why = (r: ReturnType<typeof buildMirror>) => (r.ok ? 'ok' : r.reason);
  assert.equal(why(buildMirror(buyAlert({ side: 'sell' }), ctx())), 'not-a-buy');
  assert.equal(why(buildMirror(buyAlert({ usd: null }), ctx())), 'unpriced');
  assert.equal(why(buildMirror(a, ctx({}, null))), 'no-market');
  assert.equal(why(buildMirror(a, ctx({}, { priceUsd: null }))), 'no-market');
  assert.equal(why(buildMirror(a, ctx({ now: T0 + 31_000 }))), 'lag');
  assert.equal(why(buildMirror(a, ctx({}, { priceUsd: 105.01 }))), 'drift');
  assert.equal(why(buildMirror(a, ctx({}, { priceUsd: 90 }))), 'ok', 'a price BELOW the leader\'s fill is not drift');
  assert.equal(why(buildMirror(a, ctx({}, { liqUsd: 24_999 }))), 'liquidity');
  assert.equal(why(buildMirror(a, ctx({}, { ageMs: 59_000 }))), 'age');
  assert.equal(why(buildMirror(a, ctx({ leaderSoldSince: true }))), 'leader-sold');
  assert.equal(why(buildMirror(a, ctx({ leaderIntel: { inDevCluster: true, holdsPct: 1 } }))), 'leader-dev');
  assert.equal(why(buildMirror(a, ctx({ leaderIntel: { inDevCluster: false, holdsPct: 5.1 } }))), 'leader-holds');
  assert.equal(why(buildMirror(a, ctx({ capUsd: 0.001 }))), 'cap');
  // unknowns: block time, liquidity, age, leader state, scan → shown as null, still allowed; decimals unknown → refused (no drift possible)
  const unk = buildMirror(buyAlert({ blockTime: null }), ctx({ leaderSoldSince: null, leaderIntel: null }, { liqUsd: null, ageMs: null }));
  assert.ok(unk.ok);
  assert.deepEqual(unk.checks.map((c) => [c.name, c.ok]), [['lag', null], ['drift', true], ['liquidity', null], ['age', null], ['leader-sold', null], ['leader-dev', null], ['leader-holds', null]]);
  assert.equal(unk.lagMs, null); assert.match(unk.checks[5].detail, /not scanned/); assert.equal(unk.sizeUsd, 20, 'no liquidity bound when liquidity is unknown');
  const nodec = buildMirror(a, ctx({}, { decimals: null }));
  assert.equal(why(nodec), 'no-decimals'); assert.equal((nodec as { checks: { ok: boolean | null }[] }).checks[1].ok, null);
  // the first failing check wins and the whole list is still reported
  const multi = buildMirror(a, ctx({ now: T0 + 40_000, leaderSoldSince: true }, { liqUsd: 1 }));
  assert.equal(why(multi), 'lag'); assert.equal((multi as { checks: unknown[] }).checks.length, 7);
});

test('mirror: leaderSoldSince reads the tracker\'s trades after the alerted buy only', () => {
  const a = buyAlert();
  const t = (slot: number, side: string, mint = MINT_A, s = sig(slot)) => ({ mint, side, slot, sig: s });
  assert.equal(leaderSoldSince(a, [t(400, 'sell'), t(500, 'buy', MINT_A, sig(50))]), false, 'an older sell does not count');
  assert.equal(leaderSoldSince(a, [t(501, 'sell')]), true);
  assert.equal(leaderSoldSince(a, [t(501, 'sell', 'other')]), false);
  assert.equal(leaderSoldSince(a, [t(500, 'sell', MINT_A, sig(51))]), true, 'same slot, later signature');
});

test('mirror proposal through PlanService is inert: proposed by "copy", refused without a gesture, armable only through the keypress gate into an armed mandate', () => {
  const clock = new SimClock(T0 + 5_000);
  const svc = new PlanService({ clock, rng: () => 0.42 });
  const r = buildMirror(buyAlert(), ctx());
  assert.ok(r.ok);
  const plan = svc.propose(r.input, { supply: r.supply, by: 'copy', ref: r.ref });
  assert.equal(plan.status, 'proposed'); assert.equal(plan.source.by, 'copy'); assert.match(plan.source.ref!, /^mirror:/); assert.equal(plan.sizeUsd, 20);
  assert.equal(svc.listPlans()[0].status, 'proposed');
  assert.match(svc.readBack(plan.id), /Buy \$20\.00 of TRENCH .* now; keep 100% as a moon bag; slippage 3\.0%; expires in 10 min\./);
  // no mandate → the keypress gate itself refuses; a forged proof is refused; a spoken proof cannot arm
  assert.throws(() => svc.armPlanByKeypress(plan.id, 'mandate_nope'), (e: unknown) => e instanceof PolicyRefusal && e.reason === 'unknown-mandate');
  assert.throws(() => svc.engine.armPlan(plan.id, { id: 'x', kind: 'gesture', signerIssued: false, gesture: 'keypress', subject: `plan:${plan.id}:${plan.hash}`, consumed: false }, 'm'), (e: unknown) => e instanceof PolicyRefusal);
  const m = svc.draftMandate({ totalUsd: 100, perTradeUsd: 20 });
  assert.throws(() => svc.engine.armMandate(m.id, svc.engine.issueMandateProof(m.id, 'spoken-free')), (e: unknown) => e instanceof MandateError);
  assert.equal(svc.listPlans()[0].status, 'proposed', 'still a proposal');
  // the legitimate path: keypress-armed mandate + keypress-armed plan → the normal admission (caps) applies
  svc.armMandateByKeypress(m.id);
  svc.armPlanByKeypress(plan.id, m.id);
  assert.equal(svc.listPlans()[0].status, 'armed');
  // a mirror bigger than the mandate's per-trade cap is refused by the engine, not resized by the mirror
  const big = buildMirror(buyAlert(), ctx({ capUsd: 50 }));
  assert.ok(big.ok);
  const p2 = svc.propose(big.input, { supply: big.supply, by: 'copy', ref: big.ref });
  assert.throws(() => svc.armPlanByKeypress(p2.id, m.id), (e: unknown) => e instanceof PolicyRefusal && e.reason === 'per-trade-cap');
});
