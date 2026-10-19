// task-1359: persist a settled LARP-detector verdict into the recorder's `verdicts` table (pack `larp-check`) so
// `trenchscope backtest --subject larp` can later score it against the outcome labels. Before this, verdicts lived
// only in memory (state.larpByMint) and no accuracy could ever be measured. Best-effort: no recorder, no table
// or a failed write is a silent no-op — the analyst turn never depends on it.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { recordVerdict } from '@dexterm/packs';
import { LARP_PACK, LARP_VERDICTS } from '@dexterm/recorder';

export interface LarpVerdictRecord { mint: string; verdict: string; confidence: number | null; t: number; skill: string; model: string | null }

/** Returns true when a row was written. Unknown verdict strings are refused (the eval only scores the four classes). */
export function recordLarpVerdict(db: DatabaseSync | null | undefined, v: LarpVerdictRecord): boolean {
  if (!db || !(LARP_VERDICTS as readonly string[]).includes(v.verdict)) return false;
  try {
    // input_hash is a row key (the turn's tool inputs are not retained), not a cache key over the inputs
    const hash = createHash('sha256').update(`${LARP_PACK}|${v.mint}|${v.t}|${v.verdict}`).digest('hex');
    recordVerdict(db, { mint: v.mint, t: v.t, pack: LARP_PACK, pack_version: `task-1315/${v.skill}`, model: v.model, verdict: v.verdict, rug_p: null, confidence: v.confidence, score: null, cost_usd: null, wall_ms: null, input_hash: hash, run_file: null });
    return true;
  } catch { return false; }
}
