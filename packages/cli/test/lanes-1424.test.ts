// task-1424: the test lanes stay structural. pty / real-binary / wall-clock tests live in packages/<pkg>/test/serial/
// (render budgets in test/perf/) and `npm test` runs them after the parallel suite, one file at a time, through
// scripts/test-lane.mjs. This file (in the parallel glob) keeps it that way:
//  1. no parallel-glob test file drives a pty harness;
//  2. every serial/perf test registers through serialLane(), so it gets the one LOGGED retry;
//  3. `npm test` runs parallel, then serial, then perf;
//  4. the retry really is logged: a test that fails once is retried, reported on stderr and in the retry log,
//     and DEXTERM_TEST_NO_RETRY=1 makes the same test fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..');
const LANE = resolve(here, 'serial', 'lane.ts');
const packages = readdirSync(join(ROOT, 'packages')).filter((p) => existsSync(join(ROOT, 'packages', p, 'test')));
const filesIn = (sub: string): string[] => packages.flatMap((p) => {
  const dir = join(ROOT, 'packages', p, 'test', sub);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => join(dir, f)) : [];
});

/** Markers of a test that drives a terminal through a pty (the harnesses in packages/cli/test/measure). */
const PTY_MARKERS = [/\bdrive\.py\b/, /\baction-pty\.py\b/, /\bquit-timing\.py\b/, /\bimport pty\b/, /\bpty\.(fork|openpty|spawn)\b/];

test('lanes: no parallel-glob test file drives a pty harness (those belong in test/serial/)', () => {
  const offenders: string[] = [];
  for (const f of filesIn('').filter((x) => x !== fileURLToPath(import.meta.url))) {
    const src = readFileSync(f, 'utf8');
    for (const m of PTY_MARKERS) if (m.test(src)) offenders.push(`${f.slice(ROOT.length + 1)} (${m.source})`);
  }
  assert.deepEqual(offenders, [], 'move these to packages/<pkg>/test/serial/ (see the README Test section)');
});

test('lanes: every serial and perf test registers through serialLane (one logged retry), never bare node:test', () => {
  const files = [...filesIn('serial'), ...filesIn('perf')];
  assert.ok(files.length >= 10, `expected the serial + perf lanes to hold at least 10 files, found ${files.length}`);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const rel = f.slice(ROOT.length + 1);
    assert.match(src, /import \{ serialLane \} from '[^']*serial\/lane\.ts';|import \{ serialLane \} from '\.\/lane\.ts';/, `${rel} imports serialLane`);
    assert.match(src, /const laneTest = serialLane\(import\.meta\.url\);/, `${rel} builds laneTest from its own URL`);
    assert.doesNotMatch(src, /from 'node:test'/, `${rel} must not register bare node:test tests (they would skip the logged retry)`);
  }
});

test('lanes: npm test runs the parallel suite, then the serial lane, then the perf lane', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const t = pkg.scripts.test;
  const par = t.indexOf('node --test "packages/*/test/*.test.ts"');
  const ser = t.indexOf('npm run test:serial');
  const perf = t.indexOf('npm run test:perf');
  assert.ok(par >= 0 && ser > par && perf > ser, `npm test order: ${t}`);
  assert.equal(pkg.scripts['test:serial'], 'node scripts/test-lane.mjs serial');
  assert.equal(pkg.scripts['test:perf'], 'node scripts/test-lane.mjs perf');
  const runner = readFileSync(join(ROOT, 'scripts', 'test-lane.mjs'), 'utf8');
  assert.match(runner, /'--test-concurrency=1'/, 'the lanes run one file at a time');
  assert.match(runner, /serial: 'packages\/\*\/test\/serial\/\*\.test\.ts'/);
  assert.match(runner, /perf: 'packages\/\*\/test\/perf\/\*\.test\.ts'/);
});

test('lanes: the 16 ms wall-clock p95 budget is unconditional', () => {
  const src = readFileSync(join(ROOT, 'packages', 'cli', 'test', 'perf', 'render-1330.test.ts'), 'utf8');
  assert.match(src, /assert\.ok\(b\.p95 < FRAME_BUDGET_MS/, 'wall-clock p95 stays a hard assertion');
  assert.doesNotMatch(src, /wall p95 NOT asserted|if \(wallAsserted\(b\)\)/, 'scheduler diagnostics cannot suppress the wall assertion');
});

test('lanes: a test that fails once is retried, and the retry is logged (stderr, TAP diagnostic, retry log); NO_RETRY fails it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-lane-1424-'));
  try {
    const marker = join(dir, 'attempts');
    const file = join(dir, 'flaky.test.ts');
    writeFileSync(file, [
      `import { appendFileSync, readFileSync, existsSync } from 'node:fs';`,
      `import { serialLane } from ${JSON.stringify(pathToFileURL(LANE).href)};`,
      `const laneTest = serialLane(import.meta.url);`,
      `laneTest('flaky once', {}, () => {`,
      `  const n = existsSync(${JSON.stringify(marker)}) ? readFileSync(${JSON.stringify(marker)}, 'utf8').length : 0;`,
      `  appendFileSync(${JSON.stringify(marker)}, 'x');`,
      `  if (n === 0) throw new Error('first attempt fails on purpose');`,
      `});`,
      '',
    ].join('\n'));
    const log = join(dir, 'retries.jsonl');
    // a fresh runner: drop the parent's NODE_TEST_CONTEXT, or the child refuses to run files from inside a test
    const { NODE_TEST_CONTEXT: _ctx, ...base } = process.env;
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
      encoding: 'utf8', env: { ...base, DEXTERM_TEST_RETRY_LOG: log, DEXTERM_TEST_NO_RETRY: '', ...env }, timeout: 60_000,
    });

    const ok = run({});
    assert.equal(ok.status, 0, `the retried test passes:\n${ok.stdout}\n${ok.stderr}`);
    assert.match(ok.stderr + ok.stdout, /RETRY .*flaky\.test\.ts › flaky once: attempt 1 failed \(first attempt fails on purpose\); retrying once/);
    assert.match(ok.stdout, /# passed on the automatic retry/, 'a TAP diagnostic marks the test as retried');
    const rec = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { outcome: string; first: string; test: string });
    assert.deepEqual(rec.map((r) => [r.test, r.outcome, r.first]), [['flaky once', 'passed-on-retry', 'first attempt fails on purpose']]);

    rmSync(marker, { force: true });
    rmSync(log, { force: true });
    const strict = run({ DEXTERM_TEST_NO_RETRY: '1' });
    assert.notEqual(strict.status, 0, 'with retries off the same test fails');
    assert.ok(!existsSync(log), 'nothing is logged when no retry ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
