// @dexterm/data — social / news / trending model (task-1330, lane I-03; INTEGRATIONS-DESIGN §5.1).
//
// Conventions follow ../model.ts: epoch-ms timestamps, `null` = "source did not say", plain interfaces
// only. Every post's `text` has ALREADY been through the ingest firewall (./firewall.ts) when it is a
// SocialPost; the pre-firewall shape is `RawPost`. Nothing here is ever posted anywhere, and nothing is
// fetched from X: posts arrive from keyless sources (news RSS, on-chain rules) today and from the user's
// own X login (lane I-02) later — the model is the same.

import type { SourceId } from '../model.ts';

export type Platform = 'x' | 'telegram' | 'discord' | 'news' | 'chain';

/**
 * Author tiers (design §5.5 rule 6). `kol-a/b` come from KOL lists, `own` from the user's groups, `src`
 * for news domains, `spam` from the rules; `none` is everybody else. Nothing is inferred from follower
 * counts alone.
 */
export type AuthorTier = 'kol-a' | 'kol-b' | 'own' | 'src' | 'none' | 'spam';

/**
 * Row flags. `spam` = account-burst cluster; `injection` = instruction-like text (withheld from the
 * model); `squat` = `$SYM` whose text carries a different mint; `unverified-cashtag` = symbol with ≥ 3
 * live mints and no resolved mint; `boost` = the token is in DexScreener's paid boosts.
 */
export type PostFlag = 'spam' | 'injection' | 'squat' | 'unverified-cashtag' | 'boost';

export interface SocialAuthor {
  id: string;
  /** `@handle` for X, `user:<group>` for TG/Discord, the domain for news, a short address for chain rows. */
  handle: string;
  tier: AuthorTier;
  /** Account creation time when the platform reports it (drives the fresh-account rules); null = unknown. */
  createdAt: number | null;
}

export interface PostMetrics {
  likes: number;
  reposts: number;
  replies: number;
  views: number | null;
}

/** A post as a source delivers it, BEFORE the firewall. Only `ingest()` turns these into SocialPosts. */
export interface RawPost {
  id: string;
  t: number;
  platform: Platform;
  author: SocialAuthor;
  /** Untrusted text exactly as the source sent it. */
  text: string;
  url: string | null;
  lang: string | null;
  metrics?: Partial<PostMetrics>;
  /** Mints the SOURCE resolved (never parsed from the text here; the text's base58 becomes `[addr]`). */
  mints?: string[];
  source: SourceId | 'x-api' | 'user-group';
  fetchedAt: number;
}

export interface Provenance {
  source: string;
  fetchedAt: number;
}

/**
 * SocialPost { id, t, platform, author{id, handle, tier}, text (firewalled), url, lang, metrics, mints[]
 * (resolved, never trusted from text), cluster?, dupCount, flags[], provenance }
 */
export interface SocialPost {
  id: string;
  t: number;
  platform: Platform;
  author: SocialAuthor;
  /** Firewalled, terminal-safe, ≤ POST_STORED_MAX chars. */
  text: string;
  url: string | null;
  lang: string | null;
  metrics: PostMetrics;
  mints: string[];
  /** `$CASHTAGS` seen in the text (upper-cased, no `$`), for squat detection and symbol matching. */
  cashtags: string[];
  /** Near-duplicate cluster id; the cluster head carries `dupCount`, members are hidden from lists. */
  cluster: string | null;
  /** Posts in this cluster including this one (1 = unique). */
  dupCount: number;
  /** True for non-head cluster members (never listed; still counted). */
  hidden: boolean;
  flags: PostFlag[];
  /** Set on a spam cluster's head: what the collapsed row says instead of the text ("58 near-identical posts from 31 new accounts in 90s"). */
  collapsed: { posts: number; accounts: number; spanSec: number } | null;
  provenance: Provenance;
}

export type KolListSource = 'own-x-list' | 'pack' | 'manual';

/** KolList { id, name, source, handles[], wallets[]?, signed?: {publisher, hash}, since } */
export interface KolList {
  id: string;
  name: string;
  source: KolListSource;
  /** Lower-cased handles without `@`. */
  handles: string[];
  /** Optional wallet addresses the pack/user linked to handles (evidence links live in the pack, not here). */
  wallets: string[];
  signed: { publisher: string; hash: string; verified: boolean } | null;
  since: number;
  /** Lists feed the trending credibility only while enabled (design §5.4 per-list toggle). */
  enabled: boolean;
  /** `kol-a` for the user's own lists and verified packs, `kol-b` otherwise (packs grant membership, not credibility). */
  tier: 'kol-a' | 'kol-b';
}

/** Credibility { handle, score 0..100, inputs{...}, computedAt } — computed locally from observations only. */
export interface Credibility {
  handle: string;
  score: number;
  inputs: {
    /** 0..1: share of the handle's calls that preceded a tracked-wallet buy (needs a linked wallet). */
    earlyEntry: number | null;
    /** 0..1: share of followers that are tracked KOLs or verified (unknown without X). */
    followerQuality: number | null;
    /** 0..1: share of the handle's token calls confirmed on-chain within the window. */
    onChainConfirmRate: number | null;
    spamPenalty: number;
    boostPenalty: number;
  };
  computedAt: number;
}

/** Keyless venue signals for one mint (design §5.3: blended into velocity + credibility). */
export interface VenueSignal {
  mint: string;
  symbol: string | null;
  /** 1-based rank in Jupiter toptrending/1h, null when absent. */
  jupTrendingRank: number | null;
  /** 1-based rank in Jupiter toporganicscore/1h. */
  jupOrganicRank: number | null;
  organicScore: number | null;
  /** 1-based rank in GeckoTerminal trending_pools. */
  geckoTrendingRank: number | null;
  /** In DexScreener token-boosts (paid attention) — a NEGATIVE credibility input. */
  boosted: boolean;
  boostAmount: number | null;
  /** CoinGecko search/trending match by symbol (cross-chain retail attention; macro only). */
  coingeckoTrending: boolean;
  /** 1h USD volume × 24 ÷ 24h USD volume: the venue's own "velocity" when posts are missing. */
  volumeVelocity: number | null;
  priceChange1h: number | null;
  liquidityUsd: number | null;
  /** Which venue sources mentioned this mint (for the SOURCES column). */
  sources: string[];
  fetchedAt: number;
}

/**
 * TrendRow { mint, symbol, narrative?, velocity, postsPerHour, kolCount, credibility, sources[],
 * priceChange1h, liq, latestCrediblePostId?, age }
 */
export interface TrendRow {
  mint: string;
  symbol: string;
  narrative: string | null;
  /** Spam-excluded posts/h ÷ 24 h mean; null = "new" (fewer than 2 hourly samples and no venue velocity). */
  velocity: number | null;
  /** Where the velocity number came from. */
  velocityBasis: 'social' | 'venue' | 'new';
  postsPerHour: number;
  kolCount: number;
  credibility: number;
  /** velocity × credibility (0..1 scale), the rank key. */
  score: number;
  sources: string[];
  priceChange1h: number | null;
  liq: number | null;
  latestCrediblePostId: string | null;
  latestCrediblePost: SocialPost | null;
  /** Hidden-by-rule counts for this token (shown as "N hidden"). */
  hiddenSpam: number;
  hiddenSquats: number;
  /** Epoch ms of the newest input behind the row (data age in the UI). */
  updatedAt: number;
  venue: VenueSignal | null;
}

/** Narrative { id, label, tokens[], velocity, delta24h, kolThreads, newsCount } */
export interface Narrative {
  id: string;
  /** From the analyst summary / user, never from a single post; null = unlabelled. */
  label: string | null;
  tokens: string[];
  symbols: string[];
  velocity: number | null;
  delta24h: number | null;
  kolThreads: number;
  newsCount: number;
}

export type NewsTag = 'macro' | 'security' | 'regulation' | 'solana' | 'cross-ref' | 'other';

/** One RSS item after the firewall, with the mints/symbols it was matched to (never parsed as truth). */
export interface NewsItem {
  post: SocialPost;
  /** Publisher domain (`coindesk.com`). */
  domain: string;
  tag: NewsTag;
  /** Mints on the current board the headline mentioned by symbol/name. */
  crossRefs: string[];
}

/** Display truncation (design §5.6): 280 shown, 512 stored, 160 for bios. */
export const POST_DISPLAY_MAX = 280;
export const POST_STORED_MAX = 512;
export const BIO_MAX = 160;
