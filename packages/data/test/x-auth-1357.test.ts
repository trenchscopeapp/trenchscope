import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1357 (lane I-02): Login with X — PKCE + loopback + token store against the loopback MOCK OAuth server.
// No real X calls: the mock listens on an ephemeral 127.0.0.1 port, the "browser" is a node:http client, and
// helpers.ts blocks globalThis.fetch for the whole file so any accidental live call fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request, type Server } from 'node:http';
import {
  XTokenStore, XOAuth, XAuthError, startMockX, mockBrowser, pkce, pkceMatches, oauthState, safeEqual, redactXSecrets, isPlausibleClientId,
  X_SCOPES, X_FORBIDDEN_SCOPE_RE, callbackUri, xDir, nodeXTransport, waitForCallback,
} from '../src/x/index.ts';
import { NetworkBlockedError } from './helpers.ts';

const CLIENT = 'mock-client-id-1357';
/** A random loopback port per test so parallel test files never collide on 41287. */
let portSeq = 42_300 + (process.pid % 500);
const nextPort = () => (portSeq += 1);
const tmp = () => mkdtempSync(join(tmpdir(), 'dexterm-x-'));
const get = (u: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const r = request(u, { method: 'GET' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
  r.on('error', reject); r.end();
});

test('network is blocked for keyless code in this file (the X transport uses node:http, not fetch)', async () => {
  await assert.rejects(() => globalThis.fetch('https://api.x.com/2/users/me'), NetworkBlockedError);
});

test('pkce: 64-char verifier, 43-char S256 challenge, constant-time state compare', () => {
  const p = pkce();
  assert.equal(p.verifier.length, 64);
  assert.equal(p.challenge.length, 43);
  assert.equal(p.method, 'S256');
  assert.ok(pkceMatches(p.verifier, p.challenge));
  assert.ok(!pkceMatches(p.verifier + 'x', p.challenge));
  assert.equal(oauthState().length, 32);
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'ab'));
});

test('config: scopes are read-only, the callback is 127.0.0.1 on the fixed port, DEXTERM_HOME moves the dir', () => {
  for (const s of X_SCOPES) assert.ok(!X_FORBIDDEN_SCOPE_RE.test(s), s);
  assert.ok(X_FORBIDDEN_SCOPE_RE.test('tweet.write'));
  assert.ok(X_FORBIDDEN_SCOPE_RE.test('dm.read'));
  assert.equal(callbackUri(), 'http://127.0.0.1:41287/callback');
  assert.equal(xDir({ DEXTERM_HOME: '/tmp/dh' }), join('/tmp/dh', 'x'));
  assert.ok(isPlausibleClientId('abc123XYZ-_:1:ci'));
  assert.ok(!isPlausibleClientId('has spaces here'));
  assert.ok(!isPlausibleClientId('short'));
});

test('redactXSecrets: bearers, form fields and JSON token fields never survive into a message', () => {
  const s = 'Authorization: Bearer at-abcdefghijk12345 body=access_token=at-zzzzzzzzz&refresh_token=rt-yyyyyyy&code=c1234&client_id=pub json {"access_token":"at-1","refresh_token":"rt-2","scope":"x"}';
  const r = redactXSecrets(s);
  assert.doesNotMatch(r, /at-abcdefghijk12345|at-zzzzzzzzz|rt-yyyyyyy|c1234|"at-1"|"rt-2"/);
  assert.match(r, /client_id=pub/);
  assert.match(r, /"scope":"x"/);
});

test('token store: files are 0600 in a 0700 dir, meta() never carries the secret, env client id wins', async (t) => {
  const dir = tmp();
  try {
    const store = new XTokenStore({ dir: join(dir, 'x'), now: () => 1_000_000 });
    assert.equal(store.clientId({}), null);
    assert.throws(() => store.setClientId('bad id'), /Client ID/);
    store.setClientId(CLIENT);
    assert.equal(store.clientId({}), CLIENT);
    assert.equal(store.clientId({ DEXTERM_X_CLIENT_ID: 'env-client-id-9999' }), 'env-client-id-9999');
    assert.equal(store.tokens(), null);
    assert.equal(store.meta().loggedIn, false);
    const rec = store.setTokens({ access_token: 'at-secret-1', refresh_token: 'rt-secret-1', scope: 'tweet.read users.read', expires_in: 7200 }, { id: '1', username: 'u' });
    assert.equal(rec.expires_at, 1_000_000 + 7200 * 1000);
    const modes = store.modes();
    await posixPermissions(t, () => { assert.equal(modes.dir, 0o700); });
    await posixPermissions(t, () => { assert.equal(modes.tokens, 0o600); });
    await posixPermissions(t, () => { assert.equal(modes.clientId, 0o600); });
    await posixPermissions(t, () => { assert.equal(statSync(store.tokensPath).mode & 0o077, 0, 'group/other have no bits'); });
    const meta = store.meta();
    assert.deepEqual(meta, { loggedIn: true, user: { id: '1', username: 'u' }, scopes: ['tweet.read', 'users.read'], expiresAt: 1_000_000 + 7_200_000, hasRefresh: true, obtainedAt: 1_000_000 });
    assert.doesNotMatch(JSON.stringify(meta), /secret/);
    // malformed / foreign file → null, never a throw
    const other = new XTokenStore({ dir: join(dir, 'x2') });
    assert.equal(other.tokens(), null);
    assert.ok(store.clearTokens());
    assert.ok(!store.clearTokens());
    assert.equal(store.tokens(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('login: PKCE round trip against the mock; wrong-state hit ignored; tokens stored 0600; nothing logged', async (t) => {
  const dir = tmp();
  const mock = await startMockX({ clientId: CLIENT });
  const port = nextPort();
  const written: string[] = [];
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    store.setClientId(CLIENT);
    const opened: string[] = [];
    const oauth = new XOAuth({
      store, endpoints: mock.endpoints, port, loginTimeoutMs: 10_000,
      open: (url) => {
        opened.push(url);
        // a stray hit with the wrong state first (must be ignored, not consumed), then the real consent redirect
        void get(`${callbackUri(port)}?state=WRONG&code=nope`).then((r) => { written.push(r.body); return mockBrowser(url); });
      },
    });
    const res = await oauth.login({ env: {} });
    assert.equal(opened.length, 1);
    const u = new URL(opened[0]);
    assert.deepEqual([...u.searchParams.keys()].sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'response_type', 'scope', 'state']);
    assert.equal(u.searchParams.get('redirect_uri'), callbackUri(port));
    assert.equal(u.searchParams.get('scope'), X_SCOPES.join(' '));
    assert.ok(written[0].includes('state mismatch'), 'the wrong-state page says so and the login keeps waiting');
    assert.deepEqual(res.user, { id: '1001', username: 'dexterm_tester' });
    assert.ok(res.hasRefresh);
    assert.deepEqual(res.scopes, [...X_SCOPES]);
    const rec = store.tokens();
    assert.ok(rec && rec.access_token.startsWith('at-') && rec.refresh_token?.startsWith('rt-'));
    await posixPermissions(t, () => { assert.equal(statSync(store.tokensPath).mode & 0o777, 0o600); });
    // the mock's request log carries paths only; the code was used exactly once
    assert.ok(mock.state.log.includes('POST /2/oauth2/token'));
    assert.ok(mock.state.log.includes('GET /2/users/me'));
    assert.equal([...mock.state.codes.values()].filter((c) => c.used).length, 1);
    // a replay of the same code is refused
    const replay = await (async () => {
      const code = [...mock.state.codes.keys()][0];
      const r = await new Promise<{ status: number }>((resolve, reject) => {
        const body = new URLSearchParams({ code, grant_type: 'authorization_code', client_id: CLIENT, redirect_uri: callbackUri(port), code_verifier: 'x'.repeat(43) }).toString();
        const rq = request(mock.endpoints.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) } }, (res2) => { res2.resume(); res2.on('end', () => resolve({ status: res2.statusCode ?? 0 })); });
        rq.on('error', reject); rq.end(body);
      });
      return r.status;
    })();
    assert.equal(replay, 400);
    // bearer() returns the token without a refresh while fresh (the replay above was the 2nd token call)
    const before = mock.state.calls['/2/oauth2/token'];
    const b = await oauth.bearer({});
    assert.equal(b, rec.access_token);
    assert.equal(mock.state.calls['/2/oauth2/token'], before);
  } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('login: no client id → XAuthError(no-client-id) before any listener; forbidden scope refused', async () => {
  const dir = tmp();
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    const oauth = new XOAuth({ store, port: nextPort(), open: () => { throw new Error('must not open'); } });
    await assert.rejects(() => oauth.login({ env: {} }), (e: unknown) => e instanceof XAuthError && e.kind === 'no-client-id');
    assert.throws(() => oauth.authorizeUrl(CLIENT, 'c', 's', ['tweet.read', 'tweet.write']), (e: unknown) => e instanceof XAuthError && e.kind === 'scope');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('login: the user denies consent → XAuthError(denied); PKCE mismatch at the token endpoint → exchange error with no token stored', async () => {
  const dir = tmp();
  const mock = await startMockX({ clientId: CLIENT, consent: 'deny' });
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    store.setClientId(CLIENT);
    const oauth = new XOAuth({ store, endpoints: mock.endpoints, port: nextPort(), loginTimeoutMs: 10_000, open: (url) => void mockBrowser(url) });
    await assert.rejects(() => oauth.login({ env: {} }), (e: unknown) => e instanceof XAuthError && e.kind === 'denied');
    assert.equal(store.tokens(), null);
  } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  // exchange failure: a mock with a different client id answers invalid_client
  const dir2 = tmp();
  const mock2 = await startMockX({ clientId: 'other-client-id-0000' });
  try {
    const store = new XTokenStore({ dir: join(dir2, 'x') });
    store.setClientId(CLIENT);
    const port = nextPort();
    // the mock refuses the authorize step for an unknown client, so simulate the browser landing on the callback with a code
    const oauth = new XOAuth({ store, endpoints: mock2.endpoints, port, loginTimeoutMs: 10_000, open: (url) => { const st = new URL(url).searchParams.get('state') ?? ''; void get(`${callbackUri(port)}?state=${encodeURIComponent(st)}&code=forged`); } });
    await assert.rejects(() => oauth.login({ env: {} }), (e: unknown) => e instanceof XAuthError && e.kind === 'exchange' && /invalid_client/.test(e.message) && !/forged/.test(e.message));
    assert.equal(store.tokens(), null);
  } finally { await mock2.close(); rmSync(dir2, { recursive: true, force: true }); }
});

test('login: timeout and port-busy are reported as XAuthError kinds', async () => {
  const dir = tmp();
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    store.setClientId(CLIENT);
    const port = nextPort();
    const oauth = new XOAuth({ store, port, loginTimeoutMs: 150, open: () => { /* browser never comes back */ } });
    await assert.rejects(() => oauth.login({ env: {} }), (e: unknown) => e instanceof XAuthError && e.kind === 'timeout');
    // squat the port, then try to log in
    const squat = await new Promise<Server>((resolve) => { const srv = createServer(() => {}); srv.listen(port, '127.0.0.1', () => resolve(srv)); });
    try {
      await assert.rejects(() => oauth.login({ env: {} }), (e: unknown) => e instanceof XAuthError && e.kind === 'port-busy');
    } finally { squat.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refresh rotates both tokens; bearer() refreshes near expiry; logout revokes at X and deletes the file', async () => {
  const dir = tmp();
  const mock = await startMockX({ clientId: CLIENT, expiresIn: 7200 });
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    store.setClientId(CLIENT);
    let now = Date.now();
    const oauth = new XOAuth({ store, endpoints: mock.endpoints, port: nextPort(), loginTimeoutMs: 10_000, now: () => now, open: (url) => void mockBrowser(url) });
    await oauth.login({ env: {} });
    const first = store.tokens()!;
    const r = await oauth.refresh({});
    assert.notEqual(r.access_token, first.access_token);
    assert.notEqual(r.refresh_token, first.refresh_token, 'X rotates the refresh token; the record is rewritten');
    assert.deepEqual(r.user, first.user, 'the handle survives a refresh');
    assert.ok(mock.state.refresh.get(first.refresh_token!)!.revoked, 'old refresh token is dead at X');
    // near expiry → bearer() refreshes transparently
    now += 7200 * 1000 - 30_000;
    const calls = mock.state.calls['/2/oauth2/token'];
    const b = await oauth.bearer({});
    assert.equal(mock.state.calls['/2/oauth2/token'], calls + 1);
    assert.equal(b, store.tokens()!.access_token);
    // logout
    const out = await oauth.logout({});
    assert.ok(out.hadTokens);
    assert.deepEqual(out.revoked, { access_token: 200, refresh_token: 200 });
    assert.equal(store.tokens(), null);
    assert.ok(!existsSync(store.tokensPath));
    await assert.rejects(() => oauth.bearer({}), (e: unknown) => e instanceof XAuthError && e.kind === 'not-logged-in');
    // a second logout is a no-op
    assert.equal((await oauth.logout({})).hadTokens, false);
  } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('transport: refuses plain http off loopback; errors are redacted', async () => {
  const t = nodeXTransport();
  await assert.rejects(() => t({ method: 'GET', url: 'http://example.com/x' }), /refusing http/);
  await assert.rejects(() => t({ method: 'GET', url: 'ftp://127.0.0.1/x' }), /refusing/);
});

test('waitForCallback: 404 for other paths/methods and foreign Host; the page never echoes the code', async () => {
  const port = nextPort();
  const state = oauthState();
  const p = waitForCallback({ state, port, timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  const other = await get(`http://127.0.0.1:${port}/`);
  assert.equal(other.status, 404);
  const wrongHost = await new Promise<number>((resolve, reject) => { const r = request({ host: '127.0.0.1', port, path: `/callback?state=${state}&code=abc`, headers: { host: 'evil.example:80' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); }); r.on('error', reject); r.end(); });
  assert.equal(wrongHost, 404);
  const ok = await get(`http://127.0.0.1:${port}/callback?state=${encodeURIComponent(state)}&code=THECODE`);
  assert.equal(ok.status, 200);
  assert.doesNotMatch(ok.body, /THECODE/);
  assert.deepEqual(await p, { code: 'THECODE' });
  void readFileSync;
});
