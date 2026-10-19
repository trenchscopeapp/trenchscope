import { serialLane } from './lane.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const laneTest = serialLane(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// the QA pty driver vendored into the repo (task-1319); task-1415 dropped the out-of-repo evidence path
const driver = resolve(root, 'packages/cli/test/measure/drive.py');
const hasPty = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore', timeout: 5000 }).status === 0;
// task-1424: serial lane. The key script waits on the screen (drive.py WAIT:text@secs shifts every later key by
// the time it waited) instead of fixed offsets, and the bounds are generous: the old 16 s spawn / 20 s test
// limits were exceeded by a slow start-up at high load (it passes alone in ~9 s at load 84).
laneTest('pty: explicit V runs larp-check and renders the computed badge; L opens a navigable menu', { skip: !existsSync(driver) ? 'vendored PTY driver missing' : !hasPty ? 'python3 POSIX pty module unavailable (not a native Windows ConPTY test)' : false, timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'task1315-pty-'));
  const answer = { type: 'result', structured_output: { skill: 'larp-check', verdict: 'UNVERIFIABLE', confidence: 0.2,
    summary: 'FIXTURE product evidence unavailable', claims: [], missing_data: ['fixture'], flags: [], injection_detected: false } };
  const stub = '#!/usr/bin/env node\n' +
    "require('node:fs').writeFileSync(process.env.LARP_SPAWN_LOG,JSON.stringify(process.argv.slice(2))); console.log(" +
    JSON.stringify(JSON.stringify(answer)) + ');\n';
  writeFileSync(join(dir, 'claude'), stub, { mode: 0o755 });
  const out = spawnSync('python3', ['-I', driver, '--cwd', root, '--out', dir, '--name', 'larp', '--cols', '176', '--rows', '48', '--grace', '3',
    '--env', 'HOME=' + dir, '--env', 'DEXTERM_HOME=' + dir, '--env', 'PATH=' + dir + ':' + process.env.PATH, '--env', 'LARP_SPAWN_LOG=' + join(dir, 'spawn.json'),
    '--keys', '0.3:WAIT:WELCOME_TO_DEXTERM@30,2.0:SPACE,2.4:j,2.6:j,2.8:j,3.2:ENTER,3.3:WAIT:ON-CHAIN@20,4.8:V,4.9:WAIT:FIXTURE_product_evidence@30,6.0:SNAP:verdict,6.5:L,6.6:WAIT:ADVERTISED_LINKS@20,7.2:SNAP:links,7.8:ESC,8.4:q',
    '--', 'node', 'packages/cli/bin/dexterm.mjs', '--replay', 'packages/data/fixtures/live-sample.json', '--no-boot', '--calm'], { encoding: 'utf8', timeout: 100_000 });
  assert.equal(out.status, 0, out.stderr);
  const args = JSON.parse(readFileSync(join(dir, 'spawn.json'), 'utf8')) as string[];
  assert.match(args[args.indexOf('-p') + 1], /^\/dexterm:larp-check /);
  const frames = readFileSync(join(dir, 'larp.frames.txt'), 'utf8');
  assert.match(frames, /FIXTURE product evidence/);
  assert.match(frames, /UNKNOWN/);
  assert.match(frames, /ADVERTISED LINKS/);
  const meta = readFileSync(join(dir, 'larp.meta.txt'), 'utf8');
  assert.match(meta, /exit: 0/);
  assert.match(meta, /restored at tail: True/);
  console.log('PTY evidence (stubbed analyst, replay data): ' + dir);
});
