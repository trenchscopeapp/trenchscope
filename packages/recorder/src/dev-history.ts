// DEV HISTORY (0.1.5, task-1425): "has this deployer rugged before?" from dexterm's OWN recorded history, keyless.
// The creator links come from the `creators` table (a keyless source naming the dev when trenchscope saw the coin), the
// outcomes from the recorder's code-only labeler (labels.ts: keyless-proxy tier), the dev-exit timing from the
// recorded `dev_pct` series. Every number carries its source, sample size and age; no recorded prior launch is
// `unknown`, never "clean". It is a risk flag from observed history, never a certificate.
//
// Point in time: with `asOf`, only links recorded before it and labels already known by then count (a label is known
// once its observation t1, or t0 + horizon, has passed). The backtest uses this so a coin is never judged on the
// future (the same leakage rule as export.ts).

import type { DatabaseSync } from 'node:sqlite';
import type { Label } from './labels.ts';

/** Label horizons in preference order: the 72 h label when known, else the longest one known. */
const PREF_HORIZONS = [259200, 86400, 21600, 7200, 3600] as const;
/** Dev-exit rule: the dev held more than this % of supply, then this little. */
export const DEV_EXIT = { heldPct: 0.5, exitPct: 0.1 } as const;
/** Prior rugs at/over this many = the `serial_rugger` flag (same threshold as the token-dossier pack). */
export const SERIAL_RUGGER_MIN = 2;
export const DEV_HISTORY_SOURCE = 'trenchscope recorder (keyless creator links + code-only outcome labels)';

export interface CreatorLink { mint: string; creator: string; source: string; firstT: number; createdAt: number | null }

export interface DevLaunch {
  mint: string;
  symbol: string | null;
  firstT: number;
  createdAt: number | null;
  /** The label at the longest horizon known as of `asOf`; null = not labelled yet. */
  label: Exclude<Label, 'unobserved'> | null;
  horizonSec: number | null;
  /** Minutes from creation (or first sighting) to the dev's observed exit; null = not observed. */
  devExitMin: number | null;
}

export interface DevHistoryReport {
  creator: string;
  /** `unknown` = no prior launch by this wallet in the local record (not evidence of anything). */
  status: 'ok' | 'unknown';
  asOf: number;
  source: string;
  /** Prior launches by this wallet that trenchscope recorded (the coin itself excluded). */
  launches: { n: number; newestT: number | null; ageSec: number | null };
  /** Outcome labels among those launches (keyless-proxy tier; 72 h preferred). */
  labelled: { n: number; rug: number; dead: number; fade: number; flat: number; runner: number; horizon: string; tier: 'keyless-proxy'; newestT: number | null; ageSec: number | null };
  /** rug / labelled; null when nothing is labelled. */
  rugRate: number | null;
  /** (rug + dead) / labelled: the backtest harness's "bad" outcome. */
  badRate: number | null;
  /** How fast the dev sold its own bag on prior launches (recorded dev_pct series). */
  devExit: { n: number; medianMin: number | null; within60m: number };
  /** Prior rugs >= SERIAL_RUGGER_MIN. */
  serialRugger: boolean;
  /** Newest prior launches (≤ 10). */
  recent: DevLaunch[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The creator trenchscope recorded for `mint`, or null. */
export function creatorOf(db: DatabaseSync, mint: string): CreatorLink | null {
  try {
    const r = db.prepare('SELECT mint, creator, source, first_t, created_at FROM creators WHERE mint = ?').get(mint) as { mint: string; creator: string; source: string; first_t: number; created_at: number | null } | undefined;
    return r ? { mint: r.mint, creator: r.creator, source: r.source, firstT: Number(r.first_t), createdAt: r.created_at === null ? null : Number(r.created_at) } : null;
  } catch { return null; }
}

export interface DevHistoryQuery {
  creator: string;
  /** The coin being judged (excluded from its own history). */
  mint?: string | null;
  /** Point in time, unix ms (default: now). */
  asOf?: number;
  /** Max prior launches read (default 300, newest first). */
  limit?: number;
  /** Compute the dev-exit timing (one indexed read per launch; default true). */
  devExit?: boolean;
}

/** The creator's recorded track record. Never throws: a DB without the tables reads as `unknown`. */
export function queryDevHistory(db: DatabaseSync, q: DevHistoryQuery): DevHistoryReport {
  const asOf = q.asOf ?? Date.now();
  const empty: DevHistoryReport = {
    creator: q.creator, status: 'unknown', asOf, source: DEV_HISTORY_SOURCE,
    launches: { n: 0, newestT: null, ageSec: null },
    labelled: { n: 0, rug: 0, dead: 0, fade: 0, flat: 0, runner: 0, horizon: '72h preferred', tier: 'keyless-proxy', newestT: null, ageSec: null },
    rugRate: null, badRate: null, devExit: { n: 0, medianMin: null, within60m: 0 }, serialRugger: false, recent: [],
  };
  let links: Array<{ mint: string; first_t: number; created_at: number | null }>;
  try {
    links = db.prepare('SELECT mint, first_t, created_at FROM creators WHERE creator = ? AND first_t <= ? AND mint != ? ORDER BY first_t DESC LIMIT ?')
      .all(q.creator, asOf, q.mint ?? '', q.limit ?? 300) as typeof links;
  } catch { return empty; }
  if (!links.length) return empty;
  const outStmt = db.prepare("SELECT t0, horizon_sec, t1, label FROM outcomes WHERE mint = ? AND label != 'unobserved' ORDER BY t0 ASC");
  const symStmt = db.prepare('SELECT symbol FROM token_snapshots WHERE mint = ? AND symbol IS NOT NULL ORDER BY t ASC LIMIT 1');
  const devStmt = db.prepare('SELECT t, dev_pct FROM token_snapshots WHERE mint = ? AND dev_pct IS NOT NULL AND t <= ? ORDER BY t ASC LIMIT 400');
  const counts = { rug: 0, dead: 0, fade: 0, flat: 0, runner: 0 };
  let labelledN = 0, labelledNewest: number | null = null;
  const exits: number[] = [];
  const launches: DevLaunch[] = [];
  for (const l of links) {
    const firstT = Number(l.first_t);
    const createdAt = l.created_at === null ? null : Number(l.created_at);
    const rows = outStmt.all(l.mint) as Array<{ t0: number; horizon_sec: number; t1: number | null; label: Label }>;
    // the label of the EARLIEST anchor (closest to launch) at the longest horizon already known as of asOf
    const known = rows.filter((r) => (r.t1 !== null ? Number(r.t1) : Number(r.t0) + Number(r.horizon_sec) * 1000) <= asOf);
    let label: DevLaunch['label'] = null, horizonSec: number | null = null, knownAt: number | null = null;
    if (known.length) {
      const t0 = Math.min(...known.map((r) => Number(r.t0)));
      const at = known.filter((r) => Number(r.t0) === t0);
      for (const h of PREF_HORIZONS) {
        const hit = at.find((r) => Number(r.horizon_sec) === h);
        if (hit) { label = hit.label as DevLaunch['label']; horizonSec = h; knownAt = hit.t1 !== null ? Number(hit.t1) : t0 + h * 1000; break; }
      }
    }
    if (label) {
      labelledN++;
      counts[label]++;
      if (knownAt !== null) labelledNewest = Math.max(labelledNewest ?? 0, knownAt);
    }
    let devExitMin: number | null = null;
    if (q.devExit !== false) {
      const series = devStmt.all(l.mint, asOf) as Array<{ t: number; dev_pct: number }>;
      const held = series.findIndex((r) => r.dev_pct > DEV_EXIT.heldPct);
      if (held >= 0) {
        const out = series.slice(held + 1).find((r) => r.dev_pct <= DEV_EXIT.exitPct);
        if (out) {
          const from = createdAt ?? Number(series[held].t);
          devExitMin = Math.max(0, (Number(out.t) - from) / 60_000);
          exits.push(devExitMin);
        }
      }
    }
    if (launches.length < 10) {
      const sym = (symStmt.get(l.mint) as { symbol: string } | undefined)?.symbol ?? null;
      launches.push({ mint: l.mint, symbol: sym, firstT, createdAt, label, horizonSec, devExitMin });
    }
  }
  const newestT = Number(links[0].first_t);
  return {
    ...empty,
    status: 'ok',
    launches: { n: links.length, newestT, ageSec: Math.max(0, Math.round((asOf - newestT) / 1000)) },
    labelled: { ...empty.labelled, n: labelledN, ...counts, newestT: labelledNewest, ageSec: labelledNewest === null ? null : Math.max(0, Math.round((asOf - labelledNewest) / 1000)) },
    rugRate: labelledN ? counts.rug / labelledN : null,
    badRate: labelledN ? (counts.rug + counts.dead) / labelledN : null,
    devExit: { n: exits.length, medianMin: median(exits), within60m: exits.filter((m) => m <= 60).length },
    serialRugger: counts.rug >= SERIAL_RUGGER_MIN,
    recent: launches,
  };
}

const ago = (sec: number | null): string => sec === null ? 'age unknown' : sec < 3600 ? `${Math.max(1, Math.round(sec / 60))}m ago` : sec < 172800 ? `${Math.round(sec / 3600)}h ago` : `${Math.round(sec / 86400)}d ago`;

/**
 * The one-line summary every surface shows (DEV panel, rug-signal row, MCP note): counts with the sample size and
 * the age, or `unknown` with why. Plain wording: a risk flag from observed history, never "rug confirmed" or "safe".
 */
export function devHistoryLine(r: DevHistoryReport): string {
  if (r.status === 'unknown') return 'unknown: no prior launch by this wallet in dexterm\'s record';
  const L = r.labelled;
  if (!L.n) return `${r.launches.n} prior launch${r.launches.n === 1 ? '' : 'es'} recorded, none labelled yet (newest ${ago(r.launches.ageSec)})`;
  return `rugged ${L.rug} of ${L.n} labelled prior launches${L.dead ? ` (+${L.dead} dead)` : ''} · ${r.launches.n} recorded · labels ${ago(L.ageSec)}`;
}
