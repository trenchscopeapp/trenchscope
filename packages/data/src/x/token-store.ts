// @dexterm/data — local storage for the X client id and the user's OAuth tokens (task-1357).
//
//   <xDir>/client-id    the user's OWN X app Client ID (public-ish, kept out of argv/repo anyway), mode 0600
//   <xDir>/tokens.json  { v, access_token, refresh_token, token_type, scope, expires_at, obtained_at, user }, mode 0600
//
// The directory is created 0700. Nothing here prints a token: `meta()` is the only read meant for display and
// it carries ages, scopes and the handle, never the secret. The store is the ONLY module that reads tokens.json;
// the adapter asks it for a bearer and never keeps a copy longer than one request.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlausibleClientId, xDir } from './config.ts';

export interface XUser { id: string; username: string }

export interface XTokenRecord {
  v: 1;
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  scope: string;
  /** Epoch ms when the access token expires (X: 2 h). */
  expires_at: number;
  obtained_at: number;
  user: XUser | null;
}

/** Display-safe view of what is stored: no secret material. */
export interface XTokenMeta {
  loggedIn: boolean;
  user: XUser | null;
  scopes: string[];
  expiresAt: number | null;
  hasRefresh: boolean;
  obtainedAt: number | null;
}

export interface XTokenStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export class XTokenStore {
  readonly dir: string;
  private readonly now: () => number;

  constructor(opts: XTokenStoreOptions = {}) {
    this.dir = opts.dir ?? xDir(opts.env ?? process.env);
    this.now = opts.now ?? (() => Date.now());
  }

  get tokensPath(): string { return join(this.dir, 'tokens.json'); }
  get clientIdPath(): string { return join(this.dir, 'client-id'); }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.dir, 0o700); } catch { /* best effort on platforms without chmod */ }
  }

  private writePrivate(path: string, text: string): void {
    this.ensureDir();
    writeFileSync(path, text, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }

  // ---------------------------------------------------------------- client id

  /** `DEXTERM_X_CLIENT_ID` wins (CI / scripts), else the stored file; null when neither is usable. */
  clientId(env: NodeJS.ProcessEnv = process.env): string | null {
    const fromEnv = env.DEXTERM_X_CLIENT_ID?.trim();
    if (fromEnv && isPlausibleClientId(fromEnv)) return fromEnv;
    try {
      const v = readFileSync(this.clientIdPath, 'utf8').trim();
      return isPlausibleClientId(v) ? v : null;
    } catch { return null; }
  }

  setClientId(id: string): void {
    const v = id.trim();
    if (!isPlausibleClientId(v)) throw new Error('that does not look like an X app Client ID (8-128 URL-safe characters)');
    this.writePrivate(this.clientIdPath, v + '\n');
  }

  clearClientId(): boolean {
    if (!existsSync(this.clientIdPath)) return false;
    rmSync(this.clientIdPath, { force: true });
    return true;
  }

  // ---------------------------------------------------------------- tokens

  /** The full record (secret!). Only the OAuth client and the API adapter may call this. */
  tokens(): XTokenRecord | null {
    try {
      if (!existsSync(this.tokensPath)) return null;
      const raw = JSON.parse(readFileSync(this.tokensPath, 'utf8')) as Partial<XTokenRecord>;
      if (raw.v !== 1 || typeof raw.access_token !== 'string' || !raw.access_token) return null;
      return {
        v: 1,
        access_token: raw.access_token,
        refresh_token: typeof raw.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : null,
        token_type: typeof raw.token_type === 'string' ? raw.token_type : 'bearer',
        scope: typeof raw.scope === 'string' ? raw.scope : '',
        expires_at: Number(raw.expires_at) || 0,
        obtained_at: Number(raw.obtained_at) || 0,
        user: raw.user && typeof raw.user === 'object' && typeof raw.user.id === 'string' && typeof raw.user.username === 'string' ? { id: raw.user.id, username: raw.user.username } : null,
      };
    } catch { return null; }
  }

  /** Persist a token response. The whole record is rewritten (X may rotate the refresh token). */
  setTokens(res: { access_token: string; refresh_token?: string | null; token_type?: string; scope?: string; expires_in?: number }, user: XUser | null = this.tokens()?.user ?? null): XTokenRecord {
    if (typeof res.access_token !== 'string' || !res.access_token) throw new Error('token response carried no access_token');
    const now = this.now();
    const rec: XTokenRecord = {
      v: 1,
      access_token: res.access_token,
      refresh_token: res.refresh_token ?? null,
      token_type: res.token_type ?? 'bearer',
      scope: res.scope ?? '',
      expires_at: now + (Number(res.expires_in) > 0 ? Number(res.expires_in) : 7200) * 1000,
      obtained_at: now,
      user,
    };
    this.writePrivate(this.tokensPath, JSON.stringify(rec, null, 2) + '\n');
    return rec;
  }

  setUser(user: XUser): void {
    const t = this.tokens();
    if (!t) return;
    t.user = user;
    this.writePrivate(this.tokensPath, JSON.stringify(t, null, 2) + '\n');
  }

  clearTokens(): boolean {
    if (!existsSync(this.tokensPath)) return false;
    rmSync(this.tokensPath, { force: true });
    return true;
  }

  /** Display-safe status. */
  meta(): XTokenMeta {
    const t = this.tokens();
    if (!t) return { loggedIn: false, user: null, scopes: [], expiresAt: null, hasRefresh: false, obtainedAt: null };
    return { loggedIn: true, user: t.user, scopes: t.scope.split(/\s+/).filter(Boolean), expiresAt: t.expires_at, hasRefresh: !!t.refresh_token, obtainedAt: t.obtained_at };
  }

  /** File modes as the OS reports them (tests + doctor): null when a file is missing. */
  modes(): { dir: number | null; tokens: number | null; clientId: number | null } {
    const mode = (p: string): number | null => { try { return existsSync(p) ? (statSync(p).mode & 0o777) : null; } catch { return null; } };
    return { dir: mode(this.dir), tokens: mode(this.tokensPath), clientId: mode(this.clientIdPath) };
  }
}
