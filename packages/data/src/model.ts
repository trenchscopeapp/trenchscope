// @dexterm/data — normalized model shared by the TUI, the data layer and the MCP server.
// Source of truth: SPEC.md §3.3 "Normalized model". Agreed on day 1 between lane A (tui)
// and lane B (data). Changes to this file need a note in the handoff of whoever changes it.
//
// Conventions
// - All timestamps are epoch milliseconds (number). `null` means "source did not say".
// - Money is USD as a plain number; prices keep full precision (the UI compresses zeros).
// - Every record carries `source` and `fetchedAt` (Provenance) so the UI and the AI can say
//   where a number came from and how old it is.
// - Plain interfaces and type aliases only (no enums/classes) so Node can run the sources
//   with type stripping and the JSON shapes stay serialisable for the MCP tools.

/** Identifiers of the data sources in SPEC §3.1 (S1..S12) plus the offline fixture source. */
export type SourceId =
  | 'dexscreener'      // S1
  | 'jupiter-tokens'   // S2
  | 'jupiter-price'    // S3
  | 'geckoterminal'    // S4
  | 'rugcheck'         // S5
  | 'solana-rpc'       // S6
  | 'pumpportal'       // S7
  | 'pumpfun'          // S8 (undocumented frontend API, feature-flagged)
  | 'helius'           // S9 (Tier 1, user key)
  | 'birdeye'          // S10 (Tier 1, user key)
  | 'jupiter-swap'     // S11 (v2 only)
  | 'fxtwitter'        // S12
  | 'x-api'            // S13: X v2 in USER context only (task-1357 Login with X; the user's own app + limits)
  | 'telegram'         // S12
  | 'goplus'           // GoPlus Solana token security (keyless; inventory 2026-10-06 §1d)
  | 'solanatracker'    // Solana Tracker data API (user key in ~/.dexterm/solanatracker.key): dev/sniper/insider/bundler risk
  | 'shrine'           // Shrine 1 s candles over socket.io (user key in ~/.dexterm/shrine.key); chart only
  | 'solana-ws'        // public RPC WebSocket (accountSubscribe); fast-lane price push, keyless (SPEC §3.9)
  | 'helius-ws'        // Helius WebSocket (accountSubscribe); fast-lane price push, user key (SPEC §3.9)
  | 'onchain-curve'    // price computed on-chain from a pump.fun bonding-curve account (SPEC §3.9)
  | 'onchain-pool'     // price computed on-chain from an AMM pool's base/quote vaults (SPEC §3.9)
  | 'coingecko'        // CoinGecko search/trending, keyless 10/min (INTEGRATIONS-DESIGN §4; task-1330 I-03)
  | 'news-rss'         // publishers' own RSS feeds (CoinDesk, Cointelegraph, The Block, Decrypt); context, never signal
  | 'fixture';         // offline fixtures / recorded replays

/** Launchpads with a dedicated semantic color (SPEC §7.1). `unknown` renders muted. */
export type Launchpad = 'pump.fun' | 'dbc' | 'raydium' | 'meteora' | 'bonk' | 'unknown';

/** Time windows used by DexScreener/Jupiter stats. */
export type Window = 'm5' | 'h1' | 'h6' | 'h24';
export type ByWindow<T> = Record<Window, T>;

export interface Provenance {
  source: SourceId;
  /** Epoch ms when the record was fetched (or recorded, for fixtures). */
  fetchedAt: number;
}

export interface Socials {
  x: string | null;
  tg: string | null;
  web: string | null;
}

/** Token { mint, symbol, name, decimals, launchpad, createdAt, image, socials{x,tg,web}, verified, sus } */
export interface Token extends Provenance {
  mint: string;
  symbol: string;
  name: string;
  /** null when only DexScreener has seen the token (it does not report decimals). */
  decimals: number | null;
  launchpad: Launchpad;
  createdAt: number | null;
  image: string | null;
  socials: Socials;
  verified: boolean;
  sus: boolean;
}

export interface BuySell {
  buys: number;
  sells: number;
}

/** Pair { pairAddress, dex, baseMint, quoteMint, priceUsd, priceNative, liquidityUsd, fdv, mcap,
 *         txns{m5,h1,h6,h24:{buys,sells}}, volume{...}, priceChange{...}, createdAt, source } */
export interface Pair extends Provenance {
  pairAddress: string;
  dex: string;
  baseMint: string;
  quoteMint: string;
  priceUsd: number;
  priceNative: number;
  liquidityUsd: number | null;
  fdv: number | null;
  mcap: number | null;
  txns: ByWindow<BuySell>;
  /** USD volume per window. */
  volume: ByWindow<number | null>;
  /** Percent change per window (e.g. 12.5 means +12.5 %). */
  priceChange: ByWindow<number | null>;
  createdAt: number | null;
}

export interface WindowStats {
  numTraders: number | null;
  numNetBuyers: number | null;
  /** Organic buy volume in USD for the window. */
  buyVol: number | null;
  /** Organic sell volume in USD for the window. */
  sellVol: number | null;
}

/** Stats { holderCount, holders24hDelta, organicScore, numTraders, numNetBuyers, buyVol, sellVol (per window) } */
export interface Stats extends Provenance {
  mint: string;
  holderCount: number | null;
  holders24hDelta: number | null;
  /** Jupiter organic score 0..100, shown raw (≥70 green, 40..69 amber, <40 red). */
  organicScore: number | null;
  perWindow: ByWindow<WindowStats | null>;
}

/** Audit { mintAuthority, freezeAuthority, top10Pct, devPct, devMints, lpLockedPct, rugRisks[], rugScore } */
export interface Audit extends Provenance {
  mint: string;
  /** true = authority still enabled (bad), false = revoked, null = unknown. */
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  /** Top-10 holder share excluding LP vault and known CEX/bridge addresses (SPEC §3.6). */
  top10Pct: number | null;
  devPct: number | null;
  devMints: number | null;
  /** 0.1.5 dev history: the creator / dev wallet the source names (Jupiter tokens v2 `dev`), keyless. Absent = not reported. */
  devAddress?: string | null;
  lpLockedPct: number | null;
  rugRisks: string[];
  rugScore: number | null;
  /** Keyed (Solana Tracker) extras. Absent = no keyed source answered; never read absent as 0. */
  sniperCount?: number | null;
  sniperPct?: number | null;
  insiderCount?: number | null;
  insiderPct?: number | null;
  bundlerCount?: number | null;
  bundledPct?: number | null;
  /** The provider's own "this has rugged" verdict. */
  rugged?: boolean | null;
  /** Solana Tracker's 0..10 risk score (higher = riskier). */
  trackerScore?: number | null;
}

/** Candle { t, o, h, l, c, v } — t = epoch ms of the bar open, v = USD volume. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export type HolderLabel = 'LP' | 'dev' | 'sniper' | 'cex' | 'bridge' | 'smart';

/** Holder { address, pct, amount, label? } */
export interface Holder {
  address: string;
  pct: number;
  amount: number;
  label?: HolderLabel;
}

export type TradeSide = 'buy' | 'sell';
export type TradeLabel = 'smart' | 'dev' | 'sniper';

/** Trade { t, side, usd, price, wallet, label? } */
export interface Trade {
  t: number;
  side: TradeSide;
  usd: number;
  price: number;
  wallet: string;
  label?: TradeLabel;
}

/** Forensics (Tier 1 only) { snipers, bundledPct, bundleWallets, devHistory{launches, rugged, bestAth} } */
export interface DevHistory {
  launches: number;
  rugged: number;
  /** Best all-time-high market cap (USD) among the creator's prior launches. */
  bestAth: number | null;
}

export interface Forensics extends Provenance {
  mint: string;
  snipers: number | null;
  bundledPct: number | null;
  bundleWallets: number | null;
  devHistory: DevHistory | null;
}

/**
 * Create { mint, creator, launchpad, initialBuySol, vSol, vToken, marketCapSol, uri, signature } — a launch
 * as pushed by PumpPortal's `subscribeNewToken` (inventory §5). `bondingPct` is estimated from the curve's
 * virtual token reserves against pump.fun's documented initial reserves (docs/pump-fun/docs-overview.md).
 * `name`/`symbol`/`uri` are untrusted text (CL-06).
 */
export interface Create extends Provenance {
  mint: string;
  creator: string;
  launchpad: Launchpad;
  name: string;
  symbol: string;
  uri: string | null;
  signature: string | null;
  /** Creator's initial buy in tokens (raw UI amount as PumpPortal sends it) and the SOL spent. */
  initialBuyTokens: number | null;
  initialBuySol: number | null;
  vSol: number | null;
  vToken: number | null;
  marketCapSol: number | null;
  bondingCurve: string | null;
  /** PumpPortal `pool` tag (`pump`, `bonk`, ...). */
  pool: string | null;
  /** 0..100 estimate of curve completion, null when the reserves were not in the message. */
  bondingPct: number | null;
  /** Local wall-clock ms when the message arrived (for event-to-row latency). */
  receivedAt: number;
}

/** `needs-key`: a Tier 1 source with no user key configured (SPEC §3.2). */
export type HealthState = 'ok' | 'degraded' | 'down' | 'disabled' | 'needs-key';

/** Health { source, ok, latencyMs, rpmUsed, rpmLimit, lastError, since } */
export interface Health {
  source: SourceId;
  ok: boolean;
  state: HealthState;
  latencyMs: number | null;
  rpmUsed: number;
  rpmLimit: number | null;
  lastError: string | null;
  /** Epoch ms since the current state began. */
  since: number;
  /** Metered sources (Helius): credits used today / daily budget, bytes streamed (inventory §5). */
  creditsUsed?: number;
  creditsBudget?: number;
  bytesStreamed?: number;
}

/**
 * Two-speed streaming (SPEC §3.9, task-1312). A token's lane is a property of attention, not of the
 * token: open / watchlisted / fresh-launch tokens are priced by push (fast), everything else by poll
 * (slow). Both lanes write the same model, so a token promotes slow→fast the moment it is opened with
 * no visual seam. The lane tag is what the honest LIVE/POLL badge reads.
 */
export type Lane = 'fast' | 'slow';

/**
 * A single price observation, lane-tagged with its provenance so the UI can show LIVE (on-chain push)
 * vs POLL (aggregator) honestly. Fast-lane points come from an on-chain account change (`onchain-curve`
 * / `onchain-pool`) delivered over a WebSocket; slow-lane points carry the aggregator `SourceId`.
 */
export interface PricePoint {
  mint: string;
  /** Price of one token in SOL (full precision). */
  priceSol: number;
  /** USD price when a SOL/USD rate was available, else null. */
  priceUsd: number | null;
  /** Chain slot the observation came from (fast lane), else null. */
  slot: number | null;
  /** Local wall-clock ms the observation was received. */
  t: number;
  source: 'onchain-curve' | 'onchain-pool' | SourceId;
  lane: Lane;
}

/**
 * How to price a mint on-chain (resolved once per mint, cached). Pre-migration pump.fun tokens are
 * priced from their bonding-curve account; migrated tokens from an AMM pool's reserves. `kind: 'unknown'`
 * means the mint is not on a streamable on-chain price source and must stay on the slow (poll) lane.
 */
export interface PriceAccount {
  mint: string;
  kind: 'pump-curve' | 'amm-pool' | 'unknown';
  /** Bonding-curve account to subscribe (pump-curve). */
  curve?: string;
  /** AMM reserves to subscribe (amm-pool); price = quote/base reserve ratio × SOL/USD. */
  baseVault?: string;
  quoteVault?: string;
  quoteMint?: string;
}

/**
 * One screener row as the UI consumes it: the pieces the data layer has for a mint.
 * Optional parts are absent when their source is keyless-unavailable or degraded.
 */
export interface TokenSnapshot {
  token: Token;
  pair: Pair;
  stats?: Stats;
  audit?: Audit;
  forensics?: Forensics;
  /** Recent closing prices for the sparkline, oldest first. */
  sparkline?: number[];
}
