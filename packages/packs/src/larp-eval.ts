// LARP eval (task-1359). Scores the LARP detector's recorded product verdicts against the recorder's outcome
// labels and reports what was actually measured, nothing more. Pure: input is the recorder join
// (@dexterm/recorder readLarpJoin), so every number is re-runnable from a history.sqlite.
//
// What "accuracy" can mean here. The only labels trenchscope records are price/liquidity OUTCOMES (rug / dead /
// fade / flat / runner at a horizon). There is no ground-truth label of whether a coin's product is real. So
// the eval measures AGREEMENT: does a `LARP` verdict precede a bad outcome (rug ∪ dead on keyless data, rug
// alone when chain-verified) more often than a REAL_PRODUCT / EARLY_BUT_REAL verdict does? It is printed as
// that, never as "the detector is N % accurate".
//
// Pre-registered gate (CLAUDE-LAYER eval rule: report hit rates only once n ≥ 50): below LARP_EVAL_MIN_N matched
// verdicts the result carries counts only and every rate is null.

import type { Label } from '@dexterm/recorder';

export const LARP_EVAL_SCHEMA = 'dexterm/packs/larp-eval';
export const LARP_EVAL_MIN_N = 50;

/** The recorder join row this needs (structurally @dexterm/recorder LarpJoinRow). */
export interface LarpEvalInputRow { verdict: string; label: Label | null; positive: boolean | null }
export interface LarpEvalInput {
  horizon_sec: number;
  slack_sec: number;
  verdicts_recorded: number;
  rows: readonly LarpEvalInputRow[];
  outcomes_at_horizon: number;
  outcome_counts: Partial<Record<Label, number>>;
  unobserved_at_horizon: number;
}

export interface Rate { value: number; lo: number; hi: number; k: number; n: number }

export interface LarpEvalResult {
  schema: typeof LARP_EVAL_SCHEMA;
  horizon_sec: number;
  slack_sec: number;
  /** Labelled history size at this horizon (observed outcomes), the sample the verdicts are drawn against. */
  outcomes_at_horizon: number;
  outcome_counts: Partial<Record<Label, number>>;
  unobserved_at_horizon: number;
  verdicts_recorded: number;
  matched: number;
  unmatched: number;
  /** Per verdict class: matched n, bad outcomes, and the label split. */
  by_verdict: Record<string, { n: number; bad: number; by_label: Partial<Record<Label, number>> }>;
  /** LARP vs (REAL_PRODUCT ∪ EARLY_BUT_REAL); UNVERIFIABLE and NO_PRODUCT_CLAIMED are reported apart, never counted as either. */
  confusion: { tp: number; fp: number; fn: number; tn: number; unverifiable: number };
  reportable: boolean;
  /** P(bad outcome | LARP verdict) — the precision of LARP as a warning. Null below the gate. */
  precision: Rate | null;
  /** P(LARP verdict | bad outcome) among decided verdicts. Null below the gate. */
  recall: Rate | null;
  /** P(bad outcome | REAL_PRODUCT or EARLY_BUT_REAL) — the comparison rate. Null below the gate. */
  bad_rate_when_real: Rate | null;
  note: string;
  method: string[];
}

/** Wilson score interval (95 % by default). n = 0 → null. */
export function wilson(k: number, n: number, z = 1.96): Rate | null {
  if (n <= 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { value: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h), k, n };
}

export function larpEval(input: LarpEvalInput): LarpEvalResult {
  const by: LarpEvalResult['by_verdict'] = {};
  const cm = { tp: 0, fp: 0, fn: 0, tn: 0, unverifiable: 0 };
  let matched = 0;
  for (const r of input.rows) {
    if (r.label === null || r.positive === null) continue;
    matched++;
    const b = (by[r.verdict] ??= { n: 0, bad: 0, by_label: {} });
    b.n++; if (r.positive) b.bad++;
    b.by_label[r.label] = (b.by_label[r.label] ?? 0) + 1;
    if (r.verdict === 'LARP') { if (r.positive) cm.tp++; else cm.fp++; }
    else if (r.verdict === 'REAL_PRODUCT' || r.verdict === 'EARLY_BUT_REAL') { if (r.positive) cm.fn++; else cm.tn++; }
    else cm.unverifiable++;
  }
  const reportable = matched >= LARP_EVAL_MIN_N;
  const method = [
    `verdicts: the LARP detector's settled product_assessment (pack larp-check), recorded when the analyst turn finishes`,
    `labels: the recorder's code-only outcome labeler at horizon ${input.horizon_sec}s (keyless proxy unless chain-verified); bad = rug ∪ dead (keyless) or rug (chain-verified)`,
    `join: the latest t0 anchor of the same mint at most ${input.slack_sec}s before the verdict; later anchors and 'unobserved' labels are not matched`,
    `scored: LARP vs REAL_PRODUCT ∪ EARLY_BUT_REAL; UNVERIFIABLE and NO_PRODUCT_CLAIMED counted apart; 95% Wilson intervals`,
    `gate: rates are published only at n ≥ ${LARP_EVAL_MIN_N} matched verdicts (pre-registered); below it, counts only`,
    `meaning: agreement between a LARP verdict and a bad price outcome, NOT a ground-truth measure of whether a product is real`,
  ];
  const note = input.verdicts_recorded === 0
    ? `no LARP verdicts recorded yet: nothing to score (labelled history at this horizon: n=${input.outcomes_at_horizon})`
    : !reportable
      ? `${matched} matched verdict${matched === 1 ? '' : 's'} (< ${LARP_EVAL_MIN_N}): counts only, no rates`
      : `${matched} matched verdicts`;
  return {
    schema: LARP_EVAL_SCHEMA, horizon_sec: input.horizon_sec, slack_sec: input.slack_sec,
    outcomes_at_horizon: input.outcomes_at_horizon, outcome_counts: { ...input.outcome_counts }, unobserved_at_horizon: input.unobserved_at_horizon,
    verdicts_recorded: input.verdicts_recorded, matched, unmatched: input.verdicts_recorded - matched,
    by_verdict: by, confusion: cm, reportable,
    precision: reportable ? wilson(cm.tp, cm.tp + cm.fp) : null,
    recall: reportable ? wilson(cm.tp, cm.tp + cm.fn) : null,
    bad_rate_when_real: reportable ? wilson(cm.fn, cm.fn + cm.tn) : null,
    note, method,
  };
}

const pct = (r: Rate | null): string => (r === null ? '—' : `${(r.value * 100).toFixed(1)}% [${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)}] (${r.k}/${r.n})`);

/** The human table `trenchscope backtest --subject larp` prints. */
export function renderLarpEvalText(r: LarpEvalResult, source: string): string {
  const L: string[] = [];
  L.push(`LARP EVAL  horizon=${r.horizon_sec}s  match window=${r.slack_sec}s  db=${source}`);
  const oc = Object.entries(r.outcome_counts).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none';
  L.push(`  labelled history at this horizon: n=${r.outcomes_at_horizon} (${oc}; unobserved ${r.unobserved_at_horizon})`);
  L.push(`  LARP verdicts recorded: ${r.verdicts_recorded} · matched to an outcome: ${r.matched} · unmatched: ${r.unmatched}`);
  for (const [v, b] of Object.entries(r.by_verdict)) L.push(`    ${v.padEnd(15)} n=${b.n}  bad=${b.bad}  ${Object.entries(b.by_label).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  L.push(`  confusion (LARP vs real): tp ${r.confusion.tp} · fp ${r.confusion.fp} · fn ${r.confusion.fn} · tn ${r.confusion.tn} · unverifiable ${r.confusion.unverifiable}`);
  if (r.reportable) {
    L.push(`  P(bad | LARP)      = ${pct(r.precision)}`);
    L.push(`  P(bad | real)      = ${pct(r.bad_rate_when_real)}`);
    L.push(`  P(LARP | bad)      = ${pct(r.recall)}`);
  } else L.push(`  ${r.note}`);
  L.push('  method:');
  for (const m of r.method) L.push(`    - ${m}`);
  return L.join('\n') + '\n';
}
