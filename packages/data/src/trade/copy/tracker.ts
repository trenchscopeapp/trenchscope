// task-1360 Tier 1 — the WALLET TRACKER: polls each followed wallet's recent history (Helius
// `getTransactionsForAddress`, newest first, 10 credits a call; the limiter and credit meter own the budget),
// decodes new transactions into trades, keeps per-wallet trades + stats, and raises an ALERT for every new buy or
// sell. The first page of a wallet is a BACKFILL (history is not news: no alerts); only transactions that appear
// after that are alerted. Keyless the tracker is honestly unavailable with the free-key fix; a failed poll is a
// visible degraded state, never silence. Read-only: it never trades, never signs, never proposes by itself —
// stages 2 and 3 consume its alerts through their own gates.

import type { Clock } from '../../clock.ts';
import { systemClock } from '../../clock.ts';
import type { RawTx } from '../../intel/rules.ts';
import { KEY_FIX } from '../../intel/scan.ts';
import { decodeWalletTrades } from './trades.ts';
import { walletStats } from './stats.ts';
import type { StatsOptions } from './stats.ts';
import type { FollowStore } from './follows.ts';
import type { CopyAlert, WalletStats, WalletTrade } from './types.ts';

/** The slice of HeliusHistory the tracker needs (so tests inject a scripted source). */
export interface HistorySource {
  transactions(address: string, opts: { limit: number; sortOrder?: 'asc' | 'desc'; paginationToken?: string }): Promise<{ data: RawTx[]; paginationToken: string | null; fetchedAt: number }>;
}

export interface TrackerOptions {
  follows: FollowStore;
  /** null = no Helius endpoint: the tracker is unavailable and says why */
  history: HistorySource | null;
  clock?: Clock;
  solUsd?: () => number | null;
  /** ms between polls of the whole follow list (design: 5–15 s; default 15 s) */
  pollMs?: number;
  /** newest txs fetched per wallet per poll */
  pageLimit?: number;
  /** txs fetched on the first look at a wallet (stats) */
  backfillLimit?: number;
  /** trades kept per wallet */
  keep?: number;
  onAlert?: (a: CopyAlert) => void;
  onChange?: () => void;
  /** optional: a source-health gate (false = skip the poll, report paused) */
  available?: () => { ok: true } | { ok: false; why: string };
  /** optional: early-entry ranks for a wallet (from scanned launch windows) */
  earlyEntry?: (wallet: string) => StatsOptions['earlyEntry'];
}

export interface TrackerStatus {
  state: 'unavailable' | 'idle' | 'ok' | 'degraded' | 'paused';
  why: string | null;
  polls: number;
  lastPollAt: number | null;
  wallets: number;
  alerts: number;
}

interface WalletState { primed: boolean; seen: Set<string>; trades: WalletTrade[]; txs: number; complete: boolean; lastSlot: number; error: string | null; asOf: number | null }

export const TRACKER_DEFAULTS = { pollMs: 15_000, pageLimit: 25, backfillLimit: 100, keep: 500 } as const;

export class WalletTracker {
  private readonly follows: FollowStore;
  private readonly history: HistorySource | null;
  private readonly clock: Clock;
  private readonly solUsd: () => number | null;
  private readonly pollMs: number;
  private readonly pageLimit: number;
  private readonly backfillLimit: number;
  private readonly keep: number;
  private readonly onAlert: (a: CopyAlert) => void;
  private readonly onChange: () => void;
  private readonly available: () => { ok: true } | { ok: false; why: string };
  private readonly earlyEntry: (wallet: string) => StatsOptions['earlyEntry'];
  private readonly wallets = new Map<string, WalletState>();
  private readonly alertLog: CopyAlert[] = [];
  private polls = 0;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private running: AbortController | null = null;
  private inflight: Promise<CopyAlert[]> | null = null;
  private n = 0;

  constructor(opts: TrackerOptions) {
    this.follows = opts.follows;
    this.history = opts.history;
    this.clock = opts.clock ?? systemClock;
    this.solUsd = opts.solUsd ?? (() => null);
    this.pollMs = opts.pollMs ?? TRACKER_DEFAULTS.pollMs;
    this.pageLimit = opts.pageLimit ?? TRACKER_DEFAULTS.pageLimit;
    this.backfillLimit = opts.backfillLimit ?? TRACKER_DEFAULTS.backfillLimit;
    this.keep = opts.keep ?? TRACKER_DEFAULTS.keep;
    this.onAlert = opts.onAlert ?? (() => {});
    this.onChange = opts.onChange ?? (() => {});
    this.available = opts.available ?? (() => ({ ok: true }));
    this.earlyEntry = opts.earlyEntry ?? (() => undefined);
  }

  status(): TrackerStatus {
    const wallets = this.follows.list().length;
    const base = { polls: this.polls, lastPollAt: this.lastPollAt, wallets, alerts: this.alertLog.length };
    if (!this.history) return { state: 'unavailable', why: `following wallets needs a ${KEY_FIX}`, ...base };
    const av = this.available();
    if (!av.ok) return { state: 'paused', why: av.why, ...base };
    if (this.lastError) return { state: 'degraded', why: this.lastError, ...base };
    if (this.polls === 0) return { state: 'idle', why: wallets ? 'first poll pending' : 'no wallets followed', ...base };
    return { state: 'ok', why: null, ...base };
  }

  trades(addr: string): WalletTrade[] { return [...(this.wallets.get(addr)?.trades ?? [])].reverse(); }
  alerts(limit = 50): CopyAlert[] { return this.alertLog.slice(-limit).reverse(); }
  stats(addr: string): WalletStats {
    const w = this.wallets.get(addr);
    return walletStats(addr, w?.trades ?? [], { solUsd: this.solUsd(), txs: w?.txs ?? 0, complete: w?.complete ?? false, earlyEntry: this.earlyEntry(addr), asOf: w?.asOf ?? null });
  }
  /** Per-wallet poll error (shown on the row), null when the last poll was clean. */
  walletError(addr: string): string | null { return this.wallets.get(addr)?.error ?? null; }

  /** One pass over the follow list. Serialised: a second call while one runs returns the same promise. */
  pollOnce(): Promise<CopyAlert[]> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async run(): Promise<CopyAlert[]> {
    const out: CopyAlert[] = [];
    if (!this.history) return out;
    const av = this.available();
    if (!av.ok) return out;
    const live = new Set(this.follows.list().map((f) => f.addr));
    for (const addr of [...this.wallets.keys()]) if (!live.has(addr)) this.wallets.delete(addr);
    let anyError: string | null = null;
    for (const f of this.follows.list()) {
      let w = this.wallets.get(f.addr);
      if (!w) { w = { primed: false, seen: new Set(), trades: [], txs: 0, complete: false, lastSlot: 0, error: null, asOf: null }; this.wallets.set(f.addr, w); }
      try {
        const page = await this.history.transactions(f.addr, { limit: w.primed ? this.pageLimit : this.backfillLimit, sortOrder: 'desc' });
        w.asOf = page.fetchedAt;
        const fresh = page.data.filter((tx) => { const s = tx.transaction?.signatures?.[0]; return !!s && !w!.seen.has(s); });
        for (const tx of fresh) w.seen.add(tx.transaction!.signatures![0]);
        w.txs += fresh.length;
        const trades = decodeWalletTrades(fresh, f.addr, { solUsd: this.solUsd(), fetchedAt: page.fetchedAt });
        if (!w.primed) { w.primed = true; w.complete = page.paginationToken === null; }
        else {
          const now = this.clock.now();
          for (const tr of trades) {
            if (tr.side === 'transfer') continue;
            const a: CopyAlert = { id: `copy_${++this.n}`, t: now, wallet: f.addr, name: f.name, trade: tr, lagMs: tr.tKnown ? Math.max(0, now - tr.t) : null };
            this.alertLog.push(a); out.push(a);
          }
        }
        if (trades.length) {
          w.trades.push(...trades);
          w.trades.sort((a, b) => a.slot - b.slot || a.sig.localeCompare(b.sig));
          if (w.trades.length > this.keep) w.trades.splice(0, w.trades.length - this.keep);
          w.lastSlot = w.trades[w.trades.length - 1].slot;
        }
        w.error = null;
      } catch (e) {
        w.error = e instanceof Error ? e.message : String(e);
        anyError = `${f.addr.slice(0, 4)}…: ${w.error}`;
      }
    }
    if (this.alertLog.length > 500) this.alertLog.splice(0, this.alertLog.length - 500);
    this.polls += 1;
    this.lastPollAt = this.clock.now();
    this.lastError = anyError;
    for (const a of out) this.onAlert(a);
    this.onChange();
    return out;
  }

  /** Poll on an interval until stop(). Never throws out of the loop; errors show in status(). */
  start(): void {
    if (this.running || !this.history) return;
    const ctl = new AbortController();
    this.running = ctl;
    void (async () => {
      while (!ctl.signal.aborted) {
        try { await this.pollOnce(); } catch { /* reported via status() */ }
        await this.clock.sleep(this.pollMs, ctl.signal);
      }
    })();
  }

  stop(): void { this.running?.abort(); this.running = null; }
  get isRunning(): boolean { return this.running !== null; }
}
