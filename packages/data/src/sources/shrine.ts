// Shrine candle adapter (keyed, read-only): 1-second OHLCV for a mint's most active pool, over the
// socket.io client in shrine-socket.ts. Ported from tape (worker/src/feed/shrine.ts, chart-context.ts,
// lib/shrine-candles.ts); differences are noted inline.
//
//   emit 'ohlcv_history' { mint, limit }  ack { ok, pool, data: [[ms, o, h, l, c, v], ...] }
//        the newest 500 one-second rows (the server caps limit at 500 and has no paging), priced in the
//        pool's QUOTE token (SOL for pump coins), v = quote volume
//   emit 'subscribe' { pool }             the server first pushes 'token_update' { pool, quote, price,
//        priceUSD, time }: the quote mint and Shrine's quote/USD ratio. Unsubscribed right after.
//
// Rows are validated and bad prints dropped (MAX_MOVE), converted to USD (SOL at the keyless Jupiter
// SOL/USD when available, else Shrine's own ratio; USDC/USDT at their ratio), and a PumpSwap pool with
// virtual quote reserves is repriced from one read-only chain snapshot ((R + V) / B, see boostedPrice).
// Anything that cannot be priced honestly throws, so the caller falls back to GeckoTerminal.

import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { HealthRegistry } from '../health.ts';
import { currentPriority } from '../http.ts';
import type { RateLimiter } from '../limiter.ts';
import type { Candle } from '../model.ts';
import { base58Decode, PUMP_PROGRAM_ID, pumpBondingCurve } from './pda.ts';
import { base58, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './solana-rpc.ts';
import { ShrineError, ShrineSocket, type ShrineSocketOptions } from './shrine-socket.ts';

/** Rows per history read. The server caps `limit` here (checked live 2026-10-18: 7200 and 50000 both return 500). */
export const SHRINE_HISTORY_LIMIT = 500;
/**
 * Shrine sometimes prints an impossible wick on a coin's first seconds (tape, 7RcM...pump 2026-10-17: a
 * high of 2.5e6 SOL on a 4e-8 SOL coin), which scales the chart to trillions. A pump curve spans about
 * 15x from launch to completion, so a 1 s move past 100x is a bad print.
 */
export const SHRINE_MAX_MOVE = 100;
/** History rows older than this are refused (tape's window). */
export const SHRINE_MAX_AGE_MS = 30 * 86_400_000;
/** A Shrine series thinner than this many bars lets GeckoTerminal answer instead when it has more. */
export const SHRINE_MIN_BARS = 20;
/** A Shrine series on another pool than the screen's pair is dropped once its last row is this old. */
export const SHRINE_SIDE_STALE_MS = 3_600_000;

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const USD_STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const SOL_USD_MIN = 1;
const SOL_USD_MAX = 10_000;

// PumpSwap Pool layout (pump-swap-sdk IDL; tape chart-context.ts, checked against chain 2026-10-14/18).
const POOL_BASE_MINT = 43;
const POOL_QUOTE_MINT = 75;
const POOL_BASE_VAULT = 139;
const POOL_QUOTE_VAULT = 171;
/** Signed i128 virtual_quote_reserves, after is_mayhem_mode (243) and is_cashback_coin (244). Zero on legacy pools. */
const POOL_VIRTUAL_QUOTE = 245;

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base58 string that decodes to exactly 32 bytes (a public key), not just any base58 text. */
export function isShrineAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) return false;
  try { return base58Decode(value).length === 32; } catch { return false; }
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

/**
 * Validate raw history tuples into 1 s candles (t in ms, quote units), oldest first. Drops malformed rows,
 * rows outside [now - 30 d, now + 5 s] and rows whose own open/close span exceeds MAX_MOVE; clamps wicks
 * past MAX_MOVE to the body. Like tape, there is no cross-row filter: a rug can fall more than 100x
 * between seconds (FOMO's vault price fell 4000x in 19 s on 2026-10-18), and that is real data.
 */
export function validateShrineRows(data: unknown, nowMs: number): { rows: Candle[]; dropped: number } {
  if (!Array.isArray(data)) throw new ShrineError('shrine: invalid history');
  const byT = new Map<number, Candle>();
  let dropped = 0;
  const tuples = data.slice(-SHRINE_HISTORY_LIMIT);
  dropped += data.length - tuples.length;
  for (const tuple of tuples) {
    if (!Array.isArray(tuple) || tuple.length !== 6) { dropped++; continue; }
    const [t, o, h, l, c, v] = tuple as unknown[];
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t % 1000 !== 0 || t < nowMs - SHRINE_MAX_AGE_MS || t > nowMs + 5_000 ||
      !positive(o) || !positive(h) || !positive(l) || !positive(c) || !nonnegative(v) || h < Math.max(o, c) || l > Math.min(o, c)) { dropped++; continue; }
    const top = Math.max(o, c);
    const bottom = Math.min(o, c);
    if (top / bottom > SHRINE_MAX_MOVE) { dropped++; continue; }
    if (byT.has(t)) dropped++;
    byT.set(t, { t, o, h: h > top * SHRINE_MAX_MOVE ? top : h, l: l < bottom / SHRINE_MAX_MOVE ? bottom : l, c, v });
  }
  return { rows: [...byT.values()].sort((a, b) => a.t - b.t), dropped };
}

/**
 * Bucket 1 s rows into display bars of `periodMs` (tape lib/shrine-candles.ts): buckets align to
 * floor(t / period) * period; each bar after the first opens at the previous bar's close (the terminal's
 * previous-close convention), widening its high/low to include that open. Gaps stay gaps.
 */
export function bucketShrineRows(rows: readonly Candle[], periodMs: number): Candle[] {
  if (!Number.isSafeInteger(periodMs) || periodMs < 1000) throw new Error('Invalid candle interval');
  const buckets = new Map<number, Candle>();
  for (const row of [...rows].sort((a, b) => a.t - b.t)) {
    const t = Math.floor(row.t / periodMs) * periodMs;
    const prev = buckets.get(t);
    buckets.set(t, prev ? { ...prev, h: Math.max(prev.h, row.h), l: Math.min(prev.l, row.l), c: row.c, v: prev.v + row.v } : { ...row, t });
  }
  const bars = [...buckets.values()];
  return bars.map((bar, i) => {
    if (i === 0) return bar;
    const open = bars[i - 1].c;
    return { ...bar, o: open, h: Math.max(bar.h, open), l: Math.min(bar.l, open) };
  });
}

/** A PumpSwap pool's reserves in whole tokens and SOL, read in one snapshot. */
export interface PoolBoost { virtualQuote: number; quoteReserve: number; baseReserve: number }

/**
 * Shrine prices a PumpSwap pool from its vaults, R / B. A pool with virtual quote reserves V trades at
 * (R + V) / B (pump-swap-sdk buy and sell math), which Shrine leaves out: tape saw FOMO (SEn1...pump,
 * 2026-10-18) chart 3.57e-10 SOL while its trades filled at 1.807e-8, a 50x gap. Between trades
 * (R + V) * B = k holds, so a vault price p solves p * B^2 + V * B = k and the traded price is k / B^2.
 * k and V come from one chain read of the current reserves and price the whole window.
 * shortcut (tape): LP fee growth and fee sweeps since a bar are ignored; checked within 1% of FOMO's fills.
 */
export function boostedPrice(price: number, boost: PoolBoost): number {
  const k = (boost.quoteReserve + boost.virtualQuote) * boost.baseReserve;
  const v = boost.virtualQuote;
  return (v + Math.sqrt(v * v + 4 * price * k)) ** 2 / (4 * k);
}

/** Owner + base64 data per address, one snapshot (RpcPool.accountsInfo). Read-only. */
export type AccountsReader = (addresses: string[]) => Promise<Map<string, { owner: string; data: string } | null>>;

export interface ShrineVenue {
  venue: 'pumpswap' | 'pump-curve' | 'other';
  /** Quote mint decoded from a PumpSwap pool (null for other venues). */
  quoteMint: string | null;
  boost: PoolBoost | null;
}

const virtualQuote = (pool: Buffer): bigint =>
  pool.length >= POOL_VIRTUAL_QUOTE + 16 ? (pool.readBigInt64LE(POOL_VIRTUAL_QUOTE + 8) << 64n) | pool.readBigUInt64LE(POOL_VIRTUAL_QUOTE) : 0n;
const key = (data: Buffer, at: number) => base58(data.subarray(at, at + 32));

/**
 * Verify the pool Shrine charts on chain and read its boost (tape chart-context.ts readBoost, re-based on
 * the pool Shrine names instead of deriving the canonical PDA: owner and base mint are checked instead).
 * Throws when a virtual-reserve pool cannot be priced, so the caller never charts the uncorrected price.
 */
export async function readShrineVenue(read: AccountsReader, mint: string, pool: string): Promise<ShrineVenue> {
  const first = await read([pool, mint]);
  const p = first.get(pool) ?? null;
  if (!p) throw new ShrineError('shrine: pool account not found');
  // a curve must be THIS mint's curve; any other venue is not verified here, so it is refused (the chart
  // falls back to GeckoTerminal) rather than shown as a Shrine price on trust
  if (p.owner === PUMP_PROGRAM_ID) {
    if (pool !== pumpBondingCurve(mint)) throw new ShrineError('shrine: curve does not match mint');
    return { venue: 'pump-curve', quoteMint: null, boost: null };
  }
  if (p.owner !== PUMP_AMM_PROGRAM) throw new ShrineError('shrine: unverified pool venue');
  const data = Buffer.from(p.data, 'base64');
  if (data.length < POOL_QUOTE_VAULT + 32) throw new ShrineError('shrine: unreadable PumpSwap pool');
  const [baseMint, quoteMint, baseVault, quoteVault] = [key(data, POOL_BASE_MINT), key(data, POOL_QUOTE_MINT), key(data, POOL_BASE_VAULT), key(data, POOL_QUOTE_VAULT)];
  if (baseMint !== mint && quoteMint !== mint) throw new ShrineError('shrine: pool does not hold this mint');
  const quote = baseMint === mint ? quoteMint : baseMint;
  if (virtualQuote(data) === 0n) return { venue: 'pumpswap', quoteMint: quote, boost: null };
  if (baseMint !== mint || quoteMint !== WSOL_MINT) throw new ShrineError('shrine: virtual-reserve pool not priceable');
  const m = first.get(mint) ?? null;
  if (!m || !TOKEN_PROGRAMS.has(m.owner)) throw new ShrineError('shrine: mint account not readable');
  const mintData = Buffer.from(m.data, 'base64');
  // SPL Mint: decimals u8 at 44, is_initialized at 45 (Token-2022 extends this layout).
  if (mintData.length < 82 || mintData[45] !== 1) throw new ShrineError('shrine: mint account not readable');
  const decimals = mintData[44];
  // Vaults and pool in one snapshot: a fee sweep moves SOL between the quote vault and V together.
  const second = await read([baseVault, quoteVault, pool]);
  const [b, q, cur] = [second.get(baseVault) ?? null, second.get(quoteVault) ?? null, second.get(pool) ?? null];
  if (!b || !q || !cur || !TOKEN_PROGRAMS.has(b.owner) || !TOKEN_PROGRAMS.has(q.owner) || cur.owner !== PUMP_AMM_PROGRAM) throw new ShrineError('shrine: pool vaults not readable');
  const now = Buffer.from(cur.data, 'base64');
  if (now.length < POOL_QUOTE_VAULT + 32 || key(now, POOL_BASE_VAULT) !== baseVault || key(now, POOL_QUOTE_VAULT) !== quoteVault) throw new ShrineError('shrine: pool changed during read');
  const vRaw = virtualQuote(now);
  if (vRaw === 0n) return { venue: 'pumpswap', quoteMint: WSOL_MINT, boost: null };
  // SPL token account: amount u64 at 64.
  const amount = (data64: string): bigint | null => { const bytes = Buffer.from(data64, 'base64'); return bytes.length >= 72 ? bytes.readBigUInt64LE(64) : null; };
  const [baseRaw, quoteRaw] = [amount(b.data), amount(q.data)];
  if (baseRaw === null || quoteRaw === null) throw new ShrineError('shrine: pool vaults not readable');
  const boost = { virtualQuote: Number(vRaw) / 1e9, quoteReserve: Number(quoteRaw) / 1e9, baseReserve: Number(baseRaw) / 10 ** decimals };
  if (!(boost.baseReserve > 0) || !(boost.quoteReserve + boost.virtualQuote > 0)) throw new ShrineError('shrine: pool reserves not priceable');
  return { venue: 'pumpswap', quoteMint: WSOL_MINT, boost };
}

/** One mint's validated history in USD. JSON-safe (cached in the data layer's Cache). */
export interface ShrineHistory {
  mint: string;
  /** The pool Shrine charts (its most active venue for the mint). */
  pool: string;
  venue: ShrineVenue['venue'];
  quoteMint: string;
  /** USD per quote token used for every row (current rate, not historical FX). */
  quoteUsd: number;
  quoteSource: 'jupiter-price' | 'shrine';
  /** Set when PumpSwap virtual quote reserves were applied to the prices. */
  adjusted: 'pumpswap-virtual-reserves' | null;
  /** 1 s candles, t in ms, USD price and USD volume, oldest first. */
  rows: Candle[];
  /** Rows dropped by validation and the bad-print filter. */
  dropped: number;
  /** True when the server returned its full window: older history exists but is not served. */
  capped: boolean;
  source: 'shrine';
  fetchedAt: number;
}

interface PoolQuote { quoteMint: string; ratio: number; at: number; seenAt: number }

export interface ShrineOptions {
  apiKey: string;
  /** Read-only chain reads for the PumpSwap check (RpcPool.accountsInfo). */
  accounts: AccountsReader;
  /** Fresh SOL/USD (keyless Jupiter in the data layer). Null/throw falls back to Shrine's own ratio. */
  solUsd?: () => Promise<number | null>;
  clock?: Clock;
  limiter?: RateLimiter;
  health?: HealthRegistry;
  /** Counts each socket request (the per-source budget meter). */
  onRequest?: () => void;
  /** Wait for the subscribe snapshot ('token_update') at most this long (default 2.5 s). */
  quoteWaitMs?: number;
  /** Test seam: a prebuilt socket. Otherwise one is built from `socket` options. */
  client?: ShrineSocket;
  socket?: Omit<ShrineSocketOptions, 'apiKey' | 'onHealth'>;
}

export class Shrine {
  readonly client: ShrineSocket;
  private readonly opts: Omit<ShrineOptions, 'apiKey'>;
  /** The last SOL/USD Jupiter gave; Shrine's own ratio is only trusted within 20 % of it. */
  private lastSolUsd: number | null = null;
  private readonly clock: Clock;
  private readonly quotes = new Map<string, PoolQuote>();

  constructor(opts: ShrineOptions) {
    const { apiKey, ...rest } = opts;
    this.opts = rest; // the key is handed to the socket and not kept here
    this.clock = opts.clock ?? systemClock;
    this.client = opts.client ?? new ShrineSocket({
      ...opts.socket,
      apiKey,
      onHealth: (ok, error) => { if (!ok) opts.health?.record('shrine', { ok: false, error }); },
    });
  }

  /** Validated USD history for `mint`. Throws (fixed-phrase ShrineError) when it cannot be served honestly. */
  async history(mint: string): Promise<ShrineHistory> {
    if (!isShrineAddress(mint)) throw new ShrineError('shrine: invalid mint');
    if (this.opts.health && !this.opts.health.isAvailable('shrine')) throw new ShrineError('shrine: source degraded');
    const ack = rec(await this.request('ohlcv_history', { mint, limit: SHRINE_HISTORY_LIMIT }));
    if (!ack || ack.ok !== true) throw this.fail('shrine: history unavailable');
    if (!isShrineAddress(ack.pool)) throw this.fail('shrine: invalid pool');
    const pool = ack.pool;
    const now = this.clock.now();
    const { rows: quoteRows, dropped } = validateShrineRows(ack.data, now);
    if (quoteRows.length === 0) throw new ShrineError('shrine: no history for this mint');
    const capped = Array.isArray(ack.data) && ack.data.length >= SHRINE_HISTORY_LIMIT;
    const [venue, quote] = await Promise.all([
      readShrineVenue(this.opts.accounts, mint, pool).catch((e: unknown) => { throw e instanceof ShrineError ? e : new ShrineError('shrine: chain read failed'); }),
      this.poolQuote(pool),
    ]);
    const quoteMint = quote?.quoteMint ?? venue.quoteMint;
    if (!quoteMint) throw new ShrineError('shrine: quote token unknown');
    if (venue.quoteMint && quoteMint !== venue.quoteMint) throw new ShrineError('shrine: quote token disagrees with chain');
    const usd = await this.quoteUsd(quoteMint, quote);
    const boost = venue.boost;
    const price = boost ? (p: number) => boostedPrice(p, boost) : (p: number) => p;
    const rows: Candle[] = [];
    for (const r of quoteRows) {
      const c = { t: r.t, o: price(r.o) * usd.rate, h: price(r.h) * usd.rate, l: price(r.l) * usd.rate, c: price(r.c) * usd.rate, v: r.v * usd.rate };
      if (![c.o, c.h, c.l, c.c, c.v].every(Number.isFinite)) throw new ShrineError('shrine: unpriceable history');
      rows.push(c);
    }
    return {
      mint, pool, venue: venue.venue, quoteMint, quoteUsd: usd.rate, quoteSource: usd.source,
      adjusted: boost ? 'pumpswap-virtual-reserves' : null, rows, dropped, capped, source: 'shrine', fetchedAt: now,
    };
  }

  /** Close the socket for good (data layer shutdown). */
  close(): void {
    this.client.close();
  }

  private fail(message: string): ShrineError {
    this.opts.health?.record('shrine', { ok: false, error: message });
    return new ShrineError(message);
  }

  /** One acked request through the rate bucket, timed and reported to health. */
  private async request(event: string, data: unknown): Promise<unknown> {
    // The caller's priority (task-1323): an idle-priority hover prefetch is deferred, never queued.
    await this.opts.limiter?.acquire('shrine', undefined, currentPriority() ?? 'normal');
    this.opts.onRequest?.();
    const t0 = this.clock.now();
    try {
      const value = await this.client.request(event, data);
      this.opts.health?.record('shrine', { ok: true, latencyMs: this.clock.now() - t0 });
      return value;
    } catch (err) {
      const message = err instanceof ShrineError ? err.message : 'shrine: request failed';
      this.opts.health?.record('shrine', { ok: false, error: message });
      throw new ShrineError(message);
    }
  }

  /**
   * The pool's quote mint and Shrine's quote/USD ratio, from the snapshot the server pushes on subscribe.
   * Cached per pool for a minute; null when no snapshot arrived in time (the caller may still know the
   * quote from the chain read).
   */
  private async poolQuote(pool: string): Promise<PoolQuote | null> {
    const now = this.clock.now();
    const cached = this.quotes.get(pool);
    if (cached && now - cached.seenAt < 60_000) return cached;
    let got: PoolQuote | null = null;
    let wake: (() => void) | null = null;
    const off = this.client.on('token_update', (raw) => {
      const d = rec(raw);
      if (!d || d.pool !== pool || !isShrineAddress(d.quote) || !positive(d.price) || !positive(d.priceUSD) || typeof d.time !== 'number' || !Number.isFinite(d.time)) return;
      const ratio = d.priceUSD / d.price;
      if (!Number.isFinite(ratio) || ratio <= 0) return;
      got = { quoteMint: d.quote, ratio, at: d.time * 1000, seenAt: this.clock.now() };
      wake?.();
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await this.request('subscribe', { pool });
      if (!got) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, this.opts.quoteWaitMs ?? 2_500);
          (timer as { unref?: () => void }).unref?.();
        });
      }
    } catch {
      // No snapshot: the chain read may still name the quote.
    } finally {
      if (timer) clearTimeout(timer);
      off();
      this.client.emit('unsubscribe', { pool });
    }
    const q = got as PoolQuote | null;
    if (q) this.quotes.set(pool, q);
    return q;
  }

  /** USD per quote token: SOL at a fresh keyless SOL/USD (else Shrine's ratio), stables at their ratio. */
  private async quoteUsd(quoteMint: string, quote: PoolQuote | null): Promise<{ rate: number; source: 'jupiter-price' | 'shrine' }> {
    if (quoteMint === WSOL_MINT) {
      let fresh: number | null = null;
      try { fresh = (await this.opts.solUsd?.()) ?? null; } catch { fresh = null; }
      if (fresh !== null && fresh >= SOL_USD_MIN && fresh <= SOL_USD_MAX) { this.lastSolUsd = fresh; return { rate: fresh, source: 'jupiter-price' }; }
      // Shrine's own ratio only near the last good Jupiter price: a wide band could chart 100x off with no hint
      const last = this.lastSolUsd;
      if (last !== null && quote && quote.quoteMint === WSOL_MINT && Math.abs(quote.ratio - last) <= last * 0.2) return { rate: quote.ratio, source: 'shrine' };
      throw new ShrineError('shrine: no SOL/USD rate');
    }
    if (USD_STABLES.has(quoteMint) && quote && quote.quoteMint === quoteMint && quote.ratio > 0.97 && quote.ratio < 1.03) return { rate: quote.ratio, source: 'shrine' };
    throw new ShrineError('shrine: unsupported quote token');
  }
}
