// @dexterm/data — Login with X: constants, endpoints, local paths and secret redaction (task-1357, lane I-02;
// INTEGRATIONS-DESIGN §3, research/task-1289/xlogin).
//
// Facts this encodes (docs.x.com, fetched 2026-10-09 by the spike):
//   * authorize  https://x.com/i/oauth2/authorize   (response_type=code, client_id, redirect_uri, scope, state,
//                code_challenge, code_challenge_method=S256); the code must be exchanged within 30 s
//   * token      POST https://api.x.com/2/oauth2/token  (x-www-form-urlencoded; a Native App is a PUBLIC client:
//                client_id in the body, no secret). Access tokens live 2 h; refresh needs `offline.access`
//   * revoke     POST https://api.x.com/2/oauth2/revoke (token + client_id)
//   * callback   must match EXACTLY and must be http://127.0.0.1 (not localhost) for a local app → FIXED port
//   * rate limits are per USER for user-context tokens; pay-per-use credits bill the DEVELOPER account that owns
//     the app — each trenchscope user brings their OWN app (client id), so each user pays for their own reads.
//
// Every endpoint is injectable so tests run the whole flow against the loopback mock server (./mock-server.ts)
// and never touch x.com. Nothing in this directory ever logs a token: `redactXSecrets()` is applied to every
// error string that could reach a log, the screen or the health registry.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Fixed loopback port: X requires an exact-match callback URL, so the port is part of the app registration. */
export const X_CALLBACK_PORT = 41287;
export const X_CALLBACK_PATH = '/callback';

/** Scopes trenchscope asks for. Never any `.write` or `dm.*` — trenchscope never posts, likes, follows or DMs. */
export const X_SCOPES = ['tweet.read', 'users.read', 'list.read', 'offline.access'] as const;
export const X_FORBIDDEN_SCOPE_RE = /\.write$|^dm\./;

export interface XEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  /** API base, e.g. `https://api.x.com` (the adapter appends `/2/...`). */
  api: string;
}

export const X_LIVE_ENDPOINTS: XEndpoints = {
  authorize: 'https://x.com/i/oauth2/authorize',
  token: 'https://api.x.com/2/oauth2/token',
  revoke: 'https://api.x.com/2/oauth2/revoke',
  api: 'https://api.x.com',
};

export function callbackUri(port = X_CALLBACK_PORT): string {
  return `http://127.0.0.1:${port}${X_CALLBACK_PATH}`;
}

/** `$DEXTERM_HOME/x` (default `~/.dexterm/x`): client id + tokens, mode 0700. */
export function xDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
  return join(home, 'x');
}

const BEARER_RE = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_PARAM_RE = /((?:access_token|refresh_token|token|code|code_verifier|client_secret)=)[^&\s"'<>]+/gi;
const TOKEN_JSON_RE = /("(?:access_token|refresh_token|token|code_verifier|client_secret)"\s*:\s*")[^"]*(")/gi;

/** Strip bearer tokens, OAuth form fields and token-bearing JSON fields from any string. Safe on any input. */
export function redactXSecrets(text: string): string {
  return String(text).replace(BEARER_RE, '$1REDACTED').replace(TOKEN_PARAM_RE, '$1REDACTED').replace(TOKEN_JSON_RE, '$1REDACTED$2');
}

/** A client id is one token of URL-safe characters (X ids are base64url-ish and end in `:1:ci`). */
export function isPlausibleClientId(id: string): boolean {
  return /^[A-Za-z0-9._:~-]{8,128}$/.test(id);
}
