// trenchscope paper bot: the live wiring. The keyless screener feed (the same one `record` and `watch` run,
// through the data layer's rate limiter and health gate), the keyless Jupiter swap QUOTE, the keyless Jupiter
// SOL/USD price and a decimals lookup. Everything comes from '@dexterm/data/core', the trade-free entry: no
// signer, live executor, swap build, rpc send or bridge module is in this file's import graph.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import {
  resolveRpcUrl, resolveTrackerKey, resolveShrineKey, extraRpcUrls, redactSecrets, SOL_MINT,
  type QuoteRequest, type SwapQuote,
} from '@dexterm/data/core';
import { createLiveFeed } from '../feed.ts';
import type { ScreenerRow } from '../screener/rows.ts';

export interface BotLive {
  /** One feed refresh: the current screener rows. */
  rows(): Promise<ScreenerRow[]>;
  quote(req: QuoteRequest): Promise<SwapQuote>;
  solUsd(): Promise<number | null>;
  decimals(mint: string): Promise<number>;
  /** Latest recorded LARP verdict for a mint (read from the recorder's table), or null. */
  larp(mint: string): string | null;
  requests(): number;
  close(): void;
}

/** Recorder pack id of the LARP check (same value as @dexterm/recorder LARP_PACK; not imported, see the guard test). */
const LARP_PACK = 'larp-check';

function larpMap(dbPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (dbPath === ':memory:' || !existsSync(dbPath)) return map;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT mint, verdict FROM verdicts WHERE pack = ? AND verdict IS NOT NULL ORDER BY t').all(LARP_PACK) as Array<{ mint: string; verdict: string }>;
    for (const r of rows) map.set(r.mint, r.verdict);
  } catch { /* no recorder table yet */ } finally { try { db?.close(); } catch { /* ignore */ } }
  return map;
}

export function buildBotLive(env: NodeJS.ProcessEnv, opts: { dbPath: string; verbose?: boolean; onLog?: (s: string) => void }): BotLive {
  const rpc = resolveRpcUrl({ env });
  const feed = createLiveFeed({
    dbPath: opts.dbPath, rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl, rpcPublicPool: true, rpcExtraUrls: extraRpcUrls(env),
    trackerKey: resolveTrackerKey({ env })?.key ?? null, shrineKey: resolveShrineKey({ env })?.key ?? null,
    onRequest: opts.verbose ? (req, meta, o) => opts.onLog?.(`  ${meta.source.padEnd(14)} ${String(o.status ?? 'ERR').padStart(3)} ${String(o.latencyMs).padStart(5)}ms ${redactSecrets(req.url).slice(0, 110)}\n`) : undefined,
  });
  const dl = feed.dl;
  const decimalsCache = new Map<string, number>();
  let larp = larpMap(opts.dbPath);
  let larpAt = Date.now();
  return {
    async rows() {
      if (Date.now() - larpAt > 10 * 60_000) { larp = larpMap(opts.dbPath); larpAt = Date.now(); }
      return feed.refresh();
    },
    quote(req) { return dl.jupiterSwap.quote(req, AbortSignal.timeout(10_000)); },
    async solUsd() {
      const p = (await dl.jupiter.price([SOL_MINT])).get(SOL_MINT)?.usdPrice;
      return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
    },
    async decimals(mint) {
      const hit = decimalsCache.get(mint);
      if (hit !== undefined) return hit;
      const r = await dl.store.enrich([mint]);
      const d = r.rows.find((x) => x.mint === mint)?.token.decimals;
      const out = typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 18 ? d : 6;
      decimalsCache.set(mint, out);
      return out;
    },
    larp(mint) { return larp.get(mint) ?? null; },
    requests() { return feed.requests; },
    close() { try { feed.close(); } catch { /* ignore */ } },
  };
}
