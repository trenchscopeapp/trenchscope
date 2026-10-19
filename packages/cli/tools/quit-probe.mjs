// Instrumentation for the task-1311 quit hang. Builds a LIVE LiveContext over the real systemClock
// with a WebSocket factory that refuses to connect, so the PumpPortal stream and the task-1312 fast
// lane both fall into their reconnect backoff (a real setTimeout). It also opens a token and a PAPER
// trade ticket, so every handle a quit must release is live. Then it close()s everything and reports
// the active timers and how long the event loop stays alive — the same thing quit() does in main.ts.
//
//   node packages/cli/tools/quit-probe.mjs
//
// Exits 0 only when close() left zero pending timers and the loop went idle in under a second.
import { createDataLayer, systemClock } from '../../data/src/index.ts';
import { unlimitedBuckets } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';

/** A WebSocket that never opens: it fires error+close on the next microtask, forcing a reconnect. */
function makeFailingWs() {
  return (_url) => {
    const listeners = {};
    const ws = { readyState: 0, send() {}, close() {}, addEventListener(type, fn) { (listeners[type] ??= []).push(fn); } };
    queueMicrotask(() => {
      for (const fn of listeners.error ?? []) fn({ message: 'connect refused' });
      for (const fn of listeners.close ?? []) fn({ code: 1006, reason: 'refused' });
    });
    return ws;
  };
}

const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout' || r === 'Immediate').length;

const dl = createDataLayer({
  transport: async () => ({ status: 503, headers: {}, body: '{}', latencyMs: 1 }),
  clock: systemClock,
  buckets: unlimitedBuckets(),
});
const ctx = new LiveContext(dl, {
  mode: 'live',
  ws: makeFailingWs(),
  fastEndpoints: [{ url: 'wss://example/a', source: 'solana-ws', keyed: false, label: 'a' }],
  now: () => Date.now(),
});
ctx.openToken({ mint: 'FakeMintPumpaaaaaaaaaaaaaaaaaaaaaaaaaaaapump', symbol: 'FAKE', name: 'Fake', launchpad: 'pump.fun' });
ctx.openTicket({ mint: 'FakeMintPumpaaaaaaaaaaaaaaaaaaaaaaaaaaaapump', symbol: 'FAKE', name: 'Fake' }, 'buy');
await ctx.startFeed(1);

// Let the fake sockets fail a few times so the reconnect backoff timers are pending.
await new Promise((r) => setTimeout(r, 60));
console.log('pending while running:', timers());

const t0 = Date.now();
ctx.close();
dl.close();
const after = timers();
console.log('pending right after close():', after);

let idleMs = -1;
process.on('beforeExit', () => { idleMs = Date.now() - t0; console.log(`event loop idle at +${idleMs}ms after close()`); });
process.on('exit', () => {
  // Fail loudly if close() left a timer behind or the loop took more than a second to drain. (Standard
  // stdio wraps are always live and never block exit, so they are not part of the check.)
  process.exitCode = after === 0 && idleMs >= 0 && idleMs < 1000 ? 0 : 1;
});
