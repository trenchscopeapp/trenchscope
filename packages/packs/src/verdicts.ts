// Record a pack verdict into the recorder's `verdicts` table (schema owner: @dexterm/recorder, lane
// L-01 reserved this table). A verdict row lets the eval/backtest score a model's output against the
// outcomes the labeler later writes (the non-circular golden set, AI-SUITE-DESIGN §4). Deterministic
// stages are recorded with model = null; reason stages with the model id and cost.
//
// Takes a `node:sqlite` DatabaseSync (Recorder.database) so the pack engine never imports the Recorder
// class and tests can pass an in-memory DB.

import type { DatabaseSync } from 'node:sqlite';

export interface VerdictRow {
  mint: string;
  t: number;
  pack: string;
  pack_version: string;
  model: string | null;
  verdict: string | null;
  rug_p: number | null;
  confidence: number | null;
  score: number | null;
  cost_usd: number | null;
  wall_ms: number | null;
  input_hash: string;
  run_file: string | null;
}

/** Insert one verdict row. The `verdicts` table is created by the recorder's SCHEMA_SQL. No-op guard if the table is absent. */
export function recordVerdict(db: DatabaseSync, row: VerdictRow): void {
  db.prepare(
    `INSERT INTO verdicts (mint, t, pack, pack_version, model, verdict, rug_p, confidence, score, cost_usd, wall_ms, input_hash, run_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.mint, row.t, row.pack, row.pack_version, row.model, row.verdict, row.rug_p, row.confidence, row.score, row.cost_usd, row.wall_ms, row.input_hash, row.run_file);
}

/** The most recent verdict for a mint+pack (for the cache: don't re-spend on an unchanged input_hash). */
export function latestVerdict(db: DatabaseSync, mint: string, pack: string): VerdictRow | null {
  const r = db.prepare('SELECT mint, t, pack, pack_version, model, verdict, rug_p, confidence, score, cost_usd, wall_ms, input_hash, run_file FROM verdicts WHERE mint = ? AND pack = ? ORDER BY t DESC LIMIT 1').get(mint, pack) as VerdictRow | undefined;
  return r ?? null;
}
