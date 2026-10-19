// @dexterm/data — credibility, velocity, trend rows and narratives (task-1330; design §5.3 / §5.4).
//
// Rank = velocity × credibility, computed locally and deterministically:
//   velocity    = spam-excluded listed posts in the last hour ÷ the mean of the previous 23 hourly
//                 buckets (≥ 2 non-empty buckets required, else the venue's own volume velocity, else "new")
//   credibility = mean author credibility over the window + KOL count + on-chain confirmation
//                 − boost penalty − spam share; 0..100
//   score       = velocity × credibility/100 + 0.1 per independent venue source that lists the mint
// Author credibility comes only from the user's own observations (early entry, confirm rate, follower
// quality when known) on top of a tier baseline; a KOL list grants membership, never credibility.

import type { Credibility, Narrative, SocialAuthor, SocialPost, TrendRow, VenueSignal } from './model.ts';
import { countsForVelocity } from './dedupe.ts';

export const HOUR_MS = 3_600_000;
export const WINDOW_HOURS = 24;
export const MIN_VELOCITY_SAMPLES = 2;
export const BOOST_PENALTY = 20;
export const CHAIN_CONFIRM_BONUS = 15;
export const KOL_BONUS_PER = 2;
export const KOL_BONUS_CAP = 10;
export const SPAM_SHARE_PENALTY = 20;
export const VENUE_CONFIRM_BONUS = 0.1;

/** Baselines by tier (design §5.5 rule 6 + §5.4): news domains are official sources; spam is spam. */
export const TIER_BASE: Record<SocialAuthor['tier'], number> = { src: 90, 'kol-a': 60, 'kol-b': 50, own: 55, none: 30, spam: 4 };

export interface AuthorObservation {
  earlyEntry?: number | null;
  followerQuality?: number | null;
  onChainConfirmRate?: number | null;
}

const clamp01 = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null);

export function credibilityOf(author: SocialAuthor, obs: AuthorObservation | undefined, now: number): Credibility {
  const earlyEntry = clamp01(obs?.earlyEntry);
  const followerQuality = clamp01(obs?.followerQuality);
  const onChainConfirmRate = clamp01(obs?.onChainConfirmRate);
  let score = TIER_BASE[author.tier];
  if (earlyEntry !== null) score += 25 * earlyEntry;
  if (onChainConfirmRate !== null) score += 15 * onChainConfirmRate;
  if (followerQuality !== null) score += 10 * followerQuality;
  const spamPenalty = author.tier === 'spam' ? Math.max(0, score - TIER_BASE.spam) : 0;
  score -= spamPenalty;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { handle: author.handle, score, inputs: { earlyEntry, followerQuality, onChainConfirmRate, spamPenalty, boostPenalty: 0 }, computedAt: now };
}

/** Posts per hourly bucket, index 0 = the current hour, 1 = the previous, … up to `hours`. */
export function hourlyBuckets(posts: readonly SocialPost[], now: number, hours = WINDOW_HOURS): number[] {
  const out = new Array<number>(hours).fill(0);
  for (const p of posts) {
    if (!countsForVelocity(p)) continue;
    const age = now - p.t;
    if (age < 0) continue;
    const i = Math.floor(age / HOUR_MS);
    if (i < hours) out[i] += 1;
  }
  return out;
}

export interface Velocity {
  postsPerHour: number;
  /** null = fewer than MIN_VELOCITY_SAMPLES non-empty prior buckets. */
  velocity: number | null;
  samples: number;
}

export function socialVelocity(buckets: readonly number[]): Velocity {
  const postsPerHour = buckets[0] ?? 0;
  const prior = buckets.slice(1);
  const samples = prior.filter((n) => n > 0).length;
  if (samples < MIN_VELOCITY_SAMPLES) return { postsPerHour, velocity: null, samples };
  const mean = prior.reduce((s, n) => s + n, 0) / prior.length;
  return { postsPerHour, velocity: mean > 0 ? postsPerHour / mean : null, samples };
}

export interface TrendInput {
  mint: string;
  symbol: string;
  /** Every post about the mint in the 24 h window (hidden/spam included; the rules decide). */
  posts: readonly SocialPost[];
  venue: VenueSignal | null;
  /** Credibility lookup for an author (from credibilityOf + the observation store). */
  credibility: (author: SocialAuthor) => number;
  /** Lower-cased KOL handles (enabled lists, muted removed). */
  kolHandles: ReadonlySet<string>;
  /** True when tracked wallets actually bought inside the window (on-chain rows present). */
  chainConfirmed: boolean;
  narrative?: string | null;
  now: number;
}

export function buildTrendRow(input: TrendInput): TrendRow {
  const { posts, venue, now } = input;
  const listed = posts.filter((p) => !p.hidden);
  const counted = posts.filter(countsForVelocity);
  const lastHour = counted.filter((p) => now - p.t < HOUR_MS);
  const buckets = hourlyBuckets(posts, now);
  const sv = socialVelocity(buckets);
  let velocity: number | null = sv.velocity;
  let basis: TrendRow['velocityBasis'] = 'social';
  if (velocity === null) {
    if (venue && venue.volumeVelocity !== null) { velocity = venue.volumeVelocity; basis = 'venue'; }
    else basis = 'new';
  }
  const windowPosts = lastHour.length ? lastHour : counted;
  const kols = new Set<string>();
  let credSum = 0;
  for (const p of windowPosts) {
    credSum += input.credibility(p.author);
    if (input.kolHandles.has(p.author.handle.replace(/^@/, '').toLowerCase())) kols.add(p.author.handle.toLowerCase());
  }
  const spamCount = listed.filter((p) => p.flags.includes('spam')).reduce((s, p) => s + (p.collapsed?.posts ?? p.dupCount), 0);
  const squatCount = listed.filter((p) => p.flags.includes('squat') || p.flags.includes('unverified-cashtag')).length;
  const total = counted.length + spamCount;
  const spamShare = total > 0 ? spamCount / total : 0;
  let cred = windowPosts.length ? credSum / windowPosts.length : venue ? 20 + (venue.organicScore ?? 0) * 0.2 : 0;
  cred += Math.min(kols.size, KOL_BONUS_CAP) * KOL_BONUS_PER;
  if (input.chainConfirmed) cred += CHAIN_CONFIRM_BONUS;
  if (venue?.boosted) cred -= BOOST_PENALTY;
  cred -= spamShare * SPAM_SHARE_PENALTY;
  cred = Math.max(0, Math.min(100, Math.round(cred)));
  const venueSources = venue ? venue.sources.filter((s) => s !== 'boost').length : 0;
  const vel = velocity ?? (sv.postsPerHour > 0 ? 1 : 0.5);
  const score = vel * (cred / 100) + venueSources * VENUE_CONFIRM_BONUS;
  const latest = [...counted].sort((a, b) => b.t - a.t).find((p) => input.credibility(p.author) >= 40) ?? null;
  const sources = new Set<string>();
  for (const p of listed) sources.add(p.platform === 'x' ? 'X' : p.platform === 'telegram' ? 'TG' : p.platform === 'discord' ? 'DC' : p.platform === 'news' ? 'news' : 'chain');
  for (const s of venue?.sources ?? []) sources.add(s);
  const updatedAt = Math.max(venue?.fetchedAt ?? 0, ...listed.map((p) => p.provenance.fetchedAt));
  return {
    mint: input.mint, symbol: input.symbol, narrative: input.narrative ?? null,
    velocity, velocityBasis: basis, postsPerHour: sv.postsPerHour, kolCount: kols.size, credibility: cred, score: Math.round(score * 1000) / 1000,
    sources: [...sources], priceChange1h: venue?.priceChange1h ?? null, liq: venue?.liquidityUsd ?? null,
    latestCrediblePostId: latest?.id ?? null, latestCrediblePost: latest,
    hiddenSpam: spamCount, hiddenSquats: squatCount, updatedAt: updatedAt || now, venue,
  };
}

/** Highest score first; ties by posts/h then symbol so the order is total. */
export function rankRows(rows: TrendRow[]): TrendRow[] {
  return [...rows].sort((a, b) => b.score - a.score || b.postsPerHour - a.postsPerHour || a.symbol.localeCompare(b.symbol));
}

/**
 * Narratives = clusters of tokens linked by shared KOL threads (one KOL handle posting about both inside
 * the window) or co-mention (one post naming both mints). Union-find over the rows' mints. Labels come
 * from `labels` (the analyst summary or the user), never from a single post; unlabelled clusters keep
 * `label: null` and the UI lists the symbols.
 */
export function buildNarratives(rows: readonly TrendRow[], posts: readonly SocialPost[], kolHandles: ReadonlySet<string>, labels: ReadonlyMap<string, string> = new Map(), newsCountFor: (mint: string) => number = () => 0): Narrative[] {
  const mints = rows.map((r) => r.mint);
  const idx = new Map(mints.map((m, i) => [m, i]));
  const parent = mints.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const byKol = new Map<string, Set<number>>();
  const threads = new Map<number, Set<string>>();
  for (const p of posts) {
    if (!countsForVelocity(p)) continue;
    const ids = p.mints.map((m) => idx.get(m)).filter((i): i is number => i !== undefined);
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]); // co-mention
    const h = p.author.handle.replace(/^@/, '').toLowerCase();
    if (kolHandles.has(h)) {
      const s = byKol.get(h) ?? new Set<number>();
      for (const i of ids) s.add(i);
      byKol.set(h, s);
    }
  }
  for (const [h, set] of byKol) {
    const arr = [...set];
    for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    for (const i of arr) { const t = threads.get(i) ?? new Set<string>(); t.add(h); threads.set(i, t); }
  }
  const groups = new Map<number, number[]>();
  mints.forEach((_, i) => { const r = find(i); const g = groups.get(r) ?? []; g.push(i); groups.set(r, g); });
  const out: Narrative[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue; // a narrative needs at least two tokens
    const rs = members.map((i) => rows[i]).sort((a, b) => b.score - a.score);
    const id = rs.map((r) => r.mint.slice(0, 6)).sort().join('+');
    const kolSet = new Set<string>();
    for (const i of members) for (const h of threads.get(i) ?? []) kolSet.add(h);
    const vels = rs.map((r) => r.velocity).filter((v): v is number => v !== null);
    const d24 = rs.map((r) => r.venue?.priceChange1h).filter((v): v is number => typeof v === 'number');
    out.push({
      id, label: labels.get(id) ?? null, tokens: rs.map((r) => r.mint), symbols: rs.map((r) => r.symbol),
      velocity: vels.length ? vels.reduce((s, v) => s + v, 0) / vels.length : null,
      delta24h: d24.length ? d24.reduce((s, v) => s + v, 0) / d24.length : null,
      kolThreads: kolSet.size, newsCount: members.reduce((s, i) => s + newsCountFor(rows[i].mint), 0),
    });
  }
  return out.sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0) || b.tokens.length - a.tokens.length);
}
