// task-1311 (QA M1): quitting must exit in well under a second from every state. The hang was the
// WebSocket reconnect backoff — PumpPortal and the task-1312 fast lane both `await clock.sleep(wait)`
// with a doubling backoff (1→2→4…30 s), and stop() never cancelled that pending timer, so a quit
// during a backoff waited the whole window out (~9 s observed). The analyst child is the other handle:
// its stdio pipes would keep the loop alive past a SIGTERM that claude is slow to honour.
//
// These tests drive the real handle owners (LiveContext over an injected FakeClock + a WebSocket that
// refuses to connect; AnalystSession over an injected fake spawn) and assert close()/cancel() releases
// every handle. The FakeClock makes "is a backoff timer still pending?" exact via pendingTimers. The
// end-to-end check (the quit-probe over the REAL systemClock: the process must go idle in under a second,
// with the token + ticket + fast lane + stream all live) runs in the serial lane: serial/quit-1311-probe.test.ts
// (task-1424).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataLayer, FakeClock, type Transport, type WsFactory, type WsLike, type FastLaneEndpoint } from '@dexterm/data';
import { unlimitedBuckets } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';
import { AnalystSession } from '../src/analyst/session.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MINT = 'FakeMintPumpaaaaaaaaaaaaaaaaaaaaaaaaaaaapump';
const EP: FastLaneEndpoint = { url: 'wss://example/fast', source: 'solana-ws', keyed: false, label: 'public RPC ws' };

/** A WebSocket that never opens: fires error+close on the next microtask so the client reconnects. */
const failingWs: WsFactory = () => {
  const listeners: Record<string, Array<(ev: { message?: string; code?: number; reason?: string }) => void>> = {};
  const ws: WsLike = {
    readyState: 0,
    send() {},
    close() {},
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn as never); },
  };
  queueMicrotask(() => {
    for (const fn of listeners.error ?? []) fn({ message: 'refused' });
    for (const fn of listeners.close ?? []) fn({ code: 1006, reason: 'refused' });
  });
  return ws;
};

const errTransport: Transport = async () => ({ status: 503, headers: {}, body: '{}', latencyMs: 1 });

function liveCtx(clock: FakeClock, opts: { fast?: boolean } = {}) {
  const dl = createDataLayer({ transport: errTransport, clock, buckets: unlimitedBuckets() });
  const ctx = new LiveContext(dl, {
    mode: 'live',
    ws: failingWs,
    fastEndpoints: opts.fast ? [EP] : undefined,
    now: () => clock.now(),
  });
  return { dl, ctx };
}

/** Run the WS clients until their reconnect backoff is pending (a couple of failed connects). */
async function driveIntoBackoff(clock: FakeClock): Promise<void> {
  await clock.advance(1);      // the microtask-fired close() lands → schedule the first retry
  await clock.advance(1_000);  // fire it → reconnect → fail → schedule the next (2 s) retry
  await clock.advance(2_000);  // and again (4 s) — the backoff is now firmly pending
}

test('QA M1 (boot): a context whose feed never started closes clean, with no pending timer', () => {
  const clock = new FakeClock(1_000_000);
  const { dl, ctx } = liveCtx(clock, { fast: true });
  // boot: the stream/fast lane have not been started yet.
  assert.equal(ctx.feedStarted, false);
  assert.equal(clock.pendingTimers, 0, 'nothing scheduled before the feed starts');
  ctx.close();
  ctx.close(); // idempotent
  dl.close();
  assert.equal(clock.pendingTimers, 0, 'close() leaves nothing pending');
});

test('QA M1 (screener / new pairs): close() cancels the PumpPortal reconnect backoff', async () => {
  const clock = new FakeClock(2_000_000);
  const { dl, ctx } = liveCtx(clock); // no fast lane: isolate the PumpPortal stream
  await ctx.startFeed(1);
  await driveIntoBackoff(clock);
  assert.ok(clock.pendingTimers >= 1, 'a PumpPortal reconnect backoff is pending while live');
  ctx.close();
  dl.close();
  assert.equal(clock.pendingTimers, 0, 'the backoff timer was cancelled on close — quit no longer waits it out');
});

test('QA M1 (token screen + LIVE fast lane): close() cancels the fast-lane and stream backoffs', async () => {
  const clock = new FakeClock(3_000_000);
  const { dl, ctx } = liveCtx(clock, { fast: true });
  ctx.openToken({ mint: MINT, symbol: 'FAKE', name: 'Fake', launchpad: 'pump.fun' });
  await ctx.startFeed(1);
  await driveIntoBackoff(clock);
  assert.ok(clock.pendingTimers >= 2, 'both the fast-lane WS and the PumpPortal stream are in backoff');
  ctx.close();
  dl.close();
  assert.equal(clock.pendingTimers, 0, 'every WS reconnect backoff was cancelled on close');
});

test('QA M1 (ticket open): an open PAPER ticket adds no timer that survives close', async () => {
  const clock = new FakeClock(4_000_000);
  const { dl, ctx } = liveCtx(clock, { fast: true });
  ctx.openToken({ mint: MINT, symbol: 'FAKE', name: 'Fake', launchpad: 'pump.fun' });
  ctx.openTicket({ mint: MINT, symbol: 'FAKE', name: 'Fake' }, 'buy');
  await ctx.startFeed(1);
  await driveIntoBackoff(clock);
  ctx.close();
  dl.close();
  assert.equal(clock.pendingTimers, 0, 'the ticket + WS handles are all released on close');
});

/** A fake `claude` child whose stdio can be destroyed and whose kill/unref are observable. */
function fakeSpawn() {
  const calls = { kill: [] as Array<string | undefined>, unref: 0, destroyed: 0 };
  const spawn = (() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const pipe = () => {
      const s = new PassThrough();
      s.on('error', () => {});
      const orig = s.destroy.bind(s);
      s.destroy = ((...a: unknown[]) => { calls.destroyed++; return (orig as (...x: unknown[]) => unknown)(...a); }) as never;
      return s;
    };
    child.stdout = pipe();
    child.stderr = pipe();
    child.stdin = pipe();
    child.kill = (sig?: string) => { calls.kill.push(sig); return true; };
    child.unref = () => { calls.unref++; };
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawn, calls };
}

test('QA M1 (analyst busy): cancel() kills the claude child and drops its stdio handles', () => {
  const { spawn, calls } = fakeSpawn();
  const sess = new AnalystSession({ skill: 'token-dossier', mint: MINT, symbol: 'FAKE', screenState: {} }, () => {}, { spawn });
  sess.start();
  assert.equal(sess.busy, true, 'a started turn is busy (a live child is running)');
  sess.cancel();
  assert.deepEqual(calls.kill, ['SIGTERM'], 'the child got SIGTERM');
  assert.equal(calls.unref, 1, 'the child was unref’d so a slow death cannot hold the loop');
  assert.ok(calls.destroyed >= 2, 'the stdout/stderr pipes were destroyed so they stop holding the loop');
});
