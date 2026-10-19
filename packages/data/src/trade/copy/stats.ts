// task-1360 Tier 1 — PnL, win rate and early-entry score for a followed wallet (research/wallet-intel design
// §4.3), computed from decoded trades only. Every number is sample-bounded and says so: realised PnL is FIFO by
// token amount over the trades we have, in SOL (exact) with a USD view at the rate given; win rate is hidden under
// n < 10 closed positions; the early-entry score needs launch-window buyer ranks (a token's bubble-map scan) and is
// `—` with the reason otherwise. Airdrops / transfers-in are cost 0 and flagged; transfers-out remove tokens and
// their cost without touching realised PnL (a wallet move is not a loss). Nothing here is a recommendation.

import type { EarlyEntryInput, MintLot, MintPosition, WalletStats, WalletTrade } from './types.ts';

export const WIN_RATE_MIN_N = 10;

export interface StatsOptions {
  solUsd?: number | null;
  /** per-mint early-entry ranks when known (from a scanned launch window) */
  earlyEntry?: readonly EarlyEntryInput[];
  /** true when the whole history was fetched (no older page left) */
  complete?: boolean;
  /** how many raw txs the trades came from (for the sample caption) */
  txs?: number;
  /** when the history these trades came from was last fetched (ms) — the data age shown next to every number */
  asOf?: number | null;
}

function closedNow(p: { tokensRaw: bigint; peakRaw: bigint }): boolean {
  return p.peakRaw > 0n && p.tokensRaw * 100n <= p.peakRaw;
}

/** FIFO positions per mint over trades sorted oldest first. */
export function positionsOf(trades: readonly WalletTrade[]): MintPosition[] {
  const lots = new Map<string, MintLot[]>();
  const pos = new Map<string, MintPosition>();
  const sorted = [...trades].sort((a, b) => a.slot - b.slot || a.sig.localeCompare(b.sig));
  for (const tr of sorted) {
    const delta = BigInt(tr.tokenDelta);
    let p = pos.get(tr.mint);
    if (!p) { p = { mint: tr.mint, tokensRaw: 0n, peakRaw: 0n, costSol: 0, realisedSol: 0, buys: 0, sells: 0, transfers: 0, flagged: false, closed: false, firstT: tr.t, lastT: tr.t, firstKnown: tr.tKnown, lastKnown: tr.tKnown, holdMs: null }; pos.set(tr.mint, p); }
    const L = lots.get(tr.mint) ?? []; lots.set(tr.mint, L);
    p.lastT = tr.t; p.lastKnown = tr.tKnown;
    if (delta > 0n) {
      // a buy with a SOL leg carries cost; a token-swap leg or an airdrop is cost 0 and flagged
      const cost = tr.side === 'buy' && tr.solDelta !== null ? Math.abs(tr.solDelta) : 0;
      const flagged = cost === 0;
      L.push({ tokensRaw: delta, costSol: cost, flagged });
      p.tokensRaw += delta; p.costSol += cost; if (flagged) p.flagged = true;
      if (tr.side === 'buy') p.buys += 1; else p.transfers += 1;
      if (p.tokensRaw > p.peakRaw) p.peakRaw = p.tokensRaw;
    } else {
      let need = -delta;
      let costOut = 0;
      while (need > 0n && L.length) {
        const lot = L[0];
        if (lot.tokensRaw <= need) { need -= lot.tokensRaw; costOut += lot.costSol; L.shift(); }
        else { const frac = Number(need) / Number(lot.tokensRaw); const c = lot.costSol * frac; costOut += c; lot.costSol -= c; lot.tokensRaw -= need; need = 0n; }
      }
      const removed = -delta - need; // tokens we actually had lots for (history may start mid-position)
      p.tokensRaw -= removed; if (p.tokensRaw < 0n) p.tokensRaw = 0n;
      p.costSol = Math.max(0, p.costSol - costOut);
      if (tr.side === 'sell' && tr.solDelta !== null) { p.realisedSol += tr.solDelta - costOut; p.sells += 1; }
      else if (tr.side === 'sell') { p.sells += 1; p.flagged = true; } // token-swap leg: proceeds unknown, cost released
      else p.transfers += 1; // transfer-out: cost released, no PnL
    }
    p.closed = closedNow(p);
  }
  // hold time = first buy → last sell, only trustworthy for a CLOSED position whose first+last block times are both real
  for (const p of pos.values()) p.holdMs = p.closed && p.firstKnown && p.lastKnown && p.lastT > p.firstT ? p.lastT - p.firstT : null;
  return [...pos.values()].sort((a, b) => b.lastT - a.lastT);
}

/** Compact human hold time: 45s · 12m · 3.2h · 2.1d. null → '—'. */
export function fmtHoldMs(ms: number | null): string {
  if (ms === null) return '—';
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Median over the numbers (already finite); undefined on an empty list. */
function median(xs: readonly number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Early-entry score = median over tokens of (1 − rank / buyers); null without ranks (design §4.3). */
export function earlyEntryScore(inputs: readonly EarlyEntryInput[]): { score: number | null; n: number; note: string } {
  const xs = inputs.filter((e) => e.buyers > 0 && e.rank >= 0 && e.rank < e.buyers).map((e) => 1 - e.rank / e.buyers).sort((a, b) => a - b);
  if (!xs.length) return { score: null, n: 0, note: 'needs launch-window buyer ranks (scan the token: M) · no 3× filter yet' };
  const mid = Math.floor(xs.length / 2);
  const score = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return { score: Math.round(score * 1000) / 1000, n: xs.length, note: `median over ${xs.length} scanned launch window${xs.length === 1 ? '' : 's'} · no 3× filter yet` };
}

export function walletStats(wallet: string, trades: readonly WalletTrade[], opts: StatsOptions = {}): WalletStats {
  const positions = positionsOf(trades);
  const closed = positions.filter((p) => p.closed);
  const wins = closed.filter((p) => p.realisedSol > 0).length;
  const realisedSol = positions.reduce((s, p) => s + p.realisedSol, 0);
  const solUsd = typeof opts.solUsd === 'number' && opts.solUsd > 0 ? opts.solUsd : null;
  const ts = trades.map((t) => t.t).filter((t) => t > 0);
  const winRate = closed.length >= WIN_RATE_MIN_N ? wins / closed.length : null;
  const txs = opts.txs ?? new Set(trades.map((t) => t.sig)).size;
  const holds = closed.map((p) => p.holdMs).filter((m): m is number => m !== null);
  const holdMedianMs = median(holds) ?? null;
  const holdNote = holdMedianMs === null
    ? (closed.length ? `no closed position with both block times known (${closed.length} closed)` : 'no closed positions yet')
    : `median first-buy→last-sell over ${holds.length} closed position${holds.length === 1 ? '' : 's'} with known times`;
  return {
    wallet,
    trades: trades.length,
    buys: trades.filter((t) => t.side === 'buy').length,
    sells: trades.filter((t) => t.side === 'sell').length,
    transfers: trades.filter((t) => t.side === 'transfer').length,
    mints: positions.length,
    realisedSol: Math.round(realisedSol * 1e6) / 1e6,
    realisedUsd: solUsd === null ? null : Math.round(realisedSol * solUsd * 100) / 100,
    solUsdAt: solUsd,
    closed: closed.length,
    wins,
    winRate: winRate === null ? null : Math.round(winRate * 1000) / 1000,
    winRateNote: closed.length >= WIN_RATE_MIN_N ? `${wins}/${closed.length} closed` : `hidden under n=${WIN_RATE_MIN_N} (${wins}/${closed.length} closed so far)`,
    open: positions.length - closed.length,
    earlyEntry: earlyEntryScore(opts.earlyEntry ?? []),
    holdMedianMs,
    holdNote,
    positions,
    firstT: ts.length ? Math.min(...ts) : null,
    lastT: ts.length ? Math.max(...ts) : null,
    sample: { txs, complete: !!opts.complete, note: opts.complete ? `all ${txs} txs` : `last ${txs} txs only · older history not fetched`, source: 'helius-history', asOf: opts.asOf ?? null },
  };
}
