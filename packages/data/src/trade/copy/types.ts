// task-1360 — COPY TRADING (staged) shared types. Personal tool for the user's OWN wallet only: no custody, no
// third parties, no fees, no hosted/pooled copy, no curated leader lists (product decision 2026-10-06; ROADMAP legal
// flags; research/wallet-intel design §6). Stage 1 = follow a wallet + alerts, stage 2 = one-key mirror PROPOSAL,
// stage 3 = capped auto-mirror inside an armed copy mandate. Nothing in this module signs, holds a key, or reaches
// mainnet: it decodes public history, keeps local notes, and hands PROPOSALS to the plan engine.

/** What a followed wallet did in one transaction, as far as its own balances show it. */
export type TradeSide = 'buy' | 'sell' | 'transfer';

export interface WalletTrade {
  /** the followed wallet (owner address) */
  wallet: string;
  sig: string;
  slot: number;
  /** block time in ms (fetchedAt when the node gave none; `tKnown` says which) */
  t: number;
  tKnown: boolean;
  mint: string;
  side: TradeSide;
  /** raw token delta for the wallet (base units) as a decimal string; positive = received */
  tokenDelta: string;
  /** net lamports delta for the wallet in this tx (fees and tips included); 0 when it could not be read */
  lamportsDelta: number;
  /** SOL leg attributable to this mint: null on a multi-mint (token→token) tx, where the SOL cannot be split */
  solDelta: number | null;
  /** |solDelta| × solUsd at decode time; null without a SOL price or SOL leg */
  usd: number | null;
  /** the SOL/USD price used for `usd` (audit) */
  solUsdAt: number | null;
  /**
   * 'token-swap' = two mints moved in one tx (both legs listed, neither priced); 'airdrop' = tokens in, no SOL out;
   * 'lp-like' = tokens and SOL moved the SAME way (both in = LP removal / payout, both out = LP add): never a swap
   */
  note: 'token-swap' | 'airdrop' | 'lp-like' | null;
}

export interface FollowRecord {
  addr: string;
  /** user-typed label (firewalled, ≤ 24 chars) or null; NEVER inferred, never exported */
  name: string | null;
  since: number;
  tier: 'poll';
}

export interface CopyAlert {
  id: string;
  /** when the tracker saw it (ms) */
  t: number;
  wallet: string;
  name: string | null;
  trade: WalletTrade;
  /** how long after the block the tracker noticed it (null when the block time is unknown) */
  lagMs: number | null;
}

export interface MintLot { tokensRaw: bigint; costSol: number; flagged: boolean }

export interface MintPosition {
  mint: string;
  /** tokens held now (raw) */
  tokensRaw: bigint;
  /** largest holding ever seen (raw) — closed = holding ≤ 1 % of it */
  peakRaw: bigint;
  /** open cost basis (SOL) */
  costSol: number;
  realisedSol: number;
  buys: number;
  sells: number;
  transfers: number;
  /** any lot with cost 0 (airdrop / transfer-in) */
  flagged: boolean;
  closed: boolean;
  firstT: number;
  lastT: number;
  /** the first/last trade in this position carried a real block time (not a fetchedAt fallback) */
  firstKnown: boolean;
  lastKnown: boolean;
  /** hold time (ms) first buy → last sell — only for a CLOSED position whose first+last block times are both known; null otherwise */
  holdMs: number | null;
}

export interface EarlyEntryInput {
  mint: string;
  /** 0-based rank of this wallet's first buy among the token's distinct early buyers */
  rank: number;
  buyers: number;
}

export interface WalletStats {
  wallet: string;
  trades: number;
  buys: number;
  sells: number;
  transfers: number;
  mints: number;
  realisedSol: number;
  /** realised at the given SOL/USD (null without one); `solUsdAt` says the rate */
  realisedUsd: number | null;
  solUsdAt: number | null;
  closed: number;
  wins: number;
  /** wins / closed, null under n < 10 (design §4.3) */
  winRate: number | null;
  winRateNote: string;
  open: number;
  earlyEntry: { score: number | null; n: number; note: string };
  /** median hold time (ms) over closed positions with known block times; null without any; `holdNote` carries the n */
  holdMedianMs: number | null;
  holdNote: string;
  positions: MintPosition[];
  firstT: number | null;
  lastT: number | null;
  /** how much history the numbers rest on; every figure is sample-bounded. `source` + `asOf` (last fetch ms) give provenance + data age */
  sample: { txs: number; complete: boolean; note: string; source: 'helius-history'; asOf: number | null };
}
