// @dexterm/data — the social feed engine (task-1330, lane I-03). One instance per run, over the shared
// data layer. It owns:
//   • ingest(): firewall → store → dedupe → burst-spam → squat rules, for every RawPost from any source
//     (news RSS and on-chain rows today; X posts from the user's own login in lane I-02; TG/Discord bots)
//   • the keyless venue layer (TrendingVenues) refreshed every VENUE_REFRESH_MS, news every NEWS_REFRESH_MS
//   • trendRows() / narratives() / newsItems() / postsFor(mint) — pure reads over what is in memory
// It never creates timers: the UI loop calls tick(now) at its 2 Hz data tick and awaits nothing, so a
// quit never waits on this module. Posts are retained for RETENTION_MS (24 h, design §6 "stored locally
// for 24 h for dedup/billing only") and pruned on tick.

import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { HttpClient } from '../http.ts';
import type { DexScreener } from '../sources/dexscreener.ts';
import type { Jupiter } from '../sources/jupiter.ts';
import { clusterPosts, countsForVelocity, markBurstSpam, markSquats } from './dedupe.ts';
import { firewallText } from './firewall.ts';
import type { KolStore } from './kol.ts';
import type { NewsItem, RawPost, SocialPost, TrendRow, Narrative, VenueSignal, PostFlag } from './model.ts';
import { POST_STORED_MAX } from './model.ts';
import { buildNarratives, buildTrendRow, credibilityOf, rankRows, type AuthorObservation } from './rank.ts';
import { NewsRss, NEWS_REFRESH_MS, newsTag } from './rss.ts';
import { TrendingVenues, type CgTrendingCoin } from './venues.ts';
import type { XFeedState, XFeedStatus } from '../x/source.ts';

/** What the feed needs from the X poller (task-1357): it ticks it, reads its status, and is its sink. */
export interface XAttachment { tick(now: number): void; status(): XFeedStatus; sink: ((raws: RawPost[]) => void) | null; close(): void }

export const VENUE_REFRESH_MS = 60_000;
export const RETENTION_MS = 24 * 3_600_000;
export const SOCIAL_WINDOW_MS = 3_600_000;
/** Hard cap on stored posts (memory guard; oldest pruned first). */
export const POSTS_MAX = 20_000;

export interface BoardToken { mint: string; symbol: string; name?: string }

export interface SocialFeedOptions {
  clock?: Clock;
  now?: () => number;
  kol?: KolStore | null;
  /** Keyless venue adapters; null = offline (tests feed venue signals through setVenue()). */
  venues?: TrendingVenues | null;
  news?: NewsRss | null;
  /** The board: tokens the screener currently knows (symbol ↔ mint resolution for news matching and squats). */
  board?: () => readonly BoardToken[];
  /** Live mints for a symbol (for unverified-cashtag). Defaults to the board index. */
  mintsForSymbol?: (symbol: string) => string[];
  venueRefreshMs?: number;
  newsRefreshMs?: number;
  onChange?: (reason: string) => void;
}

export interface IngestResult {
  accepted: number;
  flagged: { injection: number; spam: number; squat: number; dupes: number };
}

export interface SourceAge { id: string; label: string; ageMs: number | null; state: 'ok' | 'error' | 'off' | 'never'; error?: string }

export interface SocialStatus {
  sources: SourceAge[];
  posts: number;
  hiddenSpam: number;
  hiddenSquats: number;
  hiddenInjection: number;
  /** X is read only through the user's own login (task-1357); `logged-out` until then, and every degraded state is visible. */
  xState: XFeedState;
  /** The X poller's status line (`@handle · 12/300 search · $0.12 of $10 today`, or why it is degraded). */
  xDetail: string;
  xUser: { id: string; username: string } | null;
  venueErrors: Record<string, string>;
  newsErrors: Record<string, string>;
}

export function socialDeps(dl: { http: HttpClient; jupiter: Jupiter; dexscreener: DexScreener }): { venues: TrendingVenues; news: NewsRss } {
  return { venues: new TrendingVenues({ http: dl.http, jupiter: dl.jupiter, dexscreener: dl.dexscreener }), news: new NewsRss(dl.http) };
}

export class SocialFeed {
  readonly clock: Clock;
  private readonly now: () => number;
  readonly kol: KolStore | null;
  private readonly venues: TrendingVenues | null;
  private readonly news: NewsRss | null;
  private readonly board: () => readonly BoardToken[];
  private readonly mintsForSymbolFn: ((symbol: string) => string[]) | null;
  private readonly venueRefreshMs: number;
  private readonly newsRefreshMs: number;
  private readonly onChange: (reason: string) => void;

  private readonly posts = new Map<string, SocialPost>();
  private readonly byMint = new Map<string, Set<string>>();
  /** Original base58 addresses per post id (squat rule input); not part of the stored post. */
  private readonly addresses = new Map<string, string[]>();
  private readonly observations = new Map<string, AuthorObservation>();
  private readonly labels = new Map<string, string>();
  private readonly dirtyMints = new Set<string>();
  private venue = new Map<string, VenueSignal>();
  private coingecko: CgTrendingCoin[] = [];
  private venueFetchedAt: Partial<Record<string, number>> = {};
  venueErrors: Record<string, string> = {};
  newsErrors: Record<string, string> = {};
  private newsFetchedAt: number | null = null;
  private lastVenueAt = 0;
  private lastNewsAt = 0;
  private venueBusy = false;
  private newsBusy = false;
  private closed = false;
  private lastPrune = 0;
  /** The X poller (task-1357), attached by the live context when the user is logged in; null = never read X. */
  private x: XAttachment | null = null;
  /** Bumped by every mutation; with the 2 s time bucket it keys the trendRows() memo (renders run at up to 30 fps). */
  private version = 0;
  private memo: { key: string; rows: TrendRow[]; narratives: Narrative[] } | null = null;

  constructor(opts: SocialFeedOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.now = opts.now ?? (() => this.clock.now());
    this.kol = opts.kol ?? null;
    this.venues = opts.venues ?? null;
    this.news = opts.news ?? null;
    this.board = opts.board ?? (() => []);
    this.mintsForSymbolFn = opts.mintsForSymbol ?? null;
    this.venueRefreshMs = opts.venueRefreshMs ?? VENUE_REFRESH_MS;
    this.newsRefreshMs = opts.newsRefreshMs ?? NEWS_REFRESH_MS;
    this.onChange = opts.onChange ?? (() => {});
  }

  /** Attach the X poller: the feed ticks it and becomes its sink. Detach with null. */
  attachX(x: XAttachment | null): void {
    if (this.x) this.x.sink = null;
    this.x = x;
    if (x) x.sink = (raws) => { if (!this.closed) this.ingest(raws); };
    this.version += 1; this.memo = null;
    this.onChange('social:x');
  }

  /** The X poller's status, or a synthetic logged-out/off one. */
  xStatus(): XFeedStatus {
    if (this.x) return this.x.status();
    return { state: 'logged-out', user: null, detail: 'logged out · trenchscope x login (your own X app, your limits)', lastOkAt: null, lastError: null, resumesAt: null, spend: null, windows: {}, posts: 0, requests: 0 };
  }

  // ------------------------------------------------------------------ ingest

  /** Firewall + store + rules. Idempotent per post id (re-ingesting updates metrics only). */
  ingest(raws: readonly RawPost[]): IngestResult {
    const res: IngestResult = { accepted: 0, flagged: { injection: 0, spam: 0, squat: 0, dupes: 0 } };
    const now = this.now();
    for (const r of raws) {
      if (!r || typeof r.id !== 'string' || !r.id || typeof r.text !== 'string') continue;
      if (now - r.t > RETENTION_MS) continue; // too old to matter (and to keep)
      const existing = this.posts.get(r.id);
      if (existing) {
        existing.metrics = { likes: r.metrics?.likes ?? existing.metrics.likes, reposts: r.metrics?.reposts ?? existing.metrics.reposts, replies: r.metrics?.replies ?? existing.metrics.replies, views: r.metrics?.views ?? existing.metrics.views };
        continue;
      }
      const mints = [...new Set((r.mints ?? []).filter((m) => typeof m === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)))];
      const fw = firewallText(r.text, { keepMint: mints[0] ?? null, max: POST_STORED_MAX });
      const flags: PostFlag[] = [];
      if (fw.injection) { flags.push('injection'); res.flagged.injection += 1; }
      const author = { id: String(r.author?.id ?? r.author?.handle ?? '?'), handle: cleanHandle(r.author?.handle ?? '?'), tier: r.author?.tier ?? 'none', createdAt: typeof r.author?.createdAt === 'number' ? r.author.createdAt : null };
      // KOL lists decide the tier for X/TG/Discord authors; news domains stay `src`, chain rows keep theirs.
      if (this.kol && (r.platform === 'x' || r.platform === 'telegram' || r.platform === 'discord')) {
        if (this.kol.isMuted(author.handle)) continue; // muted handle: never stored
        const tier = this.kol.tierOf(author.handle);
        if (tier) author.tier = tier;
      }
      const post: SocialPost = {
        id: r.id, t: r.t, platform: r.platform, author,
        text: fw.text, url: safeUrl(r.url), lang: r.lang ?? null,
        metrics: { likes: num(r.metrics?.likes), reposts: num(r.metrics?.reposts), replies: num(r.metrics?.replies), views: r.metrics?.views ?? null },
        mints, cashtags: fw.cashtags, cluster: null, dupCount: 1, hidden: false, flags, collapsed: null,
        provenance: { source: String(r.source), fetchedAt: r.fetchedAt },
      };
      // News headlines are matched to the board by symbol/name (never trusted as the post's claim).
      if (post.platform === 'news') {
        if (post.mints.length === 0) post.mints = this.matchBoard(post.text);
        this.newsFetchedAt = Math.max(this.newsFetchedAt ?? 0, r.fetchedAt);
      }
      this.posts.set(post.id, post);
      this.addresses.set(post.id, fw.addresses);
      for (const m of post.mints.length ? post.mints : ['']) { const s = this.byMint.get(m) ?? new Set(); s.add(post.id); this.byMint.set(m, s); this.dirtyMints.add(m); }
      res.accepted += 1;
    }
    if (res.accepted) {
      this.applyRules();
      this.version += 1; this.memo = null;
      if (this.posts.size > POSTS_MAX) this.prune(now, true);
      this.onChange('social:ingest');
    }
    return res;
  }

  /** Re-run the deterministic rules on the mints touched since the last run. */
  private applyRules(): void {
    if (this.dirtyMints.size === 0) return;
    const now = this.now();
    const mintsForSymbol = this.mintsForSymbolFn ?? ((sym: string) => this.board().filter((b) => b.symbol.toUpperCase() === sym.toUpperCase()).map((b) => b.mint));
    for (const m of this.dirtyMints) {
      const posts = [...(this.byMint.get(m) ?? [])].map((id) => this.posts.get(id)).filter((p): p is SocialPost => !!p);
      clusterPosts(posts);
      markBurstSpam(posts, { now });
      markSquats(posts, { mintsForSymbol, addressesOf: (p) => this.addresses.get(p.id) ?? [] });
    }
    this.dirtyMints.clear();
  }

  /** Board tokens whose symbol (as `$SYM` or a whole word) or name appears in the headline. */
  private matchBoard(text: string): string[] {
    const out: string[] = [];
    const upper = text.toUpperCase();
    for (const b of this.board()) {
      const sym = b.symbol.toUpperCase();
      if (sym.length < 3) continue; // SOL/BTC-length symbols match everything
      const re = new RegExp(`(^|[^A-Z0-9])\\$?${sym.replace(/[^A-Z0-9_]/g, '')}([^A-Z0-9]|$)`);
      if (re.test(upper) || (b.name && b.name.length >= 5 && upper.includes(b.name.toUpperCase()))) out.push(b.mint);
    }
    return [...new Set(out)].slice(0, 6);
  }

  // ------------------------------------------------------------------ reads

  postsFor(mint: string, opts: { includeHidden?: boolean; includeSpam?: boolean; includeInjection?: boolean; sinceMs?: number } = {}): SocialPost[] {
    const ids = this.byMint.get(mint);
    if (!ids) return [];
    const now = this.now();
    const out: SocialPost[] = [];
    for (const id of ids) {
      const p = this.posts.get(id);
      if (!p) continue;
      if (opts.sinceMs !== undefined && now - p.t > opts.sinceMs) continue;
      if (p.hidden && !opts.includeHidden) continue;
      if (p.flags.includes('spam') && !opts.includeSpam && !p.collapsed) continue;
      if (p.flags.includes('injection') && !opts.includeInjection) continue;
      out.push(p);
    }
    return out.sort((a, b) => b.t - a.t);
  }

  /** Every stored post about a mint (rules input): hidden/spam/injection included. */
  allPostsFor(mint: string): SocialPost[] {
    return [...(this.byMint.get(mint) ?? [])].map((id) => this.posts.get(id)).filter((p): p is SocialPost => !!p);
  }

  get size(): number { return this.posts.size; }

  credibilityOfPost(p: SocialPost): number {
    return credibilityOf(p.author, this.observations.get(p.author.handle.replace(/^@/, '').toLowerCase()), this.now()).score;
  }

  /** Record a local observation about a handle (early-entry / confirm-rate); the only way credibility grows. */
  observe(handle: string, obs: AuthorObservation): void {
    const h = handle.replace(/^@/, '').toLowerCase();
    this.observations.set(h, { ...this.observations.get(h), ...obs });
    this.invalidate();
  }

  /** Label a narrative (from the analyst summary or the user); never from a single post. */
  labelNarrative(id: string, label: string): void { this.labels.set(id, label.slice(0, 24)); this.invalidate(); }

  setVenue(signals: Map<string, VenueSignal>, fetchedAt: Partial<Record<string, number>> = {}, coingecko: CgTrendingCoin[] = []): void {
    this.venue = signals;
    this.venueFetchedAt = { ...this.venueFetchedAt, ...fetchedAt };
    this.coingecko = coingecko;
    this.lastVenueAt = this.now();
    this.version += 1; this.memo = null;
    this.onChange('social:venue');
  }

  venueFor(mint: string): VenueSignal | null { return this.venue.get(mint) ?? null; }

  symbolOf(mint: string): string {
    return this.venue.get(mint)?.symbol ?? this.board().find((b) => b.mint === mint)?.symbol ?? this.allPostsFor(mint).find((p) => p.cashtags.length)?.cashtags[0] ?? `${mint.slice(0, 4)}…`;
  }

  /** Posts in the chain layer confirm attention (tracked wallet bought) when a kol-buy row exists in the window. */
  private chainConfirmed(mint: string): boolean {
    const now = this.now();
    return this.allPostsFor(mint).some((p) => p.platform === 'chain' && now - p.t < SOCIAL_WINDOW_MS && /tracked wallet|same slot/.test(p.text));
  }

  /** Invalidate the board memo (call after KOL list edits, which live outside this object). */
  invalidate(): void { this.version += 1; this.memo = null; }

  /** Ranked board rows over every mint with posts or venue signals (news-only mints excluded). Memoised per 2 s. */
  trendRows(): TrendRow[] {
    const key = `${this.version}:${Math.floor(this.now() / 2000)}`;
    if (this.memo?.key === key) return this.memo.rows;
    const rows = this.computeTrendRows();
    const narratives = this.narrativesFor(rows);
    const byMint = new Map<string, Narrative>();
    for (const n of narratives) for (const m of n.tokens) byMint.set(m, n);
    for (const r of rows) { const n = byMint.get(r.mint); if (n) r.narrative = n.label ?? n.symbols.slice(0, 3).join(' '); }
    this.memo = { key, rows, narratives };
    return rows;
  }

  private computeTrendRows(): TrendRow[] {
    const now = this.now();
    const kolHandles = this.kol?.kolHandles() ?? new Set<string>();
    const mints = new Set<string>(this.venue.keys());
    for (const [m, ids] of this.byMint) {
      if (!m) continue;
      for (const id of ids) { const p = this.posts.get(id); if (p && p.platform !== 'news') { mints.add(m); break; } }
    }
    const rows: TrendRow[] = [];
    for (const mint of mints) {
      const posts = this.allPostsFor(mint).filter((p) => p.platform !== 'news');
      rows.push(buildTrendRow({
        mint, symbol: this.symbolOf(mint), posts, venue: this.venue.get(mint) ?? null,
        credibility: (a) => credibilityOf(a, this.observations.get(a.handle.replace(/^@/, '').toLowerCase()), now).score,
        kolHandles, chainConfirmed: this.chainConfirmed(mint), now,
      }));
    }
    return rankRows(rows);
  }

  narratives(): Narrative[] { this.trendRows(); return this.memo?.narratives ?? []; }

  private narrativesFor(rows: readonly TrendRow[]): Narrative[] {
    const posts: SocialPost[] = [];
    // headlines are context, not signal: a news item naming two tokens never makes a narrative
    for (const r of rows) posts.push(...this.allPostsFor(r.mint).filter((p) => p.platform !== 'news'));
    return buildNarratives(rows, posts, this.kol?.kolHandles() ?? new Set(), this.labels, (m) => this.newsItems().filter((n) => n.crossRefs.includes(m)).length);
  }

  /** The NEWS column: firewalled headlines newest first, tagged, with board cross-refs. */
  newsItems(limit = 40): NewsItem[] {
    const out: NewsItem[] = [];
    for (const p of this.posts.values()) {
      if (p.platform !== 'news' || p.hidden || p.flags.includes('injection')) continue;
      const tag = p.mints.length ? 'cross-ref' : newsTag(p.text);
      out.push({ post: p, domain: p.author.handle, tag, crossRefs: p.mints });
    }
    return out.sort((a, b) => b.post.t - a.post.t).slice(0, limit);
  }

  /** News matched to one mint (token social panel). */
  newsFor(mint: string): NewsItem[] { return this.newsItems(200).filter((n) => n.crossRefs.includes(mint)); }

  coingeckoTrending(): CgTrendingCoin[] { return this.coingecko; }

  // ------------------------------------------------------------------ refresh

  /** Called by the UI loop at its data tick; kicks the paced refreshes when due. Never throws. */
  tick(now = this.now()): void {
    if (this.closed) return;
    if (this.venues && !this.venueBusy && now - this.lastVenueAt >= this.venueRefreshMs) void this.refreshVenues();
    if (this.news && !this.newsBusy && now - this.lastNewsAt >= this.newsRefreshMs) void this.refreshNews();
    if (this.x) { try { this.x.tick(now); } catch { /* the poller reports through its status */ } }
    if (now - this.lastPrune >= 60_000) this.prune(now);
  }

  async refreshVenues(): Promise<void> {
    if (!this.venues || this.venueBusy || this.closed) return;
    this.venueBusy = true;
    this.lastVenueAt = this.now();
    try {
      const c = await this.venues.collect((m) => this.board().find((b) => b.mint === m)?.symbol ?? null);
      if (this.closed) return;
      this.venueErrors = { ...c.errors } as Record<string, string>;
      this.setVenue(c.signals, c.fetchedAt, c.coingecko);
    } catch (e) {
      this.venueErrors = { all: (e instanceof Error ? e.message : String(e)).slice(0, 80) };
    } finally {
      this.venueBusy = false;
    }
  }

  async refreshNews(): Promise<void> {
    if (!this.news || this.newsBusy || this.closed) return;
    this.newsBusy = true;
    this.lastNewsAt = this.now();
    try {
      const r = await this.news.fetchAll();
      if (this.closed) return;
      this.newsErrors = r.errors;
      if (r.fetchedAt !== null) this.newsFetchedAt = r.fetchedAt;
      this.ingest(r.posts);
      this.onChange('social:news');
    } finally {
      this.newsBusy = false;
    }
  }

  /** Drop posts past retention (or down to POSTS_MAX when `hard`). */
  prune(now = this.now(), hard = false): number {
    this.lastPrune = now;
    let dropped = 0;
    const drop = (p: SocialPost) => {
      this.posts.delete(p.id);
      this.addresses.delete(p.id);
      for (const m of p.mints.length ? p.mints : ['']) { const s = this.byMint.get(m); if (s) { s.delete(p.id); if (s.size === 0) this.byMint.delete(m); } }
      dropped += 1;
    };
    for (const p of [...this.posts.values()]) if (now - p.t > RETENTION_MS) drop(p);
    if (dropped) { this.version += 1; this.memo = null; }
    if (hard && this.posts.size > POSTS_MAX) {
      const sorted = [...this.posts.values()].sort((a, b) => a.t - b.t);
      for (const p of sorted.slice(0, this.posts.size - POSTS_MAX)) drop(p);
    }
    return dropped;
  }

  status(): SocialStatus {
    const now = this.now();
    const age = (t: number | undefined | null): number | null => (typeof t === 'number' ? Math.max(0, now - t) : null);
    const src = (id: string, label: string, t: number | undefined | null, err: string | undefined, on: boolean): SourceAge => ({
      id, label, ageMs: age(t), state: !on ? 'off' : err ? 'error' : t ? 'ok' : 'never', error: err,
    });
    const v = this.venueFetchedAt;
    // a venue counts as "on" when an adapter exists OR signals were fed in (replay / demo via setVenue)
    const on = (t: number | undefined | null) => !!this.venues || typeof t === 'number';
    const xs = this.xStatus();
    const sources: SourceAge[] = [
      // x: `ok` with an age while reads flow; `error` carries the degraded reason; `off` when logged out
      { id: 'x', label: 'x-stream', ageMs: age(xs.lastOkAt), state: xs.state === 'logged-out' || xs.state === 'off' ? 'off' : xs.state === 'ok' ? (xs.lastOkAt ? 'ok' : 'never') : 'error', error: xs.state === 'ok' || xs.state === 'logged-out' || xs.state === 'off' ? undefined : xs.detail },
      src('jup', 'jupiter', v.jup ?? v.org, this.venueErrors.jup ?? this.venueErrors.org, on(v.jup ?? v.org)),
      src('gecko', 'gecko', v.gecko, this.venueErrors.gecko, on(v.gecko)),
      src('boost', 'boosts', v.boost, this.venueErrors.boost, on(v.boost)),
      src('cg', 'coingecko', v.cg, this.venueErrors.cg, on(v.cg)),
      src('news', 'news', this.newsFetchedAt, Object.keys(this.newsErrors).length ? Object.values(this.newsErrors)[0] : undefined, !!this.news || this.newsFetchedAt !== null || [...this.posts.values()].some((p) => p.platform === 'news')),
    ];
    let hiddenSpam = 0, hiddenSquats = 0, hiddenInjection = 0;
    for (const p of this.posts.values()) {
      if (p.flags.includes('injection')) hiddenInjection += 1;
      else if (p.flags.includes('spam')) hiddenSpam += p.collapsed ? p.collapsed.posts : p.hidden ? 0 : p.dupCount;
      else if (p.flags.includes('squat') || p.flags.includes('unverified-cashtag')) hiddenSquats += 1;
    }
    return { sources, posts: this.posts.size, hiddenSpam, hiddenSquats, hiddenInjection, xState: xs.state, xDetail: xs.detail, xUser: xs.user, venueErrors: this.venueErrors, newsErrors: this.newsErrors };
  }

  /** Data ages for the summary label (venue + news), ms. */
  ages(): Record<string, number | null> {
    const now = this.now();
    const v = this.venueFetchedAt;
    const out: Record<string, number | null> = {};
    if (v.jup ?? v.org) out.jupiter = now - (v.jup ?? v.org ?? now);
    if (v.gecko) out.gecko = now - v.gecko;
    if (v.boost) out.dexscreener = now - v.boost;
    if (this.newsFetchedAt) out['news-rss'] = now - this.newsFetchedAt;
    const xs = this.xStatus();
    out['x-stream'] = xs.lastOkAt !== null ? now - xs.lastOkAt : null;
    return out;
  }

  close(): void { this.closed = true; try { this.x?.close(); } catch { /* ignore */ } }
}

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function cleanHandle(h: string): string {
  const s = firewallText(h, { max: 40, keepUrls: false }).text.replace(/\s+/g, '');
  return s || '?';
}
function safeUrl(u: string | null | undefined): string | null {
  if (!u || typeof u !== 'string') return null;
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString().slice(0, 300) : null; } catch { return null; }
}
