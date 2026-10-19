// task-1319 (QA M1): quitting the REAL binary with `q` must exit in well under a second, even with a
// token open. The earlier quit-1311 tests cover the WebSocket-reconnect backoff path with a FakeClock,
// but they inject an error transport and never exercise the live HTTP layer. The 10-33 s hang that QA
// hit had two more causes, both only reproducible against a real network:
//   1. liveTransport used AbortSignal.timeout(), whose internal timer is ref'd and never cancelled when
//      the fetch settles — so each request left a ref'd ~10 s timer holding the event loop.
//   2. systemClock.sleep() (the rate-limiter / pacing / backoff wait) scheduled a ref'd timer, so a
//      pending limiter sleep (up to the bucket interval, or 30 s+ under a 429) held the loop at quit.
// Both are fixed to be unref'd + cancelled on close(). This end-to-end test spawns the actual binary
// under a pty, lets it open a token and run live, sends `q`, and asserts the process exits in < 1 s.
//
// It needs a real network and a pty, so it SKIPS under DEXTERM_OFFLINE (the suite's default) or when
// python3's pty module is unavailable — a networked run is where the regression lives.
import { serialLane } from './lane.ts';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const laneTest = serialLane(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(here, '..', 'measure', 'quit-timing.py');
const HANG_STUB = resolve(here, '..', 'measure', 'hang-fetch.mjs');

function skipReason(): string | false {
  if (process.env.DEXTERM_OFFLINE) return 'offline (DEXTERM_OFFLINE set): the quit hang only reproduces against a live network';
  try { execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }); } catch { return 'python3 pty module not available'; }
  return false;
}

// The wiring test below stubs fetch so it never needs a real network; it only needs python3's pty.
function ptySkipReason(): string | false {
  try { execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }); } catch { return 'python3 pty module not available'; }
  return false;
}

laneTest('QA M1 (real binary): `q` with a token open exits in under a second', { skip: skipReason() }, () => {
  // Fill for ~10 s (opens a token at +3 s so the token loader + fast lane are live), then press `q`.
  const r = spawnSync('python3', ['-I', HARNESS, '--wait', '10', '--key', 'q', '--open', '--intensity', 'fever'],
    { encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 0, `quit-timing harness failed:\n${r.stdout}\n${r.stderr}`);
  const m = /exit after q:\s*([\d.]+)\s*s\s*\(exit code (\d+)\)/.exec(r.stdout);
  assert.ok(m, `harness did not report an exit time:\n${r.stdout}`);
  const seconds = Number(m[1]);
  const code = Number(m[2]);
  assert.equal(code, 0, `the app did not exit cleanly on q (code ${code}):\n${r.stdout}`);
  assert.ok(seconds < 1.0, `quit took ${seconds.toFixed(2)} s after q — must be < 1 s (QA M1 regression):\n${r.stdout}`);
});

// task-1319 (AC1 re-dispatch): the regression that a live network could not reproduce reliably — the
// shutdown signal never reached the transport createLiveFeed actually builds, so feed.close() aborted a
// controller wired to nothing and in-flight live fetches were left to linger. The hang-fetch stub makes
// EVERY request hang (holding a ref'd handle) until its AbortSignal fires, so this is deterministic and
// network-free: pre-fix, quit waits out liveTransport's own ~10 s timeout; post-fix, close() aborts the
// in-flight fetch and the app exits sub-second. Reuses the pty quit-timing harness with the stub injected
// via NODE_OPTIONS=--import (which also forces live feeds — the harness unsets DEXTERM_OFFLINE).
for (const key of ['ctrlc', 'q'] as const) {
  const label = key === 'q' ? '`q`' : 'Ctrl-C';
  laneTest(`AC1 (real binary, hung in-flight fetch): ${label} aborts the live transport and exits under a second`,
    { skip: ptySkipReason() }, () => {
      const r = spawnSync('python3', ['-I', HARNESS, '--wait', '6', '--key', key, '--open', '--intensity', 'fever'],
        { encoding: 'utf8', timeout: 90_000, env: { ...process.env, NODE_OPTIONS: `--import=${HANG_STUB}` } });
      assert.equal(r.status, 0, `quit-timing harness failed:\n${r.stdout}\n${r.stderr}`);
      const m = new RegExp(`exit after ${key === 'q' ? 'q' : 'Ctrl-C'}:\\s*([\\d.]+)\\s*s\\s*\\(exit code (\\d+)\\)`).exec(r.stdout);
      assert.ok(m, `harness did not report an exit time:\n${r.stdout}`);
      const seconds = Number(m[1]);
      const code = Number(m[2]);
      assert.equal(code, 0, `the app did not exit cleanly (code ${code}):\n${r.stdout}`);
      assert.ok(seconds < 1.0, `quit took ${seconds.toFixed(2)} s with a hung fetch in flight — must be < 1 s (AC1):\n${r.stdout}`);
    });
}
