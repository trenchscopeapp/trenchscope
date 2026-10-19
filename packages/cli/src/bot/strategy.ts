// trenchscope paper bot: the entry filter and the exit rules. Pure functions over a ScreenerRow, so every
// decision can be replayed from the row snapshot the journal stores with it.
//
// Two books run side by side on the same feed, the same caps and the same exit rules:
//   strategy  enters a coin only when the MARKET filters and the SAFETY checks both pass;
//   baseline  enters every coin that passes the MARKET filters alone (the safety verdict is ignored).
// Comparing the two is how `bot stats` shows whether the safety checks add value.
import type { ScreenerRow } from '../screener/rows.ts';
import { rugP } from '../screener/rug.ts';
import { verdictFor, type VerdictWord } from '../screener/verdict.ts';
import type { BotConfig, BotEntryRules } from './config.ts';

export type Book = 'strategy' | 'baseline';
export const BOOKS: readonly Book[] = ['strategy', 'baseline'];

export type ExitReason =
  | 'take-profit' | 'stop-loss' | 'time-stop'
  | 'verdict-avoid' | 'dead' | 'mint-authority' | 'freeze-authority'
  | 'no-route';
export const EXIT_REASONS: readonly ExitReason[] = ['take-profit', 'stop-loss', 'time-stop', 'verdict-avoid', 'dead', 'mint-authority', 'freeze-authority', 'no-route'];

export interface Check { ok: boolean; fails: string[] }

export interface EntryEval {
  book: Book;
  ok: boolean;
  market: Check;
  /** Null for the baseline book (it never looks at safety). */
  safety: (Check & { verdict: VerdictWord; rugP: number | null; reasons: string[] }) | null;
}

const fmt = (n: number): string => (Math.abs(n) >= 1000 ? `${Math.round(n).toLocaleString('en-US')}` : `${Math.round(n * 100) / 100}`);

/** Market filters: the coin is liquid, sized and established enough, and has not already run. */
export function marketCheck(r: ScreenerRow, e: BotEntryRules): Check {
  const fails: string[] = [];
  if (r.skeleton || !r.mint) return { ok: false, fails: ['placeholder row'] };
  if (r.stale) fails.push('row data is stale (cached, not refreshed this tick)');
  if (r.price === null || !(r.price > 0)) fails.push('no price');
  if (r.mcap === null) fails.push('mcap unknown');
  else if (r.mcap < e.minMcapUsd) fails.push(`mcap $${fmt(r.mcap)} < $${fmt(e.minMcapUsd)}`);
  else if (r.mcap > e.maxMcapUsd) fails.push(`mcap $${fmt(r.mcap)} > $${fmt(e.maxMcapUsd)}`);
  if (r.mcapFlagged) fails.push('sources disagree on mcap by more than 5x');
  if (r.liq === null) fails.push('liquidity unknown');
  else if (r.liq < e.minLiqUsd) fails.push(`liquidity $${fmt(r.liq)} < $${fmt(e.minLiqUsd)}`);
  if (r.ageMin === null) fails.push('age unknown');
  else if (r.ageMin < e.minAgeMin) fails.push(`age ${fmt(r.ageMin)} min < ${fmt(e.minAgeMin)} min`);
  const h1 = r.chg.h1;
  if (h1 === null) fails.push('1h change unknown');
  else if (h1 < e.minChg1hPct) fails.push(`1h ${fmt(h1)}% < ${fmt(e.minChg1hPct)}%`);
  else if (h1 > e.maxChg1hPct) fails.push(`1h ${fmt(h1)}% > ${fmt(e.maxChg1hPct)}%`);
  return { ok: fails.length === 0, fails };
}

const VERDICT_RANK: Record<VerdictWord, number> = { 'NO RED FLAGS': 0, CAREFUL: 1, AVOID: 2 };

/**
 * Safety checks: the screener's verdict at or better than the gate, the H2 risk score known and under the
 * cap, mint AND freeze authority known to be revoked, and the top-10 share known and under the cap.
 * An unknown check is a fail, never a pass.
 */
export function safetyCheck(r: ScreenerRow, e: BotEntryRules, larp: string | null = null): NonNullable<EntryEval['safety']> {
  const v = verdictFor(r, larp);
  const p = rugP(r);
  const fails: string[] = [];
  if (VERDICT_RANK[v.word] > VERDICT_RANK[e.verdict]) fails.push(`verdict ${v.word} (gate ${e.verdict})`);
  if (p === null) fails.push('risk score unavailable');
  else if (p >= e.maxRugP) fails.push(`p(rug) ${p.toFixed(2)} >= ${e.maxRugP}`);
  if (r.mintAuth !== false) fails.push(r.mintAuth === true ? 'mint authority live' : 'mint authority unknown');
  if (r.freezeAuth !== false) fails.push(r.freezeAuth === true ? 'freeze authority live' : 'freeze authority unknown');
  if (r.top10 === null) fails.push('top-10 share unknown');
  else if (r.top10 >= e.maxTop10Pct) fails.push(`top-10 ${fmt(r.top10)}% >= ${fmt(e.maxTop10Pct)}%`);
  return { ok: fails.length === 0, fails, verdict: v.word, rugP: p, reasons: v.reasons.map((x) => `${x.mark} ${x.text}`) };
}

/** Would `book` enter this row? (Caps, open positions and cooldowns are the engine's job.) */
export function evaluateEntry(book: Book, r: ScreenerRow, cfg: BotConfig, larp: string | null = null): EntryEval {
  const market = marketCheck(r, cfg.entry);
  const safety = book === 'strategy' ? safetyCheck(r, cfg.entry, larp) : null;
  return { book, ok: market.ok && (safety ? safety.ok : true), market, safety };
}

export interface OpenPositionView {
  openedAt: number;
  /** SOL spent including simulated fees, lamports. */
  costLamports: bigint;
}

export interface ExitEval {
  reason: ExitReason;
  detail: string;
}

/**
 * The exit rule for one open position at `now`. `markLamports` is the NET proceeds a full sell would book right
 * now (a real Jupiter sell quote minus simulated fees), or null when no quote came back this tick. `row` is the
 * coin's current screener row, or null when it fell out of the feed (then only TP / SL / time apply).
 * Order: the hard safety exits first (authority appears, collapsed, verdict AVOID), then stop loss, take
 * profit, time stop. Every book uses the same rules.
 */
export function evaluateExit(pos: OpenPositionView, markLamports: bigint | null, row: ScreenerRow | null, now: number, cfg: BotConfig, larp: string | null = null): ExitEval | null {
  if (row && !row.skeleton) {
    if (row.mintAuth === true) return { reason: 'mint-authority', detail: 'mint authority appeared' };
    if (row.freezeAuth === true) return { reason: 'freeze-authority', detail: 'freeze authority appeared' };
    if (row.flags.includes('DEAD')) return { reason: 'dead', detail: 'collapsed (DEAD flag)' };
    const v = verdictFor(row, larp);
    if (v.word === 'AVOID') return { reason: 'verdict-avoid', detail: `verdict turned AVOID${v.p !== null ? ` (p ${v.p.toFixed(2)})` : ''}` };
  }
  if (markLamports !== null && pos.costLamports > 0n) {
    const pct = pnlPct(pos.costLamports, markLamports);
    if (pct <= -cfg.stopLossPct) return { reason: 'stop-loss', detail: `net quote ${pct.toFixed(1)}% <= -${cfg.stopLossPct}%` };
    if (pct >= cfg.takeProfitPct) return { reason: 'take-profit', detail: `net quote +${pct.toFixed(1)}% >= +${cfg.takeProfitPct}%` };
  }
  const heldMin = (now - pos.openedAt) / 60_000;
  if (heldMin >= cfg.timeStopMin) return { reason: 'time-stop', detail: `held ${Math.round(heldMin)} min >= ${cfg.timeStopMin} min` };
  return null;
}

/** PnL percent of net proceeds over cost (both lamports). */
export function pnlPct(costLamports: bigint, proceedsLamports: bigint): number {
  if (costLamports <= 0n) return 0;
  return (Number(proceedsLamports - costLamports) / Number(costLamports)) * 100;
}
