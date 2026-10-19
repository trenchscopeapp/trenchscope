// Per-source request budget meter (task-1309). Every free data source gives each user their own
// per-IP quota (that is why a local client scales: there is no shared server quota). This meter
// counts the requests trenchscope sends to each source — this session and today (persisted in the SQLite
// cache, so restarts keep counting) — and exposes a snapshot + header label so the budget is visible.
// Optional soft daily caps let a cautious user bound a source; passing no cap means "unlimited, just
// count" (the limiter already paces to the documented rpm). The meter never sees or stores any key.

import type { Cache } from './cache.ts';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { SourceId } from './model.ts';

const NS = 'meter';
const DAY_TTL_MS = 2 * 86_400_000;
export const BUDGET_WARN_PCT = 0.8;

export interface SourceBudget {
  source: SourceId;
  /** Requests sent to this source this process run. */
  session: number;
  /** Requests sent today (persisted across runs, per UTC day). */
  day: number;
  /** Soft daily cap, or null when uncapped (count only). */
  dayCap: number | null;
  /** 0..1 of the cap, or null when uncapped. */
  dayPct: number | null;
  /** True once the soft cap is reached (the caller may choose to stop sending). */
  over: boolean;
}

export interface BudgetMeterOptions {
  clock?: Clock;
  /** Persists day totals (ns `meter`); in-memory is fine, totals just die with the process. */
  cache?: Cache;
  /** Optional soft daily request caps per source. Omit a source to leave it uncapped. */
  dayCaps?: Partial<Record<SourceId, number>>;
  warnPct?: number;
}

/** Counts requests per source for a visible budget meter; soft daily caps are advisory, not enforced here. */
export class BudgetMeter {
  private readonly clock: Clock;
  private readonly cache?: Cache;
  private readonly dayCaps: Partial<Record<SourceId, number>>;
  readonly warnPct: number;
  private readonly session = new Map<SourceId, number>();
  private readonly dayTotals = new Map<SourceId, number>();
  private dayKey = '';

  constructor(opts: BudgetMeterOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.cache = opts.cache;
    this.dayCaps = { ...opts.dayCaps };
    this.warnPct = opts.warnPct ?? BUDGET_WARN_PCT;
    this.roll();
  }

  static dayKeyFor(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  private roll(): void {
    const key = BudgetMeter.dayKeyFor(this.clock.now());
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.dayTotals.clear();
  }

  private dayTotal(source: SourceId): number {
    const cached = this.dayTotals.get(source);
    if (cached !== undefined) return cached;
    const hit = this.cache?.get<number>(NS, `req:${this.dayKey}:${source}`);
    const n = hit && typeof hit.value === 'number' ? hit.value : 0;
    this.dayTotals.set(source, n);
    return n;
  }

  /** Record one request to `source`. */
  charge(source: SourceId): void {
    this.roll();
    this.session.set(source, (this.session.get(source) ?? 0) + 1);
    const day = this.dayTotal(source) + 1;
    this.dayTotals.set(source, day);
    this.cache?.set(NS, `req:${this.dayKey}:${source}`, day, { ttlMs: DAY_TTL_MS, source });
  }

  /** True while another request to `source` is within its soft cap (always true when uncapped). */
  allow(source: SourceId): boolean {
    this.roll();
    const cap = this.dayCaps[source];
    if (cap === undefined) return true;
    return this.dayTotal(source) < cap;
  }

  status(source: SourceId): SourceBudget {
    this.roll();
    const cap = this.dayCaps[source] ?? null;
    const day = this.dayTotal(source);
    return {
      source,
      session: this.session.get(source) ?? 0,
      day,
      dayCap: cap,
      dayPct: cap && cap > 0 ? day / cap : null,
      over: cap !== null && day >= cap,
    };
  }

  /** Every source seen this run (plus any with a cap), busiest first. */
  snapshot(): SourceBudget[] {
    this.roll();
    const sources = new Set<SourceId>([...this.session.keys(), ...(Object.keys(this.dayCaps) as SourceId[])]);
    return [...sources].map((s) => this.status(s)).sort((a, b) => b.session - a.session);
  }

  /** Header-sized summary of the busiest sources, e.g. `req: dexscreener 42 · jupiter 11`. */
  label(max = 3): string {
    const top = this.snapshot().filter((s) => s.session > 0).slice(0, max);
    if (top.length === 0) return 'req: 0';
    return `req: ${top.map((s) => `${s.source} ${s.session}${s.dayCap ? `/${s.dayCap}` : ''}`).join(' · ')}`;
  }
}
