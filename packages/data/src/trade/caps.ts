// trenchscope T1 — signer-side trade caps (SPEC §6.0 invariant 3, §6.2 CL-04). The policy the UI, the
// model, the voice router and a compromised popup CANNOT bypass: every real trade is re-checked here
// against hard limits before anything is signed or submitted, and refused out of policy.
//
// Hard rules (task-1310 scope §3):
//   * DEVNET is the default. MAINNET requires `mainnetEnabled` (the `--mainnet` flag) AND a known USD
//     notional AND it must pass a per-trade USD cap (default $5) and a daily USD cap (default $20).
//   * A plan whose simulation failed, whose price impact exceeds 3%, or whose signed/submitted intent
//     differs from the shown plan (plan-hash mismatch) is refused.
//   * Round 2 (SPEC §6.2): the decoded transaction must pass the program allow-list / forbidden-
//     instruction scan, the simulated SOL OUT of the wallet must not exceed the plan (+ a fee
//     allowance) nor the absolute SOL-out cap, slippage has a ceiling, and a mainnet notional must be
//     strictly positive and known.
//   * Caps live here, not in the UI. This module holds no keys and performs no I/O beyond the daily
//     ledger; it only decides ALLOW / REFUSE.
//
// This file imports no wallet, signing or crypto-key library. `node:crypto` is used only for a SHA-256
// plan hash (binding), never for key material.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { Side } from '../paper.ts';

export type TradeNetwork = 'devnet' | 'mainnet';

export const DEFAULT_PER_TRADE_USD = 5;
export const DEFAULT_DAILY_USD = 20;
export const MAX_PRICE_IMPACT_PCT = 3;
/** Absolute SOL that may leave the wallet in one transaction (any network). */
export const DEFAULT_MAX_SOL_OUT = 1;
export const HARD_MAX_SOL_OUT = 5;
/** Slippage ceiling (SPEC §6.2 "slippage exceeds the configured maximum"). */
export const DEFAULT_MAX_SLIPPAGE_BPS = 500;
export const HARD_MAX_SLIPPAGE_BPS = 1000;
/**
 * How much MORE SOL than the planned SOL leg a transaction may consume: network fee + priority fee +
 * up to two ATA rents (2 × 0.00203928 SOL). A buy of 0.5 SOL may simulate as 0.5 + fees; 0.51 may not.
 */
export const SOL_OVERHEAD_ALLOWANCE_LAMPORTS = 10_000_000n; // 0.01 SOL

// DEFECT 6: hard ceilings the caps can NEVER exceed, however they are configured. `--max-usd 1000000`
// or `--daily-usd 1e12` must not be accepted as-is. defaultCaps() clamps any override down to these,
// the CLI flag parser rejects an over-ceiling value outright, and (round 2) checkCaps clamps AGAIN at
// the decision point so a caps object literal or a mutated object cannot raise them either.
export const HARD_MAX_PER_TRADE_USD = 500;
export const HARD_MAX_DAILY_USD = 2000;

export interface TradeCaps {
  /** The network real trades run against; DEVNET is the default everywhere. */
  network: TradeNetwork;
  /** Only the `--mainnet` flag sets this true; without it a mainnet plan is refused. */
  mainnetEnabled: boolean;
  /** Max USD value of a single mainnet trade. */
  perTradeUsd: number;
  /** Max USD value across all mainnet trades in a UTC day. */
  dailyUsd: number;
  /** Max price impact (%) for any trade, any network. */
  maxPriceImpactPct: number;
  /** Max SOL that may leave the wallet in one transaction (simulated delta), any network. */
  maxSolOut: number;
  /** Max slippage (bps) a plan may carry, any network. */
  maxSlippageBps: number;
}

function clampCap(v: unknown, dflt: number, hardMax: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!(n > 0) || !Number.isFinite(n)) return dflt;
  return Math.min(n, hardMax);
}

/**
 * Safe defaults: devnet, mainnet disabled, tiny caps. Override only from explicit flags. The result is
 * FROZEN (round 2): mutating a caps object after construction throws instead of raising a cap.
 */
export function defaultCaps(over: Partial<TradeCaps> = {}): TradeCaps {
  const caps: TradeCaps = {
    network: over.network === 'mainnet' ? 'mainnet' : 'devnet',
    mainnetEnabled: over.mainnetEnabled === true,
    // Defensive clamps: a caller can only make caps SMALLER than the defaults by override, never silently
    // larger through a bad value. Non-finite / negative values fall back to the safe default; an
    // over-ceiling value is clamped DOWN to the hard ceiling (DEFECT 6).
    perTradeUsd: clampCap(over.perTradeUsd, DEFAULT_PER_TRADE_USD, HARD_MAX_PER_TRADE_USD),
    dailyUsd: clampCap(over.dailyUsd, DEFAULT_DAILY_USD, HARD_MAX_DAILY_USD),
    maxPriceImpactPct: clampCap(over.maxPriceImpactPct, MAX_PRICE_IMPACT_PCT, MAX_PRICE_IMPACT_PCT),
    maxSolOut: clampCap(over.maxSolOut, DEFAULT_MAX_SOL_OUT, HARD_MAX_SOL_OUT),
    maxSlippageBps: clampCap(over.maxSlippageBps, DEFAULT_MAX_SLIPPAGE_BPS, HARD_MAX_SLIPPAGE_BPS),
  };
  // mainnet is only ever on when explicitly enabled AND the network is mainnet.
  if (caps.network === 'mainnet' && !caps.mainnetEnabled) caps.network = 'devnet';
  return Object.freeze(caps);
}

/**
 * task-1328: without `--mainnet` the USD caps are configurable only DOWNWARD — a value above the
 * defaults ($5 / $20) is clamped back to the default. Raising them needs the explicit mainnet flag
 * (and the hard ceilings still apply). The signer applies this to the caps it was started with.
 */
export function capsOnlyDownward(caps: TradeCaps): TradeCaps {
  if (caps.mainnetEnabled) return caps;
  return defaultCaps({
    ...caps,
    perTradeUsd: Math.min(caps.perTradeUsd, DEFAULT_PER_TRADE_USD),
    dailyUsd: Math.min(caps.dailyUsd, DEFAULT_DAILY_USD),
    // task-1337 (verify-1328 minor): the SOL-out and slippage ceilings are downward-only too without
    // --mainnet; `--max-slippage-bps 900` used to be honoured on a devnet-labelled signer.
    maxSolOut: Math.min(caps.maxSolOut, DEFAULT_MAX_SOL_OUT),
    maxSlippageBps: Math.min(caps.maxSlippageBps, DEFAULT_MAX_SLIPPAGE_BPS),
  });
}

/**
 * The caps as the decision point actually applies them: every numeric cap clamped to its hard ceiling
 * (or its default when missing/invalid), whatever object the caller handed in. A `TradeCaps` literal
 * `{perTradeUsd: 1e9}` is therefore worth exactly HARD_MAX_PER_TRADE_USD here (re-verify MEDIUM #6).
 */
export function effectiveCaps(caps: Partial<TradeCaps> | null | undefined): TradeCaps {
  const c = caps ?? {};
  return defaultCaps({
    network: c.network, mainnetEnabled: c.mainnetEnabled,
    perTradeUsd: c.perTradeUsd, dailyUsd: c.dailyUsd, maxPriceImpactPct: c.maxPriceImpactPct,
    maxSolOut: c.maxSolOut, maxSlippageBps: c.maxSlippageBps,
  });
}

/** The static policy verdict the executor recorded for the plan's transaction bytes (SPEC §6.2). */
export type TxPolicyVerdict =
  | { ok: true }
  | { ok: false; reason: CapRefusal; message: string };

/** The concrete, simulated plan a real trade would execute. Built by the executor, hashed, then checked. */
export interface TradePlan {
  network: TradeNetwork;
  mint: string;
  symbol: string;
  side: Side;
  /** Raw input amount (lamports for a buy, token base units for a sell). */
  amountInRaw: bigint;
  /** Raw output amount at the quoted route (token base units for a buy, lamports for a sell). */
  amountOutRaw: bigint;
  slippageBps: number;
  route: string[];
  priceImpactPct: number | null;
  /** USD value of the trade as the executor priced it LOCALLY; null when it could not. */
  notionalUsd: number | null;
  /** Did the executor run an on-chain simulateTransaction, and did it succeed? */
  simulated: boolean;
  simOk: boolean;
  simError: string | null;
  /**
   * Lamports that LEAVE the user's wallet per the simulation (pre − post balance). Negative when SOL
   * came in (a sell). null when the simulation could not report balances → refused.
   */
  solOutLamports: bigint | null;
  /** Planned SOL leg in lamports (the order amount for a buy; the SOL received for a sell). */
  solLegLamports: bigint;
  /** Static transaction policy (quote binding, program allow-list, forbidden instructions, signer). */
  txPolicy: TxPolicyVerdict;
}

export type CapRefusal =
  | 'mainnet-not-enabled'
  | 'network-mismatch'
  | 'not-simulated'
  | 'simulation-failed'
  | 'price-impact'
  | 'slippage'
  | 'no-usd-value'
  | 'per-trade-cap'
  | 'daily-cap'
  | 'plan-mismatch'
  | 'plan-expired'
  // DEFECT 2: the bytes about to be submitted are not the bytes that were simulated/approved.
  | 'tx-mismatch'
  // Round 2 (SPEC §6.2): the decoded transaction / quote failed static policy.
  | 'quote-mismatch'
  | 'program-not-allowed'
  | 'forbidden-instruction'
  // Round 3: the transaction does not have the shape of a Jupiter swap (no / several / non-route Jupiter ix).
  | 'not-a-swap'
  | 'signer-mismatch'
  | 'bad-signature'
  | 'sol-out-cap'
  | 'sol-delta-unknown'
  // task-1337: the simulation moved tokens OUT of one of the wallet's token accounts that the plan does
  // not spend (a hostile route with crafted accounts), or the token post-state could not be read.
  | 'token-delta'
  | 'token-delta-unknown'
  // task-1337 F2: pre-existing wrapped SOL left the wallet beyond what the plan's SOL leg accounts for
  // (a route draining a WSOL account the SOL-delta upper bound alone would not notice).
  | 'wsol-drain'
  | 'panicked';

export interface CapResult {
  ok: boolean;
  reason?: CapRefusal;
  message?: string;
}

const ok: CapResult = { ok: true };
function refuse(reason: CapRefusal, message: string): CapResult {
  return { ok: false, reason, message };
}

function lamportsToSolText(l: bigint): string { return (Number(l) / 1e9).toFixed(4); }

/**
 * The one decision point. Returns ALLOW or a typed REFUSAL. Pure: `spentTodayUsd` is supplied by the
 * caller (the ledger), so this is trivially testable and cannot be influenced by UI state.
 */
export interface CheckCapsOptions {
  /**
   * task-1363: enforce the USD per-trade / daily caps on DEVNET too. The fast-wallet (mandate) lane sets
   * this so a devnet fill exercises the real money path end to end — a fill with no trustworthy SOL/USD
   * price, or one above the per-trade or remaining daily budget, is refused exactly as on mainnet.
   */
  enforceUsd?: boolean;
}

export function checkCaps(plan: TradePlan, rawCaps: TradeCaps, spentTodayUsd: number, opts: CheckCapsOptions = {}): CapResult {
  const caps = effectiveCaps(rawCaps);

  // 1. Network gate — mainnet is the dangerous one.
  if (plan.network === 'mainnet') {
    if (!caps.mainnetEnabled || caps.network !== 'mainnet') {
      return refuse('mainnet-not-enabled', 'mainnet trading requires the --mainnet flag (and an explicit opt-in)');
    }
  } else if (plan.network !== caps.network) {
    return refuse('network-mismatch', `plan network ${plan.network} does not match configured ${caps.network}`);
  }

  // 2. Static transaction policy (SPEC §6.2): quote binding, program allow-list, forbidden
  //    instructions, signer. Checked BEFORE the simulation gate because a plan that failed policy was
  //    (deliberately) never simulated. A plan with no verdict at all is refused: only the executor's
  //    decoder produces one, so its absence means the bytes were never inspected.
  const pol = plan.txPolicy as TxPolicyVerdict | undefined;
  if (!pol || typeof pol !== 'object' || pol.ok !== true) {
    if (pol && pol.ok === false) return refuse(pol.reason, pol.message);
    return refuse('program-not-allowed', 'the transaction was not inspected');
  }

  // 3. Simulation must have run and passed (no confirm on a red sim).
  if (!plan.simulated) return refuse('not-simulated', 'the transaction was not simulated');
  if (!plan.simOk) return refuse('simulation-failed', `simulation failed: ${plan.simError ?? 'unknown error'}`);

  // 4. Price impact ceiling (any network). Unknown impact is refused on mainnet (re-verify LOW #10).
  if (plan.priceImpactPct === null || !Number.isFinite(plan.priceImpactPct)) {
    if (plan.network === 'mainnet') return refuse('price-impact', 'the quote carried no price impact; refusing on mainnet');
  } else if (plan.priceImpactPct > caps.maxPriceImpactPct) {
    return refuse('price-impact', `price impact ${plan.priceImpactPct.toFixed(2)}% exceeds the ${caps.maxPriceImpactPct}% ceiling`);
  }

  // 5. Slippage ceiling (any network).
  if (!Number.isFinite(plan.slippageBps) || plan.slippageBps < 0 || plan.slippageBps > caps.maxSlippageBps) {
    return refuse('slippage', `slippage ${plan.slippageBps} bps exceeds the ${caps.maxSlippageBps} bps ceiling`);
  }

  // 6. SOL out of the wallet, from the SIMULATED balance delta (any network): must be known, must not
  //    exceed the planned SOL leg plus the fee allowance, and must not exceed the absolute cap.
  if (typeof plan.solOutLamports !== 'bigint') {
    return refuse('sol-delta-unknown', 'the simulation did not report the wallet balance change');
  }
  if (typeof plan.solLegLamports !== 'bigint' || plan.solLegLamports < 0n) {
    return refuse('sol-out-cap', 'the plan carries no SOL leg');
  }
  if (plan.solOutLamports > plan.solLegLamports + SOL_OVERHEAD_ALLOWANCE_LAMPORTS) {
    return refuse('sol-out-cap', `the transaction moves ${lamportsToSolText(plan.solOutLamports)} SOL out but the plan is ${lamportsToSolText(plan.solLegLamports)} SOL`);
  }
  const maxOutLamports = BigInt(Math.round(caps.maxSolOut * 1e9));
  if (plan.solOutLamports > maxOutLamports) {
    return refuse('sol-out-cap', `${lamportsToSolText(plan.solOutLamports)} SOL out exceeds the ${caps.maxSolOut} SOL per-transaction cap`);
  }

  // 7. USD caps — enforced on mainnet (devnet funds have no value), and on devnet when the caller asks
  //    (task-1363 fast-wallet lane). Mainnet with no known USD value, or a zero/negative one, is refused
  //    rather than waved through (round 2: `<= 0`, was `< 0`).
  if (plan.network === 'mainnet' || opts.enforceUsd === true) {
    if (plan.notionalUsd === null || !Number.isFinite(plan.notionalUsd) || plan.notionalUsd <= 0) {
      return refuse('no-usd-value', `cannot price this trade in USD (or it prices at $0); refusing${plan.network === 'mainnet' ? ' on mainnet' : ' (USD caps are enforced on this lane)'}`);
    }
    if (plan.notionalUsd > caps.perTradeUsd) {
      return refuse('per-trade-cap', `trade $${plan.notionalUsd.toFixed(2)} exceeds the per-trade cap $${caps.perTradeUsd.toFixed(2)}`);
    }
    const spent = Number.isFinite(spentTodayUsd) && spentTodayUsd > 0 ? spentTodayUsd : 0;
    if (spent + plan.notionalUsd > caps.dailyUsd) {
      return refuse('daily-cap', `trade $${plan.notionalUsd.toFixed(2)} would exceed today's remaining budget ($${Math.max(0, caps.dailyUsd - spent).toFixed(2)} of $${caps.dailyUsd.toFixed(2)})`);
    }
  }

  return ok;
}

/**
 * A plan hash binds a confirm/signature to the exact plan the user saw (SPEC §6.5 plan-hash binding).
 * If any material field changes between display and submit, the hash changes and the confirm is void.
 * Amounts are included so an inflated size or a swapped mint invalidates the confirm.
 */
export function planHash(plan: TradePlan): string {
  const canonical = [
    plan.network, plan.mint, plan.side,
    plan.amountInRaw.toString(), plan.amountOutRaw.toString(),
    String(plan.slippageBps), plan.route.join('>'),
    typeof plan.solLegLamports === 'bigint' ? plan.solLegLamports.toString() : 'none',
    typeof plan.solOutLamports === 'bigint' ? plan.solOutLamports.toString() : 'none',
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/** True when two plans are the same trade (same hash). Used to refuse a mutated plan at submit time. */
export function samePlan(a: TradePlan, b: TradePlan): boolean {
  return planHash(a) === planHash(b);
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Where the CLI keeps the daily-cap ledger (shared by every trenchscope process on this machine). */
export function defaultCapLedgerPath(): string {
  return join(homedir(), '.dexterm', 'trade-caps.sqlite');
}

export interface Reservation { ok: true; day: string; usd: number }
export type ReserveResult = Reservation | { ok: false; reason: 'daily-cap' | 'panicked'; spent: number };

/**
 * Persistent daily-spend ledger for the USD daily cap. Backed by node:sqlite so the cap survives a
 * restart (a compromised UI cannot "forget" today's spend by relaunching). An in-memory DB is used
 * when no path is given (tests). Only realized mainnet USD is recorded.
 *
 * Round 2: `tryReserve` checks AND charges inside one `BEGIN IMMEDIATE` transaction, so two dexterm
 * PROCESSES sharing the file cannot both pass the daily check (re-verify MEDIUM #7); a `busy_timeout`
 * makes a concurrent open wait instead of throwing SQLITE_BUSY. `lock()` is the panic path: a locked
 * ledger reserves nothing until `unlock()`.
 */
export class CapLedger {
  readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(opts: { path?: string; clock?: Clock } = {}) {
    const path = opts.path ?? ':memory:';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.clock = opts.clock ?? systemClock;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trade_day_spend (
        day TEXT PRIMARY KEY,
        usd REAL NOT NULL DEFAULT 0,
        trades INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS trade_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        locked_at INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
    `);
  }

  /** USD already spent on mainnet today (UTC). */
  spentToday(now = this.clock.now()): number {
    const row = this.db.prepare('SELECT usd FROM trade_day_spend WHERE day = ?').get(utcDay(now)) as { usd?: number } | undefined;
    return row && Number.isFinite(row.usd) ? Number(row.usd) : 0;
  }

  /** Record a realized mainnet trade's USD against today's budget. Devnet trades record nothing. */
  record(usd: number, now = this.clock.now()): void {
    if (!(usd > 0)) return;
    const day = utcDay(now);
    this.db.prepare(`INSERT INTO trade_day_spend (day, usd, trades) VALUES (?, ?, 1)
                     ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd, trades = trades + 1`).run(day, usd);
  }

  /**
   * Atomically check `spent + usd <= dailyCap` and reserve `usd` for today. The SELECT and the INSERT
   * run inside BEGIN IMMEDIATE, which takes the write lock first, so concurrent processes serialize
   * here. Returns the reservation's DAY so a refund credits the same day even across midnight.
   */
  tryReserve(usd: number, dailyCap: number, now = this.clock.now()): ReserveResult {
    const day = utcDay(now);
    if (!(usd > 0)) return { ok: true, day, usd: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.lockedRow()) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'panicked', spent: this.spentToday(now) }; }
      const row = this.db.prepare('SELECT usd FROM trade_day_spend WHERE day = ?').get(day) as { usd?: number } | undefined;
      const spent = row && Number.isFinite(row.usd) && Number(row.usd) > 0 ? Number(row.usd) : 0;
      if (spent + usd > dailyCap) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'daily-cap', spent }; }
      this.db.prepare(`INSERT INTO trade_day_spend (day, usd, trades) VALUES (?, ?, 1)
                       ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd, trades = trades + 1`).run(day, usd);
      this.db.exec('COMMIT');
      return { ok: true, day, usd };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      throw e;
    }
  }

  /**
   * Undo a reservation (DEFECT 5): the executor charges a trade's USD BEFORE it signs/submits so a
   * burst of concurrent trades cannot each pass the daily check and collectively blow the cap. If the
   * send definitely never left (sign failed, tx-byte mismatch, a pre-broadcast JSON-RPC rejection) the
   * reservation is refunded here, to the DAY it was reserved on (re-verify LOW #9). A send that was
   * broadcast, or MAY have been (transport error), is NOT refunded — the funds may have moved.
   */
  refund(usd: number, dayOrNow: string | number = this.clock.now()): void {
    if (!(usd > 0)) return;
    const day = typeof dayOrNow === 'string' ? dayOrNow : utcDay(dayOrNow);
    // Floor at 0; one trade's refund can never drive the day negative.
    this.db.prepare(`UPDATE trade_day_spend SET usd = MAX(0, usd - ?), trades = MAX(0, trades - 1) WHERE day = ?`).run(usd, day);
  }

  private lockedRow(): { locked_at: number; reason: string } | null {
    const row = this.db.prepare('SELECT locked_at, reason FROM trade_lock WHERE id = 1').get() as { locked_at: number; reason: string } | undefined;
    return row ?? null;
  }

  /** The panic lock, if engaged. Re-read every call so a lock from another process is seen at once. */
  locked(): { lockedAt: number; reason: string } | null {
    const row = this.lockedRow();
    return row ? { lockedAt: Number(row.locked_at), reason: String(row.reason) } : null;
  }

  /** PANIC: refuse every reservation until unlock(). Idempotent. */
  lock(reason = 'panic', now = this.clock.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO trade_lock (id, locked_at, reason) VALUES (1, ?, ?)').run(now, reason.slice(0, 200));
  }

  unlock(): boolean {
    const r = this.db.prepare('DELETE FROM trade_lock WHERE id = 1').run();
    return Number(r.changes) > 0;
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
