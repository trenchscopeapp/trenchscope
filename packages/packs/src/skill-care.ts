// Skill care (task-1414): the pure decision logic behind the recurring skill backtest that research/skill-care/
// run.mjs schedules. It never ships anything — it decides whether the newly labelled recorder history is enough,
// and improves the shipped skills enough, to be worth PROPOSING a tuning (a Kanban card + a parameter diff), or
// whether to record "no change" and stay silent. Pure over the eval sets + metrics it is given, so the gate is
// unit-testable with fixtures.
//
// Two eval slices matter:
//   - ROLLING: the full current eval set, re-split so the NEWEST `windowDays` of coins are a held-out TEST
//     window (never used to tune; the tuning functions already refuse test rows). Rates drift with the market,
//     so a fresh tune has to beat the shipped rules HERE, beyond Wilson-interval noise.
//   - FROZEN CANARY: the committed task-1401 eval set and its published numbers. A proposed tuning must also
//     hold on the frozen canary (an overfitting guard); and if the SHIPPED rules stop reproducing the frozen
//     numbers (code/data drift), that itself is worth a proposal.

import { gradeLinks, type LinkRubric } from '@dexterm/data';
import { type Rate } from './larp-eval.ts';
import {
  gradeRugRules, splitMetrics,
  LARP_GRADE_CLAIMS, LARP_GRADE_ORDER, RUG_GRADE_CLAIMS, RUG_GRADE_ORDER,
  type RugRules, type SkillEvalRow, type SkillEvalSet, type SplitMetrics,
} from './skill-backtest.ts';

export const SKILL_CARE_SCHEMA = 'dexterm/packs/skill-care/1';
/** Minimum newly labelled coins since the last accepted tuning before an improvement may be proposed. */
export const DEFAULT_MIN_NEW_COINS = 150;
/** Tolerance (absolute MCC) for calling the frozen canary "regressed" or "held". */
export const DEFAULT_CANARY_NOISE = 0.05;

// ---------------------------------------------------------------- rolling split

export interface RollingSplitOptions {
  /**
   * Newest this-many days of coins (by t0) are the held-out TEST window. Use this once the recorder spans many
   * days. Ignored when `testFrac` is set.
   */
  windowDays?: number;
  /**
   * Newest this FRACTION of coins by t0 are the held-out TEST window (default 0.3, the task-1401 method). This
   * is the robust default while the labelled span is narrow and back-loaded: a fixed day-window would put most
   * coins in TEST and starve the TRAIN split the tuning needs. "Rolling" because the cutoff is recomputed each
   * run as the recorder grows.
   */
  testFrac?: number;
  /** Anchor a `windowDays` window to this time (default: the newest t0 in the set). */
  anchor?: number;
}

/**
 * Re-split an eval set so the NEWEST coins are a held-out TEST window the tuning never sees. By default (and
 * whenever `windowDays` is not given) the newest `testFrac` of coins by t0 are TEST (count-based, so TRAIN stays
 * the majority even when t0 is clustered); with `windowDays` it is a time window instead. Returns a new set
 * (rows cloned with updated `split`); the original is untouched.
 */
export function rollingSplit(set: SkillEvalSet, opts: RollingSplitOptions = {}): SkillEvalSet {
  let cutoff: number;
  let rule: string;
  if (opts.windowDays !== undefined) {
    const anchor = opts.anchor ?? set.rows.reduce((m, r) => Math.max(m, r.t0), 0);
    cutoff = anchor - opts.windowDays * 86_400_000;
    rule = `rolling window: coins with t0 in the newest ${opts.windowDays} day(s) (t0 ≥ ${new Date(cutoff).toISOString()}) are the held-out TEST window; never tuned on`;
  } else {
    const frac = opts.testFrac ?? 0.3;
    const sorted = [...set.rows].sort((a, b) => a.t0 - b.t0);
    const idx = Math.min(sorted.length, Math.floor(sorted.length * (1 - frac)));
    cutoff = sorted[idx]?.t0 ?? Number.MAX_SAFE_INTEGER;
    rule = `rolling window: the newest ${Math.round(frac * 100)}% of coins by t0 (t0 ≥ ${new Date(cutoff).toISOString()}) are the held-out TEST window; never tuned on`;
  }
  const rows: SkillEvalRow[] = set.rows.map((r) => ({ ...r, split: r.t0 >= cutoff ? 'test' : 'train' }));
  const train = rows.filter((r) => r.split === 'train');
  const test = rows.filter((r) => r.split === 'test');
  return {
    ...set,
    split_rule: rule,
    cutoff_t0: cutoff,
    counts: { ...set.counts, rows: rows.length, train: train.length, test: test.length, bad_train: train.filter((r) => r.bad).length, bad_test: test.filter((r) => r.bad).length },
    rows,
  };
}

// ---------------------------------------------------------------- new coins since the last tuning

/** Coins in `current` whose mint is not in `baselineMints` — the newly labelled coins since that baseline. */
export function newCoinsSince(current: SkillEvalSet, baselineMints: ReadonlySet<string>): { newMints: string[]; count: number } {
  const newMints = current.rows.filter((r) => !baselineMints.has(r.mint)).map((r) => r.mint);
  return { newMints, count: newMints.length };
}

// ---------------------------------------------------------------- metrics helpers (one split, one subject)

/** Binary warning→bad metrics for the link rubric on one set of rows. */
export function larpSplit(rows: readonly SkillEvalRow[], rubric: LinkRubric): SplitMetrics {
  return splitMetrics(rows.map((r) => ({ grade: gradeLinks(r.link, rubric).grade, bad: r.bad })), LARP_GRADE_CLAIMS, LARP_GRADE_ORDER);
}
/** Binary warning→bad metrics for the rug rules on one set of rows. */
export function rugSplit(rows: readonly SkillEvalRow[], rules: RugRules): SplitMetrics {
  return splitMetrics(rows.map((r) => ({ grade: gradeRugRules(r.rug, rules).grade, bad: r.bad })), RUG_GRADE_CLAIMS, RUG_GRADE_ORDER);
}

/** The MCC of "warning grade → bad" on the TEST rows of `set` for each subject (null below the metric's floor). */
export function canaryMcc(set: SkillEvalSet, params: { larp: LinkRubric; rug: RugRules }): { larpMcc: number | null; rugMcc: number | null } {
  const test = set.rows.filter((r) => r.split === 'test');
  return { larpMcc: larpSplit(test, params.larp).binary.mcc, rugMcc: rugSplit(test, params.rug).binary.mcc };
}

// ---------------------------------------------------------------- the interval-noise rule

export interface IntervalRule { improves: boolean; mccDelta: number | null; reason: string }

/**
 * Does `after` beat `before` on a held-out split BEYOND interval noise? The test is on the binary warning→bad
 * classifier: the after precision's Wilson lower bound must clear the before precision's upper bound (a gain
 * that the intervals do not overlap on), with no interval-exceeding recall loss and a positive MCC delta. When
 * a precision interval is unavailable (too few flagged rows) the answer is a conservative "no".
 */
export function intervalImproves(before: SplitMetrics, after: SplitMetrics): IntervalRule {
  const bp = before.binary.precision, ap = after.binary.precision;
  const br = before.binary.recall, ar = after.binary.recall;
  const mccDelta = after.binary.mcc !== null && before.binary.mcc !== null ? after.binary.mcc - before.binary.mcc : null;
  if (!ap || !bp) return { improves: false, mccDelta, reason: 'precision interval unavailable (too few flagged rows on the held-out window)' };
  const precisionBeatsNoise = ap.lo > bp.hi;
  const recallHolds = !ar || !br ? true : ar.hi >= br.lo; // no noise-exceeding recall drop
  const mccUp = mccDelta !== null && mccDelta > 0;
  const improves = precisionBeatsNoise && recallHolds && mccUp;
  const reason = improves
    ? `precision ${(ap.value * 100).toFixed(0)}% [${(ap.lo * 100).toFixed(0)}-${(ap.hi * 100).toFixed(0)}] clears before ${(bp.value * 100).toFixed(0)}% [${(bp.lo * 100).toFixed(0)}-${(bp.hi * 100).toFixed(0)}], ΔMCC ${mccDelta!.toFixed(3)}`
    : !precisionBeatsNoise ? `precision gain within noise (after [${(ap.lo * 100).toFixed(0)}-${(ap.hi * 100).toFixed(0)}] overlaps before [${(bp.lo * 100).toFixed(0)}-${(bp.hi * 100).toFixed(0)}])`
    : !recallHolds ? 'recall dropped beyond interval noise' : `ΔMCC ${mccDelta === null ? '—' : mccDelta.toFixed(3)} not positive`;
  return { improves, mccDelta, reason };
}

// ---------------------------------------------------------------- the gate

export interface GateInput {
  newCoins: number;
  /** Minimum new coins for an improvement proposal (DEFAULT_MIN_NEW_COINS). */
  N?: number;
  /** Held-out (rolling TEST) shipped-vs-freshly-tuned metrics per subject. */
  larp: { before: SplitMetrics; after: SplitMetrics };
  rug: { before: SplitMetrics; after: SplitMetrics };
  /** Frozen-canary MCC: the SHIPPED rules now, the committed baseline, and the PROPOSED (freshly tuned) rules. */
  canaryShipped: { larpMcc: number | null; rugMcc: number | null };
  canaryBaseline: { larpMcc: number | null; rugMcc: number | null };
  canaryProposed: { larpMcc: number | null; rugMcc: number | null };
  /** Proposed vs shipped parameters (for the drift report). */
  proposed: { larp: LinkRubric; rug: RugRules };
  shipped: { larp: LinkRubric; rug: RugRules };
  canaryNoise?: number;
}

export type GateKind = 'improvement' | 'canary-regression' | 'none';

export interface GateDecision {
  propose: boolean;
  kind: GateKind;
  reasons: string[];
  /** Subjects whose freshly tuned rules improved the held-out window beyond noise. */
  improved: ('larp' | 'rug')[];
  /** Whether the proposed params still hold on the frozen canary (overfitting guard). */
  canaryHolds: boolean;
  /** Proposed params differ from shipped, per subject. */
  parameterDrift: { larp: boolean; rug: boolean };
}

function rubricChanged(a: LinkRubric, b: LinkRubric): boolean {
  return a.threshold !== b.threshold || JSON.stringify(a.weights) !== JSON.stringify(b.weights);
}
function rugChanged(a: RugRules, b: RugRules): boolean {
  return a.dev_pct_over !== b.dev_pct_over || a.organic_below !== b.organic_below || a.top10_over !== b.top10_over || a.liq_below !== b.liq_below;
}
/** MCC `a` has not regressed below `b` by more than `noise` (nulls treated as not-worse). */
function holds(a: number | null, b: number | null, noise: number): boolean {
  if (a === null || b === null) return true;
  return a >= b - noise;
}
function regressed(a: number | null, b: number | null, noise: number): boolean {
  return a !== null && b !== null && a < b - noise;
}

/**
 * Decide. Priority: a frozen-canary REGRESSION of the shipped rules (the published numbers no longer reproduce)
 * is always worth a proposal, even with few new coins. Otherwise an IMPROVEMENT needs all of: at least N new
 * coins, at least one subject beating the held-out window beyond noise (`intervalImproves`), and the proposed
 * params holding on the frozen canary. Anything else is 'none' (record it, stay silent).
 */
export function proposalGate(input: GateInput): GateDecision {
  const N = input.N ?? DEFAULT_MIN_NEW_COINS;
  const noise = input.canaryNoise ?? DEFAULT_CANARY_NOISE;
  const reasons: string[] = [];
  const parameterDrift = { larp: rubricChanged(input.proposed.larp, input.shipped.larp), rug: rugChanged(input.proposed.rug, input.shipped.rug) };

  // (0) Canary regression of the SHIPPED rules — a canary, not an improvement.
  const larpReg = regressed(input.canaryShipped.larpMcc, input.canaryBaseline.larpMcc, noise);
  const rugReg = regressed(input.canaryShipped.rugMcc, input.canaryBaseline.rugMcc, noise);
  if (larpReg || rugReg) {
    if (larpReg) reasons.push(`frozen canary regressed: shipped larp MCC ${fmt(input.canaryShipped.larpMcc)} < baseline ${fmt(input.canaryBaseline.larpMcc)} − ${noise}`);
    if (rugReg) reasons.push(`frozen canary regressed: shipped rug MCC ${fmt(input.canaryShipped.rugMcc)} < baseline ${fmt(input.canaryBaseline.rugMcc)} − ${noise}`);
    return { propose: true, kind: 'canary-regression', reasons, improved: [], canaryHolds: false, parameterDrift };
  }

  // (1) Improvement path.
  const larpI = intervalImproves(input.larp.before, input.larp.after);
  const rugI = intervalImproves(input.rug.before, input.rug.after);
  const improved: ('larp' | 'rug')[] = [];
  if (larpI.improves) improved.push('larp');
  if (rugI.improves) improved.push('rug');
  const canaryHolds = holds(input.canaryProposed.larpMcc, input.canaryBaseline.larpMcc, noise) && holds(input.canaryProposed.rugMcc, input.canaryBaseline.rugMcc, noise);

  if (input.newCoins < N) reasons.push(`only ${input.newCoins} new labelled coins since the last accepted tuning (need ${N})`);
  if (!improved.length) reasons.push(`no subject beats the held-out window beyond noise (larp: ${larpI.reason}; rug: ${rugI.reason})`);
  else reasons.push(`held-out improvement — larp: ${larpI.improves ? larpI.reason : 'no'}; rug: ${rugI.improves ? rugI.reason : 'no'}`);
  if (improved.length && !canaryHolds) reasons.push('proposed params would regress the frozen canary (overfit guard) — not proposing');

  const propose = input.newCoins >= N && improved.length > 0 && canaryHolds;
  return { propose, kind: propose ? 'improvement' : 'none', reasons, improved, canaryHolds, parameterDrift };
}

const fmt = (x: number | null): string => (x === null ? '—' : x.toFixed(3));

// ---------------------------------------------------------------- the one-line trend

const pr = (r: Rate | null): string => (r === null ? '—' : `${(r.value * 100).toFixed(0)}%[${(r.lo * 100).toFixed(0)}-${(r.hi * 100).toFixed(0)}]`);

/** One subject's compact per-grade precision/recall with Wilson intervals, for the trend line. */
function subjectTrend(label: string, m: SplitMetrics): string {
  const grades = m.by_grade.filter((g) => g.claims).map((g) => `${g.grade}=${pr(g.precision)}`).join(' ');
  return `${label} MCC ${m.binary.mcc === null ? '—' : m.binary.mcc.toFixed(3)} ${grades}`;
}

export interface TrendInput {
  date: string;
  evalBuiltAt: string;
  trainN: number;
  testN: number;
  badTest: number;
  newCoins: number;
  larpTest: SplitMetrics;
  rugTest: SplitMetrics;
  decision: GateKind;
}

/** The dated one-line trend record (MCC + per-grade precision Wilson intervals + n + the decision). */
export function trendLine(t: TrendInput): string {
  return `${t.date}  test n=${t.testN} bad=${t.badTest} · train n=${t.trainN} · new=${t.newCoins} · ${subjectTrend('rug', t.rugTest)} · ${subjectTrend('larp', t.larpTest)} · decision=${t.decision}`;
}

// ---------------------------------------------------------------- the proposal card (never ships; a card + diff)

export interface ProposalCardInput {
  kind: GateKind;
  reasons: string[];
  date: string;
  newCoins: number;
  minNew: number;
  splitRule: string;
  proposed: { larp: LinkRubric; rug: RugRules };
  shipped: { larp: LinkRubric; rug: RugRules };
  heldOut: { larp: { before: number | null; after: number | null }; rug: { before: number | null; after: number | null } };
  canary: { baseline: { larpMcc: number | null; rugMcc: number | null }; proposed: { larpMcc: number | null; rugMcc: number | null } };
  /** The lane the card is routed to (owner + delegationTarget); set by the maintainers' tooling. Default 'maintainers'. */
  owner?: string;
}

export interface ProposalCard {
  title: string;
  description: string;
  project: string;
  priority: string;
  owner: string;
  delegationTarget: string;
  actor: string;
  constraints: string[];
  acceptanceCriteria: string[];
}

const cv = (v: number | null): string => (v === null || v === undefined ? 'off' : String(v));
const cm = (m: number | null): string => (m === null || m === undefined ? '—' : m.toFixed(3));

/**
 * The Kanban card a proposal creates (priority normal, owner `i.owner`, default 'maintainers': the maintainers'
 * tooling names the lane). It carries the numbers and the exact tunable-grid parameter change; it NEVER edits app
 * main and NEVER ships to users — a maintainer opens a scratch branch, applies the diff, it is verified, and the
 * skills reach users only in a normal release.
 */
export function proposalCard(i: ProposalCardInput): ProposalCard {
  const d = [
    `Skill care proposes a ${i.kind} tuning for the trenchscope analyst skills (task-1414). It never edits app main; a maintainer creates a scratch branch and applies the parameter diff below, it is verified, and it reaches users only in a normal release.`,
    '',
    `New labelled coins since the last accepted tuning: ${i.newCoins} (threshold ${i.minNew}).`,
    `Rolling held-out window: ${i.splitRule}`,
    `Gate: ${i.reasons.join('; ')}`,
    '',
    'Proposed parameters (the existing tunable grid only; keep the AVOID hard rules):',
    `  rug-check (packages/packs/src/skill-backtest.ts RUG_RULES_V1): dev_pct_over=${cv(i.proposed.rug.dev_pct_over)} organic_below=${cv(i.proposed.rug.organic_below)} top10_over=${cv(i.proposed.rug.top10_over)} liq_below=${cv(i.proposed.rug.liq_below)}`,
    `    shipped: dev_pct_over=${cv(i.shipped.rug.dev_pct_over)} organic_below=${cv(i.shipped.rug.organic_below)} top10_over=${cv(i.shipped.rug.top10_over)} liq_below=${cv(i.shipped.rug.liq_below)}`,
    `  larp-check (packages/data/src/larp/link-baseline.ts LINK_RUBRIC_V1): threshold=${i.proposed.larp.threshold} weights=${JSON.stringify(i.proposed.larp.weights)}`,
    `    shipped: threshold=${i.shipped.larp.threshold} weights=${JSON.stringify(i.shipped.larp.weights)}`,
    '',
    `Held-out MCC — rug ${cm(i.heldOut.rug.before)} → ${cm(i.heldOut.rug.after)}; larp ${cm(i.heldOut.larp.before)} → ${cm(i.heldOut.larp.after)}.`,
    `Frozen canary MCC (must not regress) — baseline rug ${cm(i.canary.baseline.rugMcc)} / larp ${cm(i.canary.baseline.larpMcc)}; proposed rug ${cm(i.canary.proposed.rugMcc)} / larp ${cm(i.canary.proposed.larpMcc)}.`,
    '',
    'Also update the skill prose that names these numbers (rug-check/larp-check SKILL.md, token-dossier.md, packages/packs/eval/README.md) and the site docs/larp.md in the release lane — published numbers change only via a release and must keep the weak results. Do NOT auto-ship.',
  ].join('\n');
  return {
    title: `trenchscope skill-care: proposed ${i.kind} tuning (${i.date.slice(0, 10)})`,
    description: d,
    project: 'dexterm', priority: 'normal', owner: i.owner ?? 'maintainers', delegationTarget: i.owner ?? 'maintainers', actor: 'skill-care',
    constraints: [
      'Scratch branch off app main; never commit to main; ship to users only via a release after verification.',
      'Change the tunable grid only (RUG_RULES_V1 / LINK_RUBRIC_V1); keep the AVOID hard rules.',
      'Keep the weak results in the published numbers (site docs/larp.md).',
    ],
    acceptanceCriteria: [
      'Parameter diff applied on a scratch branch with the before/after numbers in the handoff',
      'Frozen canary does not regress; one npm test green',
      'Site docs/larp.md + skill prose updated in the release lane',
    ],
  };
}
