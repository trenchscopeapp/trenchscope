// trenchscope — `trenchscope x <status|set-client-id|login|logout>` (task-1357, lane I-02). Login with X through
// OAuth 2.0 PKCE on the fixed loopback callback; each user brings their OWN X app Client ID (their developer
// account, their rate limits, their bill). Tokens live in ~/.dexterm/x/tokens.json (0600) and are never
// printed: `status` shows the handle, scopes, ages and file modes only. No `.write`/`dm.*` scope is ever
// requested; trenchscope never posts.
import { XOAuth, XTokenStore, XAuthError, XApi, XSource, XSpendMeter, KolStore, X_SCOPES, callbackUri, redactXSecrets, type XEndpoints, type BrowserOpener, type Cache } from '@dexterm/data';

export interface XIo {
  stdout: { write(s: string): void; isTTY?: boolean };
  stderr: { write(s: string): void };
  env: NodeJS.ProcessEnv;
  stdin?: { isTTY?: boolean; setEncoding?(enc: string): unknown; on(event: 'data', cb: (chunk: Buffer | string) => void): unknown; once?(event: 'end', cb: () => void): unknown; off?(event: 'data', cb: (chunk: Buffer | string) => void): unknown; pause?(): unknown; resume?(): unknown };
}

export interface XCmdOverrides {
  store?: XTokenStore;
  endpoints?: XEndpoints;
  open?: BrowserOpener;
  port?: number;
  loginTimeoutMs?: number;
  now?: () => number;
}

export const X_HELP = `  trenchscope x status             Login with X: client id stored? logged in as @handle? scopes, expiry, file modes
  trenchscope x set-client-id      store YOUR X app's Client ID (prompted on the terminal, or one line on stdin with --stdin)
  trenchscope x login              OAuth2 PKCE in your browser → tokens in ~/.dexterm/x/tokens.json (0600); read scopes only
  trenchscope x logout             revoke both tokens at X and delete the local record`;

const fmtIn = (ms: number): string => {
  if (ms <= 0) return 'expired';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
};

/** Read one line from stdin (piped) or the TTY. Never echoes it back. */
function readLine(io: XIo, prompt: string): Promise<string | null> {
  const stdin = io.stdin;
  if (!stdin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; try { stdin.off?.('data', onData); } catch { /* ignore */ } try { stdin.pause?.(); } catch { /* ignore */ } resolve(v); };
    const onData = (chunk: Buffer | string) => { buf += chunk.toString(); const nl = buf.indexOf('\n'); if (nl >= 0) finish(buf.slice(0, nl).trim()); };
    if (stdin.isTTY) io.stderr.write(prompt);
    stdin.setEncoding?.('utf8');
    stdin.on('data', onData);
    stdin.once?.('end', () => finish(buf.trim() || null));
    stdin.resume?.();
  });
}

function printStatus(io: XIo, store: XTokenStore, now: number): void {
  const meta = store.meta();
  const modes = store.modes();
  const clientId = store.clientId(io.env);
  const oct = (m: number | null) => (m === null ? '—' : m.toString(8).padStart(3, '0'));
  io.stdout.write(`client id: ${clientId ? `stored (${io.env.DEXTERM_X_CLIENT_ID ? 'DEXTERM_X_CLIENT_ID' : store.clientIdPath})` : 'missing — run `trenchscope x set-client-id` (create a Native App with callback ' + callbackUri() + ' in your X developer portal)'}\n`);
  if (!meta.loggedIn) {
    io.stdout.write(`login: not logged in — run \`trenchscope x login\`${clientId ? '' : ' after storing the client id'}\n`);
  } else {
    io.stdout.write(`login: ${meta.user ? `@${meta.user.username} (id ${meta.user.id})` : 'logged in (handle unknown)'} · scopes ${meta.scopes.join(' ') || '—'} · access token ${meta.expiresAt !== null ? (meta.expiresAt > now ? `valid ${fmtIn(meta.expiresAt - now)}` : 'expired (refreshes on next use)') : '?'} · refresh ${meta.hasRefresh ? 'yes' : 'no (login again)'}\n`);
  }
  if (process.platform === 'win32') {
    io.stdout.write(`files: ${store.dir} · tokens.json ${modes.tokens === null ? 'absent' : 'present'} · client-id ${modes.clientId === null ? 'absent' : 'present'} · Windows ACL isolation is not verified\n`);
    io.stderr.write('Review the token directory Security permissions in Windows; chmod does not enforce owner-only ACLs.\n');
  } else {
    io.stdout.write(`files: ${store.dir} (mode ${oct(modes.dir)}) · tokens.json ${modes.tokens === null ? 'absent' : `mode ${oct(modes.tokens)}`} · client-id ${modes.clientId === null ? 'absent' : `mode ${oct(modes.clientId)}`}\n`);
    if ((modes.tokens !== null && modes.tokens !== 0o600) || (modes.dir !== null && modes.dir !== 0o700)) io.stderr.write('⚠ permissions are looser than 0600/0700; trenchscope will tighten them on the next write (or chmod them now)\n');
  }
  io.stdout.write(`callback: ${callbackUri()} · tokens are never printed, logged, or sent to a model · X reads are user-context only (your rate limits, your bill)\n`);
}

/** Run the `x` subcommand. Returns a process exit code. */
export async function runX(argv: string[], io: XIo, over: XCmdOverrides = {}): Promise<number> {
  const sub = argv[0] ?? 'status';
  const store = over.store ?? new XTokenStore({ env: io.env });
  const now = over.now ?? (() => Date.now());

  if (sub === 'status') { printStatus(io, store, now()); return 0; }

  if (sub === 'set-client-id') {
    const useStdin = argv.includes('--stdin');
    if (!useStdin && !(io.stdin && io.stdin.isTTY)) { io.stderr.write('trenchscope x set-client-id: paste the id on a terminal, or pipe ONE line with --stdin (never put it on the command line)\n'); return 2; }
    const v = await readLine(io, 'paste your X app Client ID and press enter: ');
    if (!v) { io.stderr.write('trenchscope x set-client-id: nothing read\n'); return 2; }
    try { store.setClientId(v); } catch (e) { io.stderr.write(`trenchscope x set-client-id: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }
    io.stdout.write(`stored (${v.length} chars) at ${store.clientIdPath} (${process.platform === 'win32' ? 'Windows ACL isolation unverified' : 'mode 600'}). Next: trenchscope x login\n`);
    return 0;
  }

  if (sub === 'login') {
    const oauth = new XOAuth({ store, endpoints: over.endpoints, open: over.open, port: over.port, loginTimeoutMs: over.loginTimeoutMs, now: over.now });
    if (!store.clientId(io.env)) { io.stderr.write(`trenchscope x login: no client id stored. Create a Native App (OAuth 2.0, callback ${callbackUri(over.port)}) in your X developer portal, then run \`trenchscope x set-client-id\`.\n`); return 2; }
    io.stdout.write(`Opening your browser to X (scopes: ${X_SCOPES.join(' ')} — read only; trenchscope never posts). Callback ${callbackUri(over.port)}.\n`);
    const t = setTimeout(() => { if (oauth.lastAuthorizeUrl) io.stderr.write(`If the browser did not open, paste this URL into it:\n${oauth.lastAuthorizeUrl}\n`); }, 4000);
    (t as unknown as { unref?: () => void }).unref?.();
    try {
      const res = await oauth.login({ env: io.env });
      clearTimeout(t);
      io.stdout.write(`✓ logged in${res.user ? ` as @${res.user.username}` : ''} · scopes ${res.scopes.join(' ')} · access token valid ${fmtIn(res.expiresAt - now())} · refresh ${res.hasRefresh ? 'yes' : 'no'} · browser ${Math.round(res.callbackMs / 100) / 10}s · exchange ${res.exchangeMs}ms\n`);
      io.stdout.write(`tokens: ${store.tokensPath} (${process.platform === 'win32' ? 'Windows ACL isolation unverified' : 'mode 600'}). The SOCIAL panel and TRENDING board now read X with your own limits.\n`);
      return 0;
    } catch (e) {
      clearTimeout(t);
      const msg = e instanceof Error ? e.message : String(e);
      io.stderr.write(`trenchscope x login failed: ${redactXSecrets(msg)}\n`);
      if (e instanceof XAuthError && e.kind === 'exchange' && /invalid_client/.test(msg)) io.stderr.write('  the Client ID is not one X recognises — check the app in your developer portal and re-run `trenchscope x set-client-id`\n');
      if (e instanceof XAuthError && e.kind === 'port-busy') io.stderr.write(`  port ${over.port ?? 41287} is in use; close the other login (or the process on that port) and retry\n`);
      return 1;
    }
  }

  if (sub === 'logout') {
    const oauth = new XOAuth({ store, endpoints: over.endpoints, open: over.open, port: over.port, now: over.now });
    const out = await oauth.logout(io.env);
    if (!out.hadTokens) { io.stdout.write('not logged in; nothing to revoke.\n'); return 0; }
    const parts = Object.entries(out.revoked).map(([k, s]) => `${k.replace('_token', '')} ${s === 200 ? 'revoked' : s === 0 ? 'unreachable' : `HTTP ${s}`}`);
    io.stdout.write(`✓ logged out · ${parts.join(' · ') || 'nothing to revoke'} · local tokens deleted. You can also check x.com/settings/connected_apps.\n`);
    return 0;
  }

  io.stderr.write(`trenchscope x: unknown subcommand ${JSON.stringify(sub)} (expected status | set-client-id | login | logout)\n`);
  return 2;
}

/**
 * `trenchscope kol import-x` (task-1357): the user's OWN X lists → `own-x-list` KOL lists (handles only). Needs a
 * login; a degraded X (401/429/403/budget) is reported as text, never as an empty import.
 */
export async function importOwnXLists(opts: { cache: Cache; env: NodeJS.ProcessEnv; store?: XTokenStore; endpoints?: XEndpoints; now?: () => number }): Promise<{ ok: true; lists: { id: string; name: string; handles: number }[] } | { ok: false; error: string }> {
  const store = opts.store ?? new XTokenStore({ env: opts.env });
  if (!store.meta().loggedIn) return { ok: false, error: 'not logged in to X — run `trenchscope x login` first (your own X app, read scopes only)' };
  const oauth = new XOAuth({ store, endpoints: opts.endpoints, now: opts.now });
  const api = new XApi({ oauth, endpoints: opts.endpoints, cache: opts.cache, spend: new XSpendMeter({ cache: opts.cache, env: opts.env, now: opts.now }), env: opts.env });
  const kol = new KolStore({ cache: opts.cache });
  const x = new XSource({ api, store, kol, now: opts.now });
  try {
    const r = await x.importOwnLists();
    return { ok: true, lists: r.lists };
  } catch (e) {
    return { ok: false, error: redactXSecrets(e instanceof Error ? e.message : String(e)) };
  } finally { x.close(); }
}
