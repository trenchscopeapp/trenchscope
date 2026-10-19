// task-1329: the CLI's recorder wiring — flag, help, subcommand, and that replay/fixture runs never record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs, main, HELP } from '../src/index.ts';

const REPLAY = fileURLToPath(new URL('../../data/fixtures/live-sample.json', import.meta.url));

function sink() {
  const chunks: string[] = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  return { w, text: () => chunks.join('') };
}
function fakeIo(env: NodeJS.ProcessEnv = {}) {
  const out = sink(); const err = sink();
  const io = { stdout: Object.assign(out.w, { isTTY: false, columns: 120, rows: 40 }), stderr: err.w, stdin: Object.assign(new Writable(), { isTTY: false }), env: { DEXTERM_OFFLINE: '1', ...env } };
  return { io: io as unknown as Parameters<typeof main>[1], out, err };
}

test('parseArgs: --no-recorder; HELP documents the switch, the env var and the subcommand', () => {
  assert.equal(parseArgs([]).noRecorder, false);
  assert.equal(parseArgs(['--no-recorder']).noRecorder, true);
  assert.match(HELP, /--no-recorder/);
  assert.match(HELP, /DEXTERM_RECORDER=0/);
  assert.match(HELP, /trenchscope recorder stats\|label\|prune\|export/);
});

test('trenchscope recorder stats / export run against --db without network; a replay run writes no history rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r01-main-'));
  const db = join(dir, 'dexterm.db');
  try {
    // a replay one-shot over the fixture recording with the DB: the live context opens the DB (watchlist,
    // paper wallet), the recorder tables are never created — a replay must not write fixture-time history
    const r = fakeIo();
    const code = await main(['--screen', 'screener', '--replay', REPLAY, '--db', db, '--plain', '--width', '120', '--height', '30'], r.io);
    assert.equal(code, 0, r.err.text());
    const d = new DatabaseSync(db);
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    assert.ok(tables.includes('watchlist'), tables.join(','));
    assert.ok(!tables.includes('token_snapshots'), 'replay mode never creates or writes recorder tables');
    d.close();
    const s = fakeIo();
    assert.equal(await main(['recorder', 'stats', '--db', db], s.io), 0, s.err.text());
    assert.match(s.out.text(), /snapshots\s+0/);
    const e = fakeIo();
    assert.equal(await main(['recorder', 'export', '--db', db, '--limit', '5'], e.io), 0);
    assert.match(e.out.text(), /"schema": "dexterm-recorder-export\/1"/);
    const h = fakeIo();
    assert.equal(await main(['recorder', 'help'], h.io), 0);
    assert.match(h.out.text(), /--no-recorder or DEXTERM_RECORDER=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
