// task-1359 LARP eval: settled LARP verdicts are written to the recorder (pack larp-check), joined to the outcome
// labels with an anti-leak match window, and scored honestly (counts only below n = 50, Wilson intervals above,
// "agreement with a bad outcome" — never "accuracy of what is real"). Offline, in-memory / temp-file DBs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL, readLarpJoin, LARP_PACK } from '@dexterm/recorder';
import { larpEval, wilson, renderLarpEvalText, LARP_EVAL_MIN_N } from '@dexterm/packs';
import { recordLarpVerdict } from '../src/larp-record.ts';
import { backtestCommand } from '../src/backtest-cmd.ts';

const H = 3600;
const T = 1_790_000_000_000;

function mem(): DatabaseSync { const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL); return db; }
function outcome(db: DatabaseSync, mint: string, t0: number, label: string, tier = 'keyless-proxy', horizon = H): void {
  db.prepare('INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, evidence, labeler_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(mint, t0, horizon, t0 + horizon * 1000, label, tier, '{}', '0.2.0');
}
const v = (mint: string, verdict: string, t: number) => ({ mint, verdict, confidence: 0.7, t, skill: 'larp-check', model: null });

test('recordLarpVerdict keeps a NO_PRODUCT_CLAIMED verdict, and the eval never scores it as real (larp-fixes)', () => {
  const db = mem();
  assert.equal(recordLarpVerdict(db, v('M2', 'NO_PRODUCT_CLAIMED', T)), true);
  const r = larpEval({ horizon_sec: 3600, slack_sec: 360, outcomes_at_horizon: 1, outcome_counts: {}, unobserved_at_horizon: 0, verdicts_recorded: 1,
    rows: [{ verdict: 'NO_PRODUCT_CLAIMED', label: 'flat', positive: false }] });
  assert.deepEqual(r.confusion, { tp: 0, fp: 0, fn: 0, tn: 0, unverifiable: 1 });
});

test('recordLarpVerdict: writes one larp-check row per call, refuses unknown verdicts and a missing DB', () => {
  const db = mem();
  assert.equal(recordLarpVerdict(db, v('M1', 'LARP', T)), true);
  assert.equal(recordLarpVerdict(db, v('M1', 'SAFE_TO_APE', T)), false, 'only the four product classes');
  assert.equal(recordLarpVerdict(null, v('M1', 'LARP', T)), false);
  assert.equal(recordLarpVerdict(new DatabaseSync(':memory:'), v('M1', 'LARP', T)), false, 'no verdicts table → no-op, never a throw');
  const rows = db.prepare('SELECT pack, pack_version, verdict, confidence, length(input_hash) AS h FROM verdicts').all() as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ pack: LARP_PACK, pack_version: 'task-1315/larp-check', verdict: 'LARP', confidence: 0.7, h: 64 }]);
});

test('readLarpJoin: latest t0 anchor at most 10% of the horizon BEFORE the verdict; later anchors, stale anchors and unobserved are unmatched', () => {
  const db = mem();
  outcome(db, 'A', T - 100_000, 'dead');       // 100 s before → matched
  outcome(db, 'B', T - 1_000_000, 'flat');     // 1000 s before (> 360 s) → stale, unmatched
  outcome(db, 'C', T + 60_000, 'rug');         // after the verdict → never matched (would leak)
  outcome(db, 'D', T - 10_000, 'unobserved');  // unobserved → unmatched
  outcome(db, 'E', T - 50_000, 'rug', 'chain-verified');
  outcome(db, 'F', T - 50_000, 'dead', 'chain-verified');
  outcome(db, 'G', T - 50_000, 'flat', 'keyless-proxy', 7200); // other horizon
  for (const m of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) recordLarpVerdict(db, v(m, 'LARP', T));
  const j = readLarpJoin(db, H);
  assert.equal(j.slack_sec, 360);
  assert.equal(j.verdicts_recorded, 7);
  const by = Object.fromEntries(j.rows.map((r) => [r.mint, r]));
  assert.equal(by.A.label, 'dead'); assert.equal(by.A.positive, true);
  assert.equal(by.B.label, null); assert.equal(by.C.label, null); assert.equal(by.D.label, null); assert.equal(by.G.label, null);
  assert.equal(by.E.positive, true, 'chain-verified rug is bad');
  assert.equal(by.F.positive, false, 'chain-verified: dead alone is not a rug');
  assert.equal(j.outcomes_at_horizon, 5); assert.equal(j.unobserved_at_horizon, 1);
  assert.deepEqual(j.outcome_counts, { dead: 2, flat: 1, rug: 2 });
  // a DB with no verdicts table at all (older file) reads as zero verdicts
  const bare = new DatabaseSync(':memory:');
  bare.exec("CREATE TABLE outcomes (mint TEXT, t0 INTEGER, horizon_sec INTEGER, label TEXT, label_tier TEXT)");
  assert.equal(readLarpJoin(bare, H).verdicts_recorded, 0);
});

test('larpEval: below 50 matched verdicts counts only (every rate null); at 50+ Wilson intervals; UNVERIFIABLE apart; the method says what it is', () => {
  const none = larpEval({ horizon_sec: H, slack_sec: 360, verdicts_recorded: 0, rows: [], outcomes_at_horizon: 149, outcome_counts: { flat: 137, fade: 9, runner: 2, dead: 1 }, unobserved_at_horizon: 29 });
  assert.equal(none.reportable, false); assert.equal(none.precision, null); assert.equal(none.recall, null);
  assert.match(none.note, /no LARP verdicts recorded yet.*n=149/);
  assert.ok(none.method.some((m) => /NOT a ground-truth measure/.test(m)));
  const few = larpEval({ horizon_sec: H, slack_sec: 360, verdicts_recorded: 4, rows: [
    { verdict: 'LARP', label: 'dead', positive: true }, { verdict: 'REAL_PRODUCT', label: 'flat', positive: false },
    { verdict: 'UNVERIFIABLE', label: 'rug', positive: true }, { verdict: 'LARP', label: null, positive: null },
  ], outcomes_at_horizon: 10, outcome_counts: {}, unobserved_at_horizon: 0 });
  assert.equal(few.matched, 3); assert.equal(few.unmatched, 1);
  assert.deepEqual(few.confusion, { tp: 1, fp: 0, fn: 0, tn: 1, unverifiable: 1 });
  assert.equal(few.reportable, false); assert.equal(few.precision, null, 'no 100% from n=1');
  assert.match(few.note, /3 matched verdicts \(< 50\): counts only/);
  // 60 matched: 20 LARP (12 bad), 40 real (4 bad)
  const rows = [
    ...Array.from({ length: 12 }, () => ({ verdict: 'LARP', label: 'dead' as const, positive: true })),
    ...Array.from({ length: 8 }, () => ({ verdict: 'LARP', label: 'flat' as const, positive: false })),
    ...Array.from({ length: 4 }, () => ({ verdict: 'EARLY_BUT_REAL', label: 'rug' as const, positive: true })),
    ...Array.from({ length: 36 }, () => ({ verdict: 'REAL_PRODUCT', label: 'flat' as const, positive: false })),
  ];
  assert.ok(rows.length >= LARP_EVAL_MIN_N);
  const r = larpEval({ horizon_sec: H, slack_sec: 360, verdicts_recorded: 60, rows, outcomes_at_horizon: 60, outcome_counts: {}, unobserved_at_horizon: 0 });
  assert.equal(r.reportable, true);
  assert.equal(r.precision?.k, 12); assert.equal(r.precision?.n, 20); assert.equal(r.precision?.value, 0.6);
  assert.equal(r.bad_rate_when_real?.k, 4); assert.equal(r.bad_rate_when_real?.n, 40);
  assert.equal(r.recall?.k, 12); assert.equal(r.recall?.n, 16);
  assert.ok(r.precision!.lo < 0.6 && r.precision!.hi > 0.6);
  const text = renderLarpEvalText(r, 'mem');
  assert.match(text, /P\(bad \| LARP\)\s+= 60\.0% \[/);
  assert.match(text, /LARP verdicts recorded: 60 · matched to an outcome: 60/);
});

test('wilson: textbook values; n = 0 is null', () => {
  const w = wilson(5, 10)!;
  assert.ok(Math.abs(w.lo - 0.2366) < 1e-3 && Math.abs(w.hi - 0.7634) < 1e-3, `${w.lo} ${w.hi}`);
  const z = wilson(0, 20)!;
  assert.equal(z.lo, 0); assert.ok(Math.abs(z.hi - 0.1611) < 1e-3);
  assert.equal(wilson(0, 0), null);
});

test('trenchscope backtest --subject larp: end to end on a temp recorder DB (human + --json), honest when nothing is recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-larp-'));
  const path = join(dir, 'history.db');
  try {
    const db = new DatabaseSync(path);
    db.exec(SCHEMA_SQL);
    outcome(db, 'A', T - 100_000, 'dead'); outcome(db, 'B', T - 100_000, 'flat');
    db.close();
    const mk = () => { let out = ''; let err = ''; return { stdout: { write: (s: string) => { out += s; return true; } }, stderr: { write: (s: string) => { err += s; return true; } }, env: {} as NodeJS.ProcessEnv, get out() { return out; }, get err() { return err; } }; };
    let io = mk();
    assert.equal(backtestCommand(['--subject', 'larp', '--db', path], io), 0);
    assert.match(io.out, /LARP EVAL {2}horizon=3600s/);
    assert.match(io.out, /labelled history at this horizon: n=2/);
    assert.match(io.out, /no LARP verdicts recorded yet/);
    const w = new DatabaseSync(path);
    recordLarpVerdict(w, v('A', 'LARP', T)); recordLarpVerdict(w, v('B', 'REAL_PRODUCT', T));
    w.close();
    io = mk();
    assert.equal(backtestCommand(['--subject', 'larp', '--db', path, '--json'], io), 0);
    const j = JSON.parse(io.out);
    assert.equal(j.subject, 'larp'); assert.equal(j.verdicts_recorded, 2); assert.equal(j.matched, 2);
    assert.equal(j.reportable, false); assert.equal(j.precision, null);
    assert.deepEqual(j.confusion, { tp: 1, fp: 0, fn: 0, tn: 1, unverifiable: 0 });
    io = mk();
    assert.equal(backtestCommand(['--help'], io), 0);
    assert.match(io.out, /larp \(task-1359/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
