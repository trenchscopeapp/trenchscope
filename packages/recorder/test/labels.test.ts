// Labeler port: replays the task-1287 prototype recording (178 tokens, t0 sweep + t1 outcome sweep,
// labeler 0.1.0) and must reproduce every label; then checks the v0.2 additions and each rule in isolation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { label, labelAtHorizon, isPositive, CURVE_LAUNCHPADS, LABELER_VERSION, RULES, type Observation } from '../src/labels.ts';

interface Fixture {
  source: string;
  mints: number;
  snapshots: Record<string, (Observation & { kind: 't0' | 't1' })[]>;
  expected: { mint: string; t0: number; horizon_sec: number; t1: number; label: string; mcap_ratio: number | null; liq_ratio: number | null; price_ratio: number | null; max_mcap_ratio: number | null; reason: string | null; rule: string | null }[];
}

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/proto-1287.json', import.meta.url)), 'utf8')) as Fixture;

function pairs(): { mint: string; t0: Observation; obs: Observation[] }[] {
  const out: { mint: string; t0: Observation; obs: Observation[] }[] = [];
  for (const [mint, rows] of Object.entries(fx.snapshots)) {
    const sorted = [...rows].sort((a, b) => a.t - b.t);
    const t0 = sorted.find((r) => r.kind === 't0')!;
    const obs = sorted.filter((r) => r.t > t0.t);
    out.push({ mint, t0: { ...t0, mint }, obs: obs.map((o) => ({ ...o, mint })) });
  }
  return out;
}

test('v0.1 rules reproduce the prototype labels for all 178 tokens (label, horizon, ratios, reason)', () => {
  assert.equal(fx.mints, 178);
  const expected = new Map(fx.expected.map((e) => [e.mint, e]));
  const counts: Record<string, number> = {};
  for (const { mint, t0, obs } of pairs()) {
    const row = label(t0, obs, { rules: '0.1' })!;
    const e = expected.get(mint)!;
    assert.ok(e, `no expected row for ${mint}`);
    assert.equal(row.label, e.label, `${mint}: ${row.label} vs prototype ${e.label}`);
    assert.equal(row.horizon_sec, e.horizon_sec);
    assert.equal(row.t1, e.t1);
    assert.equal(row.mcap_ratio, e.mcap_ratio);
    assert.equal(row.liq_ratio, e.liq_ratio);
    assert.equal(row.price_ratio, e.price_ratio);
    assert.equal(row.max_mcap_ratio, e.max_mcap_ratio);
    const ev = JSON.parse(row.evidence) as { reason?: string; rule?: string };
    assert.equal(ev.reason ?? null, e.reason);
    assert.equal(ev.rule ?? null, e.rule);
    assert.equal(row.labeler_version, '0.1.0');
    counts[row.label] = (counts[row.label] ?? 0) + 1;
  }
  // BACKTEST.md §1: unobserved 29, flat 137, fade 9, runner 2, dead 1, rug 0.
  assert.deepEqual(counts, { unobserved: 29, flat: 137, fade: 9, runner: 2, dead: 1 });
});

test('v0.2 rules: every source-mismatch pump.fun row and every other dead curve (t1 liq ≤ $100, vol_h1 < $100) is D2 dead; all else unchanged', () => {
  const expected = new Map(fx.expected.map((e) => [e.mint, e]));
  const counts: Record<string, number> = {};
  let fromUnobserved = 0;
  let fromOther = 0;
  for (const { mint, t0, obs } of pairs()) {
    const row = label(t0, obs)!;
    const e = expected.get(mint)!;
    const ev = JSON.parse(row.evidence) as { reason?: string; rule?: string; cross_source?: boolean };
    const t1 = obs[obs.length - 1];
    const d2 = CURVE_LAUNCHPADS.has(t0.launchpad ?? '') && (t1.liquidity_usd ?? 0) <= RULES.curveDeadLiq && (t1.vol_h1 ?? 0) < RULES.curveDeadVolH1;
    if (d2) {
      assert.equal(row.label, 'dead', `${mint}`);
      assert.match(ev.rule ?? '', /^D2 /);
      if (e.label === 'unobserved') { assert.equal(ev.cross_source, true); fromUnobserved++; } else fromOther++;
    } else {
      assert.equal(row.label, e.label, `${mint}: ${row.label} vs ${e.label}`);
      assert.equal(ev.rule ?? null, e.rule);
      assert.equal(ev.reason ?? null, e.reason);
    }
    assert.equal(row.labeler_version, LABELER_VERSION);
    counts[row.label] = (counts[row.label] ?? 0) + 1;
  }
  // BACKTEST.md §3: all 29 unobserved rows (the jup:recent feed, no DexScreener pair at t0) are D2 dead.
  assert.equal(fromUnobserved, 29);
  assert.equal(counts.unobserved ?? 0, 0);
  // The same rule also reaches same-source pump.fun rows whose curve shows no liquidity and no trades at
  // t1 (the prototype called them flat/fade because their floor-pinned mcap did not move). Recorded here
  // so the number is visible: the v0.2 positive class on this recording is dead = 30 + fromOther.
  assert.ok(fromOther >= 0);
  assert.equal(counts.dead, 30 + fromOther);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 178);
  D2_EXTRA.n = fromOther;
});
/** Exposed for the summary line below (how many prototype flat/fade rows v0.2 reclassifies as dead curves). */
const D2_EXTRA = { n: -1 };
test('v0.2 summary: how many non-unobserved prototype rows D2 reclassifies (printed for the handoff)', () => {
  assert.ok(D2_EXTRA.n >= 0);
  const reclassified = pairs().filter(({ t0, obs }) => {
    const t1 = obs[obs.length - 1];
    return CURVE_LAUNCHPADS.has(t0.launchpad ?? '') && (t1.liquidity_usd ?? 0) <= RULES.curveDeadLiq && (t1.vol_h1 ?? 0) < RULES.curveDeadVolH1 && fx.expected.find((e) => e.mint === t0.mint)!.label !== 'unobserved';
  }).map(({ t0, obs }) => `${(t0 as { symbol?: string }).symbol ?? t0.mint.slice(0, 6)}:${fx.expected.find((e) => e.mint === t0.mint)!.label}→dead(t1 liq ${obs[obs.length - 1].liquidity_usd}, vol ${obs[obs.length - 1].vol_h1})`);
  assert.equal(reclassified.length, D2_EXTRA.n);
  console.log(`v0.2 D2 reclassified ${reclassified.length} prototype rows: ${reclassified.join('; ')}`);
});

const base = (over: Partial<Observation> = {}): Observation => ({
  mint: 'M', t: 0, mcap: 100_000, liquidity_usd: 20_000, price_usd: 1, vol_h1: 5_000, pair_address: 'P', src_market: 'dexscreener', launchpad: 'pump.fun', ...over,
});
const H = 3600;
const at = (sec: number, over: Partial<Observation> = {}): Observation => base({ t: sec * 1000, ...over });

test('R1 rug: t0 liquidity ≥ $5k, liquidity ≤ 10 % and price ≤ 50 % of t0', () => {
  const r = labelAtHorizon(at(0), [at(H, { liquidity_usd: 1_000, price_usd: 0.3, mcap: 30_000 })], H);
  assert.equal(r.label, 'rug');
  assert.equal(r.label_tier, 'keyless-proxy');
  assert.equal(r.liq_ratio, 0.05);
  assert.equal(r.price_ratio, 0.3);
  assert.equal(isPositive(r.label), true);
  // thin t0 liquidity never calls a rug (bonding-curve mints without a pool fall through to dead/fade)
  const thin = labelAtHorizon(at(0, { liquidity_usd: 4_000 }), [at(H, { liquidity_usd: 100, price_usd: 0.3, mcap: 30_000, vol_h1: 10_000 })], H);
  assert.equal(thin.label, 'fade');
});

test('pair vanished: ratios are 0 and a liquid t0 is a rug', () => {
  const r = labelAtHorizon(at(0), [at(H, { pair_address: null, mcap: null, liquidity_usd: null, price_usd: null, src_market: 'none' })], H);
  assert.equal(r.label, 'rug');
  assert.equal(r.mcap_ratio, 0);
  assert.equal(JSON.parse(r.evidence).vanished, true);
});

test('D1 dead, F1 fade, U1 runner (max over intermediate observations), flat', () => {
  assert.equal(labelAtHorizon(at(0), [at(H, { mcap: 15_000, vol_h1: 100, price_usd: 0.15, liquidity_usd: 15_000 })], H).label, 'dead');
  assert.equal(labelAtHorizon(at(0), [at(H, { mcap: 15_000, vol_h1: 5_000, liquidity_usd: 15_000 })], H).label, 'fade');
  assert.equal(labelAtHorizon(at(0), [at(H, { mcap: 45_000, liquidity_usd: 15_000 })], H).label, 'fade');
  const run = labelAtHorizon(at(0), [at(600, { mcap: 250_000 }), at(H, { mcap: 120_000 })], H);
  assert.equal(run.label, 'runner');
  assert.equal(run.max_mcap_ratio, 2.5);
  assert.equal(labelAtHorizon(at(0), [at(H, { mcap: 110_000 })], H).label, 'flat');
  assert.equal(labelAtHorizon(at(0), [at(H, { mcap: 100_000 * RULES.runnerRatio })], H).label, 'runner');
});

test('D2 curve-dead (v0.2) needs a bonding-curve launchpad; a listed token with the same numbers is unobserved on a source mismatch', () => {
  const t0 = at(0, { src_market: 'jupiter-tokens', pair_address: null, liquidity_usd: 3_000, mcap: 3_000 });
  const t1 = at(H, { src_market: 'dexscreener', liquidity_usd: 0, vol_h1: 0, mcap: 3_000 });
  assert.equal(labelAtHorizon(t0, [t1], H).label, 'dead');
  assert.equal(labelAtHorizon({ ...t0, launchpad: 'unknown' }, [t1], H).label, 'unobserved');
  assert.equal(JSON.parse(labelAtHorizon({ ...t0, launchpad: 'unknown' }, [t1], H).evidence).reason, 'source-mismatch');
  // v0.1 never fires D2
  assert.equal(labelAtHorizon(t0, [t1], H, { rules: '0.1' }).label, 'unobserved');
});

test('v0.2 cross-source ratios for curve tokens that gained a pool: labelled, evidence says cross_source', () => {
  const t0 = at(0, { src_market: 'jupiter-tokens', pair_address: null, liquidity_usd: 3_000, mcap: 10_000 });
  const t1 = at(H, { src_market: 'dexscreener', liquidity_usd: 30_000, vol_h1: 50_000, mcap: 40_000 });
  const r = labelAtHorizon(t0, [t1], H);
  assert.equal(r.label, 'runner');
  assert.equal(JSON.parse(r.evidence).cross_source, true);
});

test('unobserved: no observation in the window (t1 null), no mcap at t0', () => {
  const none = labelAtHorizon(at(0), [], H);
  assert.equal(none.label, 'unobserved');
  assert.equal(none.t1, null);
  assert.equal(none.horizon_sec, H);
  assert.equal(JSON.parse(none.evidence).reason, 'no-observation-in-window');
  assert.equal(JSON.parse(labelAtHorizon(at(0, { mcap: null }), [at(H)], H).evidence).reason, 'no-mcap-at-t0');
  assert.equal(isPositive('unobserved'), false);
});

test('chain-verified events override the proxy (R-02 hook): lp_withdraw / freeze / dev_sell ≥ 20 %', () => {
  const flat = [at(H, { mcap: 110_000 })];
  const r = labelAtHorizon(at(0), flat, H, { chainEvents: [{ kind: 'lp_withdraw' }] });
  assert.equal(r.label, 'rug');
  assert.equal(r.label_tier, 'chain-verified');
  assert.equal(labelAtHorizon(at(0), flat, H, { chainEvents: [{ kind: 'dev_sell', amount: 10 }] }).label, 'flat');
  assert.equal(labelAtHorizon(at(0), flat, H, { chainEvents: [{ kind: 'dev_sell', amount: 25 }] }).label, 'rug');
  assert.equal(isPositive('dead', 'chain-verified'), false, 'with chain-verified labels only rug is positive');
});

test('prototype-mode label(): Δt below the smallest horizon is unobserved with horizon 0', () => {
  const r = label(at(0), [at(600)])!;
  assert.equal(r.label, 'unobserved');
  assert.equal(r.horizon_sec, 0);
  assert.equal(label(at(0), []), null);
});
