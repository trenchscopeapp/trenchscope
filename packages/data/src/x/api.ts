// @dexterm/data — the user-authorized X v2 read adapter (task-1357, lane I-02; INTEGRATIONS-DESIGN §4).
//
// Only these official endpoints, only in USER context (the user's own login, their rate windows, their bill):
//   GET /2/users/me                       identity (75 / 15 min)
//   GET /2/tweets/search/recent           per-token panel, `from:` KOL queries (300 / 15 min per user, 7 days)
//   GET /2/lists/:id/tweets               the user's own X lists as KOL feeds (900 / 15 min)
//   GET /2/users/:id/owned_lists          import own lists (15 / 15 min)
//   GET /2/lists/:id/members              the list's handles (900 / 15 min)
// Never: posting, liking, following, DMs, streams (economically unbounded), scraping of x.com pages.
//
// Every call: health gate + limiter bucket `x-api` → bearer from the OAuth client (refreshed near expiry) →
// node transport → the X rate-limit headers update a per-endpoint window → the spend meter counts NEW post ids
// → 15-minute query cache in the shared DB so re-opening a token is free. 401 = logged out (the user revoked
// at x.com); 429 = rate-limited until `x-rate-limit-reset`; 403 client-not-enrolled = the app's tier cannot
// read this endpoint (X Free tier: no search/list timelines). Each is a typed XApiError the poller turns into
// a VISIBLE state — never a silent empty feed. Raw tweet text leaves this module only as a RawPost, which the
// social feed firewalls on ingest; no tweet text is ever logged.

import type { Cache } from '../cache.ts';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { HealthRegistry } from '../health.ts';
import type { RateLimiter } from '../limiter.ts';
import type { RawPost } from '../social/model.ts';
import { X_LIVE_ENDPOINTS, redactXSecrets, type XEndpoints } from './config.ts';
import { XAuthError, type XOAuth } from './oauth.ts';
import type { XSpendMeter } from './budget.ts';
import type { XUser } from './token-store.ts';
import { nodeXTransport, type XHttpResponse, type XTransport } from './transport.ts';

export const X_BUCKET = 'x-api';
export const X_QUERY_NS = 'x:query';
export const X_QUERY_TTL_MS = 15 * 60_000;
export const X_SEARCH_MAX = 100;
export const X_TWEET_FIELDS = 'created_at,public_metrics,lang,author_id';
export const X_USER_FIELDS = 'created_at,username,name';

export type XApiErrorKind = 'unauthorized' | 'rate-limited' | 'not-enrolled' | 'forbidden' | 'no-credit' | 'http' | 'transport' | 'unavailable';

export class XApiError extends Error {
  readonly kind: XApiErrorKind;
  readonly status: number | null;
  /** Epoch ms when a rate-limited window resets (429 only). */
  readonly resetAt: number | null;
  constructor(kind: XApiErrorKind, message: string, status: number | null = null, resetAt: number | null = null) {
    super(redactXSecrets(message));
    this.name = 'XApiError';
    this.kind = kind;
    this.status = status;
    this.resetAt = resetAt;
  }
}

export interface XRateWindow { limit: number | null; remaining: number | null; resetAt: number | null; seenAt: number }

export interface XTweet {
  id: string;
  text: string;
  authorId: string;
  createdAt: number;
  lang: string | null;
  metrics: { likes: number; reposts: number; replies: number; views: number | null };
}
export interface XUserFull extends XUser { name: string | null; createdAt: number | null }
export interface XTweetPage {
  tweets: XTweet[];
  users: Map<string, XUserFull>;
  newestId: string | null;
  fetchedAt: number;
  /** Served from the 15-min cache (no request, nothing billed). */
  cached: boolean;
}
export interface XListInfo { id: string; name: string; memberCount: number | null }

export interface XApiOptions {
  oauth: XOAuth;
  endpoints?: XEndpoints;
  transport?: XTransport;
  limiter?: RateLimiter;
  health?: HealthRegistry;
  cache?: Cache;
  spend?: XSpendMeter;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  queryTtlMs?: number;
  onRequest?: (info: { endpoint: string; status: number | null; latencyMs: number; cached: boolean }) => void;
}

interface Envelope<T> { data?: T; includes?: { users?: unknown[] }; meta?: { result_count?: number; newest_id?: string; next_token?: string }; errors?: unknown[]; detail?: string; title?: string; reason?: string }

export class XApi {
  readonly endpoints: XEndpoints;
  private readonly oauth: XOAuth;
  private readonly transport: XTransport;
  private readonly limiter: RateLimiter | null;
  private readonly health: HealthRegistry | null;
  private readonly cache: Cache | null;
  readonly spend: XSpendMeter | null;
  private readonly clock: Clock;
  private readonly env: NodeJS.ProcessEnv;
  private readonly queryTtlMs: number;
  private readonly onRequest: XApiOptions['onRequest'];
  /** Per-endpoint windows from the last response headers (`search`, `list-tweets`, `me`, …). */
  readonly windows = new Map<string, XRateWindow>();

  constructor(opts: XApiOptions) {
    this.oauth = opts.oauth;
    this.endpoints = opts.endpoints ?? opts.oauth.endpoints ?? X_LIVE_ENDPOINTS;
    this.transport = opts.transport ?? nodeXTransport();
    this.limiter = opts.limiter ?? null;
    this.health = opts.health ?? null;
    this.cache = opts.cache ?? null;
    this.spend = opts.spend ?? null;
    this.clock = opts.clock ?? systemClock;
    this.env = opts.env ?? process.env;
    this.queryTtlMs = opts.queryTtlMs ?? X_QUERY_TTL_MS;
    this.onRequest = opts.onRequest;
  }

  /** The window for an endpoint key, or null when never seen / already reset. */
  window(key: string): XRateWindow | null {
    const w = this.windows.get(key);
    if (!w) return null;
    if (w.resetAt !== null && this.clock.now() >= w.resetAt) return null;
    return w;
  }

  private noteWindow(key: string, res: XHttpResponse): void {
    const num = (h: string): number | null => { const v = Number(res.headers[h]); return Number.isFinite(v) ? v : null; };
    const reset = num('x-rate-limit-reset');
    this.windows.set(key, { limit: num('x-rate-limit-limit'), remaining: num('x-rate-limit-remaining'), resetAt: reset !== null ? reset * 1000 : null, seenAt: this.clock.now() });
  }

  /** One authenticated GET. Throws XApiError; never logs a token or a tweet. */
  private async get<T>(key: string, path: string, params: Record<string, string>): Promise<{ data: Envelope<T>; res: XHttpResponse }> {
    if (this.health && !this.health.isAvailable('x-api')) throw new XApiError('unavailable', `x-api is ${this.health.state('x-api')}`);
    if (this.spend && !this.spend.allow()) throw new XApiError('no-credit', `daily X budget reached ($${this.spend.budgetUsd} — DEXTERM_X_DAILY_USD); reads resume at the next UTC day`);
    const w = this.window(key);
    if (w && w.remaining !== null && w.remaining <= 0 && w.resetAt !== null) throw new XApiError('rate-limited', `${key}: window exhausted`, 429, w.resetAt);
    let bearer: string;
    try { bearer = await this.oauth.bearer(this.env); } catch (e) {
      if (e instanceof XAuthError && (e.kind === 'not-logged-in')) throw new XApiError('unauthorized', 'not logged in', 401);
      throw new XApiError('unauthorized', `token refresh failed: ${e instanceof Error ? e.message : String(e)}`, 401);
    }
    if (this.limiter) await this.limiter.acquire(X_BUCKET);
    const url = `${this.endpoints.api}${path}?${new URLSearchParams(params).toString()}`;
    let res: XHttpResponse;
    try {
      res = await this.transport({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
    } catch (e) {
      const msg = redactXSecrets(e instanceof Error ? e.message : String(e));
      this.health?.record('x-api', { ok: false, error: msg });
      this.onRequest?.({ endpoint: key, status: null, latencyMs: 0, cached: false });
      throw new XApiError('transport', msg);
    }
    this.onRequest?.({ endpoint: key, status: res.status, latencyMs: res.latencyMs, cached: false });
    this.noteWindow(key, res);
    let body: Envelope<T> = {};
    try { body = JSON.parse(res.body) as Envelope<T>; } catch { body = {}; }
    if (res.status === 401) { this.health?.record('x-api', { ok: false, status: 401, latencyMs: res.latencyMs }); throw new XApiError('unauthorized', 'X answered 401: the login was revoked or expired — run `trenchscope x login`', 401); }
    if (res.status === 429) {
      const reset = Number(res.headers['x-rate-limit-reset']);
      const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : this.clock.now() + 15 * 60_000;
      if (this.limiter) this.limiter.pause(X_BUCKET, Math.max(1000, Math.min(resetAt - this.clock.now(), 15 * 60_000)));
      this.health?.record('x-api', { ok: false, status: 429, latencyMs: res.latencyMs });
      throw new XApiError('rate-limited', `${key}: X rate limit (resets ${new Date(resetAt).toISOString()})`, 429, resetAt);
    }
    if (res.status === 403) {
      this.health?.record('x-api', { ok: false, status: 403, latencyMs: res.latencyMs, error: String(body.reason ?? body.title ?? '') });
      if (body.reason === 'client-not-enrolled' || /enrollment|attached to a Project/i.test(String(body.detail ?? ''))) throw new XApiError('not-enrolled', `${key}: your X app's tier cannot read this endpoint (Free tier has no search / list timelines; see docs: Login with X)`, 403);
      throw new XApiError('forbidden', `${key}: X answered 403 ${String(body.title ?? '')}`.trim(), 403);
    }
    if (res.status < 200 || res.status >= 300) {
      this.health?.record('x-api', { ok: false, status: res.status, latencyMs: res.latencyMs });
      throw new XApiError('http', `${key}: X answered ${res.status} ${String(body.title ?? body.detail ?? '')}`.trim(), res.status);
    }
    this.health?.record('x-api', { ok: true, status: res.status, latencyMs: res.latencyMs });
    return { data: body, res };
  }

  private cacheKey(key: string, params: Record<string, string>): string {
    return `${key}:${new URLSearchParams(params).toString()}`;
  }

  private parsePage(env: Envelope<unknown[]>, fetchedAt: number, cached: boolean): XTweetPage {
    const users = new Map<string, XUserFull>();
    for (const u of env.includes?.users ?? []) {
      const r = u as { id?: unknown; username?: unknown; name?: unknown; created_at?: unknown };
      if (typeof r.id === 'string' && typeof r.username === 'string') users.set(r.id, { id: r.id, username: r.username, name: typeof r.name === 'string' ? r.name : null, createdAt: typeof r.created_at === 'string' ? Date.parse(r.created_at) || null : null });
    }
    const tweets: XTweet[] = [];
    for (const t of env.data ?? []) {
      const r = t as { id?: unknown; text?: unknown; author_id?: unknown; created_at?: unknown; lang?: unknown; public_metrics?: { like_count?: unknown; retweet_count?: unknown; reply_count?: unknown; impression_count?: unknown } };
      if (typeof r.id !== 'string' || typeof r.text !== 'string') continue;
      const m = r.public_metrics ?? {};
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      tweets.push({ id: r.id, text: r.text, authorId: typeof r.author_id === 'string' ? r.author_id : '?', createdAt: typeof r.created_at === 'string' ? Date.parse(r.created_at) || fetchedAt : fetchedAt, lang: typeof r.lang === 'string' ? r.lang : null, metrics: { likes: n(m.like_count), reposts: n(m.retweet_count), replies: n(m.reply_count), views: typeof m.impression_count === 'number' ? m.impression_count : null } });
    }
    return { tweets, users, newestId: typeof env.meta?.newest_id === 'string' ? env.meta.newest_id : (tweets[0]?.id ?? null), fetchedAt, cached };
  }

  private async page(key: string, path: string, params: Record<string, string>): Promise<XTweetPage> {
    const ck = this.cacheKey(key, params);
    const hit = this.cache?.get<Envelope<unknown[]>>(X_QUERY_NS, ck);
    if (hit && !hit.stale) { this.onRequest?.({ endpoint: key, status: 200, latencyMs: 0, cached: true }); return this.parsePage(hit.value, hit.fetchedAt, true); }
    const { data } = await this.get<unknown[]>(key, path, params);
    const fetchedAt = this.clock.now();
    this.cache?.set(X_QUERY_NS, ck, data, { ttlMs: this.queryTtlMs, fetchedAt });
    const page = this.parsePage(data, fetchedAt, false);
    this.spend?.record(page.tweets.map((t) => t.id), 0);
    return page;
  }

  async me(): Promise<XUserFull> {
    const { data } = await this.get<{ id?: string; username?: string; name?: string; created_at?: string }>('me', '/2/users/me', { 'user.fields': X_USER_FIELDS });
    const d = data.data;
    if (!d || typeof d.id !== 'string' || typeof d.username !== 'string') throw new XApiError('http', 'users/me answered without a user');
    this.spend?.record([], 1);
    return { id: d.id, username: d.username, name: typeof d.name === 'string' ? d.name : null, createdAt: typeof d.created_at === 'string' ? Date.parse(d.created_at) || null : null };
  }

  /**
   * search/recent. `query` is built by the caller from mints/handles/symbols (never from post text);
   * `-is:retweet -is:reply` are appended so reposts/replies are never billed.
   */
  searchRecent(query: string, opts: { maxResults?: number; sinceId?: string | null } = {}): Promise<XTweetPage> {
    const q = /-is:retweet/.test(query) ? query : `${query} -is:retweet -is:reply`;
    const params: Record<string, string> = { query: q.slice(0, 512), max_results: String(Math.max(10, Math.min(X_SEARCH_MAX, opts.maxResults ?? 50))), 'tweet.fields': X_TWEET_FIELDS, expansions: 'author_id', 'user.fields': X_USER_FIELDS };
    if (opts.sinceId) params.since_id = opts.sinceId;
    return this.page('search', '/2/tweets/search/recent', params);
  }

  listTweets(listId: string, opts: { maxResults?: number } = {}): Promise<XTweetPage> {
    if (!/^\d{1,30}$/.test(listId)) return Promise.reject(new XApiError('http', 'list id must be numeric'));
    return this.page('list-tweets', `/2/lists/${listId}/tweets`, { max_results: String(Math.max(1, Math.min(100, opts.maxResults ?? 50))), 'tweet.fields': X_TWEET_FIELDS, expansions: 'author_id', 'user.fields': X_USER_FIELDS });
  }

  async ownedLists(userId: string): Promise<XListInfo[]> {
    if (!/^\d{1,30}$/.test(userId)) throw new XApiError('http', 'user id must be numeric');
    const { data } = await this.get<{ id?: unknown; name?: unknown; member_count?: unknown }[]>('owned-lists', `/2/users/${userId}/owned_lists`, { 'list.fields': 'member_count,name', max_results: '100' });
    return (data.data ?? []).filter((l) => typeof l.id === 'string' && typeof l.name === 'string').map((l) => ({ id: l.id as string, name: l.name as string, memberCount: typeof l.member_count === 'number' ? l.member_count : null }));
  }

  async listMembers(listId: string): Promise<XUserFull[]> {
    if (!/^\d{1,30}$/.test(listId)) throw new XApiError('http', 'list id must be numeric');
    const { data } = await this.get<{ id?: unknown; username?: unknown; name?: unknown; created_at?: unknown }[]>('list-members', `/2/lists/${listId}/members`, { 'user.fields': X_USER_FIELDS, max_results: '100' });
    const out = (data.data ?? []).filter((u) => typeof u.id === 'string' && typeof u.username === 'string').map((u) => ({ id: u.id as string, username: u.username as string, name: typeof u.name === 'string' ? u.name : null, createdAt: typeof u.created_at === 'string' ? Date.parse(u.created_at) || null : null }));
    this.spend?.record([], out.length);
    return out;
  }
}

/** Build a per-token search query from RESOLVED facts (symbol, mint, project handle), never from post text. */
export function tokenQuery(opts: { symbol: string; mint: string; handle?: string | null }): string {
  const parts: string[] = [];
  const sym = opts.symbol.replace(/[^A-Za-z0-9_]/g, '');
  if (sym.length >= 2) parts.push(`$${sym}`);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(opts.mint)) parts.push(opts.mint);
  const h = (opts.handle ?? '').replace(/^@/, '');
  if (/^[A-Za-z0-9_]{1,15}$/.test(h)) parts.push(`from:${h}`);
  return `(${parts.join(' OR ')}) -is:retweet -is:reply`;
}

/** `from:` query for up to 20 handles (X caps queries at 512 chars on Basic/Pro). */
export function handlesQuery(handles: readonly string[]): string {
  const hs = handles.filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h)).slice(0, 20);
  return `(${hs.map((h) => `from:${h}`).join(' OR ')}) -is:retweet -is:reply`;
}

/** Tweet → RawPost for the social feed's ingest (which firewalls the text). `mints` are the CALLER's resolution. */
export function tweetToRaw(t: XTweet, users: ReadonlyMap<string, XUserFull>, opts: { mints: string[]; fetchedAt: number }): RawPost {
  const u = users.get(t.authorId);
  const handle = u ? `@${u.username}` : `@user${t.authorId.slice(-4)}`;
  return {
    id: `x:${t.id}`,
    t: t.createdAt,
    platform: 'x',
    author: { id: t.authorId, handle, tier: 'none', createdAt: u?.createdAt ?? null },
    text: t.text,
    url: u ? `https://x.com/${u.username}/status/${t.id}` : `https://x.com/i/status/${t.id}`,
    lang: t.lang,
    metrics: t.metrics,
    mints: opts.mints,
    source: 'x-api',
    fetchedAt: opts.fetchedAt,
  };
}
