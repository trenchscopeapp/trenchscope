// task-1421: the `trenchscope mcp` server's spectator sink resolved from the ~/.dexterm rendezvous (what an
// EXTERNAL client's server uses, since the running app cannot set its env). It must be inactive — and write
// NOTHING — when no spectator surface is open, and append one JSONL record per call while one is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSpectatorSink, rendezvousPath, fileSpectatorSinkFromEnv, recordForToolCall } from '../src/spectator-sink.ts';

const MINT = 'So11111111111111111111111111111111111111112';

function tmpHome(): NodeJS.ProcessEnv {
  return { DEXTERM_HOME: mkdtempSync(join(tmpdir(), 'dexterm-rv-')) } as NodeJS.ProcessEnv;
}

test('no rendezvous → inactive, and a record writes nothing (no cost when nobody is watching)', () => {
  const env = tmpHome();
  const sink = resolveSpectatorSink(env);
  assert.equal(sink.active(), false);
  sink.record({ tool: 'get_token', args: { mint: MINT }, result: { ageSec: 2 }, ms: 5 });
  assert.equal(existsSync(join(env.DEXTERM_HOME!, 'channel.jsonl')), false);
});

test('rendezvous present → active, appends one record per call to the named file with its agent/token', () => {
  const env = tmpHome();
  const channel = join(env.DEXTERM_HOME!, 'channel.jsonl');
  writeFileSync(channel, '');
  writeFileSync(rendezvousPath(env), JSON.stringify({ file: channel, token: 'tok-abc', agent: 'claude-code' }));

  const sink = resolveSpectatorSink(env);
  assert.equal(sink.active(), true);
  sink.record({ tool: 'open_token', args: { mint: MINT }, result: { ok: true }, ms: 3 });
  sink.record({ tool: 'rugcheck', args: { mint: MINT }, result: { scoreNormalised: 10, ageSec: 4 }, ms: 7 });

  const lines = readFileSync(channel, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const nav = JSON.parse(lines[0]);
  assert.equal(nav.phase, 'nav');
  assert.equal(nav.transport, 'mcp');
  assert.equal(nav.agent, 'claude-code');
  assert.equal(nav.token, 'tok-abc');
  assert.deepEqual(nav.nav, { screen: 'token', mint: MINT });
  const read = JSON.parse(lines[1]);
  assert.equal(read.phase, 'result');
  assert.equal(read.dataAgeSec, 4);
  assert.equal(read.seq, 2, 'the sink sequences its own records');
});

test('a failed navigation tool is emitted as refused with no actionable nav phase', () => {
  const rec = recordForToolCall({
    seq: 1,
    agent: 'agent',
    tool: 'open_token',
    args: { mint: MINT },
    result: { error: 'refused by tier' },
    ms: 1,
  });
  assert.equal(rec.phase, 'refused');
  assert.equal(rec.ok, false);
  assert.deepEqual(rec.nav, { screen: 'token', mint: MINT }, 'the attempted target remains audit data only');
});

test('removing the rendezvous flips the sink inactive (surface closed → server stops emitting)', () => {
  const env = tmpHome();
  const channel = join(env.DEXTERM_HOME!, 'channel.jsonl');
  writeFileSync(channel, '');
  const rv = rendezvousPath(env);
  writeFileSync(rv, JSON.stringify({ file: channel, token: 't' }));
  const sink = resolveSpectatorSink(env);
  assert.equal(sink.active(), true);
  sink.record({ tool: 'get_token', args: {}, result: {}, ms: 1 });
  rmSync(rv);
  // bust the mtime cache deterministically (the stat path keys on mtimeMs)
  assert.equal(sink.active(), false);
  sink.record({ tool: 'get_token', args: {}, result: {}, ms: 1 });
  assert.equal(readFileSync(channel, 'utf8').trim().split('\n').filter(Boolean).length, 1, 'no further records after the surface closed');
});

test('a changed rendezvous (new channel) is re-read past the mtime cache', () => {
  const env = tmpHome();
  const c1 = join(env.DEXTERM_HOME!, 'c1.jsonl');
  const c2 = join(env.DEXTERM_HOME!, 'c2.jsonl');
  writeFileSync(c1, ''); writeFileSync(c2, '');
  const rv = rendezvousPath(env);
  writeFileSync(rv, JSON.stringify({ file: c1, token: 't' }));
  const sink = resolveSpectatorSink(env);
  sink.record({ tool: 'get_token', args: {}, result: {}, ms: 1 });
  // repoint the rendezvous to a new channel with a strictly newer mtime
  writeFileSync(rv, JSON.stringify({ file: c2, token: 't' }));
  utimesSync(rv, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  sink.record({ tool: 'get_token', args: {}, result: {}, ms: 1 });
  assert.equal(readFileSync(c1, 'utf8').trim().split('\n').filter(Boolean).length, 1);
  assert.equal(readFileSync(c2, 'utf8').trim().split('\n').filter(Boolean).length, 1);
});

test('DEXTERM_SPECTATOR_FILE (the in-app analyst path) still wins and is always active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-rv-'));
  const file = join(dir, 'env.jsonl');
  const env = { DEXTERM_SPECTATOR_FILE: file, DEXTERM_SPECTATOR_AGENT: 'analyst', DEXTERM_SPECTATOR_TOKEN: 'etok' } as NodeJS.ProcessEnv;
  assert.ok(fileSpectatorSinkFromEnv(env), 'the env sink resolves');
  const sink = resolveSpectatorSink(env);
  assert.equal(sink.active(), true);
  sink.record({ tool: 'screener_query', args: {}, result: {}, ms: 2 });
  const rec = JSON.parse(readFileSync(file, 'utf8').trim());
  assert.equal(rec.agent, 'analyst');
  assert.equal(rec.token, 'etok');
});
