// @dexterm/data — the X poller behind the social feed (task-1357). Attached to a SocialFeed; `tick(now)` is
// called from the feed's own tick (the UI's 2 Hz data tick), creates no timers, awaits nothing the quit path
// could wait on, and turns every failure into a VISIBLE state:
//
//   logged-out     no tokens (the header says `x ○ logged out · trenchscope x login`)
//   ok             reads flowing (`x ● @handle · 12/300 search · $0.12 today`)
//   rate-limited   429 or an exhausted window; shows the reset time; reads resume after it
//   no-credit      the daily spend budget is reached; resumes at the next UTC day
//   not-enrolled   the user's X app tier cannot read search/list timelines (Free tier)
//   error          transport / 5xx; retried on the next cycle with backoff
//
// What it polls (design §5.2 / §5.4): the OPEN token (search/recent every 60 s, cached 15 min per query,
// since_id so a re-poll costs only new posts), the user's own X lists (list tweets, every 5 min per list) and
// manual KOL lists (`from:` search in batches of 20, every 5 min). Never a cashtag stream, never scraping.
// Posts land in SocialFeed.ingest(), which firewalls the text; cashtags on KOL posts resolve to board mints
// only when the symbol is unique on the board (else the post stays unattributed).

import type { KolStore } from '../social/kol.ts';
import type { RawPost } from '../social/model.ts';
import { XApiError, handlesQuery, tokenQuery, tweetToRaw, type XApi, type XRateWindow } from './api.ts';
import type { XSpendStatus } from './budget.ts';
import type { XTokenStore, XUser } from './token-store.ts';

export type XFeedState = 'logged-out' | 'ok' | 'rate-limited' | 'no-credit' | 'not-enrolled' | 'error' | 'off';

export interface XFeedStatus {
  state: XFeedState;
  user: XUser | null;
  /** One line for headers: `@handle · 12/300 search · $0.12 of $10 today` or the reason when degraded. */
  detail: string;
  /** Epoch ms of the last successful read (the `x` source age). */
  lastOkAt: number | null;
  lastError: string | null;
  /** When a degraded state clears on its own (rate limit reset / budget reset), else null. */
  resumesAt: number | null;
  spend: XSpendStatus | null;
  windows: Record<string, XRateWindow>;
  /** Posts ingested from X in this run. */
  posts: number;
  /** Requests made in this run (cache hits excluded). */
  requests: number;
}

export interface XSourceOptions {
  api: XApi;
  store: XTokenStore;
  kol?: KolStore | null;
  now?: () => number;
  /** The board, for cashtag → mint resolution on KOL posts. */
  board?: () => readonly { mint: string; symbol: string }[];
  tokenPollMs?: number;
  kolPollMs?: number;
  /** Per-token search page size (billable per NEW post; 50 is the design default). */
  tokenMax?: number;
  onChange?: (reason: string) => void;
  onLog?: (line: string) => void;
}

export interface XFocus { mint: string; symbol: string; handle?: string | null }

export class XSource {
  private readonly api: XApi;
  private readonly store: XTokenStore;
  private readonly kol: KolStore | null;
  private readonly now: () => number;
  private readonly board: () => readonly { mint: string; symbol: string }[];
  private readonly tokenPollMs: number;
  private readonly kolPollMs: number;
  private readonly tokenMax: number;
  private readonly onChange: (reason: string) => void;
  private readonly onLog: ((line: string) => void) | null;
  private focus: XFocus | null = null;
  private sinceByMint = new Map<string, string>();
  private lastTokenAt = 0;
  private lastKolAt = 0;
  private lastFocusMint: string | null = null;
  private busy = false;
  private closed = false;
  private state: XFeedState = 'logged-out';
  private user: XUser | null = null;
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  private resumesAt: number | null = null;
  private errorBackoffUntil = 0;
  private errorStrikes = 0;
  private posts = 0;
  private requests = 0;
  /** Where posts go: set by SocialFeed.attachX(). */
  sink: ((raws: RawPost[]) => void) | null = null;
  private metaAt = 0;
  private metaCache: { loggedIn: boolean; user: XUser | null; obtainedAt: number | null } = { loggedIn: false, user: null, obtainedAt: null };
  /** `obtained_at` of the record X answered 401 for: only a NEWER login (trenchscope x login) re-arms the poller. */
  private deadObtainedAt: number | null = null;

  constructor(opts: XSourceOptions) {
    this.api = opts.api;
    this.store = opts.store;
    this.kol = opts.kol ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.board = opts.board ?? (() => []);
    this.tokenPollMs = opts.tokenPollMs ?? 60_000;
    this.kolPollMs = opts.kolPollMs ?? 5 * 60_000;
    this.tokenMax = opts.tokenMax ?? 50;
    this.onChange = opts.onChange ?? (() => {});
    this.onLog = opts.onLog ?? null;
    this.user = this.store.meta().user;
    this.state = this.store.meta().loggedIn ? 'ok' : 'logged-out';
  }

  /** The open token: polled every tokenPollMs while set (the first poll is immediate). */
  setFocus(f: XFocus | null): void {
    this.focus = f;
    if (f && f.mint !== this.lastFocusMint) { this.lastTokenAt = 0; this.lastFocusMint = f.mint; }
  }

  /** tokens.json is re-read at most every 5 s (status() runs on every tick and render). */
  private meta(now: number): { loggedIn: boolean; user: XUser | null; obtainedAt: number | null } {
    if (now - this.metaAt >= 5_000 || this.metaAt === 0) { const m = this.store.meta(); this.metaCache = { loggedIn: m.loggedIn, user: m.user, obtainedAt: m.obtainedAt }; this.metaAt = now; }
    return this.metaCache;
  }

  status(): XFeedStatus {
    const now = this.now();
    const meta = this.meta(now);
    if (!meta.loggedIn && this.state !== 'off') { this.state = 'logged-out'; this.user = null; this.deadObtainedAt = null; }
    else if (meta.loggedIn && this.state === 'logged-out' && (this.deadObtainedAt === null || meta.obtainedAt !== this.deadObtainedAt)) { this.state = 'ok'; this.user = meta.user; this.deadObtainedAt = null; this.lastError = null; }
    if ((this.state === 'rate-limited' || this.state === 'no-credit') && this.resumesAt !== null && now >= this.resumesAt) { this.state = 'ok'; this.resumesAt = null; }
    const spend = this.api.spend?.status() ?? null;
    const windows: Record<string, XRateWindow> = {};
    for (const k of ['search', 'list-tweets', 'me']) { const w = this.api.window(k); if (w) windows[k] = w; }
    const w = windows.search;
    const fmtIn = (t: number) => { const m = Math.max(0, Math.round((t - now) / 60_000)); return m < 1 ? '<1 min' : `${m} min`; };
    const used = w && w.limit !== null && w.remaining !== null ? `${w.limit - w.remaining}/${w.limit} search` : null;
    const money = spend ? `$${spend.usd.toFixed(2)} of $${spend.budgetUsd} today` : null;
    const who = this.user ? `@${this.user.username}` : 'logged in';
    const detail = this.state === 'logged-out' ? (this.deadObtainedAt !== null ? 'login revoked or expired at X · trenchscope x login' : 'logged out · trenchscope x login (your own X app, your limits)')
      : this.state === 'off' ? 'off in this mode'
        : this.state === 'rate-limited' ? `rate limited${this.resumesAt ? ` · resets in ${fmtIn(this.resumesAt)}` : ''} · keyless sources still live`
          : this.state === 'no-credit' ? `daily budget reached (${money ?? '?'})${this.resumesAt ? ` · resets in ${fmtIn(this.resumesAt)}` : ''}`
            : this.state === 'not-enrolled' ? `${who} · your X app tier cannot read search/list timelines (Free tier) · identity only`
              : this.state === 'error' ? `error · ${this.lastError ?? '?'} · retrying`
                : [who, used, money].filter(Boolean).join(' · ');
    return { state: this.state, user: this.user, detail, lastOkAt: this.lastOkAt, lastError: this.lastError, resumesAt: this.resumesAt, spend, windows, posts: this.posts, requests: this.requests };
  }

  /** Called from SocialFeed.tick(). Never throws, never awaited by the caller. */
  tick(now = this.now()): void {
    if (this.closed || this.busy) return;
    const st = this.status();
    if (st.state !== 'ok' && st.state !== 'error') return;
    if (st.state === 'error' && now < this.errorBackoffUntil) return;
    const tokenDue = !!this.focus && now - this.lastTokenAt >= this.tokenPollMs;
    const kolDue = !!this.kol && now - this.lastKolAt >= this.kolPollMs;
    if (!tokenDue && !kolDue) return;
    this.busy = true;
    void (async () => {
      try {
        if (tokenDue) { this.lastTokenAt = now; await this.pollToken(); }
        if (kolDue && !this.closed) { this.lastKolAt = now; await this.pollKol(); }
      } finally { this.busy = false; }
    })();
  }

  private fail(e: unknown): void {
    const now = this.now();
    if (e instanceof XApiError) {
      this.lastError = e.message;
      if (e.kind === 'unauthorized') { this.state = 'logged-out'; this.user = null; this.deadObtainedAt = this.store.meta().obtainedAt ?? -1; this.metaAt = 0; }
      else if (e.kind === 'rate-limited') { this.state = 'rate-limited'; this.resumesAt = e.resetAt ?? now + 15 * 60_000; }
      else if (e.kind === 'no-credit') { this.state = 'no-credit'; this.resumesAt = this.api.spend?.status().resetsAt ?? now + 3_600_000; }
      else if (e.kind === 'not-enrolled') { this.state = 'not-enrolled'; }
      else { this.state = 'error'; this.errorStrikes += 1; this.errorBackoffUntil = now + Math.min(10 * 60_000, 30_000 * 2 ** (this.errorStrikes - 1)); }
    } else {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.state = 'error'; this.errorStrikes += 1; this.errorBackoffUntil = now + Math.min(10 * 60_000, 30_000 * 2 ** (this.errorStrikes - 1));
    }
    this.onLog?.(`x-api: ${this.state}: ${this.lastError}`);
    this.onChange('social:x');
  }

  private ok(): void {
    this.state = 'ok'; this.lastError = null; this.resumesAt = null; this.errorStrikes = 0; this.lastOkAt = this.now();
  }

  private deliver(raws: RawPost[], reason: string): void {
    if (!raws.length || !this.sink) return;
    this.posts += raws.length;
    this.sink(raws);
    this.onChange(reason);
  }

  private async pollToken(): Promise<void> {
    const f = this.focus;
    if (!f || this.closed) return;
    try {
      const page = await this.api.searchRecent(tokenQuery({ symbol: f.symbol, mint: f.mint, handle: f.handle }), { maxResults: this.tokenMax, sinceId: this.sinceByMint.get(f.mint) ?? null });
      if (!page.cached) this.requests += 1;
      if (page.newestId) this.sinceByMint.set(f.mint, page.newestId);
      this.ok();
      this.deliver(page.tweets.map((t) => tweetToRaw(t, page.users, { mints: [f.mint], fetchedAt: page.fetchedAt })), 'social:x:token');
      if (page.cached) this.onChange('social:x');
    } catch (e) { this.fail(e); }
  }

  /** Symbol → mint when unique on the board. */
  private resolveCashtags(cashtags: readonly string[]): string[] {
    const board = this.board();
    const out: string[] = [];
    for (const c of cashtags) {
      const hits = board.filter((b) => b.symbol.toUpperCase() === c.toUpperCase());
      if (hits.length === 1) out.push(hits[0].mint);
    }
    return [...new Set(out)];
  }

  private async pollKol(): Promise<void> {
    if (!this.kol || this.closed) return;
    const lists = this.kol.all().filter((l) => l.enabled);
    const ownLists = lists.filter((l) => l.source === 'own-x-list' && /^own-x-list:\d+$/.test(l.id));
    const manualHandles = [...new Set(lists.filter((l) => l.source !== 'own-x-list').flatMap((l) => l.handles).filter((h) => !this.kol!.isMuted(h)))];
    try {
      for (const l of ownLists) {
        if (this.closed) return;
        const page = await this.api.listTweets(l.id.slice('own-x-list:'.length), { maxResults: 50 });
        if (!page.cached) this.requests += 1;
        this.ok();
        this.deliver(page.tweets.map((t) => tweetToRaw(t, page.users, { mints: this.resolveCashtags(cashtagsOf(t.text)), fetchedAt: page.fetchedAt })), 'social:x:kol');
      }
      for (let i = 0; i < manualHandles.length; i += 20) {
        if (this.closed) return;
        const page = await this.api.searchRecent(handlesQuery(manualHandles.slice(i, i + 20)), { maxResults: 50 });
        if (!page.cached) this.requests += 1;
        this.ok();
        this.deliver(page.tweets.map((t) => tweetToRaw(t, page.users, { mints: this.resolveCashtags(cashtagsOf(t.text)), fetchedAt: page.fetchedAt })), 'social:x:kol');
      }
    } catch (e) { this.fail(e); }
  }

  /** Import the user's own X lists as `own-x-list` KOL lists (handles only; posts are never stored by this). */
  async importOwnLists(): Promise<{ lists: { id: string; name: string; handles: number }[] }> {
    if (!this.kol) throw new XApiError('http', 'no KOL store');
    const me = this.user ?? (await this.api.me());
    this.user = me;
    const lists = await this.api.ownedLists(me.id);
    const out: { id: string; name: string; handles: number }[] = [];
    for (const l of lists) {
      const members = await this.api.listMembers(l.id);
      const handles = members.map((m) => m.username.toLowerCase());
      this.kol.seed({ id: `own-x-list:${l.id}`, name: l.name, source: 'own-x-list', handles, wallets: [], signed: null, since: this.now(), enabled: true, tier: 'kol-a' });
      out.push({ id: `own-x-list:${l.id}`, name: l.name, handles: handles.length });
    }
    this.ok();
    this.lastKolAt = 0; // poll the new lists on the next tick
    this.onChange('social:x:lists');
    return { lists: out };
  }

  close(): void { this.closed = true; }
}

const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9_]{0,15})\b/g;
export function cashtagsOf(text: string): string[] {
  return [...new Set([...text.matchAll(CASHTAG_RE)].map((m) => m[1].toUpperCase()))];
}
