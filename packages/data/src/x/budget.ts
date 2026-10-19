// @dexterm/data — the X spend meter (task-1357; INTEGRATIONS-DESIGN §4/§6). X bills the DEVELOPER account
// per post read ($0.005) and per user read ($0.01), deduplicated per UTC day — and with Login with X each
// trenchscope user IS the developer of their own app, so this is the user's own money. The meter keeps a per-day
// estimate in the shared cache DB, counts a post only the first time its id is seen in a UTC day (24 h local
// dedup table), and hard-stops reads at the daily budget (default $10, `DEXTERM_X_DAILY_USD`). The numbers are
// ESTIMATES from the published list prices; the X console is the bill.

import type { Cache } from '../cache.ts';

export const X_USD_PER_POST = 0.005;
export const X_USD_PER_USER_READ = 0.01;
export const X_DEFAULT_DAILY_USD = 10;
export const X_BUDGET_NS = 'x:budget';
export const X_SEEN_NS = 'x:seen';
const DAY_MS = 86_400_000;

export interface XSpendDay {
  /** UTC day key `YYYY-MM-DD`. */
  day: string;
  requests: number;
  /** Distinct post ids read today (billable). */
  posts: number;
  /** Posts returned that were already counted today (free re-reads). */
  dedupedPosts: number;
  userReads: number;
  usd: number;
}

export interface XSpendStatus extends XSpendDay {
  budgetUsd: number;
  /** 0..1 of the budget used. */
  pct: number;
  level: 'ok' | 'warn' | 'stop';
  /** Epoch ms when the UTC day rolls over (the budget resets). */
  resetsAt: number;
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function dailyBudgetFrom(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.DEXTERM_X_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : X_DEFAULT_DAILY_USD;
}

export class XSpendMeter {
  private readonly cache: Cache;
  private readonly now: () => number;
  readonly budgetUsd: number;

  constructor(opts: { cache: Cache; now?: () => number; budgetUsd?: number; env?: NodeJS.ProcessEnv }) {
    this.cache = opts.cache;
    this.now = opts.now ?? (() => Date.now());
    this.budgetUsd = opts.budgetUsd ?? dailyBudgetFrom(opts.env ?? process.env);
  }

  private read(day: string): XSpendDay {
    return this.cache.get<XSpendDay>(X_BUDGET_NS, day)?.value ?? { day, requests: 0, posts: 0, dedupedPosts: 0, userReads: 0, usd: 0 };
  }
  private write(d: XSpendDay): void {
    this.cache.set(X_BUDGET_NS, d.day, d, { ttlMs: 3 * DAY_MS });
  }

  status(): XSpendStatus {
    const now = this.now();
    const d = this.read(utcDayKey(now));
    const pct = this.budgetUsd > 0 ? d.usd / this.budgetUsd : 1;
    const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    return { ...d, budgetUsd: this.budgetUsd, pct, level: pct >= 1 ? 'stop' : pct >= 0.8 ? 'warn' : 'ok', resetsAt: dayStart + DAY_MS };
  }

  /** True while another read is allowed (a zero budget means "never read X"). */
  allow(): boolean { return this.status().level !== 'stop'; }

  /** Record one request that returned `postIds` (new ids are billed) and `userReads` user objects. */
  record(postIds: readonly string[], userReads = 0): XSpendDay {
    const now = this.now();
    const d = this.read(utcDayKey(now));
    d.requests += 1;
    let fresh = 0;
    for (const id of postIds) {
      if (this.cache.get(X_SEEN_NS, id)) { d.dedupedPosts += 1; continue; }
      this.cache.set(X_SEEN_NS, id, 1, { ttlMs: DAY_MS, fetchedAt: now });
      fresh += 1;
    }
    d.posts += fresh;
    d.userReads += userReads;
    d.usd = Math.round((d.posts * X_USD_PER_POST + d.userReads * X_USD_PER_USER_READ) * 1000) / 1000;
    this.write(d);
    return d;
  }

  /** Drop stale `seen` rows (called by the poller once a minute; cheap). */
  prune(): number { return this.cache.prune(0); }
}
