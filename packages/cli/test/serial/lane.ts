// task-1424: the serial lane's test wrapper. pty, real-binary and wall-clock tests live in
// packages/<pkg>/test/serial/ (and the render budget in test/perf/); `npm test` runs them AFTER the parallel
// suite, one file at a time, through scripts/test-lane.mjs. Each such test gets ONE automatic retry, and the
// retry is LOGGED, never hidden: the failed attempt is printed to stderr, attached to the test as a TAP
// diagnostic and appended to the lane's retry log, and the lane prints every retried test in its summary.
// The assertions are unchanged: a test that fails twice fails the run. DEXTERM_TEST_NO_RETRY=1 turns the retry
// off (use it to reproduce a flake, or to prove a test passes first time).
import { test, type TestContext } from 'node:test';
import { appendFileSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Set by scripts/test-lane.mjs: one JSON line per retried test. */
export const RETRY_LOG_ENV = 'DEXTERM_TEST_RETRY_LOG';
export const NO_RETRY_ENV = 'DEXTERM_TEST_NO_RETRY';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export type LaneOptions = {
  skip?: boolean | string;
  /** Per-attempt bound (ms). The node:test timeout is twice this plus a margin, so the retry fits. */
  timeout?: number;
};

export type RetryRecord = { file: string; test: string; outcome: 'passed-on-retry' | 'failed-twice'; first: string; second?: string };

const message = (err: unknown): string => String(err instanceof Error ? err.message : err);
/** The failure on one line (whitespace collapsed, capped) for the retry log and the lane summary. */
const summary = (err: unknown): string => {
  const one = message(err).replace(/\s+/g, ' ').trim() || '(no message)';
  return one.length > 500 ? one.slice(0, 500) + '…' : one;
};

function record(r: RetryRecord): void {
  const log = process.env[RETRY_LOG_ENV];
  if (log) appendFileSync(log, JSON.stringify(r) + '\n');
}

/** `const laneTest = serialLane(import.meta.url)`, then `laneTest(name, opts, fn)` in place of `test(...)`. */
export function serialLane(fileUrl: string) {
  const file = relative(ROOT, fileURLToPath(fileUrl));
  return (name: string, opts: LaneOptions, fn: (t: TestContext) => void | Promise<void>): void => {
    const perAttempt = opts.timeout ?? 180_000;
    test(name, { skip: opts.skip, timeout: perAttempt * 2 + 10_000 }, async (t) => {
      try {
        await fn(t);
        return;
      } catch (err) {
        if (process.env[NO_RETRY_ENV]) throw err;
        const first = summary(err);
        const line = `RETRY ${file} › ${name}: attempt 1 failed (${first}); retrying once`;
        process.stderr.write(`${line}\n--- attempt 1, full failure:\n${message(err)}\n---\n`);
        t.diagnostic(line);
        try {
          await fn(t);
        } catch (err2) {
          record({ file, test: name, outcome: 'failed-twice', first, second: summary(err2) });
          throw err2;
        }
        record({ file, test: name, outcome: 'passed-on-retry', first });
        t.diagnostic('passed on the automatic retry; the lane summary reports it');
      }
    });
  };
}
