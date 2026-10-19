#!/usr/bin/env node
// task-1424: run one serial test lane and report its retries.
//
//   node scripts/test-lane.mjs serial   # packages/*/test/serial/*.test.ts (pty, real binary, wall-clock bounds)
//   node scripts/test-lane.mjs perf     # packages/*/test/perf/*.test.ts   (render budget)
//
// `npm test` runs both AFTER the parallel suite, so these tests never share the CPU with ~150 neighbouring test
// processes. Files run one at a time (--test-concurrency=1). Tests use serialLane() (packages/cli/test/serial/
// lane.ts): one automatic retry, logged. This script collects that log and prints every test that needed the
// retry, so a retry is reported and never hidden. Exit code is node --test's: a test that fails twice fails.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LANES = { serial: 'packages/*/test/serial/*.test.ts', perf: 'packages/*/test/perf/*.test.ts' };
const lane = process.argv[2];
if (!(lane in LANES)) {
  console.error(`usage: node scripts/test-lane.mjs <${Object.keys(LANES).join('|')}>`);
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), `dexterm-${lane}-lane-`));
const log = join(dir, 'retries.jsonl');
// A lane normally takes well under a minute. A test that fails without quitting the app can keep its file
// alive forever, so the whole lane is capped and a stall fails loudly instead of hanging.
const capMs = Number(process.env.DEXTERM_LANE_TIMEOUT_MS) || 10 * 60_000;
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(3), LANES[lane]], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DEXTERM_TEST_RETRY_LOG: log }, timeout: capMs, killSignal: 'SIGKILL',
});
if (r.error?.code === 'ETIMEDOUT') console.error(`\n${lane} lane: stopped after ${capMs / 1000}s with no exit. A test file is stuck (often a failed test that never quit the app).`);

const retries = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const code = r.status ?? 1;
if (retries.length === 0) {
  console.log(`\n${lane} lane: no test needed the automatic retry${process.env.DEXTERM_TEST_NO_RETRY ? ' (retries disabled)' : ''}.`);
} else {
  const passed = retries.filter((x) => x.outcome === 'passed-on-retry');
  const failed = retries.filter((x) => x.outcome === 'failed-twice');
  console.log(`\n${lane} lane: ${retries.length} test(s) failed their first attempt (${passed.length} passed on the retry, ${failed.length} failed twice):`);
  for (const x of retries) {
    console.log(`  RETRY ${x.outcome === 'passed-on-retry' ? 'passed on retry' : 'FAILED TWICE'}: ${x.file} › ${x.test}`);
    console.log(`    attempt 1: ${x.first}`);
    if (x.second) console.log(`    attempt 2: ${x.second}`);
  }
  if (passed.length) console.log(`  A test that needs the retry is load-sensitive: report it in the handoff.`);
}
rmSync(dir, { recursive: true, force: true });
process.exit(code);
