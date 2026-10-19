// Paper trading (task-1310 T0, SPEC §6.0/§6.1/§6.10). A SIMULATED wallet priced from live keyless
// Jupiter quotes. Nothing here signs, holds a key, or sends a transaction — there is a hard boundary
// (the TradeExecutor interface) behind which a real signing executor can later be plugged, and this
// file imports NO wallet/signing/crypto library of any kind (invariant SPEC §6.0, acceptance (d)).
//
// What this module owns:
//   - pure ticket/fill/PnL math (computeFill, buildQuoteRequest, position maths) — unit-tested;
//   - TradeExecutor: the one method the UI ever calls (execute an armed order against a fresh quote);
//   - PaperExecutor: the T0 implementation that books the fill into a local SQLite wallet;
//   - PaperWallet: the node:sqlite store (same DB file as the cache/watchlist; one --db controls all).
//
// Fills are computed from the quote amounts at confirm time (SPEC §6.1 step 6: book from the fill,
// never from a stale on-screen quote). A small fixed SOL fee is modelled and clearly labelled as a
// SIMULATION; no real network/priority fee is ever paid.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { QuoteRequest, SwapQuote } from './sources/jupiter-swap.ts';

/** Wrapped SOL: the quote's SOL leg for both sides (buy = SOL→token, sell = token→SOL). */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Default starting balance for a fresh paper wallet (SPEC: configurable, default 10 SOL). */
export const DEFAULT_START_LAMPORTS = 10n * LAMPORTS_PER_SOL;
/** Simulated fixed SOL fee per fill (one base signature fee). Clearly a simulation; never paid. */
export const DEFAULT_SIM_FEE_LAMPORTS = 5_000n;

export type Side = 'buy' | 'sell';

/** An armed order the executor will fill. Amounts are already raw base units (the ticket converts). */
export interface PaperOrder {
  mint: string;
  symbol: string;
  side: Side;
  /** Token decimals (for display and SOL/token price); SOL is always 9. */
  decimals: number;
  /** Raw base units being spent: lamports of SOL (buy) or token base units (sell). */
  amountRaw: bigint;
  slippageBps: number;
}

/** A booked paper fill. Deltas are signed from the wallet's point of view. */
export interface Fill {
  t: number;
  mint: string;
  symbol: string;
  side: Side;
  decimals: number;
  /** Signed SOL change to the wallet, lamports (buy < 0, sell > 0), net of the simulated fee. */
  solDelta: bigint;
  /** Signed token change, raw base units (buy > 0, sell < 0). */
  tokenDelta: bigint;
  /** |SOL| moved excluding the simulated fee (gross), lamports. */
  grossLamports: bigint;
  feeLamports: bigint;
  /** SOL per whole token at the fill. */
  priceSol: number;
  priceUsd: number | null;
  priceImpactPct: number | null;
  slippageBps: number;
  route: string[];
  /** Realized PnL booked by this fill, lamports (sells only; 0 on a buy). */
  realizedLamports: bigint;
  readonly paper: true;
}

/** A saved fill row (what the positions screen's history reads). */
export interface TradeRecord extends Fill {
  id: number;
}

export interface Position {
  mint: string;
  symbol: string;
  decimals: number;
  /** Current token balance, raw base units. */
  tokensRaw: bigint;
  /** Cost basis of the current balance, lamports. */
  costLamports: bigint;
  /** Lifetime realized PnL on this mint, lamports. */
  realizedLamports: bigint;
  updatedAt: number;
}

export interface WalletSummary {
  balanceLamports: bigint;
  startLamports: bigint;
  createdAt: number;
}

// --------------------------------------------------------------------------- pure conversions

export function lamportsToSol(l: bigint): number {
  return Number(l) / 1e9;
}

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol < 0) return 0n;
  return BigInt(Math.round(sol * 1e9));
}

export function rawToTokens(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function tokensToRaw(tokens: number, decimals: number): bigint {
  if (!Number.isFinite(tokens) || tokens < 0) return 0n;
  // Round in float then to bigint; paper amounts never need sub-unit exactness.
  return BigInt(Math.round(tokens * 10 ** decimals));
}

/** The keyless quote request for an order: SOL↔token with the right side and ExactIn amount. */
export function buildQuoteRequest(order: PaperOrder): QuoteRequest {
  return order.side === 'buy'
    ? { inputMint: SOL_MINT, outputMint: order.mint, amount: order.amountRaw, slippageBps: order.slippageBps, mode: 'ExactIn' }
    : { inputMint: order.mint, outputMint: SOL_MINT, amount: order.amountRaw, slippageBps: order.slippageBps, mode: 'ExactIn' };
}

/** True when a quote actually matches the order (same side/mint/amount) — a guard before booking. */
export function quoteMatchesOrder(order: PaperOrder, q: SwapQuote): boolean {
  const req = buildQuoteRequest(order);
  return q.inputMint === req.inputMint && q.outputMint === req.outputMint && q.inAmount === req.amount;
}

/**
 * Compute the fill a quote would produce for an order, with the simulated fee applied. Pure: no
 * wallet, no persistence, no validation — the executor validates balance before applying this.
 */
export function computeFill(order: PaperOrder, q: SwapQuote, now: number, feeLamports = DEFAULT_SIM_FEE_LAMPORTS): Fill {
  const buy = order.side === 'buy';
  const gross = buy ? q.inAmount : q.outAmount; // SOL leg (lamports)
  const tokenAbs = buy ? q.outAmount : q.inAmount; // token leg (raw base units)
  const solDelta = buy ? -(gross + feeLamports) : gross - feeLamports;
  const tokenDelta = buy ? tokenAbs : -tokenAbs;
  const tokensWhole = rawToTokens(tokenAbs, order.decimals);
  const priceSol = tokensWhole > 0 ? lamportsToSol(gross) / tokensWhole : 0;
  const priceUsd = q.usdValue !== null && tokensWhole > 0 ? q.usdValue / tokensWhole : null;
  return {
    t: now,
    mint: order.mint,
    symbol: order.symbol,
    side: order.side,
    decimals: order.decimals,
    solDelta,
    tokenDelta,
    grossLamports: gross,
    feeLamports,
    priceSol,
    priceUsd,
    priceImpactPct: q.priceImpactPct,
    slippageBps: q.slippageBps,
    route: q.route,
    realizedLamports: 0n, // set by the executor for sells, once the cost basis is known
    paper: true,
  };
}

export function emptyPosition(mint: string, symbol: string, decimals: number, now: number): Position {
  return { mint, symbol, decimals, tokensRaw: 0n, costLamports: 0n, realizedLamports: 0n, updatedAt: now };
}

/** Apply a buy fill to a position: add tokens, add the SOL spent (incl. fee) to the cost basis. */
export function applyBuy(pos: Position, fill: Fill): Position {
  return {
    ...pos,
    tokensRaw: pos.tokensRaw + fill.tokenDelta,
    costLamports: pos.costLamports + (-fill.solDelta), // solDelta is negative on a buy
    updatedAt: fill.t,
  };
}

/**
 * Apply a sell fill to a position: remove tokens, remove the proportional cost basis, and book the
 * realized PnL (net proceeds − cost removed). Returns the new position and the realized lamports.
 */
export function applySell(pos: Position, fill: Fill): { pos: Position; realizedLamports: bigint } {
  const sold = -fill.tokenDelta; // positive raw amount sold
  const have = pos.tokensRaw;
  const soldClamped = sold > have ? have : sold;
  const costRemoved = have > 0n ? (pos.costLamports * soldClamped) / have : 0n;
  const proceeds = fill.solDelta; // positive net lamports in
  const realized = proceeds - costRemoved;
  const tokensRaw = have - soldClamped;
  const costLamports = tokensRaw === 0n ? 0n : pos.costLamports - costRemoved;
  return {
    pos: { ...pos, tokensRaw, costLamports, realizedLamports: pos.realizedLamports + realized, updatedAt: fill.t },
    realizedLamports: realized,
  };
}

export interface PositionPnl {
  /** Current mark value of the held tokens in SOL (0 when no price). */
  valueSol: number;
  /** Cost basis in SOL. */
  costSol: number;
  /** Unrealized PnL in SOL (valueSol − costSol); null when no current price. */
  unrealizedSol: number | null;
  /** Unrealized PnL as a fraction of cost (0.25 = +25%); null when no price or zero cost. */
  unrealizedPct: number | null;
  realizedSol: number;
  /** Average entry price, SOL per whole token (null when flat). */
  avgEntrySol: number | null;
}

/**
 * PnL for a position given a current price in SOL per whole token (null when no live price).
 * Pure: the positions screen feeds the live mark and renders the result.
 */
export function positionPnl(pos: Position, priceSolPerToken: number | null): PositionPnl {
  const tokensWhole = rawToTokens(pos.tokensRaw, pos.decimals);
  const costSol = lamportsToSol(pos.costLamports);
  const realizedSol = lamportsToSol(pos.realizedLamports);
  const avgEntrySol = tokensWhole > 0 ? costSol / tokensWhole : null;
  if (priceSolPerToken === null || !Number.isFinite(priceSolPerToken)) {
    return { valueSol: 0, costSol, unrealizedSol: null, unrealizedPct: null, realizedSol, avgEntrySol };
  }
  const valueSol = tokensWhole * priceSolPerToken;
  const unrealizedSol = valueSol - costSol;
  const unrealizedPct = costSol > 0 ? unrealizedSol / costSol : null;
  return { valueSol, costSol, unrealizedSol, unrealizedPct, realizedSol, avgEntrySol };
}

// --------------------------------------------------------------------------- executor boundary

/** Raised when an order cannot be filled against the simulated wallet. */
export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

/**
 * The one trade operation the UI ever calls. A real, signing executor will implement this same
 * interface later (build → simulate → sign → send → book from confirmed deltas, SPEC §6.1); the
 * paper executor books directly from the quote. The UI holds only this type, so swapping in a real
 * executor touches no screen code (acceptance (d)).
 */
export interface TradeExecutor {
  readonly kind: 'paper' | 'live';
  /** Preview the fill an order+quote would produce (no side effects). */
  previewFill(order: PaperOrder, quote: SwapQuote): Fill;
  /** Execute an armed order against a fresh quote; books the fill and returns it. May throw. */
  execute(order: PaperOrder, quote: SwapQuote): Promise<TradeRecord>;
}

export interface PaperExecutorOptions {
  clock?: Clock;
  /** Simulated fixed SOL fee per fill (lamports). */
  feeLamports?: bigint;
}

/** The T0 paper executor: validates against the simulated wallet, books the fill, records history. */
export class PaperExecutor implements TradeExecutor {
  readonly kind = 'paper' as const;
  private readonly wallet: PaperWallet;
  private readonly clock: Clock;
  readonly feeLamports: bigint;

  constructor(wallet: PaperWallet, opts: PaperExecutorOptions = {}) {
    this.wallet = wallet;
    this.clock = opts.clock ?? systemClock;
    this.feeLamports = opts.feeLamports ?? DEFAULT_SIM_FEE_LAMPORTS;
  }

  previewFill(order: PaperOrder, quote: SwapQuote): Fill {
    return computeFill(order, quote, this.clock.now(), this.feeLamports);
  }

  execute(order: PaperOrder, quote: SwapQuote): Promise<TradeRecord> {
    if (!quoteMatchesOrder(order, quote)) {
      return Promise.reject(new Error('quote does not match the order (mint/side/amount changed) — re-quote and confirm again'));
    }
    const fill = computeFill(order, quote, this.clock.now(), this.feeLamports);
    try {
      const rec = this.wallet.book(order, fill);
      return Promise.resolve(rec);
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

// --------------------------------------------------------------------------- SQLite wallet store

export interface PaperWalletOptions {
  /** File path or ':memory:' (default). Same file the cache/watchlist use. */
  path?: string;
  clock?: Clock;
  /** Starting balance for a brand-new wallet (lamports). Default 10 SOL. */
  startLamports?: bigint;
}

/**
 * The simulated wallet, persisted in node:sqlite (same file as the cache and watchlist, so one
 * `--db` controls everything). A single-row balance, one row per position, and an append-only
 * trade log. Booking a fill (balance + position + history) runs in one SQL transaction.
 */
export class PaperWallet {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(opts: PaperWalletOptions = {}) {
    const path = opts.path ?? ':memory:';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.clock = opts.clock ?? systemClock;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS paper_wallet (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        balance_lamports TEXT NOT NULL,
        start_lamports TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_positions (
        mint TEXT PRIMARY KEY, symbol TEXT NOT NULL, decimals INTEGER NOT NULL,
        tokens_raw TEXT NOT NULL, cost_lamports TEXT NOT NULL, realized_lamports TEXT NOT NULL DEFAULT '0',
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, mint TEXT NOT NULL, symbol TEXT NOT NULL,
        side TEXT NOT NULL, decimals INTEGER NOT NULL, sol_delta TEXT NOT NULL, token_delta TEXT NOT NULL,
        gross_lamports TEXT NOT NULL, fee_lamports TEXT NOT NULL, price_sol REAL NOT NULL, price_usd REAL,
        price_impact_pct REAL, slippage_bps INTEGER NOT NULL, route TEXT NOT NULL DEFAULT '', realized_lamports TEXT NOT NULL DEFAULT '0'
      );
      CREATE INDEX IF NOT EXISTS paper_trades_mint ON paper_trades(mint, id);
    `);
    const start = opts.startLamports ?? DEFAULT_START_LAMPORTS;
    this.db
      .prepare('INSERT OR IGNORE INTO paper_wallet (id, balance_lamports, start_lamports, created_at) VALUES (1, ?, ?, ?)')
      .run(start.toString(), start.toString(), this.clock.now());
  }

  summary(): WalletSummary {
    const row = this.db.prepare('SELECT balance_lamports, start_lamports, created_at FROM paper_wallet WHERE id = 1').get() as Record<string, unknown>;
    return { balanceLamports: BigInt(String(row.balance_lamports)), startLamports: BigInt(String(row.start_lamports)), createdAt: Number(row.created_at) };
  }

  balance(): bigint {
    return this.summary().balanceLamports;
  }

  /** Reset the wallet to a fresh starting balance and clear positions + history (opt-in). */
  reset(startLamports = DEFAULT_START_LAMPORTS): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM paper_positions').run();
      this.db.prepare('DELETE FROM paper_trades').run();
      this.db.prepare('UPDATE paper_wallet SET balance_lamports = ?, start_lamports = ?, created_at = ? WHERE id = 1')
        .run(startLamports.toString(), startLamports.toString(), this.clock.now());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  position(mint: string): Position | undefined {
    const row = this.db.prepare('SELECT mint, symbol, decimals, tokens_raw, cost_lamports, realized_lamports, updated_at FROM paper_positions WHERE mint = ?').get(mint) as Record<string, unknown> | undefined;
    return row ? rowToPosition(row) : undefined;
  }

  /** Open positions (non-zero balance) plus any mint with realized PnL, newest activity first. */
  positions(): Position[] {
    const rows = this.db.prepare('SELECT mint, symbol, decimals, tokens_raw, cost_lamports, realized_lamports, updated_at FROM paper_positions ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map(rowToPosition);
  }

  trades(limit = 100): TradeRecord[] {
    const rows = this.db.prepare('SELECT * FROM paper_trades ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map(rowToTrade);
  }

  /**
   * Book a fill: validate funds, update the balance and position, append the trade — one SQL
   * transaction. Throws InsufficientFundsError when the simulated wallet cannot cover the order.
   */
  book(order: PaperOrder, fill: Fill): TradeRecord {
    const balance = this.balance();
    if (order.side === 'buy') {
      const need = fill.grossLamports + fill.feeLamports;
      if (balance < need) throw new InsufficientFundsError(`insufficient paper balance: need ${lamportsToSol(need).toFixed(4)} SOL, have ${lamportsToSol(balance).toFixed(4)} SOL`);
    } else {
      const have = this.position(order.mint)?.tokensRaw ?? 0n;
      const sold = -fill.tokenDelta;
      if (have < sold) throw new InsufficientFundsError(`insufficient ${order.symbol} to sell: have ${rawToTokens(have, order.decimals)}, selling ${rawToTokens(sold, order.decimals)}`);
    }

    const existing = this.position(order.mint) ?? emptyPosition(order.mint, order.symbol, order.decimals, fill.t);
    let realized = 0n;
    let next: Position;
    if (order.side === 'buy') {
      next = applyBuy(existing, fill);
    } else {
      const r = applySell(existing, fill);
      next = r.pos;
      realized = r.realizedLamports;
    }
    const booked: Fill = { ...fill, realizedLamports: realized };

    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE paper_wallet SET balance_lamports = ? WHERE id = 1').run((balance + booked.solDelta).toString());
      this.db
        .prepare(`INSERT INTO paper_positions (mint, symbol, decimals, tokens_raw, cost_lamports, realized_lamports, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals,
                    tokens_raw = excluded.tokens_raw, cost_lamports = excluded.cost_lamports,
                    realized_lamports = excluded.realized_lamports, updated_at = excluded.updated_at`)
        .run(next.mint, next.symbol, next.decimals, next.tokensRaw.toString(), next.costLamports.toString(), next.realizedLamports.toString(), next.updatedAt);
      const res = this.db
        .prepare(`INSERT INTO paper_trades (t, mint, symbol, side, decimals, sol_delta, token_delta, gross_lamports, fee_lamports, price_sol, price_usd, price_impact_pct, slippage_bps, route, realized_lamports)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(booked.t, booked.mint, booked.symbol, booked.side, booked.decimals, booked.solDelta.toString(), booked.tokenDelta.toString(),
          booked.grossLamports.toString(), booked.feeLamports.toString(), booked.priceSol, booked.priceUsd, booked.priceImpactPct,
          booked.slippageBps, booked.route.join(' → '), booked.realizedLamports.toString());
      this.db.exec('COMMIT');
      return { ...booked, id: Number(res.lastInsertRowid) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

function rowToPosition(r: Record<string, unknown>): Position {
  return {
    mint: String(r.mint),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    tokensRaw: BigInt(String(r.tokens_raw)),
    costLamports: BigInt(String(r.cost_lamports)),
    realizedLamports: BigInt(String(r.realized_lamports ?? '0')),
    updatedAt: Number(r.updated_at),
  };
}

function rowToTrade(r: Record<string, unknown>): TradeRecord {
  return {
    id: Number(r.id),
    t: Number(r.t),
    mint: String(r.mint),
    symbol: String(r.symbol),
    side: r.side === 'sell' ? 'sell' : 'buy',
    decimals: Number(r.decimals),
    solDelta: BigInt(String(r.sol_delta)),
    tokenDelta: BigInt(String(r.token_delta)),
    grossLamports: BigInt(String(r.gross_lamports)),
    feeLamports: BigInt(String(r.fee_lamports)),
    priceSol: Number(r.price_sol),
    priceUsd: r.price_usd === null || r.price_usd === undefined ? null : Number(r.price_usd),
    priceImpactPct: r.price_impact_pct === null || r.price_impact_pct === undefined ? null : Number(r.price_impact_pct),
    slippageBps: Number(r.slippage_bps),
    route: String(r.route ?? '').length ? String(r.route).split(' → ') : [],
    realizedLamports: BigInt(String(r.realized_lamports ?? '0')),
    paper: true,
  };
}
