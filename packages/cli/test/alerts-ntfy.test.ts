// ntfy alert channel: posts to the user's own topic with a title, priority and tag; the topic (the secret)
// never appears in a result, a reason or a log; credentials are validated and stored 0600; off by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeChannels, redactCreds, readNtfyCreds, writeNtfyCreds, ntfyCredsPath, type AlertDelivery } from '../src/alerts/index.ts';
import { createNtfyAdapter } from '../src/alerts/adapters/ntfy.ts';
import type { FetchLike } from '../src/alerts/adapters/telegram.ts';
import { alertsCommand } from '../src/alerts-cmd.ts';

const TOPIC = 'trench_alerts_x9Q2kLm7';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'trenchscope-ntfy-'));
const delivery = (level: AlertDelivery['level']): AlertDelivery => ({
  kind: 'alert', level, title: 'AFC dev sold 40%', body: 'dev wallet sold 40% of supply', spoken: 'AFC dev sold', symbol: 'AFC', mint: 'So11111111111111111111111111111111111111112', source: 'user', rule: 'r1', at: 1,
});

test('ntfy adapter: POSTs the line to server/topic with title, priority and tag; failures never echo the topic', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const ok: FetchLike = async (url, init) => { seen.push({ url, headers: init.headers, body: init.body }); return { ok: true, status: 200, text: async () => '' }; };
  const a = createNtfyAdapter({ creds: { topic: TOPIC, server: 'https://ntfy.sh' }, fetch: ok });
  assert.equal(a.available(), true);
  assert.deepEqual(await a.deliver(delivery('down')), { ok: true });
  assert.equal(seen[0].url, `https://ntfy.sh/${TOPIC}`);
  assert.equal(seen[0].headers.priority, '4', 'a dump buzzes');
  assert.equal(seen[0].headers.title, 'AFC dev sold 40%');
  assert.match(seen[0].body, /dev wallet sold/);
  const bad: FetchLike = async () => ({ ok: false, status: 403, text: async () => `forbidden ${TOPIC}` });
  const r = await createNtfyAdapter({ creds: { topic: TOPIC, server: 'https://ntfy.sh' }, fetch: bad }).deliver(delivery('info'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ntfy 403');
  const down: FetchLike = async () => { throw new Error(`connect ECONNREFUSED https://ntfy.sh/${TOPIC}`); };
  const r2 = await createNtfyAdapter({ creds: { topic: TOPIC, server: 'https://ntfy.sh' }, fetch: down }).deliver(delivery('info'));
  assert.equal(r2.reason, 'ntfy unreachable');
  assert.equal((await createNtfyAdapter({ creds: null }).deliver(delivery('info'))).skipped, true);
});

test('ntfy creds: guessable topics and non-https or path-carrying servers are refused; file is 0600-written and read back', () => {
  const home = tmp();
  assert.throws(() => writeNtfyCreds(home, { topic: 'abc' }), /8-64/);
  assert.throws(() => writeNtfyCreds(home, { topic: 'has spaces in it' }), /8-64/);
  assert.throws(() => writeNtfyCreds(home, { topic: TOPIC, server: 'http://ntfy.sh' }), /https origin/);
  assert.throws(() => writeNtfyCreds(home, { topic: TOPIC, server: 'https://evil.example/collect' }), /https origin/);
  writeNtfyCreds(home, { topic: TOPIC });
  assert.deepEqual(readNtfyCreds(home), { topic: TOPIC, server: 'https://ntfy.sh' });
  assert.ok(existsSync(ntfyCredsPath(home)));
});

test('ntfy is off until enabled, and redactCreds scrubs a topic URL', () => {
  assert.deepEqual(routeChannels(undefined, { kind: 'alert', level: 'down' }), ['toast']);
  assert.deepEqual(routeChannels({ channels: { ntfy: { enabled: true } } }, { kind: 'alert', level: 'down' }), ['toast', 'ntfy']);
  assert.equal(redactCreds(`posting to https://ntfy.sh/${TOPIC} failed`), 'posting to [redacted-ntfy] failed');
});

test('alerts set-ntfy stores the topic from the secret prompt (never argv) and status never prints it', async () => {
  const home = tmp();
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
  const stderr = new Writable({ write(_c, _e, cb) { cb(); } });
  const io = { stdout, stderr, env: { DEXTERM_HOME: home } };
  assert.equal(await alertsCommand(['set-ntfy'], io, { readSecret: async () => TOPIC }), 0);
  assert.deepEqual(readNtfyCreds(home), { topic: TOPIC, server: 'https://ntfy.sh' });
  assert.equal(await alertsCommand(['enable', 'ntfy'], io), 0);
  assert.equal(await alertsCommand(['status'], io), 0);
  assert.match(out, /ntfy\s+on\s+topic set \(https:\/\/ntfy\.sh\)/);
  assert.ok(!out.includes(TOPIC), 'the topic is never printed');
});
