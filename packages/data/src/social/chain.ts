// @dexterm/data — on-chain "social" rows (task-1330; design §4 table row "on-chain social", §5.2).
// The truth layer that confirms or contradicts attention, rendered as posts with `platform: 'chain'`.
// Rows are RULE-DERIVED from data the app already has (labelled top holders, the trade tape); the text is
// ours (templates + numbers), the only untrusted parts are label words and short addresses, and even those
// go through the ingest firewall like every other post. task-1359: the wallet-intel scan (task-1340) feeds its
// linked clusters (R1 funder / R2 bundle / R3 transfer / R4 dev-linked) and the launch-window snipers through the
// same ChainSignal shape (chainSignalsFromIntel).

import type { RawPost } from './model.ts';

export type ChainSignalKind = 'kol-buy' | 'labelled-holder' | 'large-trade' | 'dev-move' | 'cluster' | 'snipers';

export interface ChainSignal {
  mint: string;
  kind: ChainSignalKind;
  wallet: string;
  /** Holder/wallet label (`dev`, `sniper`, `smart`, `kol`, `LP`, …) or null. */
  label: string | null;
  side: 'buy' | 'sell' | null;
  usd: number | null;
  pct: number | null;
  t: number;
  source: string;
  /** task-1359: wallets behind a cluster / sniper signal. */
  count?: number;
}

export const LARGE_TRADE_USD = 5_000;
export const CHAIN_ROWS_MAX = 12;

const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);

/** Template the row text from OUR words; numbers formatted here, never free text from a source. */
export function chainSignalText(s: ChainSignal): string {
  const who = s.label ? `${s.label} wallet ${short(s.wallet)}` : `wallet ${short(s.wallet)}`;
  switch (s.kind) {
    case 'kol-buy': return `${who} bought${s.usd !== null ? ` ${usd(s.usd)}` : ''} (tracked wallet, on-chain)`;
    case 'labelled-holder': return `${who} holds ${s.pct !== null ? `${s.pct.toFixed(2)}%` : 'a top-20 slot'} of supply`;
    case 'large-trade': return `${who} ${s.side === 'sell' ? 'sold' : 'bought'} ${s.usd !== null ? usd(s.usd) : ''} in one trade`.replace(/\s+/g, ' ').trim();
    case 'dev-move': return `${who} moved ${s.pct !== null ? `${s.pct.toFixed(1)}%` : 'tokens'}${s.side === 'sell' ? ' out (sell)' : ''}`;
    case 'cluster': {
      // label = the cluster kind the wallet-intel rules assigned (rules.ts R1–R4); text says which rule linked them
      const share = s.pct !== null ? `${s.pct.toFixed(1)}% of supply` : 'a share of supply';
      const n = s.count !== undefined ? `${s.count} wallets` : 'linked wallets';
      const why = s.label === 'bundle' ? 'bought in the same slot and share a funder (bundle, R2)'
        : s.label === 'dev-linked' ? 'were funded by the creator wallet (dev-linked, R4)'
        : s.label === 'transfer' ? 'are linked by direct token transfers at launch (R3)'
        : 'share one funding wallet (R1)';
      return `${share} sits in ${n} that ${why}`;
    }
    case 'snipers': return `${s.count ?? 0} sniper wallet${s.count === 1 ? '' : 's'} took ${s.pct !== null ? `${s.pct.toFixed(1)}%` : 'part'} of the launch window (first 3 slots)`;
  }
}

export function chainSignalToRaw(s: ChainSignal, fetchedAt: number): RawPost {
  const tier = s.label === 'kol' || s.label === 'smart' ? 'kol-b' : 'none';
  return {
    id: `chain:${s.mint.slice(0, 8)}:${s.kind}:${s.wallet.slice(0, 8)}:${Math.floor(s.t / 1000)}`,
    t: s.t,
    platform: 'chain',
    author: { id: s.wallet, handle: short(s.wallet), tier, createdAt: null },
    text: chainSignalText(s),
    url: null,
    lang: null,
    metrics: {},
    mints: [s.mint],
    source: 'solana-rpc',
    fetchedAt,
  };
}

export interface TokenChainInput {
  mint: string;
  holders: readonly { address: string; pct: number; label: string | null }[];
  trades: readonly { t: number; side: 'buy' | 'sell'; usd: number; wallet: string }[];
  /** Wallets the user tracks as KOL wallets (from KOL packs / own labels), lower-cased. */
  kolWallets?: ReadonlySet<string>;
  now: number;
  largeTradeUsd?: number;
  max?: number;
}

/**
 * Rule-derived signals from the open token's panels: labelled top holders (dev / sniper / smart; LP
 * and CEX skipped — they are plumbing, not people), tracked-wallet buys, and large single trades.
 */
export function chainSignalsFromToken(input: TokenChainInput): ChainSignal[] {
  const out: ChainSignal[] = [];
  const large = input.largeTradeUsd ?? LARGE_TRADE_USD;
  for (const h of input.holders) {
    if (!h.label || h.label === 'LP' || h.label === 'cex' || h.label === 'bridge') continue;
    out.push({ mint: input.mint, kind: 'labelled-holder', wallet: h.address, label: h.label, side: null, usd: null, pct: h.pct, t: input.now, source: 'holders' });
  }
  for (const tr of input.trades) {
    const kol = input.kolWallets?.has(tr.wallet.toLowerCase()) ?? false;
    if (kol && tr.side === 'buy') out.push({ mint: input.mint, kind: 'kol-buy', wallet: tr.wallet, label: 'kol', side: 'buy', usd: tr.usd, pct: null, t: tr.t, source: 'tape' });
    else if (tr.usd >= large) out.push({ mint: input.mint, kind: 'large-trade', wallet: tr.wallet, label: null, side: tr.side, usd: tr.usd, pct: null, t: tr.t, source: 'tape' });
  }
  out.sort((a, b) => b.t - a.t || (b.usd ?? 0) - (a.usd ?? 0));
  return out.slice(0, input.max ?? CHAIN_ROWS_MAX);
}

// ---------------------------------------------------------------------------------------------- wallet intel (task-1359)
export interface IntelChainInput {
  mint: string;
  /** IntelAnalysis.clusters (C1 = largest share); `single` and one-member clusters are skipped. */
  clusters: readonly { name: string; kind: string; members: readonly string[]; pct: number }[];
  /** Launch-window snipers when the scan read the launch window (coverage.launchTxs > 0), else null. */
  snipers: { count: number; launchWindowSharePct: number } | null;
  /** The scan's fetch time: one stable id per scan, so re-reading a cached scan never duplicates a row. */
  t: number;
  max?: number;
}

/** Rule-derived rows from a wallet-intel scan: linked clusters (largest first) and the launch-window snipers. */
export function chainSignalsFromIntel(input: IntelChainInput): ChainSignal[] {
  const out: ChainSignal[] = [];
  for (const c of input.clusters) {
    if (c.kind === 'single' || c.members.length < 2 || !c.members[0]) continue;
    out.push({ mint: input.mint, kind: 'cluster', wallet: c.members[0], label: c.kind, side: null, usd: null, pct: c.pct, t: input.t, source: 'wallet-intel', count: c.members.length });
  }
  out.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  if (input.snipers && input.snipers.count > 0) out.unshift({ mint: input.mint, kind: 'snipers', wallet: 'snipers', label: null, side: null, usd: null, pct: input.snipers.launchWindowSharePct, t: input.t, source: 'wallet-intel', count: input.snipers.count });
  return out.slice(0, input.max ?? 6);
}
