// task-1406: the MCP tool-call path's spectator sink. When the running trenchscope launches the MCP child with
// DEXTERM_SPECTATOR_FILE, every tool call is emitted as a SpectatorEvent-shaped JSONL line the TUI tails
// into its hub. The record only DESCRIBES a completed read/navigation call — it carries nothing an agent
// could act on, and no money/UI mutation happens here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordForToolCall, maxAgeSec, fileSpectatorSinkFromEnv } from '../src/spectator-sink.ts';

const MINT = 'So11111111111111111111111111111111111111112';

test('a navigation tool records a nav move; a read records a result with data age', () => {
  const nav = recordForToolCall({ seq: 1, agent: 'mcp-agent', tool: 'open_token', args: { mint: MINT }, result: { ok: true }, ms: 4, now: () => 10 });
  assert.equal(nav.phase, 'nav');
  assert.equal(nav.transport, 'mcp');
  assert.deepEqual(nav.nav, { screen: 'token', mint: MINT });
  assert.equal(nav.ok, true);

  const read = recordForToolCall({ seq: 2, agent: 'mcp-agent', tool: 'rugcheck', args: { mint: MINT }, result: { scoreNormalised: 12, ageSec: 3 }, ms: 7 });
  assert.equal(read.phase, 'result');
  assert.equal(read.dataAgeSec, 3, 'the data age comes from the result ageSec');
  assert.equal(read.nav, null);

  const err = recordForToolCall({ seq: 3, agent: 'mcp-agent', tool: 'get_token', args: { mint: MINT }, result: { error: 'boom' }, ms: 1 });
  assert.equal(err.ok, false);
  assert.match(err.summary, /error: boom/);
});

test('maxAgeSec finds the oldest ageSec', () => {
  assert.equal(maxAgeSec({ a: { ageSec: 2 }, b: { c: { ageSec: 40 } } }), 40);
  assert.equal(maxAgeSec({ nope: 1 }), null);
});

test('the file sink appends parseable JSONL and is off without the env', () => {
  assert.equal(fileSpectatorSinkFromEnv({}), null, 'no channel without DEXTERM_SPECTATOR_FILE');
  const dir = mkdtempSync(join(tmpdir(), 'mcp-spec-'));
  const file = join(dir, 'spec.jsonl');
  const env = { DEXTERM_SPECTATOR_FILE: file, DEXTERM_SPECTATOR_TOKEN: 'tok', DEXTERM_SPECTATOR_AGENT: 'claude-code' } as NodeJS.ProcessEnv;
  const s = fileSpectatorSinkFromEnv(env)!;
  assert.equal(s.agent, 'claude-code');
  assert.equal(s.token, 'tok');
  s.sink.record(recordForToolCall({ seq: 1, agent: s.agent, tool: 'open_token', args: { mint: MINT }, result: { ok: true }, ms: 2, token: s.token }));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.v, 1);
  assert.equal(rec.agent, 'claude-code');
  assert.equal(rec.phase, 'nav');
  assert.equal(rec.token, 'tok');
});
