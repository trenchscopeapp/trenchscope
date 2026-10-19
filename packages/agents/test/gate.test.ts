// Tier 1 (task-1345): the gate every agent call passes. One function, on every transport, refuses
// the shape of a dangerous request (never-list) before any lookup, enforces the granted tier, validates
// arguments against a closed schema, enforces rate limits and quotas, requires an idempotency key on a
// proposal, and trips a flood breaker on sustained refusals. Nothing here can arm/sign/cap/gate/wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentGate, DEFAULT_LIMITS, FLOOD_REFUSALS, type AgentSession } from '../src/gate.ts';
import { MemoryAuditLog } from '../src/audit.ts';
import type { JsonSchema } from '../src/schema.ts';

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1', agentId: 'a1', agentName: 'scanbot', tier: 'propose', transport: 'test',
    openedAt: 0, lastActivity: 0, closed: false, closedReason: null, client: 'test', topics: new Set(),
    ...over,
  };
}

const PROPOSAL_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { mint: { type: 'string', maxLength: 44 }, idempotency_key: { type: 'string', maxLength: 64 } },
  required: ['mint', 'idempotency_key'], additionalProperties: false,
};

function mkGate(now = { t: 1_000_000 }, paused = new Set<string>()) {
  const audit = new MemoryAuditLog({ now: () => now.t });
  const gate = new AgentGate({ audit, now: () => now.t, isPaused: (id) => paused.has(id) });
  return { gate, audit, now, paused };
}

test('a read tool passes for an observe agent', () => {
  const { gate } = mkGate();
  const r = gate.check(session({ tier: 'observe' }), { tool: 'get_token', args: { mint: 'abc' }, schema: { type: 'object', properties: { mint: { type: 'string' } }, additionalProperties: false } });
  assert.ok(r.ok && r.tier === 'observe');
});

test('never-list is refused before any lookup, at every tier', () => {
  const { gate, audit } = mkGate();
  for (const tool of ['arm_plan', 'sign_tx', 'raise_cap', 'wallet_export', 'read_key', 'exec', 'set_tier']) {
    const r = gate.check(session(), { tool });
    assert.ok(!r.ok && r.code === 'never', `${tool} should be refused as never`);
  }
  assert.ok(audit.recent(50).every((e) => e.kind === 'refused'));
});

test('tier is enforced from the session, not the request', () => {
  const { gate } = mkGate();
  const r = gate.check(session({ tier: 'observe' }), { tool: 'propose_alert', args: { mint: 'a', idempotency_key: 'key12345' }, schema: PROPOSAL_SCHEMA });
  assert.ok(!r.ok && r.code === 'tier');
});

test('spoofing identity/tier in the arguments is refused', () => {
  const { gate } = mkGate();
  for (const f of ['tier', 'agent', 'agentId', 'session', 'token', 'on_behalf_of', 'impersonate']) {
    const r = gate.check(session(), { tool: 'get_token', args: { [f]: 'x' }, schema: { type: 'object', properties: { mint: { type: 'string' } }, additionalProperties: true } });
    assert.ok(!r.ok && r.code === 'spoof', `argument ${f} should be refused as spoof`);
  }
});

test('an unknown tool is refused', () => {
  const { gate } = mkGate();
  const r = gate.check(session(), { tool: 'make_me_rich' });
  assert.ok(!r.ok && r.code === 'unknown-tool');
});

test('bad arguments and oversize payloads are refused', () => {
  const { gate } = mkGate();
  const bad = gate.check(session(), { tool: 'get_token', args: { mint: 123 }, schema: { type: 'object', properties: { mint: { type: 'string' } }, additionalProperties: false } });
  assert.ok(!bad.ok && bad.code === 'bad-args');
  const big = gate.check(session(), { tool: 'get_token', args: { mint: 'x'.repeat(20000) }, schema: { type: 'object', properties: { mint: { type: 'string', maxLength: 50000 } }, additionalProperties: false } });
  assert.ok(!big.ok && big.code === 'too-large');
});

test('a proposal needs a well-formed idempotency key', () => {
  const { gate } = mkGate();
  const noKey = gate.check(session(), { tool: 'propose_alert', args: { mint: 'a' }, schema: { ...PROPOSAL_SCHEMA, required: ['mint'] } });
  assert.ok(!noKey.ok && noKey.code === 'idempotency-key');
  const shortKey = gate.check(session(), { tool: 'propose_alert', args: { mint: 'a', idempotency_key: 'short' }, schema: PROPOSAL_SCHEMA });
  assert.ok(!shortKey.ok && shortKey.code === 'idempotency-key');
  const ok = gate.check(session(), { tool: 'propose_alert', args: { mint: 'a', idempotency_key: 'good-key-123' }, schema: PROPOSAL_SCHEMA });
  assert.ok(ok.ok);
});

test('a closed session and a paused agent are refused', () => {
  const { gate, paused } = mkGate();
  assert.ok(!gate.check(session({ closed: true, closedReason: 'kicked' }), { tool: 'get_token', args: { mint: 'a' }, schema: { type: 'object', properties: { mint: { type: 'string' } } } }).ok);
  paused.add('a1');
  const r = gate.check(session(), { tool: 'get_token', args: { mint: 'a' }, schema: { type: 'object', properties: { mint: { type: 'string' } } } });
  assert.ok(!r.ok && r.code === 'agent-paused');
});

test('read rate limit', () => {
  const { gate } = mkGate();
  const s = session({ tier: 'observe' });
  const schema: JsonSchema = { type: 'object', properties: { mint: { type: 'string' } }, additionalProperties: false };
  let refused = 0;
  for (let i = 0; i < DEFAULT_LIMITS.readsPerMin + 5; i++) {
    const r = gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema });
    if (!r.ok) { assert.equal(r.code, 'rate-limited'); refused++; }
  }
  assert.ok(refused >= 5);
});

test('proposal quota', () => {
  const { gate } = mkGate();
  const s = session();
  let refused = 0;
  for (let i = 0; i < DEFAULT_LIMITS.proposalsPerHour + 3; i++) {
    const r = gate.check(s, { tool: 'propose_alert', args: { mint: 'a', idempotency_key: `k-${i}-abcdef` }, schema: PROPOSAL_SCHEMA });
    if (!r.ok) { assert.equal(r.code, 'quota'); refused++; }
  }
  assert.ok(refused >= 3);
});

test('rate windows slide as time passes', () => {
  const now = { t: 1_000_000 };
  const { gate } = mkGate(now);
  const s = session({ tier: 'observe' });
  const schema: JsonSchema = { type: 'object', properties: { mint: { type: 'string' } }, additionalProperties: false };
  for (let i = 0; i < DEFAULT_LIMITS.readsPerMin; i++) gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema });
  assert.ok(!gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema }).ok);
  now.t += 61_000; // the whole window has passed
  assert.ok(gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema }).ok);
});

test('the flood breaker auto-pauses after sustained refusals', () => {
  const now = { t: 1_000_000 };
  let floodedUntil = 0;
  const audit = new MemoryAuditLog({ now: () => now.t });
  const gate = new AgentGate({ audit, now: () => now.t, onFlood: (_id, _n, until) => { floodedUntil = until; } });
  const s = session();
  for (let i = 0; i < FLOOD_REFUSALS; i++) gate.check(s, { tool: 'make_me_rich' });
  assert.ok(floodedUntil > now.t, 'the breaker should have tripped');
  const r = gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema: { type: 'object', properties: { mint: { type: 'string' } } } });
  assert.ok(!r.ok && r.code === 'flood-paused', 'even a valid call is refused while flood-paused');
  gate.clearFlood('a1');
  const r2 = gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema: { type: 'object', properties: { mint: { type: 'string' } } } });
  assert.ok(r2.ok, 'a user resume clears the breaker');
});

test('usage reports current window counts', () => {
  const { gate } = mkGate();
  const s = session({ tier: 'propose' });
  const schema: JsonSchema = { type: 'object', properties: { mint: { type: 'string' } }, additionalProperties: false };
  gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema });
  gate.check(s, { tool: 'propose_alert', args: { mint: 'a', idempotency_key: 'key-abcdef' }, schema: PROPOSAL_SCHEMA });
  const u = gate.usage('a1');
  assert.equal(u.readsPerMin, 1);
  assert.equal(u.proposalsPerHour, 1);
});

test('per-agent limit overrides apply', () => {
  const { gate } = mkGate();
  gate.setAgentLimits('a1', { readsPerMin: 2 });
  const s = session({ tier: 'observe' });
  const schema: JsonSchema = { type: 'object', properties: { mint: { type: 'string' } }, additionalProperties: false };
  assert.ok(gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema }).ok);
  assert.ok(gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema }).ok);
  assert.ok(!gate.check(s, { tool: 'get_token', args: { mint: 'a' }, schema }).ok);
});
