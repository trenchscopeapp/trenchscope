// @dexterm/data — Login with X: OAuth 2.0 Authorization Code + PKCE on a loopback callback (task-1357).
//
//   login():   pkce + state → one-shot listener on http://127.0.0.1:41287/callback (binds 127.0.0.1 only, checks
//              Host, ignores wrong-state hits, 404s everything else) → opens the authorize URL in the user's
//              browser through a mode-0600 launcher file (never `open <url>` on argv) → exchanges the code at once
//              (X's code expires in 30 s) → stores the record → `/2/users/me` for the handle.
//   refresh(): grant_type=refresh_token (public client: client_id, no secret); the whole record is rewritten
//              because X may rotate the refresh token.
//   revoke():  POST /2/oauth2/revoke for both tokens, then the file is deleted even if X answered an error
//              (the user can also revoke at x.com/settings/connected_apps).
//
// Nothing here logs a token. Errors carry redacted text only. No `.write` / `dm.*` scope can be requested.

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { X_CALLBACK_PATH, X_CALLBACK_PORT, X_FORBIDDEN_SCOPE_RE, X_LIVE_ENDPOINTS, X_SCOPES, callbackUri, redactXSecrets, type XEndpoints } from './config.ts';
import { oauthState, pkce, safeEqual } from './pkce.ts';
import { XTokenStore, type XTokenRecord, type XUser } from './token-store.ts';
import { formBody, nodeXTransport, type XTransport } from './transport.ts';

const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

export type BrowserOpener = (url: string) => void;

export interface XOAuthOptions {
  store: XTokenStore;
  endpoints?: XEndpoints;
  transport?: XTransport;
  /** Default opens the OS browser via a 0600 launcher page; tests inject a function that hits the callback. */
  open?: BrowserOpener;
  port?: number;
  now?: () => number;
  /** How long to wait for the browser round trip (default 3 min). */
  loginTimeoutMs?: number;
}

export interface LoginResult {
  user: XUser | null;
  scopes: string[];
  expiresAt: number;
  hasRefresh: boolean;
  /** Timings for the status line (ms). */
  callbackMs: number;
  exchangeMs: number;
}

export class XAuthError extends Error {
  readonly kind: 'no-client-id' | 'denied' | 'timeout' | 'port-busy' | 'exchange' | 'refresh' | 'not-logged-in' | 'scope';
  constructor(kind: XAuthError['kind'], message: string) {
    super(redactXSecrets(message));
    this.name = 'XAuthError';
    this.kind = kind;
  }
}

/** The one-shot callback listener. Resolves with the code; everything else is ignored or 404. */
export function waitForCallback(opts: { state: string; port: number; timeoutMs: number; onListening?: () => void }): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let server: Server;
    // closeAllConnections: a keep-alive socket from this login must never be reused by the browser for the
    // NEXT login's redirect (it would land on this dead listener and be ignored as a state mismatch).
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { server.close(); server.closeAllConnections?.(); } catch { /* ignore */ } fn(); };
    const host = `127.0.0.1:${opts.port}`;
    server = createServer((req, res) => {
      const remote = req.socket.remoteAddress ?? '';
      if (!LOOPBACK.has(remote) || req.headers.host !== host) { res.writeHead(404); res.end(); return; }
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method !== 'GET' || url.pathname !== X_CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
      const st = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', connection: 'close', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      if (!safeEqual(st, opts.state)) { res.end(page('✗ state mismatch — this response was not for this login. Close the tab.')); return; } // not consumed; keep waiting
      if (err) { res.end(page(`✗ X returned: ${esc(err)}. Close the tab.`)); finish(() => reject(new XAuthError('denied', `authorization denied: ${err}`))); return; }
      if (!code) { res.end(page('✗ no code in the redirect. Close the tab.')); return; }
      res.end(page('✓ trenchscope is linked to your X account. You can close this tab.'));
      finish(() => resolve({ code }));
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10_000;
    server.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(e.code === 'EADDRINUSE' ? new XAuthError('port-busy', `port ${opts.port} is busy (another login in progress, or another process squats it): retry in a moment`) : e)));
    const timer = setTimeout(() => finish(() => reject(new XAuthError('timeout', `login timed out after ${Math.round(opts.timeoutMs / 1000)} s (no callback from the browser)`))), opts.timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    server.listen(opts.port, '127.0.0.1', () => opts.onListening?.());
  });
}

function esc(s: string): string { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)); }
function page(msg: string): string { return `<!doctype html><meta charset="utf-8"><title>trenchscope · X</title><body style="font:15px system-ui;background:#07090d;color:#d7dbe0;padding:2rem"><p>${msg}</p>`; }

/** Default opener: a mode-0600 redirect page handed to `open`/`xdg-open` so the URL never sits on an argv. */
export function defaultBrowserOpener(url: string): void {
  let dir: string | null = null;
  try { dir = mkdtempSync(join(tmpdir(), 'dexterm-x-')); writeFileSync(join(dir, 'open.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(url)}">`, { mode: 0o600 }); } catch { dir = null; }
  const child = spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', dir ? join(dir, 'open.html') : url] : [dir ? join(dir, 'open.html') : url], { stdio: 'ignore', detached: true });
  child.on('error', () => { /* the CLI prints the URL as a fallback */ });
  child.unref();
  if (dir) { const d = dir; const t = setTimeout(() => { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }, 20_000); (t as unknown as { unref?: () => void }).unref?.(); }
}

export class XOAuth {
  readonly store: XTokenStore;
  readonly endpoints: XEndpoints;
  readonly port: number;
  private readonly transport: XTransport;
  private readonly open: BrowserOpener;
  private readonly now: () => number;
  private readonly loginTimeoutMs: number;
  /** The authorize URL of the login in progress (the CLI prints it when the browser could not be opened). */
  lastAuthorizeUrl: string | null = null;

  constructor(opts: XOAuthOptions) {
    this.store = opts.store;
    this.endpoints = opts.endpoints ?? X_LIVE_ENDPOINTS;
    this.port = opts.port ?? X_CALLBACK_PORT;
    this.transport = opts.transport ?? nodeXTransport();
    this.open = opts.open ?? defaultBrowserOpener;
    this.now = opts.now ?? (() => Date.now());
    this.loginTimeoutMs = opts.loginTimeoutMs ?? 180_000;
  }

  get redirectUri(): string { return callbackUri(this.port); }

  /** Build the authorize URL (public values only: client id, challenge, state). */
  authorizeUrl(clientId: string, challenge: string, state: string, scopes: readonly string[] = X_SCOPES): string {
    for (const s of scopes) if (X_FORBIDDEN_SCOPE_RE.test(s)) throw new XAuthError('scope', `scope ${s} is never requested by dexterm`);
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: this.redirectUri, scope: scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return url.toString();
  }

  private async tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.transport({ method: 'POST', url: this.endpoints.token, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody(form) });
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(res.body) as Record<string, unknown>; } catch { j = null; }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`token endpoint ${res.status}: ${String(j?.error ?? '')} ${String(j?.error_description ?? '')}`.trim());
    }
    if (!j || typeof j.access_token !== 'string') throw new Error('token endpoint answered without an access_token');
    return j;
  }

  /** Run the whole login. Requires a stored client id. */
  async login(opts: { scopes?: readonly string[]; env?: NodeJS.ProcessEnv } = {}): Promise<LoginResult> {
    const clientId = this.store.clientId(opts.env ?? process.env);
    if (!clientId) throw new XAuthError('no-client-id', 'no X app Client ID stored: run `trenchscope x set-client-id` first (see docs: Login with X)');
    const { verifier, challenge } = pkce();
    const state = oauthState();
    const scopes = opts.scopes ?? X_SCOPES;
    const url = this.authorizeUrl(clientId, challenge, state, scopes);
    this.lastAuthorizeUrl = url;
    const t0 = this.now();
    const pending = waitForCallback({ state, port: this.port, timeoutMs: this.loginTimeoutMs, onListening: () => this.open(url) });
    const { code } = await pending;
    const tCallback = this.now();
    let j: Record<string, unknown>;
    try {
      j = await this.tokenRequest({ code, grant_type: 'authorization_code', client_id: clientId, redirect_uri: this.redirectUri, code_verifier: verifier });
    } catch (e) {
      throw new XAuthError('exchange', `code exchange failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const rec = this.store.setTokens(j as { access_token: string; refresh_token?: string | null; token_type?: string; scope?: string; expires_in?: number }, null);
    const user = await this.fetchMe(rec).catch(() => null);
    if (user) this.store.setUser(user);
    return { user, scopes: rec.scope.split(/\s+/).filter(Boolean), expiresAt: rec.expires_at, hasRefresh: !!rec.refresh_token, callbackMs: tCallback - t0, exchangeMs: this.now() - tCallback };
  }

  /** Rotate the access token. Throws XAuthError('refresh') and clears nothing on failure (the caller decides). */
  async refresh(env: NodeJS.ProcessEnv = process.env): Promise<XTokenRecord> {
    const clientId = this.store.clientId(env);
    const t = this.store.tokens();
    if (!clientId || !t) throw new XAuthError('not-logged-in', 'not logged in');
    if (!t.refresh_token) throw new XAuthError('refresh', 'no refresh token (login again with offline.access)');
    let j: Record<string, unknown>;
    try {
      j = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    } catch (e) {
      throw new XAuthError('refresh', `refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.store.setTokens(j as { access_token: string; refresh_token?: string | null; token_type?: string; scope?: string; expires_in?: number }, t.user);
  }

  /** A valid bearer, refreshing when within `skewMs` of expiry. Never logged by callers. */
  async bearer(env: NodeJS.ProcessEnv = process.env, skewMs = 60_000): Promise<string> {
    let t = this.store.tokens();
    if (!t) throw new XAuthError('not-logged-in', 'not logged in');
    if (t.expires_at <= this.now() + skewMs) t = await this.refresh(env);
    return t.access_token;
  }

  /** Revoke both tokens at X (best effort) and delete the local record. Returns the HTTP statuses seen. */
  async logout(env: NodeJS.ProcessEnv = process.env): Promise<{ revoked: Record<string, number>; hadTokens: boolean }> {
    const clientId = this.store.clientId(env);
    const t = this.store.tokens();
    const revoked: Record<string, number> = {};
    if (t && clientId) {
      for (const [k, v] of [['access_token', t.access_token], ['refresh_token', t.refresh_token]] as const) {
        if (!v) continue;
        try {
          const res = await this.transport({ method: 'POST', url: this.endpoints.revoke, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ token: v, client_id: clientId, token_type_hint: k }) });
          revoked[k] = res.status;
        } catch { revoked[k] = 0; }
      }
    }
    const hadTokens = this.store.clearTokens();
    return { revoked, hadTokens };
  }

  /** GET /2/users/me with a given record (login uses it before the adapter exists). */
  private async fetchMe(rec: XTokenRecord): Promise<XUser | null> {
    const res = await this.transport({ method: 'GET', url: `${this.endpoints.api}/2/users/me`, headers: { authorization: `Bearer ${rec.access_token}` } });
    if (res.status !== 200) return null;
    try {
      const j = JSON.parse(res.body) as { data?: { id?: string; username?: string } };
      return j.data && typeof j.data.id === 'string' && typeof j.data.username === 'string' ? { id: j.data.id, username: j.data.username } : null;
    } catch { return null; }
  }
}
