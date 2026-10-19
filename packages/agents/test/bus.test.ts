// Tier 2 (task-1345): the loopback agent bus end to end — the real WebSocket server + the TS SDK client
// over a 127.0.0.1 socket, backed by the fixture executor/feed and the in-memory registry/audit/proposals.
// Proves auth, tier-filtered tools/list, gated calls, spoof/never refusals, subscriptions, proposals with
// idempotency, and kick — the transport a bring-your-own-agent actually uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentBus } from '../src/bus.ts';
import { AgentRegistry } from '../src/identity.ts';
import { MemoryAuditLog } from '../src/audit.ts';
import { FixtureExecutor, FixtureFeed } from '../src/executor.ts';
import { MemoryProposalStore } from '../src/proposals.ts';
import { DextermAgent } from '../src/sdk.ts';

async function harness() {
  const registry = new AgentRegistry({ path: ':memory:' });
  const audit = new MemoryAuditLog();
  const executor = new FixtureExecutor();
  const proposals = new MemoryProposalStore();
  const feed = new FixtureFeed();
  const bus = new AgentBus({ registry, audit, executor, proposals, feed, discoveryPath: null });
  const port = await bus.start();
  const url = `ws://127.0.0.1:${port}`;
  const tokens = {
    observer: registry.add('observer', 'observe').token,
    noter: registry.add('noter', 'annotate').token,
    proposer: registry.add('proposer', 'propose').token,
  };
  return { registry, audit, executor, proposals, feed, bus, url, tokens };
}

test('observe agent: hello, tier-filtered tools/list, a read call on fixtures', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'observer', token: h.tokens.observer, url: h.url, client: 'test 1.0' });
    assert.equal(a.hello?.tier, 'observe');
    const tools = await a.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('screener_query'));
    assert.ok(!names.includes('propose_alert'), 'observe must not be offered proposal tools');
    assert.ok(!names.includes('open_token'), 'observe must not be offered navigation tools');
    const rows = await a.call('screener_query', { preset: 'new', limit: 4 });
    assert.ok(Array.isArray(rows.rows) && (rows.rows as unknown[]).length > 0);
    a.close();
  } finally { await h.bus.close(); }
});

test('a wrong token fails authentication', async () => {
  const h = await harness();
  try {
    await assert.rejects(DextermAgent.connect({ name: 'observer', token: 'dxa_' + 'A'.repeat(43), url: h.url }), /authentication failed|closed/);
  } finally { await h.bus.close(); }
});

test('tier is enforced: an observe agent cannot call a proposal tool', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'observer', token: h.tokens.observer, url: h.url });
    await assert.rejects(a.call('propose_alert', { mint: 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', when: 'mcap crosses 1M', idempotency_key: 'k-aaaaaaaa' }), /tier/);
    a.close();
  } finally { await h.bus.close(); }
});

test('spoofing tier/identity in the arguments is refused', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'observer', token: h.tokens.observer, url: h.url });
    await assert.rejects(a.call('screener_query', { preset: 'new', tier: 'propose' } as Record<string, unknown>), /not yours to set|spoof/);
    a.close();
  } finally { await h.bus.close(); }
});

test('the never-list refuses a dangerous tool name sent straight over the wire', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'proposer', token: h.tokens.proposer, url: h.url });
    for (const bad of ['arm_plan', 'sign_tx', 'wallet_export', 'raise_cap', 'read_key']) {
      await assert.rejects(a.call(bad, {}), /no agent may do that|never/);
    }
    a.close();
  } finally { await h.bus.close(); }
});

test('propose agent: a proposal is created, labelled, idempotent, and listable', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'proposer', token: h.tokens.proposer, url: h.url });
    const args = { mint: 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', when: 'mcap crosses 1M', idempotency_key: 'dup-key-123456' };
    const r1 = await a.propose('propose_alert', args);
    assert.equal((r1.proposal as { agentName: string }).agentName, 'proposer');
    assert.equal((r1.proposal as { armed: boolean }).armed, false);
    assert.equal(r1.duplicate, false);
    const r2 = await a.propose('propose_alert', args); // same idempotency key
    assert.equal(r2.duplicate, true);
    assert.equal((r2.proposal as { id: string }).id, (r1.proposal as { id: string }).id);
    const list = await a.call('list_proposals', {});
    assert.equal((list.proposals as unknown[]).length, 1, 'the idempotent repeat did not create a second proposal');
    a.close();
  } finally { await h.bus.close(); }
});

test('subscriptions: a feed event reaches a subscribed agent', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'observer', token: h.tokens.observer, url: h.url });
    const got: Array<Record<string, unknown>> = [];
    a.on('new_pairs', (ev) => got.push(ev.data));
    const subs = await a.subscribe(['new_pairs']);
    assert.ok(subs.includes('new_pairs'));
    h.feed.emit('new_pairs', { mint: 'FixtMintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', symbol: 'MOONER' });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(got.some((d) => d.symbol === 'MOONER'), 'the subscribed event should have arrived');
    // an un-subscribed topic is not delivered
    const before = got.length;
    h.feed.emit('trades', { mint: 'x', side: 'buy', usd: 1 });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.length, before);
    a.close();
  } finally { await h.bus.close(); }
});

test('annotate agent: agent_note is recorded and labelled', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'noter', token: h.tokens.noter, url: h.url });
    const r = await a.call('agent_note', { mint: 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', text: 'looks organic', tag: 'watch' });
    assert.equal(r.ok, true);
    assert.equal(h.executor.notes.at(-1)?.agent, 'noter');
    a.close();
  } finally { await h.bus.close(); }
});

test('whoami reports the server-side tier and the roster sees the live session', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'proposer', token: h.tokens.proposer, url: h.url, client: 'claude-code 2.1' });
    const who = await a.whoami();
    assert.equal(who.tier, 'propose');
    const roster = h.bus.roster();
    assert.equal(roster.length, 1);
    assert.equal(roster[0].name, 'proposer');
    assert.equal(roster[0].sessions, 1);
    a.close();
  } finally { await h.bus.close(); }
});

test('kick closes the agent session', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'observer', token: h.tokens.observer, url: h.url });
    assert.equal(h.bus.roster().length, 1);
    const n = h.bus.kickAgent('observer');
    assert.equal(n, 1);
    await new Promise((r) => setTimeout(r, 40));
    await assert.rejects(a.call('screener_query', {}), /closed|internal/);
  } finally { await h.bus.close(); }
});

test('a paused agent is refused every call', async () => {
  const h = await harness();
  try {
    h.bus.pauseAgent('observer');
    const a = await DextermAgent.connect({ name: 'observer', token: h.tokens.observer, url: h.url });
    await assert.rejects(a.call('screener_query', { preset: 'new' }), /paused/);
    a.close();
  } finally { await h.bus.close(); }
});
