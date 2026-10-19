// Build the skill backtest eval set from a recorder DB (task-1401). Read-only on the DB, no network.
//
// One row per coin. The label is the recorder's own outcome at the horizon (keyless proxy). The link evidence is
// the DexScreener / Jupiter token record the app's cache already holds (ns `ds:token` / `jup:token`), used ONLY
// when that record was fetched within `maxLagSec` AFTER the row's t0 anchor: the cache keeps the newest fetch per
// coin, and a coin that kept trading was re-fetched long after t0 (when it may have bought a DexScreener profile),
// while a coin that died stopped being fetched near t0. Taking a late record would leak the outcome into the
// evidence, so a coin with no record inside the window is excluded and counted, never back-filled.
//
// The rows keep the mint, t0, the label, URL-free link features and the t0 snapshot numbers. No URL, name or
// symbol is written (the name and symbol are read only to compute the domain-match boolean).

import type { DatabaseSync } from 'node:sqlite';
import { linkFeatures } from '@dexterm/data';
import { LABELER_VERSION } from '@dexterm/recorder';
import { SKILL_EVAL_SCHEMA, type SkillEvalRow, type SkillEvalSet } from '@dexterm/packs';

export interface BuildEvalOptions {
  horizonSec?: number;
  maxLagSec?: number;
  /** Fraction of rows (latest t0 first) held out as the test split. */
  testFrac?: number;
  now?: number;
}

interface CacheRec { fetched_at: number; socials: { web: string | null; x: string | null; tg: string | null }; symbol: string | null; name: string | null }

function readCache(db: DatabaseSync, ns: string, mint: string): CacheRec | null {
  const row = db.prepare('SELECT json, fetched_at FROM cache WHERE ns = ? AND key = ?').get(ns, mint) as { json: string; fetched_at: number } | undefined;
  if (!row) return null;
  try {
    const j = JSON.parse(row.json) as { token?: { socials?: { web?: string | null; x?: string | null; tg?: string | null }; symbol?: string; name?: string } };
    const s = j.token?.socials ?? {};
    return { fetched_at: Number(row.fetched_at), socials: { web: s.web ?? null, x: s.x ?? null, tg: s.tg ?? null }, symbol: j.token?.symbol ?? null, name: j.token?.name ?? null };
  } catch { return null; }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) !== 0);

export function buildSkillEvalSet(db: DatabaseSync, opts: BuildEvalOptions = {}): SkillEvalSet {
  const horizon = opts.horizonSec ?? 259_200;
  const lagMs = (opts.maxLagSec ?? 3_600) * 1000;
  const testFrac = opts.testFrac ?? 0.3;
  const excluded: Record<string, number> = { no_cached_link_record: 0, no_point_in_time_link_record: 0, no_t0_snapshot: 0, chain_verified_label: 0 };
  const mints = (db.prepare("SELECT DISTINCT mint FROM outcomes WHERE horizon_sec = ? AND label != 'unobserved'").all(horizon) as { mint: string }[]).map((r) => r.mint);
  const outStmt = db.prepare("SELECT t0, label, label_tier FROM outcomes WHERE mint = ? AND horizon_sec = ? AND label != 'unobserved' ORDER BY t0 DESC");
  const snapStmt = db.prepare('SELECT * FROM token_snapshots WHERE mint = ? AND t = ? AND is_t0 = 1 LIMIT 1');
  const rows: SkillEvalRow[] = [];
  for (const mint of mints) {
    const ds = readCache(db, 'ds:token', mint);
    const jup = readCache(db, 'jup:token', mint);
    if (!ds && !jup) { excluded.no_cached_link_record++; continue; }
    const outs = outStmt.all(mint, horizon) as { t0: number; label: SkillEvalRow['outcome']; label_tier: string }[];
    let picked: { t0: number; label: SkillEvalRow['outcome']; label_tier: string; srcs: Array<[string, CacheRec]> } | null = null;
    for (const o of outs) {
      const t0 = Number(o.t0);
      const srcs = ([['jupiter', jup], ['dexscreener', ds]] as Array<[string, CacheRec | null]>)
        .filter((x): x is [string, CacheRec] => !!x[1] && x[1].fetched_at >= t0 && x[1].fetched_at <= t0 + lagMs);
      if (srcs.length) { picked = { t0, label: o.label, label_tier: o.label_tier, srcs }; break; }
    }
    if (!picked) { excluded.no_point_in_time_link_record++; continue; }
    if (picked.label_tier !== 'keyless-proxy') { excluded.chain_verified_label++; continue; }
    const snap = snapStmt.get(mint, picked.t0) as Record<string, unknown> | undefined;
    if (!snap) { excluded.no_t0_snapshot++; continue; }
    // The store's merge order: Jupiter first, then DexScreener (packages/data/src/store.ts).
    const pick = (k: 'web' | 'x' | 'tg'): string | null => picked!.srcs.map(([, r]) => r.socials[k]).find((v) => v) ?? null;
    const symbol = picked.srcs.map(([, r]) => r.symbol).find((v) => v) ?? (snap.symbol as string | null);
    const name = picked.srcs.map(([, r]) => r.name).find((v) => v) ?? (snap.name as string | null);
    const createdAt = num(snap.created_at);
    rows.push({
      mint, t0: picked.t0, split: 'train',
      outcome: picked.label, bad: picked.label === 'rug' || picked.label === 'dead',
      link: linkFeatures({ web: pick('web'), x: pick('x'), tg: pick('tg'), symbol, name }),
      link_sources: picked.srcs.map(([s]) => s),
      link_lag_sec: Math.round((Math.max(...picked.srcs.map(([, r]) => r.fetched_at)) - picked.t0) / 1000),
      rug: {
        freeze_auth: bool(snap.freeze_auth_enabled), mint_auth: bool(snap.mint_auth_enabled),
        dev_pct: num(snap.dev_pct), top10_pct: num(snap.top_holders_pct), organic_score: num(snap.organic_score),
        liquidity_usd: num(snap.liquidity_usd), price_usd: num(snap.price_usd), lp_locked_pct: num(snap.lp_locked_pct),
        launchpad: (snap.launchpad as string | null) ?? null,
        age_sec: createdAt ? Math.max(0, Math.round((picked.t0 - createdAt) / 1000)) : null,
      },
    });
  }
  rows.sort((a, b) => a.t0 - b.t0 || a.mint.localeCompare(b.mint));
  const cutIdx = Math.min(rows.length, Math.floor(rows.length * (1 - testFrac)));
  const cutoff = rows[cutIdx]?.t0 ?? Number.MAX_SAFE_INTEGER;
  for (const r of rows) r.split = r.t0 >= cutoff ? 'test' : 'train';
  const train = rows.filter((r) => r.split === 'train');
  const test = rows.filter((r) => r.split === 'test');
  return {
    schema: SKILL_EVAL_SCHEMA,
    built_at: new Date(opts.now ?? Date.now()).toISOString(),
    source: { kind: 'recorder', labeler_version: LABELER_VERSION, db_note: 'the app history DB on the machine that built it (outcomes + cache + token_snapshots); not shipped' },
    horizon_sec: horizon,
    label_rule: `recorder outcome at ${horizon}s (keyless proxy, labeler ${LABELER_VERSION}); bad = rug ∪ dead, ok = flat ∪ fade ∪ runner; unobserved dropped`,
    evidence_rule: `link features from the cached DexScreener/Jupiter token record only when it was fetched within ${lagMs / 1000}s after the row's t0 (latest such t0 per coin); rug-check features from that t0 snapshot`,
    split_rule: `by time: the latest ${Math.round(testFrac * 100)}% of rows by t0 (t0 ≥ ${new Date(cutoff).toISOString()}) are the held-out TEST split, fixed before tuning`,
    cutoff_t0: cutoff,
    counts: { rows: rows.length, train: train.length, test: test.length, bad_train: train.filter((r) => r.bad).length, bad_test: test.filter((r) => r.bad).length, excluded },
    rows,
  };
}
