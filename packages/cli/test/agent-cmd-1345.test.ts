// task-1345 tier 2: the `trenchscope agent` CLI — registry management, the agent packs listing, and a
// connect round trip against a live loopback bus. Hermetic: a temp DEXTERM_HOME, fixture executor, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, AgentBus, FixtureExecutor, FixtureFeed, MemoryProposalStore, MemoryAuditLog, SqliteProposalStore } from '@dexterm/agents';
import { runAgent } from '../src/agent-cmd.ts';
import type { Io } from '../src/main.ts';

function io(env: NodeJS.ProcessEnv = {}): Io & { out: string; err: string } {
  const o = {
    out: '', err: '', env,
    stdin: undefined as unknown as Io['stdin'],
    stdout: { write(s: string) { (o as { out: string }).out += s; return true; } } as unknown as Io['stdout'],
    stderr: { write(s: string) { (o as { err: string }).err += s; return true; } } as unknown as Io['stderr'],
  };
  return o as Io & { out: string; err: string };
}
function home(): { dir: string; env: NodeJS.ProcessEnv } { const dir = mkdtempSync(join(tmpdir(), 'dexterm-agent-')); return { dir, env: { DEXTERM_HOME: dir } }; }

test('add prints a one-time token once, persists only the hash, and list shows the agent', async () => {
  const { dir, env } = home();
  try {
    const a = io(env);
    assert.equal(await runAgent(['add', 'scanbot', '--tier', 'observe', '--note', 'read-only'], a), 0);
    const m = a.out.match(/dxa_[A-Za-z0-9_-]+/);
    assert.ok(m, 'a token was printed');
    assert.ok(existsSync(join(dir, 'agents.json')));
    const reg = new AgentRegistry({ env });
    assert.ok(reg.verify('scanbot', m![0]), 'the printed token authenticates');
    const l = io(env);
    await runAgent(['list'], l);
    assert.match(l.out, /scanbot/);
    assert.match(l.out, /observe/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotate invalidates the old token; remove deletes the agent', async () => {
  const { dir, env } = home();
  try {
    const add = io(env); await runAgent(['add', 'bot', '--tier', 'propose'], add);
    const t1 = add.out.match(/dxa_[A-Za-z0-9_-]+/)![0];
    const rot = io(env); await runAgent(['rotate', 'bot'], rot);
    const t2 = rot.out.match(/dxa_[A-Za-z0-9_-]+/)![0];
    assert.notEqual(t1, t2);
    const reg = new AgentRegistry({ env });
    assert.equal(reg.verify('bot', t1), null);
    assert.ok(reg.verify('bot', t2));
    const rm = io(env); assert.equal(await runAgent(['remove', 'bot'], rm), 0);
    assert.equal(new AgentRegistry({ env }).get('bot'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tier/pause/resume mutate the registry; bad usage returns a non-zero code', async () => {
  const { dir, env } = home();
  try {
    await runAgent(['add', 'bot', '--tier', 'observe'], io(env));
    await runAgent(['tier', 'bot', 'propose'], io(env));
    assert.equal(new AgentRegistry({ env }).get('bot')?.tier, 'propose');
    await runAgent(['pause', 'bot'], io(env));
    assert.equal(new AgentRegistry({ env }).get('bot')?.paused, true);
    await runAgent(['resume', 'bot'], io(env));
    assert.equal(new AgentRegistry({ env }).get('bot')?.paused, false);
    assert.equal(await runAgent(['add', 'bad name', '--tier', 'observe'], io(env)), 1);
    assert.equal(await runAgent(['tier', 'bot', 'root'], io(env)), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('packs lists the skills an external agent gets over MCP', async () => {
  const a = io({});
  assert.equal(await runAgent(['packs'], a), 0);
  assert.match(a.out, /trench-scan/);
  assert.match(a.out, /claude mcp add trenchscope/);
});

test('connect refuses when the token is not in the environment', async () => {
  const a = io({});
  assert.equal(await runAgent(['connect', '--name', 'bot'], a), 2);
  assert.match(a.err, /DEXTERM_AGENT_TOKEN/);
});

test('proposals lists DRAFT proposals from the shared DB, labelled with the agent', async () => {
  const { dir, env } = home();
  const dbPath = join(dir, 'db.sqlite');
  const store = new SqliteProposalStore(dbPath);
  store.create({ id: 's', agentId: 'a1', agentName: 'scanbot', tier: 'propose', transport: 'test', openedAt: 0, lastActivity: 0, closed: false, closedReason: null, client: 't', topics: new Set() }, 'propose_alert', { mint: 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', when: 'mcap crosses 1M', idempotency_key: 'k-aaaaaaaa' });
  store.close();
  try {
    const a = io(env);
    assert.equal(await runAgent(['proposals', '--db', dbPath], a), 0);
    assert.match(a.out, /scanbot/);
    assert.match(a.out, /alert/);
    assert.match(a.out, /never confirm or arm/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('connect round-trips against a live bus using the discovery file', async () => {
  const { dir, env } = home();
  const registry = new AgentRegistry({ env });
  const token = registry.add('scanbot', 'observe').token;
  const bus = new AgentBus({ registry, audit: new MemoryAuditLog(), executor: new FixtureExecutor(), proposals: new MemoryProposalStore(), feed: new FixtureFeed(), discoveryPath: join(dir, 'agent-bus.json') });
  await bus.start();
  try {
    const a = io({ ...env, DEXTERM_AGENT_TOKEN: token });
    const code = await runAgent(['connect', '--name', 'scanbot'], a);
    assert.equal(code, 0, a.err);
    assert.match(a.out, /connected as "scanbot" — tier observe/);
    assert.match(a.out, /screener_query/);
  } finally { await bus.close(); rmSync(dir, { recursive: true, force: true }); }
});
