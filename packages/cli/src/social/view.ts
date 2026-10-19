// trenchscope — shared view helpers for the social layer (task-1330): what the trending screen, the token SOCIAL
// panel and the KOL screen read from the state. Pure functions over AppState + SocialFeed; no rendering here.
import type { SocialFeed, SocialPost, TrendRow, NewsItem, KolStore, KolList } from '@dexterm/data';
import type { AppState } from '../state.ts';
import { demoSocialFeed } from './demo.ts';

/** Fixtures: build the demo feed + KOL store once per state (lazily, so states that never show a social view pay nothing). */
function ensureDemo(state: AppState): void {
  if (state.social !== undefined || state.live || state.screener.source !== 'fixtures') return;
  const demo = demoSocialFeed(state.fx, state.now.getTime());
  state.social = demo.feed;
  state.kol = demo.kol;
}

export type SocialFilter = 'all' | 'kol' | 'x' | 'chain' | 'news' | 'own';
export const SOCIAL_FILTERS: SocialFilter[] = ['all', 'kol', 'x', 'chain', 'news', 'own'];

export function nextSocialFilter(f: SocialFilter | undefined): SocialFilter {
  const i = SOCIAL_FILTERS.indexOf(f ?? 'all');
  return SOCIAL_FILTERS[(i + 1) % SOCIAL_FILTERS.length];
}

/** The social feed behind the state: the live context's (live/replay) or the fixture demo's. */
export function socialOf(state: AppState): SocialFeed | null {
  if (state.live) return state.live.social;
  ensureDemo(state);
  return state.social ?? null;
}

export function kolOf(state: AppState): KolStore | null {
  if (state.live) return state.live.kol;
  ensureDemo(state);
  return state.kol ?? null;
}

/** Board rows after the narrative filter (`n`); spam/squat hiding is per row, not per board. */
export function trendingRows(state: AppState): TrendRow[] {
  const feed = socialOf(state);
  if (!feed) return [];
  let rows = feed.trendRows();
  const nar = state.socialNarrative ?? 0;
  if (nar > 0) {
    const n = feed.narratives()[nar - 1];
    if (n) { const set = new Set(n.tokens); rows = rows.filter((r) => set.has(r.mint)); }
  }
  const author = state.socialAuthor ? state.socialAuthor.toLowerCase() : null;
  if (author) rows = rows.filter((r) => feed.allPostsFor(r.mint).some((p) => p.author.handle.replace(/^@/, '').toLowerCase() === author && !p.hidden));
  const f = state.socialFilter ?? 'all';
  if (f === 'kol') rows = rows.filter((r) => r.kolCount > 0);
  else if (f === 'x') rows = rows.filter((r) => r.sources.includes('X'));
  else if (f === 'chain') rows = rows.filter((r) => r.sources.includes('chain'));
  else if (f === 'news') { const newsMints = new Set(feed.newsItems().flatMap((n) => n.crossRefs)); rows = rows.filter((r) => newsMints.has(r.mint)); }
  else if (f === 'own') rows = rows.filter((r) => r.velocityBasis === 'social');
  return rows;
}

/** The token panel's rows: newest first, the current filter applied, hidden spam/squats behind `x`. */
export function panelPosts(state: AppState, mint: string): SocialPost[] {
  const feed = socialOf(state);
  if (!feed) return [];
  const showHidden = state.socialShowSpam === true;
  let posts = feed.postsFor(mint, { includeSpam: true, includeInjection: true });
  if (!showHidden) posts = posts.filter((p) => !p.flags.includes('spam') && !p.flags.includes('squat') && !p.flags.includes('unverified-cashtag'));
  const author = state.socialAuthor ? state.socialAuthor.toLowerCase() : null;
  if (author) posts = posts.filter((p) => p.author.handle.replace(/^@/, '').toLowerCase() === author);
  const f = state.socialFilter ?? 'all';
  const kol = kolOf(state);
  if (f === 'kol') posts = posts.filter((p) => p.author.tier === 'kol-a' || p.author.tier === 'kol-b' || (kol?.tierOf(p.author.handle) ?? null) !== null);
  else if (f === 'x') posts = posts.filter((p) => p.platform === 'x');
  else if (f === 'chain') posts = posts.filter((p) => p.platform === 'chain');
  else if (f === 'news') posts = posts.filter((p) => p.platform === 'news');
  else if (f === 'own') posts = posts.filter((p) => p.author.tier === 'own');
  return posts;
}

/** Hidden counts for a mint (the panel header's "N hidden as spam"). */
export function hiddenCounts(feed: SocialFeed, mint: string): { spam: number; squats: number; injection: number } {
  let spam = 0, squats = 0, injection = 0;
  for (const p of feed.allPostsFor(mint)) {
    if (p.flags.includes('injection')) injection += 1;
    else if (p.flags.includes('spam')) { if (p.collapsed) spam += p.collapsed.posts; else if (!p.hidden) spam += p.dupCount; }
    else if (p.flags.includes('squat') || p.flags.includes('unverified-cashtag')) squats += 1;
  }
  return { spam, squats, injection };
}

export function fmtVelocity(v: number | null, basis?: TrendRow['velocityBasis']): string {
  if (v === null) return 'new';
  const s = v >= 10 ? `${Math.round(v)}×` : `${v.toFixed(1)}×`;
  return basis === 'venue' ? `${s}v` : s;
}

/** ▲ marks for a velocity multiple (1 = ·, <2 ▲, <5 ▲▲, else ▲▲▲). */
export function velocityMarks(v: number | null): string {
  if (v === null) return '·';
  if (v < 1.5) return '·';
  if (v < 3) return '▲';
  if (v < 6) return '▲▲';
  return '▲▲▲';
}

export const TIER_LABEL: Record<SocialPost['author']['tier'], string> = { 'kol-a': 'KOL·A', 'kol-b': 'KOL·B', own: 'own', src: 'src', none: '—', spam: 'spam' };

export function platformLabel(p: SocialPost['platform']): string {
  return p === 'x' ? 'X' : p === 'telegram' ? 'TG' : p === 'discord' ? 'DC' : p === 'news' ? 'news' : 'chain';
}

/** The FLAG column: the most serious flag first. */
export function flagLabel(p: SocialPost): string {
  if (p.flags.includes('injection')) return 'INJ';
  if (p.flags.includes('spam')) return 'SPAM';
  if (p.flags.includes('squat')) return 'SQUAT';
  if (p.flags.includes('unverified-cashtag')) return '?TAG';
  if (p.flags.includes('boost')) return 'boost';
  return '';
}

/** What the post column shows: the collapsed burst summary, the firewall note, or the text. */
export function postText(p: SocialPost): string {
  if (p.collapsed) return `[hidden: ${p.collapsed.posts} near-identical posts from ${p.collapsed.accounts} new accounts in ${p.collapsed.spanSec}s]`;
  if (p.flags.includes('injection')) return `${p.text} [firewall: instruction-like text, withheld from the model]`;
  if (p.dupCount > 1) return `${p.text} (×${p.dupCount})`;
  return p.text;
}

export function newsTagLabel(n: NewsItem): string {
  return n.tag === 'cross-ref' ? `[cross-ref: ${n.crossRefs.length} token${n.crossRefs.length === 1 ? '' : 's'} on this board]` : `[${n.tag}]`;
}

/** Posts by one author in the last hour (the author `vel` column). */
export function authorRate(feed: SocialFeed, mint: string, handle: string, now: number): number {
  let n = 0;
  for (const p of feed.allPostsFor(mint)) if (p.author.handle === handle && now - p.t < 3_600_000 && !p.hidden) n += 1;
  return n;
}

const fmtAge = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

/**
 * The X source as one short badge (task-1357): `x-stream ○ logged out`, `x-stream ●4s @handle`,
 * `x-stream ◐ rate limited 5m`, `x-stream ◐ daily budget`, `x-stream ◐ app tier`. Every degraded state is visible; nothing is ever shown as fresh when it is not.
 */
export function xBadge(feed: SocialFeed): string {
  const st = feed.status();
  const xs = feed.xStatus();
  const mins = (t: number | null) => (t === null ? '' : ` ${Math.max(1, Math.round((t - Date.now()) / 60_000))}m`);
  switch (st.xState) {
    case 'logged-out': return 'x-stream ○ logged out';
    case 'off': return 'x-stream ○ off';
    case 'ok': return `x-stream ●${fmtAge(st.sources[0]?.ageMs ?? null)}${xs.user ? ` @${xs.user.username}` : ''}`;
    case 'rate-limited': return `x-stream ◐ rate limited${mins(xs.resumesAt)}`;
    case 'no-credit': return `x-stream ◐ daily budget${mins(xs.resumesAt)}`;
    case 'not-enrolled': return 'x-stream ◐ app tier (no search)';
    default: return 'x-stream ◐ error';
  }
}

/** The sources line for the header band / summary footer: `x ○ logged out · jupiter ●4s · gecko ●32s · news ●6m`. */
export function sourcesLine(feed: SocialFeed): string {
  const fmt = fmtAge;
  return feed.status().sources.map((s) => {
    if (s.id === 'x') return xBadge(feed);
    if (s.state === 'off') return `${s.label} ○ off`;
    if (s.state === 'error') return `${s.label} ◐ ${s.ageMs === null ? 'error' : fmt(s.ageMs)}`;
    if (s.state === 'never') return `${s.label} ○ —`;
    return `${s.label} ●${fmt(s.ageMs)}`;
  }).join('  ');
}

// ------------------------------------------------------------------ KOL screen rows

export type KolRow = { kind: 'list'; list: KolList } | { kind: 'handle'; list: KolList; handle: string } | { kind: 'empty'; list: KolList };

/** The KOL screen's flattened rows: each list header followed by its handles (packs collapsed to a count past 12). */
export function kolRows(kol: KolStore, expanded: ReadonlySet<string> = new Set()): KolRow[] {
  const out: KolRow[] = [];
  for (const list of kol.all()) {
    out.push({ kind: 'list', list });
    if (list.handles.length === 0) { out.push({ kind: 'empty', list }); continue; }
    const show = list.source === 'pack' && !expanded.has(list.id) ? list.handles.slice(0, 12) : list.handles;
    for (const h of show) out.push({ kind: 'handle', list, handle: h });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- feeds popup (task-1359)
/** Items the feeds HUD carries at most (newest first). */
export const FEEDS_POPUP_MAX = 60;

export interface FeedsPopupModel {
  vm: { title: string; items: Array<{ t: number; source: string; text: string; kind?: string }> };
  /** The coin behind each item (same order as `vm.items`); null for a headline that names no board coin. */
  mints: (string | null)[];
}

/**
 * The FEEDS popup: the posts behind the trending board as the user filters it (spam / injection / near-dupes
 * hidden exactly as the panel hides them; collapsed bursts stay as their one summary row) plus the official RSS
 * headlines, newest first. Text is the stored firewalled text (control chars, URLs and foreign addresses already
 * replaced); the page renders it with textContent only. Mints stay in the terminal (`mints`), so the window
 * never carries an address it could act on.
 */
export function feedsPopupModel(state: AppState, max = FEEDS_POPUP_MAX): FeedsPopupModel {
  const feed = socialOf(state);
  const filter = state.socialFilter ?? 'all';
  const title = `FEEDS${filter === 'all' ? '' : ` · ${filter}`}`;
  if (!feed) return { vm: { title, items: [] }, mints: [] };
  const seen = new Set<string>();
  const rows: Array<{ t: number; source: string; text: string; kind?: string; mint: string | null }> = [];
  for (const r of trendingRows(state).slice(0, 40)) {
    // the token panel's rows for this coin (same filter, same spam/squat hiding behind `x`), minus injection rows:
    // the panel shows those flagged; the popup simply withholds them.
    for (const p of panelPosts(state, r.mint)) {
      if (seen.has(p.id) || p.flags.includes('injection')) continue;
      seen.add(p.id);
      const flag = flagLabel(p);
      const who = p.platform === 'chain' ? 'chain' : p.platform === 'news' ? `news · ${p.author.handle}` : `${platformLabel(p.platform)} @${p.author.handle.replace(/^@/, '')}`;
      rows.push({ t: p.t, source: `${who}${flag ? ` · ${flag}` : ''}`, text: `$${r.symbol} · ${postText(p)}`.slice(0, 300), ...(flag ? { kind: 'warn' } : p.platform === 'chain' || p.platform === 'news' ? { kind: p.platform } : {}), mint: r.mint });
    }
  }
  if (filter === 'all' || filter === 'news') {
    for (const n of feed.newsItems(20)) {
      if (seen.has(n.post.id)) continue;
      seen.add(n.post.id);
      rows.push({ t: n.post.t, source: `news · ${n.domain}`, text: `${n.post.text} ${newsTagLabel(n)}`.slice(0, 300), kind: 'news', mint: n.crossRefs[0] ?? null });
    }
  }
  rows.sort((a, b) => b.t - a.t);
  const top = rows.slice(0, max);
  return { vm: { title, items: top.map(({ mint: _m, ...it }) => it) }, mints: top.map((x) => x.mint) };
}
