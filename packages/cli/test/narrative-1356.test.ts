// task-1356: the NARRATIVE BOARD TUI screen renders a computed board, and the `trenchscope narrative`
// subcommand prints the board / summary from the recorder DB. Offline, no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '@dexterm/recorder';
import { makeFixtureState, renderFrame, computeNarrativeView } from '../src/state.ts';
import { narrativeCommand } from '../src/narrative-cmd.ts';

function sink() {
  const chunks: string[] = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  return { w, text: () => chunks.join('') };
}

for (const [w, h] of [[176, 48], [120, 42], [90, 36]] as const) {
  test(`narrative screen ${w}×${h}: clusters the visible rows into a ranked board`, () => {
    const state = makeFixtureState();
    state.screen = 'narrative';
    state.narrative = computeNarrativeView(state, '1h');
    const plain = renderFrame(state, w, h).toPlain();
    assert.match(plain, /NARRATIVE BOARD/);
    if (w >= 120) assert.match(plain, /model output: none|deterministic/i, 'the wide board labels itself deterministic');
  });
}

test('narrative screen: empty state is an honest "collecting" message, never a fake board', () => {
  const state = makeFixtureState();
  state.screen = 'narrative';
  state.narrative = { board: null, window: '1h', computedAt: Date.now(), source: 'none', selected: 0 };
  const plain = renderFrame(state, 120, 40).toPlain();
  assert.match(plain, /collecting narratives/);
});

test('trenchscope narrative: prints a board table from the recorder DB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'narr-1356-'));
  const dbPath = join(dir, 'dexterm.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);
    const now = Date.now();
    const ins = db.prepare(`INSERT INTO token_snapshots (mint, t, kind, hash, src_market, sources, symbol, name, vol_h1, vol_h24, chg_h1, chg_h24, holder_count, liquidity_usd, mcap, age_sec) VALUES (?, ?, 'live', ?, 'dexscreener', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let i = 0;
    for (const [sym, name] of [['DOGE', 'doge'], ['SHIB', 'shiba inu'], ['WIF', 'dogwifhat'], ['GPT', 'ai agent'], ['CLAUDE', 'claude agent'], ['AGENTIC', 'agentic ai']]) {
      ins.run(`Mint${i++}`.padEnd(40, '1'), now - 5000, `h${i}`, sym, name, 80000, 600000, 12, 30, 800, 60000, 2_000_000, 90000);
    }
    db.close();
    const out = sink(); const err = sink();
    const code = narrativeCommand([], { stdout: out.w, stderr: err.w, env: { DEXTERM_DB_PATH: dbPath } });
    assert.equal(code, 0, err.text());
    assert.match(out.text(), /NARRATIVE BOARD/);
    assert.match(out.text(), /dogs|ai-agents/, 'a narrative is ranked');
    // summary mode
    const out2 = sink();
    assert.equal(narrativeCommand(['--summary'], { stdout: out2.w, stderr: sink().w, env: { DEXTERM_DB_PATH: dbPath } }), 0);
    assert.match(out2.text(), /no model/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trenchscope narrative: a DB with no recorder tables fails cleanly, never a fake board', () => {
  const dir = mkdtempSync(join(tmpdir(), 'narr-empty-'));
  const dbPath = join(dir, 'empty.db');
  try {
    const db = new DatabaseSync(dbPath); db.exec('CREATE TABLE x (a)'); db.close();
    const err = sink();
    const code = narrativeCommand([], { stdout: sink().w, stderr: err.w, env: { DEXTERM_DB_PATH: dbPath } });
    assert.equal(code, 2);
    assert.match(err.text(), /no recorded history/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
