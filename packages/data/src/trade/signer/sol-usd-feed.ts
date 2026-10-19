// trenchscope T2 — the signer's OWN SOL/USD feed (task-1328, closes "SOL/USD freshness check"). The UI's
// number is never trusted: the signer fetches its own timestamped samples from two INDEPENDENT keyless
// sources — DexScreener (DEX-derived) and CoinGecko (exchange-derived) — and `resolveSolUsd` applies the
// freshness (60 s), plausibility and two-source-agreement rules at every plan and confirm. A sample is
// stamped with the clock at fetch; a fetch that fails leaves the old sample to AGE OUT rather than being
// refreshed, so a dead feed turns into a refusal on mainnet, never into a stale price.
//
// Plain fetch with an unref'd timeout (no AbortSignal.timeout — its ref'd timer kept processes alive,
// task-1319). No key, no cookies, GET only.

import type { Clock } from '../../clock.ts';
import { systemClock } from '../../clock.ts';
import type { SolUsdSample } from '../sol-usd.ts';
import { WSOL_MINT } from '../tx-decode.ts';

export const DEXSCREENER_SOL_URL = `https://api.dexscreener.com/tokens/v1/solana/${WSOL_MINT}`;
export const COINGECKO_SOL_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

export type Fetcher = (url: string, signal: AbortSignal) => Promise<unknown>;

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await globalThis.fetch(url, { signal, headers: { accept: 'application/json', 'user-agent': 'dexterm/0.0.1 (+signer; keyless read-only)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

/** DexScreener: pick the most liquid SOL pair's priceUsd. */
export function parseDexScreenerSol(body: unknown): number | null {
  if (!Array.isArray(body)) return null;
  let best: { liq: number; price: number } | null = null;
  for (const p of body as Record<string, unknown>[]) {
    const price = num(p.priceUsd);
    const liq = num((p.liquidity as Record<string, unknown> | undefined)?.usd) ?? 0;
    if (price === null) continue;
    if (!best || liq > best.liq) best = { liq, price };
  }
  return best?.price ?? null;
}

export function parseCoinGeckoSol(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  return num((((body as Record<string, unknown>).solana) as Record<string, unknown> | undefined)?.usd);
}

export class SolUsdFeed {
  private readonly clock: Clock;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  private readonly bySource = new Map<string, SolUsdSample>();
  private inflight: Promise<void> | null = null;
  lastError: string | null = null;

  constructor(opts: { clock?: Clock; fetcher?: Fetcher; timeoutMs?: number } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.fetcher = opts.fetcher ?? fetchJson;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  /** Current samples (possibly stale — the resolver decides). */
  samples(): SolUsdSample[] { return [...this.bySource.values()]; }

  /** Age of the freshest sample in ms, or Infinity. */
  age(now = this.clock.now()): number {
    let best = Infinity;
    for (const s of this.bySource.values()) best = Math.min(best, now - s.fetchedAt);
    return best;
  }

  /** Refresh both sources (coalesced). Never throws; failures leave old samples to age out. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Refresh only when the freshest sample is older than `maxAgeMs`. */
  async ensureFresh(maxAgeMs = 20_000): Promise<void> {
    if (this.age() > maxAgeMs) await this.refresh();
  }

  private async one(source: string, url: string, parse: (b: unknown) => number | null): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      const body = await this.fetcher(url, controller.signal);
      const price = parse(body);
      if (price === null) throw new Error('no price in response');
      this.bySource.set(source, { price, fetchedAt: this.clock.now(), source });
    } catch (e) {
      this.lastError = `${source}: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearTimeout(timer);
    }
  }

  private async doRefresh(): Promise<void> {
    await Promise.all([
      this.one('dexscreener', DEXSCREENER_SOL_URL, parseDexScreenerSol),
      this.one('coingecko', COINGECKO_SOL_URL, parseCoinGeckoSol),
    ]);
  }
}
