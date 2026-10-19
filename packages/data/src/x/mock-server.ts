// @dexterm/data — a loopback MOCK of X's OAuth2 + the v2 read endpoints trenchscope uses (task-1357). Test
// support only: the default test suites and `trenchscope x` tests run the whole login + feed flow against this
// server and never touch x.com. It validates what the real X validates (client id, redirect uri, PKCE S256,
// single-use 30-s codes, bearer, refresh rotation, revoke) and can simulate rate limits (429 + x-rate-limit-*),
// expired tokens (401) and a Free-tier app (403 on search). Zero dependencies.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pkceMatches } from './pkce.ts';
import type { XEndpoints } from './config.ts';

export interface MockTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string; // ISO
  public_metrics?: { like_count: number; retweet_count: number; reply_count: number; impression_count?: number };
  lang?: string;
}
export interface MockUser { id: string; username: string; name?: string; created_at?: string }
export interface MockList { id: string; name: string; owner_id: string; member_ids: string[] }

export interface MockXOptions {
  clientId?: string;
  redirectUri?: string;
  /** Simulated user. */
  me?: MockUser;
  users?: MockUser[];
  tweets?: MockTweet[];
  lists?: MockList[];
  /** Free tier: search and list timelines answer 403 `client-not-enrolled`. */
  tier?: 'free' | 'basic' | 'pro';
  /** Access token lifetime reported in `expires_in`. */
  expiresIn?: number;
  /** Auto-approve the consent screen (default) or deny. */
  consent?: 'approve' | 'deny';
  now?: () => number;
}

export interface MockXState {
  /** Tokens issued so far (access → record). */
  access: Map<string, { user: MockUser; scope: string; expiresAt: number; revoked: boolean }>;
  refresh: Map<string, { user: MockUser; scope: string; revoked: boolean }>;
  codes: Map<string, { challenge: string; redirectUri: string; scope: string; issuedAt: number; used: boolean }>;
  /** Request log (method + path only, never bodies or headers). */
  log: string[];
  /** Per-endpoint call counters. */
  calls: Record<string, number>;
  /** Force the next N API calls to answer 429 (with the given reset epoch-seconds). */
  rateLimitNext: { n: number; resetAt: number } | null;
  /** Force API calls to answer 401 (simulates revoked at x.com). */
  unauthorized: boolean;
  /** Remaining in the simulated 15-min window per endpoint. */
  windows: Record<string, { limit: number; remaining: number; reset: number }>;
}

export interface MockXServer {
  url: string;
  port: number;
  endpoints: XEndpoints;
  state: MockXState;
  opts: Required<Pick<MockXOptions, 'clientId' | 'me' | 'tier' | 'consent'>> & MockXOptions;
  close(): Promise<void>;
}

/** Start the mock on an ephemeral loopback port. */
export function startMockX(options: MockXOptions = {}): Promise<MockXServer> {
  const now = options.now ?? (() => Date.now());
  const opts = {
    clientId: 'mock-client-id-1357',
    me: { id: '1001', username: 'dexterm_tester', name: 'trenchscope tester', created_at: '2020-01-01T00:00:00.000Z' },
    tier: 'basic' as const,
    consent: 'approve' as const,
    expiresIn: 7200,
    ...options,
  };
  const users = new Map<string, MockUser>([[opts.me.id, opts.me], ...(opts.users ?? []).map((u) => [u.id, u] as const)]);
  const tweets = [...(opts.tweets ?? [])];
  const lists = [...(opts.lists ?? [])];
  const state: MockXState = { access: new Map(), refresh: new Map(), codes: new Map(), log: [], calls: {}, rateLimitNext: null, unauthorized: false, windows: {} };
  const rid = () => randomBytes(12).toString('base64url');
  const windowFor = (key: string, limit: number) => {
    const w = state.windows[key] ?? (state.windows[key] = { limit, remaining: limit, reset: Math.floor(now() / 1000) + 900 });
    if (Math.floor(now() / 1000) >= w.reset) { w.remaining = w.limit; w.reset = Math.floor(now() / 1000) + 900; }
    return w;
  };

  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const key = `${req.method} ${url.pathname}`;
      state.log.push(key);
      state.calls[url.pathname] = (state.calls[url.pathname] ?? 0) + 1;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

        // ---- authorize: the "consent screen". Redirects to the app's callback with code+state (or error).
        if (req.method === 'GET' && url.pathname === '/i/oauth2/authorize') {
          const q = url.searchParams;
          const bad = (reason: string) => json(400, { error: 'invalid_request', error_description: reason });
          if (q.get('response_type') !== 'code') return bad('response_type');
          if (q.get('client_id') !== opts.clientId) return bad('client_id');
          if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return bad('pkce');
          const redirect = q.get('redirect_uri') ?? '';
          if (opts.redirectUri && redirect !== opts.redirectUri) return bad('redirect_uri');
          if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect)) return bad('redirect_uri must be http://127.0.0.1:<port>/callback');
          const scope = q.get('scope') ?? '';
          if (/\.write\b|\bdm\./.test(scope)) return bad('scope: write/dm scopes are refused by this mock (trenchscope never asks for them)');
          const back = new URL(redirect);
          back.searchParams.set('state', q.get('state') ?? '');
          if (opts.consent === 'deny') back.searchParams.set('error', 'access_denied');
          else { const code = rid(); state.codes.set(code, { challenge: q.get('code_challenge') as string, redirectUri: redirect, scope, issuedAt: now(), used: false }); back.searchParams.set('code', code); }
          res.writeHead(302, { location: back.toString() }); res.end(); return;
        }

        // ---- token: authorization_code (PKCE) and refresh_token grants, public client
        if (req.method === 'POST' && url.pathname === '/2/oauth2/token') {
          const f = new URLSearchParams(body);
          if (f.get('client_id') !== opts.clientId) return json(400, { error: 'invalid_client', error_description: 'Value passed for the client id was invalid.' });
          const issue = (user: MockUser, scope: string) => {
            const access = `at-${rid()}`, refresh = scope.includes('offline.access') ? `rt-${rid()}` : null;
            state.access.set(access, { user, scope, expiresAt: now() + opts.expiresIn * 1000, revoked: false });
            if (refresh) state.refresh.set(refresh, { user, scope, revoked: false });
            return json(200, { token_type: 'bearer', expires_in: opts.expiresIn, access_token: access, scope, ...(refresh ? { refresh_token: refresh } : {}) });
          };
          if (f.get('grant_type') === 'authorization_code') {
            const c = state.codes.get(f.get('code') ?? '');
            if (!c || c.used) return json(400, { error: 'invalid_grant', error_description: 'Value passed for the authorization code was invalid.' });
            if (now() - c.issuedAt > 30_000) return json(400, { error: 'invalid_grant', error_description: 'authorization code expired' });
            if (f.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
            if (!pkceMatches(f.get('code_verifier') ?? '', c.challenge)) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            c.used = true;
            return issue(opts.me, c.scope);
          }
          if (f.get('grant_type') === 'refresh_token') {
            const r = state.refresh.get(f.get('refresh_token') ?? '');
            if (!r || r.revoked) return json(400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' });
            r.revoked = true; // X rotates refresh tokens
            return issue(r.user, r.scope);
          }
          return json(400, { error: 'unsupported_grant_type' });
        }

        if (req.method === 'POST' && url.pathname === '/2/oauth2/revoke') {
          const f = new URLSearchParams(body);
          if (f.get('client_id') !== opts.clientId) return json(400, { error: 'invalid_client' });
          const t = f.get('token') ?? '';
          const a = state.access.get(t); if (a) a.revoked = true;
          const r = state.refresh.get(t); if (r) r.revoked = true;
          return json(200, { revoked: true });
        }

        // ---- v2 reads: bearer required
        const auth = req.headers.authorization ?? '';
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const a = state.access.get(bearer);
        if (!a || a.revoked || a.expiresAt <= now() || state.unauthorized) return json(401, { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' });
        if (state.rateLimitNext && state.rateLimitNext.n > 0) {
          state.rateLimitNext.n -= 1;
          return json(429, { title: 'Too Many Requests', detail: 'Too Many Requests', type: 'about:blank', status: 429 }, { 'x-rate-limit-limit': '1', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(state.rateLimitNext.resetAt) });
        }
        const limited = (key: string, limit: number, fn: () => void) => {
          const w = windowFor(key, limit);
          if (w.remaining <= 0) return json(429, { title: 'Too Many Requests', status: 429 }, { 'x-rate-limit-limit': String(w.limit), 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(w.reset) });
          w.remaining -= 1;
          res.setHeader('x-rate-limit-limit', String(w.limit)); res.setHeader('x-rate-limit-remaining', String(w.remaining)); res.setHeader('x-rate-limit-reset', String(w.reset));
          fn();
        };
        const userObj = (u: MockUser) => ({ id: u.id, username: u.username, name: u.name ?? u.username, created_at: u.created_at ?? '2021-01-01T00:00:00.000Z' });
        const tweetsPayload = (rows: MockTweet[], max: number) => {
          const data = rows.slice(0, max).map((t) => ({ id: t.id, text: t.text, author_id: t.author_id, created_at: t.created_at, lang: t.lang ?? 'en', public_metrics: t.public_metrics ?? { like_count: 0, retweet_count: 0, reply_count: 0 } }));
          const ids = [...new Set(data.map((t) => t.author_id))];
          return { data, includes: { users: ids.map((id) => users.get(id)).filter((u): u is MockUser => !!u).map(userObj) }, meta: { result_count: data.length, ...(data.length ? { newest_id: data[0].id, oldest_id: data[data.length - 1].id } : {}) } };
        };
        const notEnrolled = () => json(403, { client_id: opts.clientId, detail: 'When authenticating requests to the Twitter API v2 endpoints, you must use keys and tokens from a Twitter developer App that is attached to a Project. You can create a project via the Developer Portal.', registration_url: 'https://developer.twitter.com/en/docs/projects/overview', title: 'Client Forbidden', required_enrollment: 'Appropriate Level of API Access', reason: 'client-not-enrolled', type: 'https://api.twitter.com/2/problems/client-forbidden' });

        if (req.method === 'GET' && url.pathname === '/2/users/me') return limited('me', 75, () => json(200, { data: userObj(a.user) }));
        if (req.method === 'GET' && url.pathname === '/2/tweets/search/recent') {
          if (opts.tier === 'free') return notEnrolled();
          return limited('search', 300, () => {
            const q = (url.searchParams.get('query') ?? '').toLowerCase();
            const terms = q.replace(/-is:\w+|lang:\w+|[()]/g, ' ').split(/\s+or\s+|\s+/).map((s) => s.trim()).filter((s) => s && s !== 'or');
            const sinceId = url.searchParams.get('since_id');
            const rows = tweets.filter((t) => terms.some((term) => t.text.toLowerCase().includes(term.replace(/^\$/, '').replace(/^from:/, '')) || (term.startsWith('from:') && users.get(t.author_id)?.username.toLowerCase() === term.slice(5))))
              .filter((t) => !sinceId || BigInt(t.id) > BigInt(sinceId))
              .sort((x, y) => (BigInt(y.id) > BigInt(x.id) ? 1 : -1));
            json(200, tweetsPayload(rows, Math.min(100, Number(url.searchParams.get('max_results') ?? 10))));
          });
        }
        const listTweets = url.pathname.match(/^\/2\/lists\/(\d+)\/tweets$/);
        if (req.method === 'GET' && listTweets) {
          if (opts.tier === 'free') return notEnrolled();
          return limited('list-tweets', 900, () => {
            const l = lists.find((x) => x.id === listTweets[1]);
            if (!l) return json(404, { errors: [{ detail: 'Could not find list' }] });
            const members = new Set(l.member_ids);
            const rows = tweets.filter((t) => members.has(t.author_id)).sort((x, y) => (BigInt(y.id) > BigInt(x.id) ? 1 : -1));
            json(200, tweetsPayload(rows, Math.min(100, Number(url.searchParams.get('max_results') ?? 10))));
          });
        }
        const owned = url.pathname.match(/^\/2\/users\/(\d+)\/owned_lists$/);
        if (req.method === 'GET' && owned) return limited('owned-lists', 15, () => json(200, { data: lists.filter((l) => l.owner_id === owned[1]).map((l) => ({ id: l.id, name: l.name, member_count: l.member_ids.length })), meta: { result_count: lists.filter((l) => l.owner_id === owned[1]).length } }));
        const members = url.pathname.match(/^\/2\/lists\/(\d+)\/members$/);
        if (req.method === 'GET' && members) return limited('list-members', 900, () => {
          const l = lists.find((x) => x.id === members[1]);
          if (!l) return json(404, { errors: [{ detail: 'Could not find list' }] });
          json(200, { data: l.member_ids.map((id) => users.get(id)).filter((u): u is MockUser => !!u).map(userObj), meta: { result_count: l.member_ids.length } });
        });
        json(404, { title: 'Not Found', status: 404 });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        url: base, port, state, opts,
        endpoints: { authorize: `${base}/i/oauth2/authorize`, token: `${base}/2/oauth2/token`, revoke: `${base}/2/oauth2/revoke`, api: base },
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

/**
 * A browser stand-in: GET the authorize URL and follow the mock's 302 to the app's loopback callback.
 * Uses node:http (not fetch) so test files that block `globalThis.fetch` can still drive the flow.
 */
export async function mockBrowser(authorizeUrl: string): Promise<void> {
  const { request } = await import('node:http');
  const get = (u: string) => new Promise<{ status: number; location: string | null }>((resolve, reject) => {
    const r = request(u, { method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, location: typeof res.headers.location === 'string' ? res.headers.location : null })); });
    r.on('error', reject); r.end();
  });
  const first = await get(authorizeUrl);
  if (first.status === 302 && first.location) await get(first.location);
}
