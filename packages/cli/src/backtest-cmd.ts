// `trenchscope backtest [--subject heuristic|pack_verdicts] [--horizon 3600] [--db PATH] [--json]`
// (task-1356, AI-SUITE-DESIGN §6). Scores the rug model (or recorded pack verdicts) against the
// recorder's LABELLED outcomes and prints HONEST metrics: base rate, precision/recall, Brier vs the
// base-rate Brier, AUC, a calibration table, a per-feed breakdown, and the worst misses/false alarms with
// their t0 numbers. No network, no model, read-only on the DB. The numbers are re-runnable from history.
//
// Subjects shipped here are the metric-bearing ones (a probability per row). The `filter` subject of the
// harness (label distribution for a grammar filter) needs a features→ScreenerRow adapter and is exercised
// through the harness API / packs tests, not this command yet.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultDbPath, LINK_RUBRIC_V0, DEFAULT_LINK_RUBRIC } from '@dexterm/data';
import { exportRecorded, openHistoryReadOnly, readLarpJoin, type Label } from '@dexterm/recorder';
import {
  runBacktest, h1Model, h2Model, larpEval, renderLarpEvalText, skillBacktest, renderSkillBacktestText, tuneLinkRubric, tuneRugRules,
  RUG_RULES_V0, RUG_RULES_V1, SKILL_EVAL_SCHEMA, type BacktestKind, type BacktestResult, type SkillEvalSet,
} from '@dexterm/packs';
import { buildSkillEvalSet } from './skill-eval-build.ts';

/** task-1401: the committed eval set the skill backtest reads by default. */
export const DEFAULT_SKILL_EVAL = fileURLToPath(new URL('../../packs/eval/skills-eval.json', import.meta.url));

export interface BacktestIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
}

const HORIZONS = [3600, 7200, 21600, 86400, 259200];

export const BACKTEST_HELP = `trenchscope backtest: score the rug model against recorded outcomes (task-1356). No network, no model.

  trenchscope backtest [--subject heuristic|pack_verdicts|larp] [--model h1|h2] [--horizon SEC] [--db PATH] [--json]
  trenchscope backtest --subject skills [--eval FILE] [--tune] [--report FILE] [--json]
  trenchscope backtest --build-eval FILE [--db PATH] [--horizon SEC] [--max-lag SEC]

  --subject   heuristic (default, the pre-registered H1 rug model), pack_verdicts (recorded pack rug_p), or
              larp (task-1359: recorded LARP-detector verdicts vs the outcome labels; counts only below
              50 matched verdicts, 95% Wilson intervals above; agreement with bad outcomes, not ground truth).
  skills      task-1401: the default analyst skills' replayable rules over the recorded eval set (the LARP
              check's links-only baseline, the rug-check verdict rules), per-grade precision/recall on a train
              and a held-out TEST split. Default eval: packages/packs/eval/skills-eval.json. --tune re-tunes on
              the train split only and prints before (v0) vs tuned; --report writes the JSON report.
  --build-eval  build that eval set from a recorder DB (read-only; no network; no URLs or names written).
  --model     which heuristic to score: h2 (the screener default) or h1 (the original pre-registered one).
  --horizon   outcome horizon in seconds: ${HORIZONS.join(', ')} (default 3600 = 1h).
  --json      print the full result object instead of the human table.
  --db        defaults to DEXTERM_DB_PATH, else ~/.local/share/dexterm/dexterm.db.

  Metrics are honest: features are the t0 snapshot the user would have seen, labels are the outcome AFTER
  t0, the split is by time, and the per-feed breakdown is shown so a model that only learns "which feed"
  is exposed. It needs recorded, outcome-labelled history (the app running with the recorder on long
  enough for the horizon to elapse); with none it says so rather than inventing numbers.`;

function parse(argv: string[]): Record<string, string | true> {
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--') && k !== 'json' && k !== 'tune') { opts[k] = v; i++; } else opts[k] = true;
  }
  return opts;
}

const pctOr = (x: number | null): string => (x === null ? ' — ' : `${(x * 100).toFixed(0)}%`);
const numOr = (x: number | null, d = 3): string => (x === null ? '—' : x.toFixed(d));
const usdOr = (x: number | null): string => {
  if (x === null) return '—';
  const a = Math.abs(x);
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(x / 1e3)}K`;
  return `$${Math.round(x)}`;
};

export function renderBacktestText(subject: string, horizon: number, labeler: string, r: BacktestResult): string {
  const L: string[] = [];
  L.push(`BACKTEST  subject=${subject}  horizon=${horizon}s  labeler=${labeler}  (${r.data_tier})`);
  if (r.note && r.precision === null && r.auc === null) { L.push(`  ${r.note}`); return L.join('\n') + '\n'; }
  L.push(`  n=${r.n}  base rate=${pctOr(r.base_rate)}  flagged=${r.flagged ?? '—'}  (tp ${r.tp ?? '—'} / fp ${r.fp ?? '—'} / fn ${r.fn ?? '—'} / tn ${r.tn ?? '—'})`);
  L.push(`  precision=${pctOr(r.precision)}  recall=${pctOr(r.recall)}  specificity=${pctOr(r.specificity ?? null)}`);
  L.push(`  AUC=${numOr(r.auc)}  Brier=${numOr(r.brier, 4)}  (base-rate Brier=${numOr(r.brier_base_rate, 4)})`);
  if (r.calibration?.length) {
    L.push('  calibration (bucket: mean p → observed, n):');
    for (const c of r.calibration) L.push(`    ${c.bucket.padEnd(9)} ${numOr(c.mean_p)} → ${numOr(c.observed)}  (n=${c.n})`);
  }
  if (r.by_feed && Object.keys(r.by_feed).length) {
    L.push('  per feed (n / positives / flagged / tp / base rate):');
    for (const [f, b] of Object.entries(r.by_feed).sort((a, c) => c[1].n - a[1].n)) {
      L.push(`    ${f.padEnd(20)} ${b.n} / ${b.pos} / ${b.flagged} / ${b.tp} / ${pctOr(b.base_rate)}`);
    }
  }
  if (r.worst_misses?.length) {
    L.push('  worst misses (positive the model scored low):');
    for (const m of r.worst_misses.slice(0, 5)) L.push(`    ${(m.symbol ?? m.mint.slice(0, 6)).padEnd(10)} p=${numOr(m.p)} ${m.label.padEnd(6)} liq ${usdOr(m.liq)} mcap ${usdOr(m.mcap)}`);
  }
  if (r.worst_false_alarms?.length) {
    L.push('  worst false alarms (negative the model scored high):');
    for (const m of r.worst_false_alarms.slice(0, 5)) L.push(`    ${(m.symbol ?? m.mint.slice(0, 6)).padEnd(10)} p=${numOr(m.p)} ${m.label.padEnd(6)} liq ${usdOr(m.liq)} mcap ${usdOr(m.mcap)}`);
  }
  L.push(`  leakage: features t0-only=${r.leakage_checks.features_from_t0_only}  labels after t0=${r.leakage_checks.labels_after_t0}  no future feeds=${r.leakage_checks.no_future_feeds}`);
  return L.join('\n') + '\n';
}

export function backtestCommand(argv: string[], io: BacktestIo): number {
  const opts = parse(argv);
  if (opts.help || opts.h) { io.stdout.write(BACKTEST_HELP + '\n'); return 0; }
  if (opts.subject === 'skills') return skillsCommand(opts, io);
  const path = typeof opts.db === 'string' ? opts.db : (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
  if (path === ':memory:') { io.stderr.write('trenchscope backtest: an in-memory DB has no history\n'); return 2; }
  const horizon = typeof opts.horizon === 'string' && HORIZONS.includes(Number(opts.horizon)) ? Number(opts.horizon) : 3600;
  const kind: BacktestKind = opts.subject === 'pack_verdicts' ? 'pack_verdicts' : 'heuristic';
  const heuristic = opts.model === 'h1' ? h1Model() : h2Model();
  let db: DatabaseSync | null = null;
  try {
    db = openHistoryReadOnly(path);
    if (!db) { io.stderr.write(`trenchscope backtest: no recorded history in ${path} (run the app with the recorder on first)\n`); return 2; }
    if (typeof opts['build-eval'] === 'string') {
      const maxLag = typeof opts['max-lag'] === 'string' ? Number(opts['max-lag']) : undefined;
      const set = buildSkillEvalSet(db, { horizonSec: typeof opts.horizon === 'string' ? horizon : 259_200, maxLagSec: Number.isFinite(maxLag) ? maxLag : undefined });
      writeFileSync(opts['build-eval'], JSON.stringify(set, null, 1) + '\n');
      io.stdout.write(`eval set: ${set.counts.rows} rows (train ${set.counts.train}, bad ${set.counts.bad_train} · test ${set.counts.test}, bad ${set.counts.bad_test}) → ${opts['build-eval']}\nexcluded: ${Object.entries(set.counts.excluded).map(([k, n]) => `${k} ${n}`).join(' · ')}\n`);
      return 0;
    }
    if (opts.subject === 'larp') {
      const r = larpEval(readLarpJoin(db, horizon));
      if (opts.json) io.stdout.write(JSON.stringify({ subject: 'larp', db: path, ...r }, null, 2) + '\n');
      else io.stdout.write(renderLarpEvalText(r, path));
      return 0;
    }
    const doc = exportRecorded(db, { labelledOnly: true });
    if (!doc.records.length) {
      io.stdout.write(`trenchscope backtest: the recorder has no outcome-labelled snapshots yet at any horizon.\nLabels need the horizon (${horizon}s) to have elapsed and a sweep to have run. Check back after the recorder has observed tokens for at least that long.\n`);
      return 0;
    }
    const verdictDb = db;
    const verdictRugP = kind === 'pack_verdicts'
      ? (mint: string, t0: number): number | null => {
          try {
            const row = verdictDb.prepare('SELECT rug_p FROM verdicts WHERE mint = ? AND t <= ? ORDER BY t DESC LIMIT 1').get(mint, t0) as { rug_p: number | null } | undefined;
            return row && typeof row.rug_p === 'number' ? row.rug_p : null;
          } catch { return null; }
        }
      : undefined;
    const result = runBacktest(doc, {
      kind, horizon_sec: horizon,
      subject: kind === 'pack_verdicts' ? { verdictRugP } : { model: heuristic },
    });
    const subjectLabel = kind === 'heuristic' ? heuristic.id : 'pack_verdicts';
    if (opts.json) io.stdout.write(JSON.stringify({ subject: subjectLabel, horizon_sec: horizon, labeler_version: doc.labeler_version, ...result }, null, 2) + '\n');
    else io.stdout.write(renderBacktestText(subjectLabel, horizon, doc.labeler_version, result));
    return 0;
  } catch (e) {
    io.stderr.write(`trenchscope backtest: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * task-1401: `--subject skills`. Before = the v0 rules written from the skill text before any backtest; after =
 * the shipped tuned rules, or (with --tune) a fresh train-split tune. Reads only the eval JSON.
 */
function skillsCommand(opts: Record<string, string | true>, io: BacktestIo): number {
  const file = typeof opts.eval === 'string' ? opts.eval : DEFAULT_SKILL_EVAL;
  let set: SkillEvalSet;
  if (file === DEFAULT_SKILL_EVAL && !existsSync(file)) {
    // the npm build ships no eval data (packages/packs/eval is repo-only): build one from your own history
    io.stderr.write('trenchscope backtest: the bundled eval set is not part of this install. Build one from your own recorder history:\n  trenchscope backtest --build-eval ./skills-eval.json && trenchscope backtest --subject skills --eval ./skills-eval.json\n');
    return 2;
  }
  try { set = JSON.parse(readFileSync(file, 'utf8')) as SkillEvalSet; } catch (e) { io.stderr.write(`trenchscope backtest: cannot read eval set ${file}: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }
  if (set.schema !== SKILL_EVAL_SCHEMA || !Array.isArray(set.rows)) { io.stderr.write(`trenchscope backtest: ${file} is not a ${SKILL_EVAL_SCHEMA} file\n`); return 2; }
  let larpAfter = DEFAULT_LINK_RUBRIC, rugAfter = RUG_RULES_V1, tuned = null;
  if (opts.tune) {
    const train = set.rows.filter((r) => r.split === 'train');
    const l = tuneLinkRubric(train); const r = tuneRugRules(train);
    larpAfter = l.rubric; rugAfter = r.rules;
    tuned = { larp: { train_mcc: l.train_mcc, candidates: l.candidates }, rug: { train_mcc: r.train_mcc, candidates: r.candidates } };
  }
  const report = skillBacktest(set, { larpBefore: LINK_RUBRIC_V0, larpAfter, rugBefore: RUG_RULES_V0, rugAfter, tuned });
  if (typeof opts.report === 'string') writeFileSync(opts.report, JSON.stringify(report, null, 1) + '\n');
  io.stdout.write(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderSkillBacktestText(report));
  return 0;
}

// Re-export so a consumer that wants the Label enum for a custom positive class has it in one place.
export type { Label };
