// Helius credit meter (task-1298; inventory 2026-10-06 §0.1, §5). The Free plan has 1M credits a
// month (docs/helius/pricing.md). We budget it per day (1M / 30), count every request we send and
// expose three levels: `ok`, `warn` at 50 % of the day, `degraded` at 90 % (the data layer then
// switches Helius off for the day and the keyless sources take over). A hard per-run cap bounds
// what one trenchscope process can spend however long it runs. Day totals persist in the SQLite cache
// so restarts keep counting; the meter never sees, stores or prints the key.

import type { Cache } from './cache.ts';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';

export const HELIUS_MONTHLY_CREDITS = 1_000_000;
export const HELIUS_DAILY_BUDGET = Math.floor(HELIUS_MONTHLY_CREDITS / 30); // 33,333
/** Default hard cap per process run (credits). */
export const DEFAULT_RUN_CAP = 5_000;
export const WARN_PCT = 0.5;
export const DEGRADE_PCT = 0.9;

/**
 * Credits per request by JSON-RPC method (docs/helius/pricing.md: standard RPC calls 1 credit,
 * DAS / getProgramAccounts-class and Parsed Events 10). Unknown methods are charged 10 to be safe.
 */
export const RPC_CREDIT_COST: Record<string, number> = {
  getAccountInfo: 1,
  getMultipleAccounts: 1,
  getTokenLargestAccounts: 1,
  getTokenSupply: 1,
  getSlot: 1,
  getAsset: 10,
  getTokenAccounts: 10,
  getTransactionsForAddress: 10,
};
export const UNKNOWN_METHOD_COST = 10;

/** WebSocket traffic: 2 credits per 0.1 MB (inventory §0.1), i.e. 20 credits per MB. */
export const WS_CREDITS_PER_MB = 20;

export type CreditLevel = 'ok' | 'warn' | 'degraded';

export interface CreditStatus {
  level: CreditLevel;
  /** Credits this process has spent. */
  session: number;
  /** Credits spent today (persisted across runs). */
  day: number;
  dayBudget: number;
  /** 0..1 of the day budget. */
  dayPct: number;
  runCap: number;
  /** True when the per-run cap stopped further Helius requests. */
  runCapHit: boolean;
  requests: number;
  bytesStreamed: number;
  dayKey: string;
}

export interface CreditMeterOptions {
  clock?: Clock;
  /** Persists the day total (ns `meter`). In-memory caches still work; the total just dies with the process. */
  cache?: Cache;
  dayBudget?: number;
  runCap?: number;
  warnPct?: number;
  degradePct?: number;
  /** Called when the level changes (e.g. to disable the source in the health registry). */
  onLevel?: (level: CreditLevel, status: CreditStatus) => void;
}

const NS = 'meter';
const DAY_TTL_MS = 2 * 86_400_000;

export class CreditMeter {
  private readonly clock: Clock;
  private readonly cache?: Cache;
  readonly dayBudget: number;
  readonly runCap: number;
  private readonly warnPct: number;
  private readonly degradePct: number;
  private readonly onLevel?: CreditMeterOptions['onLevel'];
  private session = 0;
  private requests = 0;
  private bytes = 0;
  private lastLevel: CreditLevel = 'ok';
  private dayKey = '';
  private dayTotal = 0;

  constructor(opts: CreditMeterOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.cache = opts.cache;
    this.dayBudget = opts.dayBudget ?? HELIUS_DAILY_BUDGET;
    this.runCap = opts.runCap ?? DEFAULT_RUN_CAP;
    this.warnPct = opts.warnPct ?? WARN_PCT;
    this.degradePct = opts.degradePct ?? DEGRADE_PCT;
    this.onLevel = opts.onLevel;
    this.roll();
  }

  /** YYYY-MM-DD in UTC for the clock's now (the plan's month is UTC-ish; a day boundary is good enough). */
  static dayKeyFor(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  private roll(): void {
    const key = CreditMeter.dayKeyFor(this.clock.now());
    if (key === this.dayKey) return;
    this.dayKey = key;
    const hit = this.cache?.get<number>(NS, `helius:day:${key}`);
    this.dayTotal = hit && typeof hit.value === 'number' ? hit.value : 0;
  }

  /** Credits a JSON-RPC method costs. */
  static costOf(method: string | null | undefined): number {
    if (!method) return UNKNOWN_METHOD_COST;
    return RPC_CREDIT_COST[method] ?? UNKNOWN_METHOD_COST;
  }

  /** True while another request may be sent (below 90 % of the day and below the run cap). */
  allow(): boolean {
    this.roll();
    return this.level() !== 'degraded';
  }

  /** Charge one request. Returns the new level. */
  charge(credits: number): CreditLevel {
    this.roll();
    const c = Math.max(0, credits);
    this.session += c;
    this.requests += 1;
    this.dayTotal += c;
    this.cache?.set(NS, `helius:day:${this.dayKey}`, this.dayTotal, { ttlMs: DAY_TTL_MS, source: 'helius' });
    return this.emit();
  }

  /** Charge streamed WebSocket bytes at the documented rate. */
  chargeBytes(bytes: number): CreditLevel {
    this.roll();
    this.bytes += bytes;
    return this.charge((bytes / 1_048_576) * WS_CREDITS_PER_MB) ;
  }

  level(): CreditLevel {
    if (this.session >= this.runCap) return 'degraded';
    const pct = this.dayBudget > 0 ? this.dayTotal / this.dayBudget : 0;
    if (pct >= this.degradePct) return 'degraded';
    if (pct >= this.warnPct) return 'warn';
    return 'ok';
  }

  status(): CreditStatus {
    this.roll();
    return {
      level: this.level(),
      session: Math.round(this.session * 100) / 100,
      day: Math.round(this.dayTotal * 100) / 100,
      dayBudget: this.dayBudget,
      dayPct: this.dayBudget > 0 ? this.dayTotal / this.dayBudget : 0,
      runCap: this.runCap,
      runCapHit: this.session >= this.runCap,
      requests: this.requests,
      bytesStreamed: this.bytes,
      dayKey: this.dayKey,
    };
  }

  /** Header-sized summary: `helius 1.2K/33K credits · run 12`. */
  label(): string {
    const s = this.status();
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(Math.round(n)));
    const pct = Math.round(s.dayPct * 100);
    const tail = s.runCapHit ? ' · run cap' : s.level === 'degraded' ? ' · off' : s.level === 'warn' ? ' · warn' : '';
    return `helius ${k(s.day)}/${k(s.dayBudget)} (${pct}%) · run ${k(s.session)}${tail}`;
  }

  private emit(): CreditLevel {
    const level = this.level();
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      this.onLevel?.(level, this.status());
    }
    return level;
  }
}
