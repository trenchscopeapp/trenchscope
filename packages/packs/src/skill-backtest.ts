// Skill backtest harness (task-1401). Runs the replayable part of the default analyst skills over a recorded,
// outcome-labelled eval set and reports per-grade precision/recall with 95 % Wilson intervals, on a TRAIN and a
// held-out TEST split. Pure: input is the eval set JSON (built from a recorder DB by `trenchscope backtest
// --build-eval`), so every number is re-runnable offline.
//
// Which skills, and what is actually replayed:
//   - larp-check: the links-only baseline grade (@dexterm/data link-baseline.ts) the skill starts from. The model
//     stage (fetched pages, RDAP, GitHub) cannot be replayed on history and is NOT measured here.
//   - rug-check (and token-dossier, which shares its verdict rules): the skill's stated verdict rules over the t0
//     snapshot columns the recorder keeps (authorities, dev %, organic score, top-10 %, liquidity). The model's
//     own rug_probability is not replayed either; the recorded-verdict path (`--subject pack_verdicts|larp`)
//     measures that going forward.
// The other default skills (trench-scan) have no per-token labelled outcome.
//
// Labels: the recorder's keyless-proxy outcome at the eval horizon; bad = rug ∪ dead, ok = flat ∪ fade ∪ runner.
// That is a PRICE outcome, not ground truth about a product: a LARP grade "agrees" when the coin went bad.
//
// Honesty rules enforced in code: tuning functions refuse any TEST row (throw), the split is by time and fixed
// in the eval file before tuning, and rates under MIN_N rows print as counts only.

import {
  gradeLinks, LINK_SIGNALS, linkSignals,
  type LinkFeatures, type LinkGrade, type LinkRubric, type LinkSignal,
} from '@dexterm/data';
import { wilson, type Rate } from './larp-eval.ts';

export const SKILL_EVAL_SCHEMA = 'dexterm/packs/skill-eval/1';
export const SKILL_BACKTEST_SCHEMA = 'dexterm/packs/skill-backtest/1';
/** Below this many rows in a grade, its rates are printed as counts only (same spirit as the n ≥ 50 gate). */
export const SKILL_MIN_N = 20;

/** The t0 snapshot columns the rug-check rules read (recorder token_snapshots; null = unavailable at t0). */
export interface RugRuleFeatures {
  freeze_auth: boolean | null;
  mint_auth: boolean | null;
  dev_pct: number | null;
  top10_pct: number | null;
  organic_score: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  lp_locked_pct: number | null;
  launchpad: string | null;
  age_sec: number | null;
}

export interface SkillEvalRow {
  mint: string;
  t0: number;
  split: 'train' | 'test';
  /** Recorder outcome label at the eval horizon. */
  outcome: 'rug' | 'dead' | 'fade' | 'flat' | 'runner';
  bad: boolean;
  /** URL-free link features from the cached DexScreener/Jupiter record fetched within the lag window after t0. */
  link: LinkFeatures;
  link_sources: string[];
  link_lag_sec: number;
  rug: RugRuleFeatures;
}

export interface SkillEvalSet {
  schema: typeof SKILL_EVAL_SCHEMA;
  built_at: string;
  source: { kind: 'recorder'; labeler_version: string; db_note: string };
  horizon_sec: number;
  label_rule: string;
  evidence_rule: string;
  split_rule: string;
  cutoff_t0: number;
  counts: { rows: number; train: number; test: number; bad_train: number; bad_test: number; excluded: Record<string, number> };
  rows: SkillEvalRow[];
}

// ------------------------------------------------------------------------------------------ rug-check rules

export type RugGrade = 'AVOID' | 'SPECULATIVE' | 'WATCH' | 'INSUFFICIENT_DATA';

export interface RugRules {
  id: string;
  /** SPECULATIVE when dev_pct is above this (null = rule off). */
  dev_pct_over: number | null;
  /** SPECULATIVE when organic_score is below this (null = off). */
  organic_below: number | null;
  /** SPECULATIVE when top10_pct is above this (null = off). */
  top10_over: number | null;
  /** SPECULATIVE when liquidity_usd is below this (null = off). */
  liq_below: number | null;
  provenance: string;
}

/** v0: the rug-check skill's own rules as written before the backtest (dev > 10 %, organic < 40 = soft flags). */
export const RUG_RULES_V0: RugRules = {
  id: 'rug-rules-v0', dev_pct_over: 10, organic_below: 40, top10_over: null, liq_below: null,
  provenance: 'the rug-check skill 0.2.0 / token-dossier computeFlags thresholds before the backtest',
};

/** v1: tuned on the TRAIN split (grid search, objective MCC of AVOID ∪ SPECULATIVE → bad). */
export const RUG_RULES_V1: RugRules = {
  id: 'rug-rules-v1', dev_pct_over: null, organic_below: null, top10_over: null, liq_below: 5_000,
  provenance: 'tuned on the train split of the task-1401 eval set (see packages/packs/eval/README.md)',
};

/**
 * The rug-check verdict rules on recorder t0 columns. AVOID rules are the skill's hard disqualifiers and are never
 * tuned (authorities; LP unlocked off pump.fun with top-10 above 50 %). INSUFFICIENT_DATA only when there is no
 * price and no liquidity (skill rule). Everything tunable only moves a coin between SPECULATIVE and WATCH.
 */
export function gradeRugRules(f: RugRuleFeatures, rules: RugRules = RUG_RULES_V1): { grade: RugGrade; reasons: string[] } {
  if (!((f.price_usd ?? 0) > 0) && !((f.liquidity_usd ?? 0) > 0)) return { grade: 'INSUFFICIENT_DATA', reasons: ['no price and no liquidity'] };
  const avoid: string[] = [];
  if (f.freeze_auth === true) avoid.push('freeze_authority_enabled');
  if (f.mint_auth === true) avoid.push('mint_authority_enabled');
  if (f.lp_locked_pct !== null && f.lp_locked_pct < 100 && f.launchpad !== 'pump.fun' && (f.top10_pct ?? 0) > 50) avoid.push('lp_unlocked_and_concentrated');
  if (avoid.length) return { grade: 'AVOID', reasons: avoid };
  const soft: string[] = [];
  if (rules.dev_pct_over !== null && (f.dev_pct ?? 0) > rules.dev_pct_over) soft.push(`dev_over_${rules.dev_pct_over}pct`);
  if (rules.organic_below !== null && f.organic_score !== null && f.organic_score < rules.organic_below) soft.push(`organic_below_${rules.organic_below}`);
  if (rules.top10_over !== null && f.top10_pct !== null && f.top10_pct > rules.top10_over) soft.push(`top10_over_${rules.top10_over}pct`);
  if (rules.liq_below !== null && (f.liquidity_usd ?? 0) < rules.liq_below) soft.push(`liquidity_below_${rules.liq_below}`);
  return soft.length ? { grade: 'SPECULATIVE', reasons: soft } : { grade: 'WATCH', reasons: [] };
}

// ------------------------------------------------------------------------------------------ metrics

/** What a grade claims about the outcome: a warning grade claims `bad`, a clean grade `ok`, others nothing. */
export type GradeClaim = 'bad' | 'ok' | null;
export const LARP_GRADE_CLAIMS: Record<LinkGrade, GradeClaim> = { LARP: 'bad', EARLY_BUT_REAL: 'ok', UNVERIFIABLE: null };
export const RUG_GRADE_CLAIMS: Record<RugGrade, GradeClaim> = { AVOID: 'bad', SPECULATIVE: 'bad', WATCH: 'ok', INSUFFICIENT_DATA: null };

export interface GradeMetrics {
  grade: string;
  claims: GradeClaim;
  n: number;
  bad: number;
  /** P(bad | grade). */
  bad_rate: Rate | null;
  /** P(claim right | grade): P(bad | grade) for a warning grade, P(ok | grade) for a clean grade. Null below SKILL_MIN_N or for no claim. */
  precision: Rate | null;
  /** P(grade | claimed class): the share of all bad (warning grade) or all ok (clean grade) rows this grade caught. */
  recall: Rate | null;
}

export interface SplitMetrics {
  n: number;
  bad: number;
  base_rate: Rate | null;
  by_grade: GradeMetrics[];
  /** Binary view: any warning grade → predicted bad; every other grade → predicted not bad. */
  binary: { tp: number; fp: number; fn: number; tn: number; precision: Rate | null; recall: Rate | null; mcc: number | null };
}

export function mcc(tp: number, fp: number, fn: number, tn: number): number | null {
  const d = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  return d === 0 ? null : (tp * tn - fp * fn) / d;
}

export function splitMetrics(rows: readonly { grade: string; bad: boolean }[], claims: Record<string, GradeClaim>, order: readonly string[]): SplitMetrics {
  const n = rows.length;
  const bad = rows.filter((r) => r.bad).length;
  const ok = n - bad;
  const by_grade: GradeMetrics[] = order.map((g) => {
    const gr = rows.filter((r) => r.grade === g);
    const gb = gr.filter((r) => r.bad).length;
    const claim = claims[g] ?? null;
    const enough = gr.length >= SKILL_MIN_N;
    const right = claim === 'bad' ? gb : claim === 'ok' ? gr.length - gb : 0;
    const classN = claim === 'bad' ? bad : claim === 'ok' ? ok : 0;
    return {
      grade: g, claims: claim, n: gr.length, bad: gb,
      bad_rate: enough ? wilson(gb, gr.length) : null,
      precision: claim && enough ? wilson(right, gr.length) : null,
      recall: claim && enough && classN > 0 ? wilson(right, classN) : null,
    };
  });
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    const warn = claims[r.grade] === 'bad';
    if (warn && r.bad) tp++; else if (warn) fp++; else if (r.bad) fn++; else tn++;
  }
  return {
    n, bad, base_rate: wilson(bad, n), by_grade,
    binary: { tp, fp, fn, tn, precision: tp + fp >= SKILL_MIN_N ? wilson(tp, tp + fp) : null, recall: bad >= SKILL_MIN_N ? wilson(tp, tp + fn) : null, mcc: mcc(tp, fp, fn, tn) },
  };
}

export const LARP_GRADE_ORDER: LinkGrade[] = ['LARP', 'UNVERIFIABLE', 'EARLY_BUT_REAL'];
export const RUG_GRADE_ORDER: RugGrade[] = ['AVOID', 'SPECULATIVE', 'WATCH', 'INSUFFICIENT_DATA'];

export interface SubjectResult { params: string; train: SplitMetrics; test: SplitMetrics }

function evalSplit<P>(rows: readonly SkillEvalRow[], grade: (r: SkillEvalRow, p: P) => string, p: P, claims: Record<string, GradeClaim>, order: readonly string[]) {
  return splitMetrics(rows.map((r) => ({ grade: grade(r, p), bad: r.bad })), claims, order);
}

const larpGradeOf = (r: SkillEvalRow, rubric: LinkRubric): string => gradeLinks(r.link, rubric).grade;
const rugGradeOf = (r: SkillEvalRow, rules: RugRules): string => gradeRugRules(r.rug, rules).grade;

export function runLarpSubject(set: SkillEvalSet, rubric: LinkRubric): SubjectResult {
  const train = set.rows.filter((r) => r.split === 'train');
  const test = set.rows.filter((r) => r.split === 'test');
  return {
    params: rubric.id,
    train: evalSplit(train, larpGradeOf, rubric, LARP_GRADE_CLAIMS, LARP_GRADE_ORDER),
    test: evalSplit(test, larpGradeOf, rubric, LARP_GRADE_CLAIMS, LARP_GRADE_ORDER),
  };
}

export function runRugSubject(set: SkillEvalSet, rules: RugRules): SubjectResult {
  const train = set.rows.filter((r) => r.split === 'train');
  const test = set.rows.filter((r) => r.split === 'test');
  return {
    params: rules.id,
    train: evalSplit(train, rugGradeOf, rules, RUG_GRADE_CLAIMS, RUG_GRADE_ORDER),
    test: evalSplit(test, rugGradeOf, rules, RUG_GRADE_CLAIMS, RUG_GRADE_ORDER),
  };
}

// ------------------------------------------------------------------------------------------ tuning (train only)

function assertTrainOnly(rows: readonly SkillEvalRow[]): void {
  const bad = rows.find((r) => r.split !== 'train');
  if (bad) throw new Error(`tuning refused: row ${bad.mint.slice(0, 6)}… is in the ${bad.split} split (tune on the train split only)`);
}

/** Better = higher MCC; ties go to the simpler parameter set (smaller `cost`). Null MCC never wins. */
function better(m: number | null, cost: number, best: { m: number | null; cost: number } | null): boolean {
  if (m === null) return false;
  if (!best || best.m === null) return true;
  if (m > best.m + 1e-12) return true;
  return Math.abs(m - best.m) <= 1e-12 && cost < best.cost;
}

/**
 * Grid-search the link rubric on TRAIN rows: weights 0..2 per signal, threshold 1..5, objective MCC of
 * LARP → bad. Rows are bucketed by signal mask first, so the 98 k candidates evaluate in well under a second.
 */
export function tuneLinkRubric(rows: readonly SkillEvalRow[], id = 'larp-links-v1'): { rubric: LinkRubric; train_mcc: number | null; candidates: number } {
  assertTrainOnly(rows);
  const buckets = new Map<string, { sig: LinkSignal[]; hasWeb: boolean; bad: number; ok: number }>();
  for (const r of rows) {
    const sig = linkSignals(r.link);
    const key = `${r.link.web === 'none' ? 0 : 1}|${sig.join(',')}`;
    const b = buckets.get(key) ?? { sig, hasWeb: r.link.web !== 'none', bad: 0, ok: 0 };
    if (r.bad) b.bad++; else b.ok++;
    buckets.set(key, b);
  }
  const list = [...buckets.values()].map((b) => ({ ...b, idx: b.sig.map((s) => LINK_SIGNALS.indexOf(s)) }));
  const totalBad = rows.filter((r) => r.bad).length;
  const totalOk = rows.length - totalBad;
  const K = LINK_SIGNALS.length;
  const w = new Array<number>(K).fill(0);
  let best: { m: number | null; cost: number; w: number[]; t: number } | null = null;
  let candidates = 0;
  const combos = 3 ** K;
  for (let c = 0; c < combos; c++) {
    let x = c;
    let sum = 0;
    for (let k = 0; k < K; k++) { w[k] = x % 3; x = Math.floor(x / 3); sum += w[k]; }
    if (sum === 0) continue;
    for (let t = 1; t <= 5; t++) {
      candidates++;
      let tp = 0, fp = 0;
      for (const b of list) {
        if (!b.hasWeb) continue;
        let s = 0;
        for (const i of b.idx) s += w[i];
        if (s >= t) { tp += b.bad; fp += b.ok; }
      }
      const m = mcc(tp, fp, totalBad - tp, totalOk - fp);
      if (better(m, sum * 10 + t, best)) best = { m, cost: sum * 10 + t, w: w.slice(), t };
    }
  }
  const weights = Object.fromEntries(LINK_SIGNALS.map((s, i) => [s, best ? best.w[i] : 0])) as Record<LinkSignal, number>;
  return {
    rubric: { id, weights, threshold: best?.t ?? 99, provenance: `tuned on ${rows.length} train rows (MCC ${best?.m?.toFixed(3) ?? '—'})` },
    train_mcc: best?.m ?? null, candidates,
  };
}

export const RUG_GRID = {
  dev_pct_over: [null, 5, 10, 15, 20, 30],
  organic_below: [null, 10, 20, 30, 40, 50, 60, 70],
  top10_over: [null, 20, 30, 40, 50, 60],
  liq_below: [null, 2_000, 5_000, 10_000, 20_000, 50_000],
} as const;

/** Grid-search the tunable rug-check thresholds on TRAIN rows; objective MCC of AVOID ∪ SPECULATIVE → bad. */
export function tuneRugRules(rows: readonly SkillEvalRow[], id = 'rug-rules-v1'): { rules: RugRules; train_mcc: number | null; candidates: number } {
  assertTrainOnly(rows);
  let best: { m: number | null; cost: number; r: RugRules } | null = null;
  let candidates = 0;
  for (const dev of RUG_GRID.dev_pct_over) for (const org of RUG_GRID.organic_below) for (const top of RUG_GRID.top10_over) for (const liq of RUG_GRID.liq_below) {
    candidates++;
    const r: RugRules = { id, dev_pct_over: dev, organic_below: org, top10_over: top, liq_below: liq, provenance: '' };
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const row of rows) {
      const warn = RUG_GRADE_CLAIMS[gradeRugRules(row.rug, r).grade] === 'bad';
      if (warn && row.bad) tp++; else if (warn) fp++; else if (row.bad) fn++; else tn++;
    }
    const cost = [dev, org, top, liq].filter((v) => v !== null).length;
    const m = mcc(tp, fp, fn, tn);
    if (better(m, cost, best)) best = { m, cost, r };
  }
  const rules = best?.r ?? { ...RUG_RULES_V0, id };
  return { rules: { ...rules, provenance: `tuned on ${rows.length} train rows (MCC ${best?.m?.toFixed(3) ?? '—'})` }, train_mcc: best?.m ?? null, candidates };
}

// ------------------------------------------------------------------------------------------ the report

export interface SkillBacktestReport {
  schema: typeof SKILL_BACKTEST_SCHEMA;
  eval: { built_at: string; horizon_sec: number; cutoff_t0: number; counts: SkillEvalSet['counts']; label_rule: string; evidence_rule: string; split_rule: string };
  larp: { before: SubjectResult; after: SubjectResult; rubric_before: LinkRubric; rubric_after: LinkRubric; tuned: { train_mcc: number | null; candidates: number } | null };
  rug: { before: SubjectResult; after: SubjectResult; rules_before: RugRules; rules_after: RugRules; tuned: { train_mcc: number | null; candidates: number } | null };
  not_measured: string[];
  method: string[];
}

export function skillBacktest(set: SkillEvalSet, opts: {
  larpBefore: LinkRubric; larpAfter: LinkRubric; rugBefore: RugRules; rugAfter: RugRules;
  tuned?: { larp: { train_mcc: number | null; candidates: number }; rug: { train_mcc: number | null; candidates: number } } | null;
}): SkillBacktestReport {
  return {
    schema: SKILL_BACKTEST_SCHEMA,
    eval: { built_at: set.built_at, horizon_sec: set.horizon_sec, cutoff_t0: set.cutoff_t0, counts: set.counts, label_rule: set.label_rule, evidence_rule: set.evidence_rule, split_rule: set.split_rule },
    larp: { before: runLarpSubject(set, opts.larpBefore), after: runLarpSubject(set, opts.larpAfter), rubric_before: opts.larpBefore, rubric_after: opts.larpAfter, tuned: opts.tuned?.larp ?? null },
    rug: { before: runRugSubject(set, opts.rugBefore), after: runRugSubject(set, opts.rugAfter), rules_before: opts.rugBefore, rules_after: opts.rugAfter, tuned: opts.tuned?.rug ?? null },
    not_measured: [
      'larp-check model stage (fetch_page / check_domain / check_github and the model\'s judgement): pages from the past cannot be re-fetched as they were; measured forward only via `trenchscope backtest --subject larp` once ≥ 50 recorded verdicts match an outcome',
      'rug-check model output (rug_probability, bias): measured forward via `--subject pack_verdicts` from recorded verdicts',
      'trench-scan: no per-token labelled outcome',
    ],
    method: [
      `eval set: ${set.counts.rows} coins from this machine's recorder (${set.counts.train} train / ${set.counts.test} test), one row per coin`,
      `labels: ${set.label_rule}`,
      `evidence: ${set.evidence_rule}`,
      `split: ${set.split_rule}`,
      'tuning: grid search on the train split only (the code refuses test rows); objective MCC of warning grade → bad; ties go to the simpler setting',
      `rates: 95% Wilson intervals; a grade with fewer than ${SKILL_MIN_N} rows prints counts only`,
      'meaning: agreement between a grade and a bad price outcome; a risk flag, not a certificate, and not a measure of whether a product is real',
    ],
  };
}

const pct = (r: Rate | null): string => (r === null ? '—' : `${(r.value * 100).toFixed(1)}% [${(r.lo * 100).toFixed(0)}–${(r.hi * 100).toFixed(0)}]`);

function splitLines(name: string, m: SplitMetrics): string[] {
  const L = [`    ${name}: n=${m.n}  bad=${m.bad}  base rate ${pct(m.base_rate)}  MCC ${m.binary.mcc === null ? '—' : m.binary.mcc.toFixed(3)}  (tp ${m.binary.tp} fp ${m.binary.fp} fn ${m.binary.fn} tn ${m.binary.tn})`];
  for (const g of m.by_grade) {
    L.push(`      ${g.grade.padEnd(17)} n=${String(g.n).padEnd(4)} bad=${String(g.bad).padEnd(4)} P(bad)=${pct(g.bad_rate).padEnd(18)} ${g.claims ? `claims ${g.claims.padEnd(3)} precision=${pct(g.precision).padEnd(18)} recall=${pct(g.recall)}` : 'claims nothing'}`);
  }
  return L;
}

export function renderSkillBacktestText(r: SkillBacktestReport): string {
  const L: string[] = [];
  L.push(`SKILL BACKTEST  horizon=${r.eval.horizon_sec}s  eval built ${r.eval.built_at}  rows ${r.eval.counts.rows} (train ${r.eval.counts.train} · test ${r.eval.counts.test})`);
  L.push('');
  L.push(`larp-check · links-only baseline  before=${r.larp.rubric_before.id}  after=${r.larp.rubric_after.id}${r.larp.tuned ? `  (tuned: train MCC ${r.larp.tuned.train_mcc?.toFixed(3) ?? '—'}, ${r.larp.tuned.candidates} candidates)` : ''}`);
  L.push('  before'); L.push(...splitLines('train', r.larp.before.train)); L.push(...splitLines('TEST ', r.larp.before.test));
  L.push('  after'); L.push(...splitLines('train', r.larp.after.train)); L.push(...splitLines('TEST ', r.larp.after.test));
  L.push('');
  L.push(`rug-check · verdict rules  before=${r.rug.rules_before.id}  after=${r.rug.rules_after.id}${r.rug.tuned ? `  (tuned: train MCC ${r.rug.tuned.train_mcc?.toFixed(3) ?? '—'}, ${r.rug.tuned.candidates} candidates)` : ''}`);
  L.push('  before'); L.push(...splitLines('train', r.rug.before.train)); L.push(...splitLines('TEST ', r.rug.before.test));
  L.push('  after'); L.push(...splitLines('train', r.rug.after.train)); L.push(...splitLines('TEST ', r.rug.after.test));
  L.push('');
  L.push('not measured:'); for (const m of r.not_measured) L.push(`  - ${m}`);
  L.push('method:'); for (const m of r.method) L.push(`  - ${m}`);
  return L.join('\n') + '\n';
}
