// Tier 1 (task-1345): the audit log. Every detail string is firewalled at write time so agent-supplied
// text can never carry an escape sequence or a 10 KB payload into the terminal or a model. Two stores
// (memory + node:sqlite) behind one interface return the same rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuditLog, SqliteAuditLog, auditDetail, AUDIT_DETAIL_MAX, type AuditLog } from '../src/audit.ts';

function runStore(name: string, make: () => AuditLog) {
  test(`${name}: append / recent / counts`, () => {
    const log = make();
    try {
      log.append({ agentId: 'a1', agentName: 'scanbot', session: 's1', kind: 'connect', tool: '-', detail: 'hello', ok: true });
      log.append({ agentId: 'a1', agentName: 'scanbot', session: 's1', kind: 'call', tool: 'get_token', detail: 'mint abc', ok: true });
      log.append({ agentId: 'a1', agentName: 'scanbot', session: 's1', kind: 'refused', tool: 'arm', detail: 'never: no', ok: false });
      log.append({ agentId: 'a1', agentName: 'scanbot', session: 's1', kind: 'proposal', tool: 'propose_alert', detail: 'alert on abc', ok: true });
      const recent = log.recent(10);
      assert.equal(recent.length, 4);
      assert.equal(recent[0].kind, 'proposal'); // newest first
      const calls = log.recent(10, { kind: 'call' });
      assert.equal(calls.length, 1);
      const c = log.counts('a1');
      assert.deepEqual([c.calls, c.refused, c.proposals], [1, 1, 1]);
      assert.ok(c.lastAt !== null);
    } finally { log.close(); }
  });
}

runStore('memory', () => new MemoryAuditLog());
runStore('sqlite', () => new SqliteAuditLog(':memory:'));

test('detail strings are firewalled: no escapes, no 10 KB payload', () => {
  const log = new MemoryAuditLog();
  const nasty = '\u001b[2J\u001b[0;0H ANSI clear ' + 'x'.repeat(5000);
  const row = log.append({ agentId: 'a1', agentName: 'scanbot', session: 's1', kind: 'note', tool: 'agent_note', detail: nasty, ok: true });
  assert.ok(!row.detail.includes('\u001b'), 'escape sequences are stripped');
  assert.ok(row.detail.length <= AUDIT_DETAIL_MAX, 'detail is capped');
});

test('auditDetail collapses whitespace and tolerates non-strings', () => {
  assert.equal(auditDetail('  a\n b  '), 'a b');
  assert.equal(auditDetail(undefined), '');
  assert.equal(auditDetail(null), '');
  assert.equal(typeof auditDetail({ a: 1 }), 'string');
});

test('agent name is capped so a long display name cannot blow out the roster', () => {
  const log = new MemoryAuditLog();
  const row = log.append({ agentId: 'a1', agentName: 'n'.repeat(200), session: null, kind: 'connect', tool: '-', detail: 'x', ok: true });
  assert.ok(row.agentName.length <= 24);
});
