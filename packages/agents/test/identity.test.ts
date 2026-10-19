// Tier 1 (task-1345): the agent registry. Tokens are shown once and stored only as a salted hash;
// verify is constant-time and gives the same null for an unknown name, a bad shape and a wrong token;
// a rotate or remove invalidates the old secret immediately (a kicked agent cannot reconnect).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, looksLikeToken, hashToken, AGENT_NAME_RE, MAX_AGENTS, TOKEN_PREFIX } from '../src/identity.ts';

function tmp(): string { return join(mkdtempSync(join(tmpdir(), 'dxa-')), 'agents.json'); }

test('add returns a one-time token that is never stored in plaintext', () => {
  const path = tmp();
  try {
    const reg = new AgentRegistry({ path });
    const { agent, token } = reg.add('scanbot', 'observe', { note: 'read-only scanner' });
    assert.ok(token.startsWith(TOKEN_PREFIX));
    assert.ok(looksLikeToken(token));
    assert.equal(agent.tier, 'observe');
    const raw = readFileSync(path, 'utf8');
    assert.ok(!raw.includes(token), 'the plaintext token must never hit disk');
    assert.ok(raw.includes(agent.tokenHash));
  } finally { rmSync(join(path, '..'), { recursive: true, force: true }); }
});

test('verify succeeds for the right token and returns the granted tier', () => {
  const reg = new AgentRegistry({ path: ':memory:' });
  const { token } = reg.add('scanbot', 'propose');
  const ok = reg.verify('scanbot', token);
  assert.ok(ok && ok.tier === 'propose');
});

test('verify gives the same null for unknown name, bad shape, wrong token (no oracle)', () => {
  const reg = new AgentRegistry({ path: ':memory:' });
  const { token } = reg.add('scanbot', 'observe');
  assert.equal(reg.verify('ghost', token), null);
  assert.equal(reg.verify('scanbot', 'not-a-token'), null);
  assert.equal(reg.verify('scanbot', TOKEN_PREFIX + 'A'.repeat(43)), null);
  assert.equal(reg.verify('SCANBOT', token), null); // name is case-sensitive / shape-checked
});

test('rotate invalidates the old token at once', () => {
  const reg = new AgentRegistry({ path: ':memory:' });
  const { token: t1 } = reg.add('scanbot', 'observe');
  const t2 = reg.rotate('scanbot');
  assert.notEqual(t1, t2);
  assert.equal(reg.verify('scanbot', t1), null);
  assert.ok(reg.verify('scanbot', t2));
});

test('remove invalidates the token (a kicked agent cannot reconnect)', () => {
  const reg = new AgentRegistry({ path: ':memory:' });
  const { token } = reg.add('scanbot', 'observe');
  assert.ok(reg.remove('scanbot'));
  assert.equal(reg.verify('scanbot', token), null);
  assert.equal(reg.remove('scanbot'), false);
});

test('a paused agent still verifies but is flagged paused', () => {
  const reg = new AgentRegistry({ path: ':memory:' });
  const { token } = reg.add('scanbot', 'observe');
  reg.setPaused('scanbot', true);
  const v = reg.verify('scanbot', token);
  assert.ok(v && v.paused === true);
});

test('name validation and MAX_AGENTS cap', () => {
  const reg = new AgentRegistry({ path: ':memory:' });
  assert.throws(() => reg.add('Bad Name', 'observe'), /name must match/);
  assert.throws(() => reg.add('x'.repeat(30), 'observe'), /name must match/);
  assert.ok(AGENT_NAME_RE.test('a-good-name1'));
  for (let i = 0; i < MAX_AGENTS; i++) reg.add(`agent${i}`, 'observe');
  assert.throws(() => reg.add('one-too-many', 'observe'), /at most/);
});

test('duplicate name is refused (rotate instead)', () => {
  const reg = new AgentRegistry({ path: ':memory:' });
  reg.add('scanbot', 'observe');
  assert.throws(() => reg.add('scanbot', 'observe'), /already exists/);
});

test('a hand-edited file cannot grant a bogus tier or name', () => {
  const path = tmp();
  try {
    writeFileSync(path, JSON.stringify({ version: 1, agents: [
      { id: 'a', name: 'ok', tier: 'root', tokenHash: 'x', salt: 's' },
      { id: 'b', name: 'Bad Name', tier: 'observe', tokenHash: hashToken('s', 'x'), salt: 's' },
      { id: 'c', name: 'good', tier: 'observe', tokenHash: 'deadbeef', salt: 's' },
    ] }));
    const reg = new AgentRegistry({ path });
    const names = reg.list().map((a) => a.name);
    assert.deepEqual(names, ['good'], 'only the well-formed record survives');
  } finally { rmSync(join(path, '..'), { recursive: true, force: true }); }
});

test('limits are sanitised to safe ranges', () => {
  const reg = new AgentRegistry({ path: ':memory:' });
  reg.add('scanbot', 'observe');
  reg.setLimits('scanbot', { readsPerMin: 999999, proposalsPerHour: -5, connections: 100 });
  const a = reg.get('scanbot');
  assert.ok((a?.limits?.readsPerMin ?? 0) <= 600);
  assert.equal(a?.limits?.proposalsPerHour, undefined); // -5 is out of range → dropped
  assert.ok((a?.limits?.connections ?? 0) <= 8);
});

test('looksLikeToken rejects junk', () => {
  assert.ok(!looksLikeToken(''));
  assert.ok(!looksLikeToken('abc'));
  assert.ok(!looksLikeToken(TOKEN_PREFIX + 'has space'));
  assert.ok(!looksLikeToken(123));
});
