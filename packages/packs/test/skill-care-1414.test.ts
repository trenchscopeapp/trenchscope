// task-1414: the skill-care decision logic — the rolling split, new-coins counting, the interval-noise rule,
// the proposal gate (new-coins + held-out improvement + frozen canary + the silent no-change path + canary
// regression), and the one-line trend. Pure; driven by hand-built fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkFeatures, LINK_RUBRIC_V0, LINK_RUBRIC_V1, type LinkFeatures } from '@dexterm/data';
import {
  rollingSplit, newCoinsSince, intervalImproves, proposalGate, trendLine, canaryMcc, proposalCard,
  splitMetrics, RUG_RULES_V0, RUG_RULES_V1,
  type SkillEvalRow, type SkillEvalSet, type SplitMetrics, type GateInput, type RugRuleFeatures,
} from '../src/index.ts';

const DAY = 86_400_000;

function row(mint: string, t0: number, bad: boolean, over: Partial<SkillEvalRow> = {}): SkillEvalRow {
  const link: LinkFeatures = linkFeatures({ web: null });
  const rug: RugRuleFeatures = { freeze_auth: false, mint_auth: false, dev_pct: null, top10_pct: null, organic_score: null, liquidity_usd: 50_000, price_usd: 1, lp_locked_pct: 100, launchpad: 'pump.fun', age_sec: 3600 };
  return { mint, t0, split: 'train', outcome: bad ? 'rug' : 'flat', bad, link, link_sources: ['dexscreener'], link_lag_sec: 0, rug, ...over };
}

function set(rows: SkillEvalRow[]): SkillEvalSet {
  return {
    schema: 'dexterm/packs/skill-eval/1', built_at: '2026-10-16T00:00:00.000Z',
    source: { kind: 'recorder', labeler_version: '0.2.0', db_note: 'test' },
    horizon_sec: 259_200, label_rule: 'test', evidence_rule: 'test', split_rule: 'test', cutoff_t0: 0,
    counts: { rows: rows.length, train: 0, test: 0, bad_train: 0, bad_test: 0, excluded: {} }, rows,
  };
}

/** A real SplitMetrics from a 2-grade (WARN→bad / OK→ok) confusion matrix, so intervals are genuine Wilson. */
function bin(tp: number, fp: number, fn: number, tn: number): SplitMetrics {
  const rows: { grade: string; bad: boolean }[] = [];
  for (let i = 0; i < tp; i++) rows.push({ grade: 'WARN', bad: true });
  for (let i = 0; i < fp; i++) rows.push({ grade: 'WARN', bad: false });
  for (let i = 0; i < fn; i++) rows.push({ grade: 'OK', bad: true });
  for (let i = 0; i < tn; i++) rows.push({ grade: 'OK', bad: false });
  return splitMetrics(rows, { WARN: 'bad', OK: 'ok' }, ['WARN', 'OK']);
}

test('rollingSplit: the default is the newest testFrac of coins by t0 (TRAIN stays the majority)', () => {
  const rows = Array.from({ length: 10 }, (_, k) => row(`m${k}`, (k + 1) * DAY, k % 2 === 0));
  const r = rollingSplit(set(rows), { testFrac: 0.3 });
  assert.equal(r.counts.test, 3, 'newest 30% by t0');
  assert.equal(r.counts.train, 7);
  assert.deepEqual(r.rows.filter((x) => x.split === 'test').map((x) => x.mint), ['m7', 'm8', 'm9']);
  assert.match(r.split_rule, /newest 30% of coins/);
});

test('rollingSplit: the newest windowDays of coins become the held-out TEST window', () => {
  const now = 10 * DAY;
  const s = set([row('a', 2 * DAY, false), row('b', 7 * DAY, true), row('c', 9.5 * DAY, false), row('d', 10 * DAY, true)]);
  const r = rollingSplit(s, { windowDays: 2, anchor: now });
  // cutoff = 10d - 2d = 8d → c (9.5d) and d (10d) are test; a,b are train
  assert.deepEqual(r.rows.filter((x) => x.split === 'test').map((x) => x.mint), ['c', 'd']);
  assert.equal(r.counts.test, 2);
  assert.equal(r.counts.train, 2);
  assert.equal(r.counts.bad_test, 1);
  assert.match(r.split_rule, /rolling window/);
  assert.equal(s.rows[0].split, 'train', 'the input set is not mutated');
});

test('rollingSplit: anchor defaults to the newest t0 in the set', () => {
  const s = set([row('a', 1 * DAY, false), row('b', 5 * DAY, true)]);
  const r = rollingSplit(s, { windowDays: 1 });
  assert.equal(r.rows.find((x) => x.mint === 'b')!.split, 'test');
  assert.equal(r.rows.find((x) => x.mint === 'a')!.split, 'train');
});

test('newCoinsSince: coins not in the baseline mint set are new', () => {
  const cur = set([row('a', 1, false), row('b', 2, false), row('c', 3, true)]);
  const r = newCoinsSince(cur, new Set(['a']));
  assert.equal(r.count, 2);
  assert.deepEqual(r.newMints.sort(), ['b', 'c']);
});

test('intervalImproves: a non-overlapping precision gain with no recall loss and +MCC is an improvement', () => {
  const before = bin(20, 40, 5, 60);  // precision 33%
  const after = bin(28, 10, 8, 80);   // precision 74%, wider separation
  const r = intervalImproves(before, after);
  assert.equal(r.improves, true, r.reason);
  assert.ok((r.mccDelta ?? 0) > 0);
});

test('intervalImproves: overlapping precision intervals are within noise → not an improvement', () => {
  const before = bin(20, 30, 10, 60);
  const after = bin(22, 28, 9, 61);
  assert.equal(intervalImproves(before, after).improves, false);
});

test('intervalImproves: too few flagged rows → conservative no', () => {
  const before = bin(2, 3, 10, 60);  // 5 flagged < MIN_N
  const after = bin(3, 1, 9, 61);
  const r = intervalImproves(before, after);
  assert.equal(r.improves, false);
  assert.match(r.reason, /interval unavailable/);
});

const shipped = { larp: LINK_RUBRIC_V1, rug: RUG_RULES_V1 };
const proposedSame = { larp: LINK_RUBRIC_V1, rug: RUG_RULES_V1 };
const proposedDiff = { larp: LINK_RUBRIC_V0, rug: RUG_RULES_V0 };
const flat = (mcc: number) => ({ larpMcc: mcc, rugMcc: mcc });

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    newCoins: 200, N: 150,
    larp: { before: bin(20, 30, 10, 60), after: bin(20, 30, 10, 60) },
    rug: { before: bin(20, 40, 5, 60), after: bin(28, 10, 8, 80) },  // rug improves
    canaryShipped: flat(0.16), canaryBaseline: flat(0.16), canaryProposed: flat(0.17),
    proposed: proposedDiff, shipped,
    ...over,
  };
}

test('proposalGate: improvement when new coins ≥ N, a subject beats the window, and the canary holds', () => {
  const d = proposalGate(gateInput());
  assert.equal(d.propose, true);
  assert.equal(d.kind, 'improvement');
  assert.deepEqual(d.improved, ['rug']);
  assert.ok(d.canaryHolds);
  assert.ok(d.parameterDrift.rug);
});

test('proposalGate: fewer than N new coins → no proposal, reason recorded (silent no-change)', () => {
  const d = proposalGate(gateInput({ newCoins: 40 }));
  assert.equal(d.propose, false);
  assert.equal(d.kind, 'none');
  assert.ok(d.reasons.some((r) => /only 40 new/.test(r)));
});

test('proposalGate: no held-out improvement → no proposal even with plenty of new coins', () => {
  const d = proposalGate(gateInput({ rug: { before: bin(20, 30, 10, 60), after: bin(21, 29, 10, 60) } }));
  assert.equal(d.propose, false);
  assert.equal(d.kind, 'none');
  assert.equal(d.improved.length, 0);
});

test('proposalGate: an improving tune that would regress the frozen canary is blocked (overfit guard)', () => {
  const d = proposalGate(gateInput({ canaryProposed: flat(0.05) })); // proposed << baseline 0.16
  assert.equal(d.propose, false);
  assert.equal(d.kind, 'none');
  assert.equal(d.canaryHolds, false);
  assert.ok(d.reasons.some((r) => /regress the frozen canary/.test(r)));
});

test('proposalGate: a frozen-canary regression of the SHIPPED rules proposes regardless of new coins', () => {
  const d = proposalGate(gateInput({ newCoins: 0, canaryShipped: flat(0.05), canaryBaseline: flat(0.16) }));
  assert.equal(d.propose, true);
  assert.equal(d.kind, 'canary-regression');
  assert.ok(d.reasons.some((r) => /frozen canary regressed/.test(r)));
});

test('proposalGate: identical proposed params report no parameter drift', () => {
  const d = proposalGate(gateInput({ proposed: proposedSame, rug: { before: bin(20, 30, 10, 60), after: bin(20, 30, 10, 60) } }));
  assert.deepEqual(d.parameterDrift, { larp: false, rug: false });
});

test('canaryMcc: computes a per-subject MCC on the TEST rows', () => {
  const rows = [row('a', 1, true, { split: 'test', rug: { ...row('a', 1, true).rug, liquidity_usd: 1000 } }), row('b', 2, false, { split: 'test' })];
  const m = canaryMcc(set(rows), shipped);
  assert.ok('larpMcc' in m && 'rugMcc' in m);
});

test('proposalCard: a normal-priority card (owner from the input, default maintainers) with the numbers and the tunable params, never ships', () => {
  const input: Parameters<typeof proposalCard>[0] = {
    kind: 'improvement', reasons: ['held-out improvement — rug: precision clears'], date: '2026-10-16T00:00:00Z',
    newCoins: 210, minNew: 150, splitRule: 'rolling window: the newest 30%',
    proposed: { larp: LINK_RUBRIC_V0, rug: RUG_RULES_V0 }, shipped: { larp: LINK_RUBRIC_V1, rug: RUG_RULES_V1 },
    heldOut: { larp: { before: 0.05, after: 0.09 }, rug: { before: 0.14, after: 0.22 } },
    canary: { baseline: { larpMcc: 0.05, rugMcc: 0.16 }, proposed: { larpMcc: 0.05, rugMcc: 0.17 } },
  };
  const card = proposalCard(input);
  assert.equal(card.priority, 'normal');
  assert.equal(card.owner, 'maintainers');
  assert.equal(card.delegationTarget, 'maintainers');
  assert.equal(card.project, 'dexterm');
  assert.match(card.title, /skill-care: proposed improvement tuning \(2026-10-16\)/);
  assert.match(card.description, /RUG_RULES_V1/);
  assert.match(card.description, /LINK_RUBRIC_V1/);
  assert.match(card.description, /210 \(threshold 150\)/);
  assert.match(card.description, /must not regress/);
  assert.match(card.description, /Do NOT auto-ship/);
  assert.ok(card.constraints.some((c) => /never commit to main/.test(c)));
  const routed = proposalCard({ ...input, owner: 'coder-lane' });
  assert.equal(routed.owner, 'coder-lane');
  assert.equal(routed.delegationTarget, 'coder-lane');
});

test('trendLine: one line with test/train n, new coins, both subjects and the decision', () => {
  const line = trendLine({
    date: '2026-10-16', evalBuiltAt: '2026-10-16T00:00:00Z', trainN: 708, testN: 304, badTest: 59, newCoins: 12,
    larpTest: bin(4, 10, 20, 100), rugTest: bin(23, 19, 36, 200), decision: 'none',
  });
  assert.match(line, /^2026-10-16/);
  assert.match(line, /test n=304 bad=59/);
  assert.match(line, /new=12/);
  assert.match(line, /rug MCC/);
  assert.match(line, /larp MCC/);
  assert.match(line, /decision=none/);
});
