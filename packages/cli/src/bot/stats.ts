// trenchscope paper bot: the scoreboard (`trenchscope bot stats`). Pure over the ledger's positions.
//
// Honesty rules: every figure is labelled PAPER (priced from live quotes, not financial advice), the sample size
// is always printed, and under MEANINGFUL_MIN closed trades the result is called not yet meaningful. PnL is the
// net SOL result (sell proceeds after simulated fees minus the SOL spent including fees), converted to USD at the
// SOL/USD rate of the entry, so SOL's own price move over the hold is not counted as trading PnL.
import type { BotPosition } from './store.ts';
import { EXIT_REASONS, type Book, type ExitReason } from './strategy.ts';

export const STATS_LABEL = 'paper, priced from live quotes, not financial advice';
/** Below this many closed strategy trades the scoreboard says the result is not yet meaningful. */
export const MEANINGFUL_MIN = 20;

export interface TradeRef { id: number; symbol: string; mint: string; pnlPct: number; pnlUsd: number; reason: ExitReason | null }
export interface ReasonStats { n: number; pnlUsd: number; avgPct: number }

export interface BookStats {
  book: Book;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  /** wins / closed, 0..1; null with no closed trades. */
  winRate: number | null;
  totalPnlUsd: number;
  avgPnlUsd: number | null;
  avgPnlPct: number | null;
  best: TradeRef | null;
  worst: TradeRef | null;
  avgHoldMin: number | null;
  byReason: Partial<Record<ExitReason, ReasonStats>>;
  /** Mark-to-quote PnL of open positions that have a mark, USD; null when none is marked. */
  openUnrealizedUsd: number | null;
  openMarked: number;
}

export interface BotStats {
  label: string;
  since: number | null;
  now: number;
  strategy: BookStats;
  baseline: BookStats;
  /** strategy closed trades >= MEANINGFUL_MIN */
  meaningful: boolean;
  sample: string;
  comparison: string;
}

const ref = (p: BotPosition): TradeRef => ({ id: p.id, symbol: p.symbol, mint: p.mint, pnlPct: p.pnlPct ?? 0, pnlUsd: p.pnlUsd ?? 0, reason: p.exitReason });

export function bookStats(all: BotPosition[], book: Book, since: number | null): BookStats {
  const mine = all.filter((p) => p.book === book);
  const closed = mine.filter((p) => p.status === 'closed' && p.closedAt !== null && (since === null || p.closedAt >= since));
  const open = mine.filter((p) => p.status === 'open');
  const wins = closed.filter((p) => (p.pnlLamports ?? 0n) > 0n).length;
  const totalPnlUsd = closed.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const sumPct = closed.reduce((s, p) => s + (p.pnlPct ?? 0), 0);
  const holdMin = closed.reduce((s, p) => s + ((p.closedAt as number) - p.openedAt) / 60_000, 0);
  let best: BotPosition | null = null, worst: BotPosition | null = null;
  for (const p of closed) {
    if (!best || (p.pnlPct ?? 0) > (best.pnlPct ?? 0)) best = p;
    if (!worst || (p.pnlPct ?? 0) < (worst.pnlPct ?? 0)) worst = p;
  }
  const byReason: Partial<Record<ExitReason, ReasonStats>> = {};
  for (const reason of EXIT_REASONS) {
    const xs = closed.filter((p) => p.exitReason === reason);
    if (!xs.length) continue;
    byReason[reason] = { n: xs.length, pnlUsd: xs.reduce((s, p) => s + (p.pnlUsd ?? 0), 0), avgPct: xs.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / xs.length };
  }
  const marked = open.filter((p) => p.markLamports !== null);
  const openUnrealizedUsd = marked.length
    ? marked.reduce((s, p) => s + (Number((p.markLamports as bigint) - p.costLamports) / 1e9) * p.solUsdEntry, 0)
    : null;
  return {
    book, closed: closed.length, open: open.length, wins, losses: closed.length - wins,
    winRate: closed.length ? wins / closed.length : null,
    totalPnlUsd, avgPnlUsd: closed.length ? totalPnlUsd / closed.length : null, avgPnlPct: closed.length ? sumPct / closed.length : null,
    best: best ? ref(best) : null, worst: worst ? ref(worst) : null,
    avgHoldMin: closed.length ? holdMin / closed.length : null,
    byReason, openUnrealizedUsd, openMarked: marked.length,
  };
}

const usd = (n: number): string => `${n < 0 ? '-' : n > 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number): string => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
const rate = (r: number | null): string => (r === null ? 'n/a' : `${(r * 100).toFixed(0)}%`);
function hold(min: number | null): string {
  if (min === null) return 'n/a';
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export function computeStats(positions: BotPosition[], opts: { since: number | null; now: number }): BotStats {
  const strategy = bookStats(positions, 'strategy', opts.since);
  const baseline = bookStats(positions, 'baseline', opts.since);
  const meaningful = strategy.closed >= MEANINGFUL_MIN;
  const sample = `sample: ${strategy.closed} closed strategy trade(s), ${baseline.closed} closed baseline trade(s)${meaningful ? '' : `; fewer than ${MEANINGFUL_MIN} closed trades, so this is NOT yet meaningful`}`;
  let comparison: string;
  if (!strategy.closed || !baseline.closed) {
    comparison = `vs baseline (market filters only, safety verdict ignored): not comparable yet (${strategy.closed} vs ${baseline.closed} closed)`;
  } else {
    const d = (strategy.avgPnlPct as number) - (baseline.avgPnlPct as number);
    comparison = `vs baseline (market filters only, safety verdict ignored): ${baseline.closed} trades, win ${rate(baseline.winRate)}, total ${usd(baseline.totalPnlUsd)}, avg ${pct(baseline.avgPnlPct as number)}; strategy minus baseline avg ${d >= 0 ? '+' : ''}${d.toFixed(1)} pp`;
  }
  return { label: STATS_LABEL, since: opts.since, now: opts.now, strategy, baseline, meaningful, sample, comparison };
}

function bookLines(s: BookStats): string[] {
  const out = [
    `  trades     ${s.closed} closed, ${s.open} open${s.openUnrealizedUsd !== null ? ` (open marked ${usd(s.openUnrealizedUsd)} on ${s.openMarked})` : ''}`,
    `  win rate   ${rate(s.winRate)}${s.closed ? ` (${s.wins} won, ${s.losses} lost)` : ''}`,
    `  PnL        total ${usd(s.totalPnlUsd)}${s.avgPnlUsd !== null ? `, avg ${usd(s.avgPnlUsd)} / ${pct(s.avgPnlPct as number)} per trade` : ''}`,
    `  best       ${s.best ? `${s.best.symbol} ${pct(s.best.pnlPct)} (${usd(s.best.pnlUsd)}, ${s.best.reason})` : 'n/a'}`,
    `  worst      ${s.worst ? `${s.worst.symbol} ${pct(s.worst.pnlPct)} (${usd(s.worst.pnlUsd)}, ${s.worst.reason})` : 'n/a'}`,
    `  avg hold   ${hold(s.avgHoldMin)}`,
  ];
  const reasons = Object.entries(s.byReason) as Array<[ExitReason, ReasonStats]>;
  if (reasons.length) {
    out.push('  by exit reason');
    for (const [r, x] of reasons) out.push(`    ${r.padEnd(17)} ${String(x.n).padStart(3)}  ${usd(x.pnlUsd).padStart(10)}  avg ${pct(x.avgPct)}`);
  }
  return out;
}

export function renderStats(s: BotStats): string {
  const window = s.since === null ? 'all time' : `since ${new Date(s.since).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return [
    `trenchscope paper bot: ${window}`,
    `(${s.label})`,
    s.sample,
    '',
    'strategy (market filters + safety checks)',
    ...bookLines(s.strategy),
    '',
    'baseline (market filters only)',
    ...bookLines(s.baseline),
    '',
    s.comparison,
  ].join('\n') + '\n';
}

/** `24h` / `7d` / `90m` / `all` → a since timestamp (null = all time). */
export function parseSince(v: string, now: number): number | null | { error: string } {
  if (v === 'all') return null;
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(v);
  if (!m) return { error: `--since needs a window like 90m, 24h, 7d or all (got "${v}")` };
  const ms = Number(m[1]) * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
  return now - ms;
}

/** Plain-JSON form for `--json` (bigints as strings). */
export function statsJson(s: BotStats): Record<string, unknown> {
  return { paper: true, ...s };
}
