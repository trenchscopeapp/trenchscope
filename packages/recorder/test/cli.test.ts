// `trenchscope recorder <cmd>` over a temp file DB, and the enable/disable resolution.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recorderCli } from '../src/cli.ts';
import { Recorder } from '../src/recorder.ts';
import { recorderEnabled } from '../src/index.ts';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: {} as NodeJS.ProcessEnv }, out, err };
}

test('recorder CLI: help, stats, label, prune, export on a file DB; refuses :memory:', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r01-cli-'));
  const db = join(dir, 'dexterm.db');
  try {
    const rec = new Recorder({ path: db });
    rec.recordMembers('jup:recent', ['m1', 'm2'], Date.now());
    rec.close();
    let x = io();
    assert.equal(await recorderCli([], x.io), 2);
    assert.match(x.out.join(''), /trenchscope recorder stats/);
    x = io();
    assert.equal(await recorderCli(['stats', '--db', db], x.io), 0);
    assert.match(x.out.join(''), /feed_members\s+2/);
    assert.match(x.out.join(''), /labeler 0\.2\.0/);
    x = io();
    assert.equal(await recorderCli(['label', '--db', db], x.io), 0);
    assert.match(x.out.join(''), /labelled 0/);
    x = io();
    assert.equal(await recorderCli(['prune', '--db', db], x.io), 0);
    x = io();
    const out = join(dir, 'recorded.json');
    assert.equal(await recorderCli(['export', '--db', db, '--out', out, '--since', '2026-01-01', '--labelled-only'], x.io), 0);
    const doc = JSON.parse(readFileSync(out, 'utf8')) as { schema: string; counts: { records: number } };
    assert.equal(doc.schema, 'dexterm-recorder-export/1');
    assert.equal(doc.counts.records, 0);
    x = io();
    assert.equal(await recorderCli(['export', '--db', db, '--since', 'yesterday-ish'], x.io), 1);
    assert.match(x.err.join(''), /bad time/);
    x = io();
    assert.equal(await recorderCli(['stats', '--db', ':memory:'], x.io), 2);
    x = io();
    assert.equal(await recorderCli(['bogus', '--db', db], x.io), 2);
    // DEXTERM_DB_PATH is the default DB
    x = io(); x.io.env.DEXTERM_DB_PATH = db;
    assert.equal(await recorderCli(['stats'], x.io), 0);
    assert.match(x.out.join(''), new RegExp(db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recorderEnabled: on by default, off with --no-recorder or DEXTERM_RECORDER=0/off/false/no', () => {
  assert.equal(recorderEnabled({}, false), true);
  assert.equal(recorderEnabled({}, true), false);
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) assert.equal(recorderEnabled({ DEXTERM_RECORDER: v }, false), false, v);
  for (const v of ['1', 'on', '', 'yes']) assert.equal(recorderEnabled({ DEXTERM_RECORDER: v }, false), true, v);
});
