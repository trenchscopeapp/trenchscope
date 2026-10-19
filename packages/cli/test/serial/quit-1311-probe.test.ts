// task-1311 (QA M1) end to end, split out of ../quit-1311.test.ts by task-1424 so it runs in the serial lane
// (scripts/test-lane.mjs serial): quit-probe.mjs builds a LIVE context over the REAL systemClock and measures how
// long the event loop takes to go idle after close(). The < 1000 ms bound is the product requirement and is
// unchanged; the spawn timeout only bounds a hung probe (node start-up under load is not part of the measurement).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialLane } from './lane.ts';

const laneTest = serialLane(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(here, '..', '..', 'tools', 'quit-probe.mjs');

laneTest('QA M1 (end to end, real timers): the quit path drains the loop in under a second', {}, () => {
  // Runs quit-probe.mjs: a LIVE context over the real systemClock with a refusing WebSocket (both the
  // stream and the fast lane in backoff) plus an open token and PAPER ticket, then close()s it. The
  // probe exits 0 only when close() left zero pending timers and the loop idled in < 1000 ms.
  const r = spawnSync('node', [PROBE], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `quit-probe did not exit cleanly within a second:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /pending right after close\(\): 0/, 'no WS backoff timer survived close()');
  const m = /idle at \+(\d+)ms/.exec(r.stdout);
  assert.ok(m, `probe did not report an idle time:\n${r.stdout}`);
  assert.ok(Number(m![1]) < 1000, `the loop took ${m![1]} ms to drain after close (must be < 1000 ms)`);
});
