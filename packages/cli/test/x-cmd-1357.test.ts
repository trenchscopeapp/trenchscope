import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1357 — `trenchscope x` against the loopback mock OAuth server: status/set-client-id/login/logout, and the
// invariant that no token ever reaches stdout/stderr. No real X calls (the mock is 127.0.0.1; fetch is blocked).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { XTokenStore, startMockX, mockBrowser } from '@dexterm/data';
import { runX, X_HELP, type XIo } from '../src/x-cmd.ts';

globalThis.fetch = (async () => { throw new Error('network blocked in tests'); }) as typeof fetch;

const CLIENT = 'mock-client-id-1357';
let portSeq = 43_300 + (process.pid % 500);
const nextPort = () => (portSeq += 1);

function io(stdin?: XIo['stdin']): XIo & { out: string; err: string } {
  const o = { out: '', err: '', env: {} as NodeJS.ProcessEnv, stdin,
    stdout: { write(s: string) { (o as { out: string }).out += s; } },
    stderr: { write(s: string) { (o as { err: string }).err += s; } } };
  return o;
}
/** A piped stdin: one line, then end. */
function pipedStdin(line: string): XIo['stdin'] {
  const em = new EventEmitter() as EventEmitter & { isTTY: boolean; setEncoding(): void; resume(): void; pause(): void };
  em.isTTY = false; em.setEncoding = () => {}; em.pause = () => {};
  em.resume = () => { setImmediate(() => { em.emit('data', line + '\n'); em.emit('end'); }); };
  return em as unknown as XIo['stdin'];
}

test('x status: nothing stored → tells the user what to create; help text mentions every subcommand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-xcmd-'));
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    const o = io();
    assert.equal(await runX(['status'], o, { store }), 0);
    assert.match(o.out, /client id: missing/);
    assert.match(o.out, /http:\/\/127\.0\.0\.1:41287\/callback/);
    assert.match(o.out, /not logged in/);
    for (const s of ['status', 'set-client-id', 'login', 'logout']) assert.ok(X_HELP.includes(`trenchscope x ${s}`), s);
    assert.equal(await runX(['bogus'], o, { store }), 2);
    assert.match(o.err, /unknown subcommand/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('x set-client-id: refuses argv-style use without a TTY or --stdin; accepts one piped line; validates the shape', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-xcmd-'));
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    let o = io();
    assert.equal(await runX(['set-client-id'], o, { store }), 2, 'no stdin at all');
    assert.match(o.err, /never put it on the command line/);
    o = io(pipedStdin('not a client id'));
    assert.equal(await runX(['set-client-id', '--stdin'], o, { store }), 2);
    assert.match(o.err, /Client ID/);
    o = io(pipedStdin(CLIENT));
    assert.equal(await runX(['set-client-id', '--stdin'], o, { store }), 0);
    assert.match(o.out, new RegExp(`stored \\(${CLIENT.length} chars\\)`));
    assert.doesNotMatch(o.out, new RegExp(CLIENT), 'the id itself is not echoed');
    assert.equal(store.clientId({}), CLIENT);
    await posixPermissions(t, () => { assert.equal(statSync(store.clientIdPath).mode & 0o777, 0o600); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('x login → status → logout against the mock; tokens never appear in any output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-xcmd-'));
  const mock = await startMockX({ clientId: CLIENT });
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    const port = nextPort();
    let o = io();
    assert.equal(await runX(['login'], o, { store, endpoints: mock.endpoints, port }), 2, 'no client id yet');
    assert.match(o.err, /no client id stored/);
    store.setClientId(CLIENT);
    o = io();
    assert.equal(await runX(['login'], o, { store, endpoints: mock.endpoints, port, loginTimeoutMs: 10_000, open: (url) => void mockBrowser(url) }), 0);
    assert.match(o.out, /✓ logged in as @dexterm_tester/);
    assert.match(o.out, /scopes tweet\.read users\.read list\.read offline\.access/);
    const rec = JSON.parse(readFileSync(store.tokensPath, 'utf8')) as { access_token: string; refresh_token: string };
    assert.doesNotMatch(o.out + o.err, new RegExp(rec.access_token));
    assert.doesNotMatch(o.out + o.err, new RegExp(rec.refresh_token));
    o = io();
    assert.equal(await runX(['status'], o, { store }), 0);
    assert.match(o.out, /login: @dexterm_tester \(id 1001\)/);
    assert.match(o.out, /access token valid/);
    if (process.platform === 'win32') {
      assert.match(o.out, /tokens\.json present.*Windows ACL isolation is not verified/);
      assert.match(o.err, /chmod does not enforce owner-only ACLs/);
      assert.doesNotMatch(o.out, /mode 600/);
    } else assert.match(o.out, /tokens\.json mode 600/);
    assert.doesNotMatch(o.out + o.err, new RegExp(rec.access_token));
    o = io();
    assert.equal(await runX(['logout'], o, { store, endpoints: mock.endpoints }), 0);
    assert.match(o.out, /access revoked · refresh revoked · local tokens deleted/);
    assert.equal(store.tokens(), null);
    assert.ok(mock.state.access.get(rec.access_token)?.revoked);
    o = io();
    assert.equal(await runX(['logout'], o, { store, endpoints: mock.endpoints }), 0);
    assert.match(o.out, /not logged in/);
  } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('x login: a wrong client id surfaces invalid_client with a hint, exit 1, nothing stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-xcmd-'));
  const mock = await startMockX({ clientId: 'someone-elses-app-id' });
  try {
    const store = new XTokenStore({ dir: join(dir, 'x') });
    store.setClientId(CLIENT);
    const port = nextPort();
    const o = io();
    // the mock refuses the authorize step for an unknown client id → the browser lands on the callback with a code anyway (simulated)
    const { request } = await import('node:http');
    const open = (url: string) => { const st = new URL(url).searchParams.get('state') ?? ''; const r = request(`http://127.0.0.1:${port}/callback?state=${encodeURIComponent(st)}&code=x`, (res) => res.resume()); r.on('error', () => {}); r.end(); };
    assert.equal(await runX(['login'], o, { store, endpoints: mock.endpoints, port, loginTimeoutMs: 10_000, open }), 1);
    assert.match(o.err, /invalid_client/);
    assert.match(o.err, /re-run `trenchscope x set-client-id`/);
    assert.equal(store.tokens(), null);
  } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});
