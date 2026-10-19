// trenchscope paper bot: one tick of the loop. Manage open positions (mark each one with a real Jupiter SELL
// quote, exit on the rules in strategy.ts), then enter new ones (a real Jupiter BUY quote, within the caps).
//
// PAPER ONLY. Fills come from the existing paper fill pricing (paper.ts computeFill: the quote's in/out amounts,
// so route fees, price impact and the quoted slippage are in the number, plus a simulated base + priority
// fee), never from a mid price. The only external calls are the injected keyless QUOTE, SOL/USD price and
// decimals lookups; there is no build, sign or send path anywhere under packages/cli/src/bot (asserted by
// test/bot-paper-guard.test.ts over the whole static import graph).
//
// Restart-safe: all state is in the BotStore (SQLite). Caps are counted from the database, and a position is
// opened through a partial unique index, so a crash or restart can never double-book a coin.
import {
  buildQuoteRequest, computeFill, quoteMatchesOrder, solToLamports, DEFAULT_SIM_FEE_LAMPORTS,
  type PaperOrder, type QuoteRequest, type SwapQuote, type Fill,
} from '@dexterm/data/core';
import type { ScreenerRow } from '../screener/rows.ts';
import type { BotConfig } from './config.ts';
import { BOOKS, evaluateEntry, evaluateExit, type Book, type EntryEval, type ExitEval } from './strategy.ts';
import type { BotPosition, BotStore } from './store.ts';
import type { BotEvent } from './alerts.ts';

/** Consecutive non-transient sell-quote failures before an open position is written off as unsellable. */
export const NO_ROUTE_FAILS = 5;
const HOUR_MS = 3_600_000;

export interface BotEngineDeps {
  store: BotStore;
  cfg: BotConfig;
  /** Keyless Jupiter swap QUOTE (never a build/sign/send). */
  quote: (req: QuoteRequest) => Promise<SwapQuote>;
  /** Live USD per SOL, or null when unknown (entries pause; exits still run). */
  solUsd: () => Promise<number | null>;
  /** Token decimals for a mint (display / per-token price only; PnL is in lamports). */
  decimals: (mint: string) => Promise<number>;
  /** Alert hook (the notifier). Never throws into the loop. */
  notify?: (ev: BotEvent) => Promise<void>;
  /** Latest LARP verdict for a mint, when one was recorded (feeds the safety verdict like the app does). */
  larp?: (mint: string) => string | null;
  now: () => number;
  log?: (line: string) => void;
}

export interface TickReport {
  at: number;
  rows: number;
  solUsd: number | null;
  /** Rows that passed the entry rules this tick, per book (before caps). */
  candidates: Record<Book, number>;
  entries: BotPosition[];
  exits: BotPosition[];
  marked: number;
  skips: Array<{ book: Book; symbol: string; mint: string; reason: string }>;
  errors: string[];
  open: Record<Book, number>;
}

/** A transient quote failure (rate limit, cool-down, timeout, abort): retried next tick, never counted. */
export function isTransientQuoteError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : '';
  if (name === 'JupiterRateLimitedError' || name === 'SourceUnavailableError' || name === 'AbortError' || name === 'TimeoutError' || name === 'QuotesPausedError') return true;
  // the data layer's limiter rejects a queued call with "rate-limit wait aborted" when our quote timeout fires
  return /rate.?limit|429/i.test(e instanceof Error ? e.message : String(e));
}

/** Raised for every quote after the first rate-limited one in a tick: the rest waits for the next tick. */
export class QuotesPausedError extends Error {
  constructor(cause: string) { super(`quotes paused for this tick after a rate limit (${cause})`); this.name = 'QuotesPausedError'; }
}

/** The row as the decision saw it (minus the fixture back-reference), for the journal. */
export function snapshotRow(r: ScreenerRow | null): Record<string, unknown> | null {
  if (!r) return null;
  const { fixture: _f, ...rest } = r;
  return rest as unknown as Record<string, unknown>;
}

export function quoteSnapshot(q: SwapQuote): Record<string, unknown> {
  return {
    inputMint: q.inputMint, outputMint: q.outputMint, inAmount: q.inAmount.toString(), outAmount: q.outAmount.toString(),
    otherAmountThreshold: q.otherAmountThreshold.toString(), slippageBps: q.slippageBps, priceImpactPct: q.priceImpactPct,
    route: q.route, platformFeeBps: q.platformFeeBps, usdValue: q.usdValue, contextSlot: q.contextSlot, fetchedAt: q.fetchedAt, source: q.source,
  };
}

function fillSnapshot(f: Fill): Record<string, unknown> {
  return {
    side: f.side, solDelta: f.solDelta.toString(), tokenDelta: f.tokenDelta.toString(), grossLamports: f.grossLamports.toString(),
    feeLamports: f.feeLamports.toString(), priceSol: f.priceSol, priceUsd: f.priceUsd, priceImpactPct: f.priceImpactPct, paper: true,
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export class BotEngine {
  private readonly d: BotEngineDeps;
  /** Per-tick quote cache: both books entering the same coin share one buy quote. */
  private quoteCache = new Map<string, Promise<SwapQuote>>();
  /** Alerts raised this tick; awaited before tick() returns so a --once run delivers them. */
  private pending: Promise<void>[] = [];
  /** Set by the first rate-limited quote of a tick: no more quotes until the next tick (keeps a tick short). */
  private paused: string | null = null;

  constructor(deps: BotEngineDeps) {
    this.d = deps;
  }

  get feeLamports(): bigint {
    return DEFAULT_SIM_FEE_LAMPORTS + BigInt(Math.max(0, Math.round(this.d.cfg.priorityFeeLamports)));
  }

  private quoteOnce(order: PaperOrder): Promise<SwapQuote> {
    const req = buildQuoteRequest(order);
    const key = `${req.inputMint}>${req.outputMint}:${req.amount}`;
    if (this.paused) return Promise.reject(new QuotesPausedError(this.paused));
    let p = this.quoteCache.get(key);
    if (!p) {
      p = this.d.quote(req).catch((e: unknown) => { if (isTransientQuoteError(e) && !this.paused) this.paused = errMsg(e); throw e; });
      this.quoteCache.set(key, p);
    }
    return p;
  }

  private async notify(ev: BotEvent): Promise<void> {
    if (!this.d.notify) return;
    try { await this.d.notify(ev); } catch (e) { this.d.log?.(`bot: alert failed: ${errMsg(e)}\n`); }
  }

  async tick(rows: ScreenerRow[]): Promise<TickReport> {
    const { store, cfg } = this.d;
    const now = this.d.now();
    this.quoteCache = new Map();
    this.pending = [];
    this.paused = null;
    const report: TickReport = {
      at: now, rows: rows.length, solUsd: null, candidates: { strategy: 0, baseline: 0 }, entries: [], exits: [], marked: 0, skips: [], errors: [],
      open: { strategy: 0, baseline: 0 },
    };
    const byMint = new Map<string, ScreenerRow>();
    for (const r of rows) if (r.mint && !r.skeleton && !byMint.has(r.mint)) byMint.set(r.mint, r);
    let solUsd: number | null = null;
    try { solUsd = await this.d.solUsd(); } catch (e) { report.errors.push(`SOL/USD: ${errMsg(e)}`); }
    if (solUsd !== null && !(Number.isFinite(solUsd) && solUsd > 0)) solUsd = null;
    report.solUsd = solUsd;

    // ---- 1. manage open positions (both books)
    for (const pos of store.openPositions()) await this.manage(pos, byMint.get(pos.mint) ?? null, now, solUsd, report);

    // ---- 2. entries, per book, within the caps
    if (solUsd === null) {
      report.errors.push('no SOL/USD price: entries paused this tick');
      store.journal({ t: now, book: 'bot', kind: 'error', reason: 'no SOL/USD price: entries paused this tick' });
    } else {
      for (const book of BOOKS) await this.enter(book, rows, now, solUsd, report);
    }
    for (const book of BOOKS) report.open[book] = store.openPositions(book).length;
    await Promise.all(this.pending);
    this.pending = [];
    return report;
  }

  private async manage(pos: BotPosition, row: ScreenerRow | null, now: number, solUsd: number | null, report: TickReport): Promise<void> {
    const { store, cfg } = this.d;
    const order: PaperOrder = { mint: pos.mint, symbol: pos.symbol, side: 'sell', decimals: pos.decimals, amountRaw: pos.tokensRaw, slippageBps: cfg.slippageBps };
    const larp = this.d.larp?.(pos.mint) ?? null;
    let quote: SwapQuote | null = null;
    let fill: Fill | null = null;
    try {
      quote = await this.quoteOnce(order);
      if (!quoteMatchesOrder(order, quote)) throw new Error('sell quote does not match the order');
      fill = computeFill(order, quote, now, this.feeLamports);
      const net = fill.solDelta > 0n ? fill.solDelta : 0n;
      store.mark(pos.id, net, now);
      report.marked++;
    } catch (e) {
      if (isTransientQuoteError(e)) {
        if (!(e instanceof QuotesPausedError)) report.errors.push(`${pos.symbol}: sell quote deferred (${errMsg(e)})`);
      } else {
        const n = store.quoteFailed(pos.id);
        report.errors.push(`${pos.symbol}: sell quote failed ${n}/${NO_ROUTE_FAILS} (${errMsg(e)})`);
        if (n >= NO_ROUTE_FAILS) {
          // No route for several ticks in a row: a coin you cannot sell is worth nothing. Book the honest loss.
          const exit: ExitEval = { reason: 'no-route', detail: `no sell route for ${n} consecutive ticks (${errMsg(e)})` };
          this.closeWith(pos, exit, 0n, null, null, row, now, solUsd, report);
        }
      }
      return;
    }
    const net = fill.solDelta > 0n ? fill.solDelta : 0n;
    const exit = evaluateExit({ openedAt: pos.openedAt, costLamports: pos.costLamports }, net, row, now, this.d.cfg, larp);
    if (!exit) return;
    this.closeWith(pos, exit, net, quote, fill, row, now, solUsd, report);
  }

  private closeWith(pos: BotPosition, exit: ExitEval, net: bigint, quote: SwapQuote | null, fill: Fill | null, row: ScreenerRow | null, now: number, solUsd: number | null, report: TickReport): void {
    const closed = this.d.store.closePosition({
      id: pos.id, closedAt: now, exitLamports: net, exitReason: exit.reason, exitImpactPct: quote?.priceImpactPct ?? null, solUsdExit: solUsd,
      reason: `${exit.reason}: ${exit.detail}`,
      row: snapshotRow(row),
      data: {
        exit, heldMin: (now - pos.openedAt) / 60_000, costLamports: pos.costLamports.toString(), tokensRaw: pos.tokensRaw.toString(),
        quote: quote ? quoteSnapshot(quote) : null, fill: fill ? fillSnapshot(fill) : null, solUsd, rowInFeed: row !== null, paper: true,
      },
    });
    if (!closed) return;
    report.exits.push(closed);
    if (closed.book === 'strategy' && this.d.cfg.alerts.exits) {
      this.pending.push(this.notify({ kind: 'exit', symbol: closed.symbol, mint: closed.mint, reason: exit.reason, pnlPct: closed.pnlPct ?? 0, pnlUsd: closed.pnlUsd ?? 0, heldMin: (now - closed.openedAt) / 60_000, at: now }));
    }
  }

  private async enter(book: Book, rows: ScreenerRow[], now: number, solUsd: number, report: TickReport): Promise<void> {
    const { store, cfg } = this.d;
    const open = store.openPositions(book);
    const held = new Set(open.map((p) => p.mint));
    let budget = Math.min(cfg.maxOpen - open.length, cfg.maxEntriesPerHour - store.entriesSince(book, now - HOUR_MS));
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.mint || r.skeleton || seen.has(r.mint)) continue;
      seen.add(r.mint);
      const larp = this.d.larp?.(r.mint) ?? null;
      const ev = evaluateEntry(book, r, cfg, larp);
      if (!ev.ok) continue;
      report.candidates[book]++;
      if (held.has(r.mint)) continue;
      const last = store.lastExit(book, r.mint);
      if (last !== null && now - last < cfg.reentryCooldownMin * 60_000) continue;
      if (budget <= 0 || this.paused) continue; // keep counting candidates; caps and rate limits decide who gets in
      const booked = await this.tryEntry(book, r, ev, now, solUsd, report);
      if (booked) { budget--; held.add(r.mint); }
    }
  }

  private async tryEntry(book: Book, r: ScreenerRow, ev: EntryEval, now: number, solUsd: number, report: TickReport): Promise<boolean> {
    const { store, cfg } = this.d;
    const skip = (reason: string, data?: unknown): false => {
      report.skips.push({ book, symbol: r.symbol, mint: r.mint, reason });
      store.journal({ t: now, book, kind: 'skip', mint: r.mint, symbol: r.symbol, reason, row: snapshotRow(r), data: { checks: ev, ...(data as object ?? {}) } });
      return false;
    };
    const lamports = solToLamports(cfg.sizeUsd / solUsd);
    if (lamports <= 0n) return skip('size rounds to zero lamports');
    let decimals = 6;
    try { decimals = await this.d.decimals(r.mint); } catch { /* display only; PnL is in lamports */ }
    const order: PaperOrder = { mint: r.mint, symbol: r.symbol, side: 'buy', decimals, amountRaw: lamports, slippageBps: cfg.slippageBps };
    let quote: SwapQuote;
    try {
      quote = await this.quoteOnce(order);
    } catch (e) {
      if (isTransientQuoteError(e)) {
        // journaled once per tick (the first), then entries wait for the next tick
        if (!(e instanceof QuotesPausedError)) return skip(`buy quote deferred (rate limited); entries resume next tick: ${errMsg(e)}`);
        return false;
      }
      return skip(`buy quote failed: ${errMsg(e)}`);
    }
    if (!quoteMatchesOrder(order, quote)) return skip('buy quote does not match the order', { quote: quoteSnapshot(quote) });
    if (!(quote.outAmount > 0n)) return skip('buy quote returns zero tokens', { quote: quoteSnapshot(quote) });
    if (quote.priceImpactPct !== null && quote.priceImpactPct > cfg.maxEntryImpactPct) {
      return skip(`price impact ${quote.priceImpactPct.toFixed(2)}% > ${cfg.maxEntryImpactPct}%`, { quote: quoteSnapshot(quote) });
    }
    const fill = computeFill(order, quote, now, this.feeLamports);
    const cost = -fill.solDelta; // gross + simulated fees
    const reason = book === 'strategy'
      ? `market + safety passed (${ev.safety?.verdict}, p(rug) ${ev.safety?.rugP?.toFixed(2) ?? 'n/a'})`
      : 'market filters passed (baseline ignores the safety verdict)';
    const pos = store.openPosition({
      book, mint: r.mint, symbol: r.symbol, decimals, openedAt: now, sizeUsd: cfg.sizeUsd, solUsdEntry: solUsd,
      costLamports: cost, tokensRaw: fill.tokenDelta, entryPriceUsd: fill.priceUsd ?? (r.price ?? null), entryImpactPct: quote.priceImpactPct,
      reason, row: snapshotRow(r),
      data: { checks: ev, quote: quoteSnapshot(quote), fill: fillSnapshot(fill), solUsd, config: cfg, paper: true },
    });
    if (!pos) return false; // already open in this book (restart / race): idempotent
    report.entries.push(pos);
    if (book === 'strategy' && cfg.alerts.entries) {
      this.pending.push(this.notify({ kind: 'entry', symbol: pos.symbol, mint: pos.mint, sizeUsd: cfg.sizeUsd, mcap: r.mcap, verdict: ev.safety?.verdict ?? null, rugP: ev.safety?.rugP ?? null, at: now }));
    }
    return true;
  }
}
