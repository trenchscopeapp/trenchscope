// task-1311 QA pty regressions (B1, B3, DEFECT 1, DEFECT 2), split out of ../qa-1311.test.ts by task-1424 so
// they run in the serial lane (scripts/test-lane.mjs serial), not beside ~150 parallel test processes. They drive
// the REAL binary over a pty with the vendored QA driver (../measure/drive.py), reproducing the QA report's
// keystrokes, so a skipped fix can't hide behind a green unit test. Assertions unchanged from the parallel file.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialLane } from './lane.ts';

const laneTest = serialLane(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, '..', '..', 'bin', 'dexterm.mjs');
// task-1319: the QA driver is vendored into the repo (packages/cli/test/measure/drive.py) so a clean
// checkout runs these instead of silently skipping (task-1415 dropped the out-of-repo evidence fallback).
const DRIVE = resolve(here, '..', 'measure', 'drive.py');
const hasDriver = (() => { try { execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }); return existsSync(DRIVE); } catch { return false; } })();
const skip = hasDriver ? false : 'python3 pty + QA drive.py not present (archive copy)';

/** Run the real binary under the QA pty driver with a key script; return the captured frames + meta.
 *  Every script opens with `WAIT:WELCOME_TO_DEXTERM` (task-1410): under parallel-suite load the first key
 *  must not race the app's first paint; the driver then shifts the rest of the script by the wait. */
function drive(name: string, keys: string, extraArgs: string[] = [], extraEnv: string[] = []): { frames: string; meta: string; snap: (label: string) => string } {
  const out = mkdtempSync(join(tmpdir(), `qa1311-${name}-`));
  const home = mkdtempSync(join(tmpdir(), `qa1311-home-${name}-`));
  const args = ['-I', DRIVE, '--cwd', resolve(here, '..', '..', '..', '..'), '--out', out, '--name', name,
    '--cols', '140', '--rows', '40', '--grace', '6',
    '--env', 'DEXTERM_OFFLINE=1', '--env', `DEXTERM_HOME=${home}`, '--env', 'COLORTERM=truecolor',
    ...extraEnv.flatMap((e) => ['--env', e]),
    '--keys', keys, '--', 'node', BIN, '--fixtures', '--no-boot', '--tz', 'UTC', ...extraArgs];
  const r = spawnSync('python3', args, { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `pty driver failed: ${r.stderr}`);
  const frames = readFileSync(join(out, `${name}.frames.txt`), 'utf8');
  const meta = readFileSync(join(out, `${name}.meta.txt`), 'utf8');
  // frames file blocks start with "==== t=..s before <KEY> (...) ====" — return the block for a SNAP label
  const snap = (label: string): string => {
    const parts = frames.split('==== ');
    const hit = parts.find((p) => p.startsWith(`t=`) && p.includes(`before SNAP:${label} `));
    return hit ?? '';
  };
  return { frames, meta, snap };
}

/**
 * A fake `claude` on PATH so the interactive first-question path can be driven without a real (paid)
 * run: it logs every spawn to a file (proving a run was/was not launched) and emits a minimal
 * stream-json turn that resolves to a known answer. Returns the PATH override + the spawn-log path.
 */
function makeFakeClaude(name: string): { envPath: string; logPath: string; sawSpawn: () => boolean } {
  const dir = mkdtempSync(join(tmpdir(), `qa1311-fakeclaude-${name}-`));
  const logPath = join(dir, 'spawn.log');
  writeFileSync(logPath, ''); // pre-create so an empty log (no spawn) still reads cleanly
  const bin = join(dir, 'claude');
  // Logs the spawn, then streams one assistant turn whose text + result is the sentinel answer.
  const script = [
    '#!/bin/sh',
    'echo spawned >> "$DEXTERM_FAKE_LOG"',
    `printf '%s\\n' '{"type":"system","subtype":"init","model":"fake-sonnet","session_id":"qa-sess-1","mcp_servers":[],"skills":[]}'`,
    `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"RUGCHECKANSWER42"}}}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success","result":"RUGCHECKANSWER42","total_cost_usd":0,"duration_ms":10,"num_turns":1,"is_error":false,"session_id":"qa-sess-1"}'`,
    '',
  ].join('\n');
  writeFileSync(bin, script, { mode: 0o755 });
  return {
    envPath: `PATH=${dir}:${process.env.PATH ?? ''}`,
    logPath,
    sawSpawn: () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('spawned'),
  };
}

// ---------------------------------------------------------------- B1
laneTest('QA B1: the Analyst tab is not a trap — number keys are not typed into the box and q quits', { skip }, () => {
  // repro (adapted to the fixed key model): launch · space (dismiss welcome) · 4 (analyst tab) ·
  // snapshot · q  — `q` must quit (never type into the input), proving the tab is not a trap.
  // WAIT (task-1319): block until the analyst tab has painted before the SNAP, so a slow paint under
  // parallel CPU load can't catch an empty/katakana frame (the B1-family flake) — the content is absent,
  // not corrupted, so a fixed 1.9 s offset was the bug, not the rain.
  // Two WAITs: the first lands us on the analyst tab (header), the second waits for its footer to finish
  // painting (a single frame flush can arrive split across reads, so the header can be present a beat
  // before the `q  quit` footer) — both are asserted below, so the SNAP must hold for both.
  const r = drive('b1', '0.3:WAIT:WELCOME_TO_DEXTERM@20,0.6:SPACE,1.3:4,1.4:WAIT:✦_ANALYST,1.5:WAIT:q__quit,1.9:SNAP:analyst,2.4:q,4.0:SNAP:after-q');
  assert.match(r.snap('analyst'), /✦ ANALYST/, 'the analyst tab opened');
  assert.match(r.snap('analyst'), /q {2}quit/, 'the unfocused tab offers `q quit` in the footer (q is a hotkey, not input)');
  assert.match(r.meta, /exit: 0/, 'q quit cleanly from the analyst tab (q was not typed into the box)');
  assert.match(r.meta, /killed by driver: False/, 'the app exited on its own, the driver did not have to kill it');
  assert.match(r.meta, /restored at tail: True/, 'the terminal was restored');
});

// ---------------------------------------------------------------- B3
laneTest('QA B3: typing a question on the Analyst tab fires no hotkeys — `a` does not launch a run', { skip }, () => {
  // repro: launch · space · 4 (analyst) · i (focus the input) · type "what is a rug" · snapshot.
  // The `a` in "a rug" must be typed, not launch a trench-scan; the whole question lands in the box.
  const r = drive('b3', '0.3:WAIT:WELCOME_TO_DEXTERM@20,0.6:SPACE,1.3:4,1.4:WAIT:✦_ANALYST,1.9:i,2.3:TYPE:what_is_a_rug,3.2:WAIT:what_is_a_rug,3.3:SNAP:typed,3.6:ESC,3.9:ESC,4.2:q');
  assert.match(r.snap('typed'), /what is a rug/, 'the typed question (incl. the `a`) lands in the input, no hotkey fired');
  assert.match(r.meta, /exit: 0/, 'esc blurs then backs out and q quits');
});

// ---------------------------------------------------------------- DEFECT 1 (first question never sent)
laneTest('QA DEFECT 1: the FIRST free-text question on a fresh session spawns claude and resolves', { skip }, () => {
  // repro: launch · space (dismiss welcome) · 4 (analyst tab) · i (focus) · type a question · ⏎.
  // The old bug: a brand-new session started as `busy`, so `ask()` queued the first question behind a
  // turn that never began — 0 claude spawned, a permanent "queued: … will ask" banner. The fix must
  // SEND it: assert a real spawn happened AND the answer resolved (no stuck queue banner).
  const fake = makeFakeClaude('d1');
  const r = drive('d1', '0.3:WAIT:WELCOME_TO_DEXTERM@20,0.6:SPACE,1.3:4,1.4:WAIT:✦_ANALYST,1.9:i,2.3:TYPE:is_this_safe,3.2:ENTER,3.3:WAIT:RUGCHECKANSWER42@12,5.6:SNAP:answered,6.0:ESC,6.4:q',
    [], [fake.envPath, `DEXTERM_FAKE_LOG=${fake.logPath}`]);
  assert.ok(fake.sawSpawn(), 'the first question actually spawned claude (it was sent, not left queued)');
  const answered = r.snap('answered');
  assert.doesNotMatch(answered, /queued:/, 'no "queued" banner — the first question was not stuck behind a never-started turn');
  assert.doesNotMatch(answered, /will ask when the run finishes/, 'the question is not waiting on a phantom run');
  assert.match(answered, /RUGCHECKANSWER42/, 'the analyst answer resolved and rendered on the tab');
});

// ---------------------------------------------------------------- DEFECT 2 (welcome card swallows 1-4)
laneTest('QA DEFECT 2: `4` on the welcome card dismisses it AND switches to the Analyst tab (no paid run)', { skip }, () => {
  // repro: fresh launch · 4 (while the welcome card is up) · type the dangerous "what is a rug".
  // The old bug: `4` only dismissed the card, dropping the user on the screener where the `a` in the
  // typed text fired `analyst.toggle` → a real paid rug-check run. The fix makes `4` dismiss AND
  // navigate in one keypress, landing on the Analyst tab where `a` only focuses the input.
  const fake = makeFakeClaude('d2');
  const r = drive('d2', '0.3:WAIT:WELCOME_TO_DEXTERM@20,0.8:4,0.9:WAIT:✦_ANALYST,1.4:SNAP:analyst,1.8:TYPE:what_is_a_rug,3.4:SNAP:typed,3.8:ESC,4.1:ESC,4.4:q',
    [], [fake.envPath, `DEXTERM_FAKE_LOG=${fake.logPath}`]);
  assert.match(r.snap('analyst'), /✦ ANALYST/, '`4` on the welcome card switched to the Analyst tab in the same keypress');
  assert.ok(!fake.sawSpawn(), 'navigating + typing never launched a paid run — `a` on the analyst tab only focuses the input');
  assert.match(r.meta, /exit: 0/, 'the app quit cleanly');
});
