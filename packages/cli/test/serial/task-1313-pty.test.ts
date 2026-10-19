// trenchscope — task-1313 end-to-end pty proofs, split out of ../task-1313.test.ts by task-1424 so they run in the
// serial lane (scripts/test-lane.mjs serial) instead of beside ~150 parallel test processes. The real binary runs
// under action-pty.py with a fake `claude` on PATH; the assertions are the ones the parallel file had.
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serialLane } from './lane.ts';

const laneTest = serialLane(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', '..', 'data', 'fixtures', 'live-sample.json');
const PTY = resolve(here, '..', 'measure', 'action-pty.py');
const hasPty = (() => { try { execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }); return existsSync(PTY); } catch { return false; } })();


/** A fake `claude` that writes a valid open_token line to the action channel and emits the tool call. */
function fakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task1313-fakeclaude-'));
  const script = `#!/usr/bin/env node
const fs = require('fs');
try {
  const ss = JSON.parse(process.env.DEXTERM_SCREEN_STATE || '{}');
  const mint = (ss.selected && ss.selected.mint) || (ss.actions && ss.actions.mints && ss.actions.mints[0]) || (ss.visibleMints && ss.visibleMints[0]);
  const file = process.env.DEXTERM_ACTION_FILE, token = process.env.DEXTERM_ACTION_TOKEN;
  if (process.env.DEXTERM_FAKE_LOG) fs.appendFileSync(process.env.DEXTERM_FAKE_LOG, 'spawn ' + mint + '\\n');
  if (file && token && mint) fs.appendFileSync(file, JSON.stringify({ v: 1, token, seq: 1, ts: Date.now(), action: { type: 'open_token', mint } }) + '\\n');
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'system', subtype: 'init', model: 'fake', session_id: 's1', mcp_servers: [], skills: [] });
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__dexterm__open_token', input: { mint } }] } });
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'putting it on your screen' } } });
  say({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, duration_ms: 5, num_turns: 1, is_error: false, session_id: 's1' });
} catch (e) { process.stderr.write(String(e)); }
`;
  writeFileSync(join(dir, 'claude'), script, { mode: 0o755 });
  return dir;
}

/** A fake `claude` that, for a plain-language request, applies a structured screener filter (part E). */
function fakeClaudeFilter(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task1313-fakefilter-'));
  const script = `#!/usr/bin/env node
const fs = require('fs');
try {
  const file = process.env.DEXTERM_ACTION_FILE, token = process.env.DEXTERM_ACTION_TOKEN;
  const filter = 'mcap < 5M liq > 100K h24 > 20 lplocked >= 100 !flag:mint !flag:freeze org > 50';
  if (file && token) fs.appendFileSync(file, JSON.stringify({ v: 1, token, seq: 1, ts: Date.now(), action: { type: 'show_in_screener', filter } }) + '\\n');
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'system', subtype: 'init', model: 'fake', session_id: 's1', mcp_servers: [], skills: [] });
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__dexterm__show_in_screener', input: { filter } }] } });
  const structured = { skill: 'trench-scan', skill_version: '0.1.0', scanned: 0, candidates: [], skipped: [], injection_detected: false, sources_used: [], summary: 'filtered for low-cap, liquid, up-today, LP-locked names. analysis, not financial advice', filter_applied: { query: filter, notes: 'low cap → mcap<5M, liquid → liq>100K, up → h24>20, safe → LP locked + no mint/freeze + org>50' } };
  say({ type: 'result', subtype: 'success', result: JSON.stringify(structured), structured_output: structured, total_cost_usd: 0, duration_ms: 5, num_turns: 1, is_error: false, session_id: 's1' });
} catch (e) { process.stderr.write(String(e)); }
`;
  writeFileSync(join(dir, 'claude'), script, { mode: 0o755 });
  return dir;
}

/** A fake `claude` that answers with a list-of-coins `results[]` block over real on-screen mints (part F). */
function fakeClaudeResults(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task1313-fakeresults-'));
  const script = `#!/usr/bin/env node
const fs = require('fs');
try {
  const ss = JSON.parse(process.env.DEXTERM_SCREEN_STATE || '{}');
  const mints = (ss.actions && ss.actions.mints) || (ss.visibleMints) || [];
  const results = mints.slice(0, 3).map((m, i) => ({ mint: m, reason: 'setup reason ' + (i + 1) }));
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'system', subtype: 'init', model: 'fake', session_id: 's1', mcp_servers: [], skills: [] });
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'here are the best setups' } } });
  const structured = { skill: 'trench-scan', skill_version: '0.1.0', scanned: mints.length, candidates: [], skipped: [], injection_detected: false, sources_used: [], summary: 'top setups right now. analysis, not financial advice', results };
  say({ type: 'result', subtype: 'success', result: JSON.stringify(structured), structured_output: structured, total_cost_usd: 0, duration_ms: 5, num_turns: 1, is_error: false, session_id: 's1' });
} catch (e) { process.stderr.write(String(e)); }
`;
  writeFileSync(join(dir, 'claude'), script, { mode: 0o755 });
  return dir;
}
const deAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '');

// ------------------------------------------------------------------ E: end-to-end pty proof
laneTest('pty: "put the top coin on my screen" opens the token (fake claude emits the tool call + writes the channel)', { skip: hasPty ? false : 'python3 pty not available' }, () => {
  const fakeDir = fakeClaude();
  const out = join(mkdtempSync(join(tmpdir(), 'task1313-pty-')), 'frames.bin');
  const home = mkdtempSync(join(tmpdir(), 'task1313-home-'));
  const log = join(fakeDir, 'spawn.log');
  const r = spawnSync('python3', ['-I', PTY, '--sample', SAMPLE, '--fake-dir', fakeDir, '--out', out, '--home', home, '--fake-log', log], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `pty harness failed: ${r.stderr}`);
  const screen = deAnsi(readFileSync(out, 'utf8'));
  assert.ok(existsSync(log) && readFileSync(log, 'utf8').includes('spawn'), 'the analyst turn spawned the fake claude with a real mint');
  // The app consumed the authenticated channel and applied open_token → an "analyst opened …" note.
  assert.match(screen, /analyst opened/, 'the app applied the UI action and showed "analyst opened …"');
});

laneTest('E pty: a plain-language filter request applies a structured filter and the screener shows it', { skip: hasPty ? false : 'python3 pty not available' }, () => {
  const fakeDir = fakeClaudeFilter();
  const out = join(mkdtempSync(join(tmpdir(), 'task1313-ptyE-')), 'frames.bin');
  const home = mkdtempSync(join(tmpdir(), 'task1313-homeE-'));
  const r = spawnSync('python3', ['-I', PTY, '--sample', SAMPLE, '--fake-dir', fakeDir, '--out', out, '--home', home, '--scenario', 'filter'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `pty harness failed: ${r.stderr}`);
  const screen = deAnsi(readFileSync(out, 'utf8'));
  assert.match(screen, /analyst filter|filter mcap|mcap < 5M/i, 'the app applied the analyst\'s structured filter');
});

laneTest('F pty: a coin-list answer renders a table, ↓ navigates, and ⏎ jumps to the token screen', { skip: hasPty ? false : 'python3 pty not available' }, () => {
  const fakeDir = fakeClaudeResults();
  const out = join(mkdtempSync(join(tmpdir(), 'task1313-ptyF-')), 'frames.bin');
  const home = mkdtempSync(join(tmpdir(), 'task1313-homeF-'));
  const r = spawnSync('python3', ['-I', PTY, '--sample', SAMPLE, '--fake-dir', fakeDir, '--out', out, '--home', home, '--scenario', 'results'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `pty harness failed: ${r.stderr}`);
  const screen = deAnsi(readFileSync(out, 'utf8'));
  // the table rendered (header), and ⏎ jumped onto the token screen (its ON-CHAIN panel)
  assert.match(screen, /SYMBOL|coins/i, 'the list-of-coins answer rendered as a table');
  assert.match(screen, /ON-CHAIN/, 'Enter jumped to the selected coin\'s token screen');
});
