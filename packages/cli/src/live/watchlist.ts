// trenchscope — live WATCHLIST binding (task-1298, SPEC §4.5). The list persists in SQLite (WatchlistStore,
// same DB file as the cache); prices refresh through Store.enrich (one DexScreener batch + Jupiter search
// per 10 s for every watched mint); alert rules are only ever *proposed* here (price ±25 % vs entry on
// add, liquidity −40 % on `b`) and need a `y` keypress to arm. Armed rules fire once into the alert log.
import type { DataLayer, AlertEvent, AlertRule, Launchpad, SourceId, WatchEntry, WatchlistStore } from '@dexterm/data';
import { fromSnapshot, type ScreenerRow } from '../screener/rows.ts';

export const WATCH_REFRESH_MS = 10_000;

export interface WatchViewRow {
  entry: WatchEntry;
  /** Latest market row (null until the first refresh, or when no source knows the mint any more). */
  row: ScreenerRow | null;
  /** Percent vs the entry price; null without an entry price or a current price. */
  pnlPct: number | null;
  stale: boolean;
}

export interface WatchCandidate {
  mint: string;
  symbol: string;
  name: string;
  launchpad: Launchpad;
  price: number | null;
  liq?: number | null;
  /** Market cap when known: brand-new pairs often have one (SOL-denominated at create) before any price. */
  mcap?: number | null;
}

export interface WatchlistStatus {
  caption: string;
  headerStatus?: string;
  errors: Partial<Record<SourceId, string>>;
  refreshedAt: number | null;
}

export class WatchlistLive {
  readonly dl: DataLayer;
  readonly store: WatchlistStore;
  private readonly now: () => number;
  private readonly onChange?: () => void;
  private rows = new Map<string, ScreenerRow>();
  private stale = new Set<string>();
  errors: Partial<Record<SourceId, string>> = {};
  refreshedAt: number | null = null;
  refreshing = false;
  /** One-line note for the UI after a keypress (`added $X`, `alert armed`), cleared by the next action. */
  notice: string | null = null;

  constructor(dl: DataLayer, store: WatchlistStore, opts: { now?: () => number; onChange?: () => void } = {}) {
    this.dl = dl;
    this.store = store;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange;
  }

  list(): WatchViewRow[] {
    return this.store.list().map((entry) => {
      const row = this.rows.get(entry.mint) ?? null;
      const price = row?.price ?? null;
      const pnlPct = price !== null && entry.entryPrice !== null && entry.entryPrice > 0 ? (price / entry.entryPrice - 1) * 100 : null;
      return { entry, row, pnlPct, stale: this.stale.has(entry.mint) };
    });
  }

  has(mint: string): boolean {
    return this.store.has(mint);
  }

  /** Add (or report already watched). Proposes the two default price alerts; nothing is armed. */
  add(c: WatchCandidate): 'added' | 'already' {
    const isNew = this.store.add({ mint: c.mint, symbol: c.symbol, name: c.name, launchpad: c.launchpad, entryPrice: c.price });
    if (!isNew) { this.notice = `$${c.symbol} is already on the watchlist`; this.onChange?.(); return 'already'; }
    let proposed = 0;
    if (c.price !== null && c.price > 0) {
      this.store.propose({ mint: c.mint, kind: 'price', op: '>', value: c.price * 1.25, note: '+25% vs entry' });
      this.store.propose({ mint: c.mint, kind: 'price', op: '<', value: c.price * 0.75, note: '-25% vs entry' });
      proposed = 2;
    } else if (c.mcap !== null && c.mcap !== undefined && c.mcap > 0) {
      // no price yet (a pair seconds old): propose on market cap instead, the number traders actually quote
      this.store.propose({ mint: c.mint, kind: 'mcap', op: '>', value: c.mcap * 2, note: '2x mcap vs add' });
      this.store.propose({ mint: c.mint, kind: 'mcap', op: '<', value: c.mcap * 0.5, note: 'half mcap vs add' });
      proposed = 2;
    }
    this.store.log({ mint: c.mint, kind: 'watch', level: 'info', text: `${c.symbol} added to watchlist${c.price !== null ? ` at ${fmtPrice(c.price)}` : c.mcap ? ` at ${fmtAny('mcap', c.mcap)} mcap` : ''}` });
    this.notice = `watching $${c.symbol}${proposed ? ` · ${proposed} alert proposals (y to arm, x to dismiss)` : ' · no price or mcap yet, so no alert proposals'}`;
    this.onChange?.();
    return 'added';
  }

  remove(mint: string): boolean {
    const e = this.store.get(mint);
    const ok = this.store.remove(mint);
    this.rows.delete(mint);
    if (ok) {
      this.store.log({ mint, kind: 'watch', level: 'info', text: `${e?.symbol ?? mint.slice(0, 6)} removed from watchlist` });
      this.notice = `removed $${e?.symbol ?? mint.slice(0, 6)}`;
    }
    this.onChange?.();
    return ok;
  }

  /** Propose a liquidity alert for a mint (−40 % from the current liquidity) or a price one when no liquidity is known. */
  propose(c: WatchCandidate): AlertRule | null {
    if (!this.store.has(c.mint)) this.add(c);
    const liq = c.liq ?? this.rows.get(c.mint)?.liq ?? null;
    let rule: AlertRule | null = null;
    if (liq !== null && liq > 0) rule = this.store.propose({ mint: c.mint, kind: 'liq', op: '<', value: liq * 0.6, note: 'liquidity -40%' });
    else if (c.price !== null && c.price > 0) rule = this.store.propose({ mint: c.mint, kind: 'price', op: '<', value: c.price * 0.8, note: '-20% from here' });
    this.notice = rule ? `proposed: ${c.symbol} ${rule.kind} ${rule.op} ${fmtAny(rule.kind, rule.value)} · y to arm, x to dismiss` : `nothing to alert on for $${c.symbol} yet`;
    this.onChange?.();
    return rule;
  }

  proposals(mint?: string): AlertRule[] {
    return this.store.rules('proposed', mint);
  }

  armed(mint?: string): AlertRule[] {
    return this.store.rules('armed', mint);
  }

  /** Arm the oldest proposal (for `mint` when given). The keypress is the confirmation. */
  confirm(mint?: string): AlertRule | null {
    const p = this.proposals(mint)[0] ?? this.proposals()[0];
    if (!p) { this.notice = 'no alert proposals to confirm'; this.onChange?.(); return null; }
    const r = this.store.confirm(p.id)!;
    const sym = this.store.get(r.mint)?.symbol ?? r.mint.slice(0, 6);
    this.store.log({ mint: r.mint, kind: 'alert', level: 'info', text: `armed: ${sym} ${r.kind} ${r.op} ${fmtAny(r.kind, r.value)}` });
    this.notice = `armed: ${sym} ${r.kind} ${r.op} ${fmtAny(r.kind, r.value)}`;
    this.onChange?.();
    return r;
  }

  dismiss(mint?: string): AlertRule | null {
    const p = this.proposals(mint)[0] ?? this.proposals()[0];
    if (!p) { this.notice = 'no alert proposals to dismiss'; this.onChange?.(); return null; }
    const r = this.store.dismiss(p.id)!;
    this.notice = `dismissed proposal for ${this.store.get(r.mint)?.symbol ?? r.mint.slice(0, 6)}`;
    this.onChange?.();
    return r;
  }

  events(limit = 40): AlertEvent[] {
    return this.store.events(limit);
  }

  /** Refresh prices for every watched mint, then evaluate armed rules. Never throws. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const mints = this.store.list().map((e) => e.mint);
      if (!mints.length) { this.refreshedAt = this.now(); return; }
      const res = await this.dl.store.enrich(mints, { price: true });
      const now = this.now();
      this.stale.clear();
      for (const r of res.rows) {
        this.rows.set(r.mint, fromSnapshot(r, now));
        if (r.stale) this.stale.add(r.mint);
      }
      this.errors = res.errors;
      const values = new Map<string, { price: number | null; liq: number | null; holders: number | null; mcap: number | null }>();
      for (const [mint, row] of this.rows) values.set(mint, { price: row.price, liq: row.liq, holders: row.holders, mcap: row.mcap });
      const fired = this.store.evaluate(values, (m) => this.store.get(m)?.symbol ?? m.slice(0, 6));
      if (fired.length) this.notice = `alert: ${fired[0].text}`;
      this.refreshedAt = now;
    } catch (err) {
      this.errors = { ...this.errors, dexscreener: err instanceof Error ? err.message : String(err) };
    } finally {
      this.refreshing = false;
      this.onChange?.();
    }
  }

  status(): WatchlistStatus {
    const n = this.store.list().length;
    const h = this.dl.health;
    const bad = (['dexscreener', 'jupiter-tokens', 'jupiter-price'] as SourceId[]).filter((s) => !h.isAvailable(s));
    const names = [...new Set(bad.map((s) => (s.startsWith('jupiter') ? 'jup' : s)))];
    const armed = this.armed().length;
    const proposed = this.proposals().length;
    return {
      caption: `${n} token${n === 1 ? '' : 's'} · PnL vs entry · ${armed} armed · ${proposed} proposed`,
      headerStatus: names.length ? `◐ degraded: ${names.join(', ')}` : undefined,
      errors: this.errors,
      refreshedAt: this.refreshedAt,
    };
  }
}

function fmtPrice(p: number): string {
  return p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(3)}`;
}

function fmtAny(kind: AlertRule['kind'], v: number): string {
  if (kind === 'price') return fmtPrice(v);
  if (kind === 'holders') return String(Math.round(v));
  return v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;
}
