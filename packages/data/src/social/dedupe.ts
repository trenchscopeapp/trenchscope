// @dexterm/data — dedupe and spam/bot rules (task-1330; design §5.5). All local, all deterministic,
// testable on recorded fixtures. Nothing here looks at follower counts.
//
//  1. Exact + near-duplicate text (normalized, URL/mint stripped, SimHash ≤ 3 bits) within 10 min → one
//     cluster row with `dupCount`; the cluster is a single vote for velocity (members are `hidden`).
//  2. Account burst: ≥ 10 posts about one mint from accounts created within 30 days, inside 2 min → the
//     posts are `spam`, excluded from velocity, shown collapsed on the head.
//  3. Cashtag squats: a `$SYM` whose text carries a different base58 address than the row's mint is
//     `squat`; a symbol with ≥ 3 live mints and no resolved mint is `unverified-cashtag`.

import type { SocialPost } from './model.ts';

export const DEDUPE_WINDOW_MS = 10 * 60_000;
export const DEDUPE_MAX_BITS = 3;
export const BURST_MIN_POSTS = 10;
export const BURST_SPAN_MS = 2 * 60_000;
export const FRESH_ACCOUNT_MS = 30 * 86_400_000;
export const SQUAT_MIN_LIVE_MINTS = 3;

/** Lower-case, drop `[url]`/`[addr]` placeholders, cashtags, @handles, punctuation and digits-only tokens; collapse spaces. */
export function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, ' ')
    .replace(/\[(?:url|addr)\]/g, ' ')
    .replace(/\$[a-z][a-z0-9_]*/g, ' ')
    .replace(/@[a-z0-9_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/** FNV-1a 64 over UTF-16 code units (deterministic across platforms, no deps). */
export function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/**
 * 64-bit SimHash over word shingles (unigrams + bigrams) of the normalized text. Near-identical posts
 * (a swapped word, a different emoji, another handle) land within a few bits of each other.
 */
export function simhash64(normalized: string): bigint {
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return 0n;
  const shingles: string[] = [];
  for (let i = 0; i < words.length; i++) {
    shingles.push(words[i]);
    if (i + 1 < words.length) shingles.push(`${words[i]} ${words[i + 1]}`);
  }
  const v = new Array<number>(64).fill(0);
  for (const sh of shingles) {
    const h = fnv1a64(sh);
    for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return out;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) { x &= x - 1n; n++; }
  return n;
}

interface Head { id: string; t: number; hash: bigint; members: SocialPost[] }

/**
 * Group near-duplicates (rule 1). Returns the same post objects with `cluster`, `dupCount` and
 * `hidden` set: the earliest post of a cluster is the head (listed; carries dupCount), the rest hidden.
 * Posts of different platforms or about different mints never cluster (a news headline is not a dupe
 * of an X post quoting it). Idempotent.
 */
export function clusterPosts(posts: SocialPost[], opts: { windowMs?: number; maxBits?: number } = {}): SocialPost[] {
  const windowMs = opts.windowMs ?? DEDUPE_WINDOW_MS;
  const maxBits = opts.maxBits ?? DEDUPE_MAX_BITS;
  const sorted = [...posts].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  const heads = new Map<string, Head[]>(); // key: platform|mint
  for (const p of sorted) {
    const norm = normalizeForDedupe(p.text);
    const hash = simhash64(norm);
    const key = `${p.platform}|${p.mints[0] ?? ''}`;
    const list = heads.get(key) ?? [];
    let hit: Head | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      if (p.t - h.t > windowMs) break; // list is time-ordered; older heads cannot match
      if (norm.length === 0) continue;  // empty text never clusters
      if (h.hash === hash || hamming(h.hash, hash) <= maxBits) { hit = h; break; }
    }
    if (hit) {
      hit.members.push(p);
      p.cluster = hit.id;
      p.hidden = true;
      p.dupCount = 1;
    } else {
      list.push({ id: p.id, t: p.t, hash, members: [p] });
      heads.set(key, list);
      p.cluster = null;
      p.hidden = false;
      p.dupCount = 1;
    }
  }
  for (const list of heads.values()) {
    for (const h of list) {
      if (h.members.length > 1) {
        const head = h.members[0];
        head.cluster = h.id;
        head.dupCount = h.members.length;
      }
    }
  }
  return posts;
}

export interface BurstOptions {
  now: number;
  minPosts?: number;
  spanMs?: number;
  freshAccountMs?: number;
}

/**
 * Rule 2, per mint: a sliding 2-minute window holding ≥ 10 posts from accounts younger than 30 days
 * flags every post in it `spam`, demotes those authors to the `spam` tier and collapses the burst onto
 * its earliest listed post. Accounts with an unknown creation time never count as fresh (a missing
 * field is not evidence). Idempotent.
 */
export function markBurstSpam(posts: SocialPost[], opts: BurstOptions): SocialPost[] {
  const minPosts = opts.minPosts ?? BURST_MIN_POSTS;
  const spanMs = opts.spanMs ?? BURST_SPAN_MS;
  const freshMs = opts.freshAccountMs ?? FRESH_ACCOUNT_MS;
  const byMint = new Map<string, SocialPost[]>();
  for (const p of posts) {
    if (p.platform === 'news' || p.platform === 'chain') continue;
    const fresh = p.author.createdAt !== null && opts.now - p.author.createdAt <= freshMs;
    if (!fresh) continue;
    for (const m of p.mints.length ? p.mints : ['']) {
      const l = byMint.get(m) ?? [];
      l.push(p);
      byMint.set(m, l);
    }
  }
  for (const list of byMint.values()) {
    list.sort((a, b) => a.t - b.t);
    let j = 0;
    const flagged = new Set<SocialPost>();
    for (let i = 0; i < list.length; i++) {
      while (list[i].t - list[j].t > spanMs) j++;
      if (i - j + 1 >= minPosts) for (let k = j; k <= i; k++) flagged.add(list[k]);
    }
    if (flagged.size === 0) continue;
    const arr = [...flagged].sort((a, b) => a.t - b.t);
    const accounts = new Set(arr.map((p) => p.author.id));
    const spanSec = Math.max(1, Math.round((arr[arr.length - 1].t - arr[0].t) / 1000));
    // collapse onto the earliest visible post of the burst (or the earliest post when all are hidden)
    const head = arr.find((p) => !p.hidden) ?? arr[0];
    for (const p of arr) {
      if (!p.flags.includes('spam')) p.flags.push('spam');
      p.author.tier = 'spam';
      if (p !== head) p.hidden = true;
    }
    head.hidden = false;
    head.cluster = head.cluster ?? head.id;
    head.dupCount = Math.max(head.dupCount, arr.length);
    head.collapsed = { posts: arr.length, accounts: accounts.size, spanSec };
  }
  return posts;
}

export interface SquatOptions {
  /** Live mints known for a symbol (upper-case, no `$`); undefined = no symbol index available. */
  mintsForSymbol?: (symbol: string) => string[];
  /** Addresses the ORIGINAL text carried (from the firewall result), by post id. */
  addressesOf?: (post: SocialPost) => string[];
}

/** Rule 3: cashtag squats and unverified cashtags. Idempotent. */
export function markSquats(posts: SocialPost[], opts: SquatOptions = {}): SocialPost[] {
  for (const p of posts) {
    if (p.platform === 'news' || p.platform === 'chain') continue;
    const addrs = opts.addressesOf?.(p) ?? [];
    const own = new Set(p.mints);
    if (p.cashtags.length && addrs.some((a) => !own.has(a))) {
      if (!p.flags.includes('squat')) p.flags.push('squat');
    }
    if (p.mints.length === 0 && p.cashtags.length && opts.mintsForSymbol) {
      const ambiguous = p.cashtags.some((s) => opts.mintsForSymbol!(s).length >= SQUAT_MIN_LIVE_MINTS);
      if (ambiguous && !p.flags.includes('unverified-cashtag')) p.flags.push('unverified-cashtag');
    }
  }
  return posts;
}

/** Posts that count: listed heads, not spam, not squats/unverified, not injection. */
export function countsForVelocity(p: SocialPost): boolean {
  return !p.hidden && !p.flags.includes('spam') && !p.flags.includes('squat') && !p.flags.includes('unverified-cashtag') && !p.flags.includes('injection');
}
