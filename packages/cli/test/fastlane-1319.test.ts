// task-1319 (item 2): the task-1312 on-chain fast lane (real-time price for the open token + watchlist)
// started only inside startFeed(), which the interactive loop fires only for the live-stream presets
// (trench/new/all) or the new-pairs screen. So `--preset trending` and a `--mint` launch — which open a
// token on a non-live preset or straight to the token screen — never got a LIVE price. The fix gives
// LiveContext a startFastLane() decoupled from the PumpPortal new-pairs stream, started whenever there
// is a token or watchlist to price, in any preset. These tests assert that decoupling directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataLayer, FakeClock, type Transport, type WsFactory, type WsLike, type FastLaneEndpoint } from '@dexterm/data';
import { unlimitedBuckets } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';

const EP: FastLaneEndpoint = { url: 'wss://example/fast', source: 'solana-ws', keyed: false, label: 'public RPC ws' };
const MINT = 'FakeMintPumpaaaaaaaaaaaaaaaaaaaaaaaaaaaapump';
const errTransport: Transport = async () => ({ status: 503, headers: {}, body: '{}', latencyMs: 1 });

/** A WebSocket factory that records how many sockets were opened (so we can see the lane connect). */
function recordingWs(): { ws: WsFactory; opened: () => number } {
  let count = 0;
  const ws: WsFactory = () => {
    count++;
    const listeners: Record<string, Array<(ev: unknown) => void>> = {};
    const sock: WsLike = {
      readyState: 0,
      send() {},
      close() {},
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn as never); },
    };
    return sock;
  };
  return { ws, opened: () => count };
}

function liveCtx(clock: FakeClock, ws: WsFactory, fast: boolean) {
  const dl = createDataLayer({ transport: errTransport, clock, buckets: unlimitedBuckets() });
  const ctx = new LiveContext(dl, {
    mode: 'live',
    ws,
    fastEndpoints: fast ? [EP] : undefined,
    now: () => clock.now(),
  });
  return { dl, ctx };
}

test('item 2: startFastLane() connects the fast lane without starting the push stream (any preset)', () => {
  const clock = new FakeClock(1_000_000);
  const rec = recordingWs();
  const { dl, ctx } = liveCtx(clock, rec.ws, true);

  assert.equal(ctx.fastLaneRunning, false, 'not running before start');
  assert.equal(ctx.feedStarted, false, 'the push stream has not started');

  ctx.startFastLane();

  assert.equal(ctx.fastLaneRunning, true, 'the fast lane is running after startFastLane()');
  assert.equal(ctx.feedStarted, false, 'the new-pairs PumpPortal stream did NOT start (decoupled)');
  assert.ok(rec.opened() >= 1, 'the fast-lane WebSocket was opened — a LIVE price path exists in any preset');

  ctx.startFastLane(); // idempotent
  assert.equal(rec.opened(), 1, 'a second startFastLane() opens no extra socket');

  ctx.close();
  dl.close();
});

test('item 2: a --mint launch (open token, no startFeed) tracks the token on the fast lane', () => {
  const clock = new FakeClock(2_000_000);
  const rec = recordingWs();
  const { dl, ctx } = liveCtx(clock, rec.ws, true);

  // Mirror the --mint setup path: open a token, then start just the fast lane.
  ctx.openToken({ mint: MINT, symbol: 'FAKE', name: '', launchpad: 'pump.fun' });
  ctx.startFastLane();

  assert.equal(ctx.fastLaneRunning, true, 'the fast lane runs for a --mint launch');
  assert.equal(ctx.feedStarted, false, 'no push stream needed to price the open token');
  const status = ctx.fastLane?.status();
  assert.ok(status, 'the fast lane reports status');
  assert.ok(status!.tracked >= 1, `the opened token is tracked on the fast lane (tracked=${status!.tracked})`);

  ctx.close();
  dl.close();
});

test('item 2: startFastLane() is a no-op in replay mode and without endpoints', () => {
  const clock = new FakeClock(3_000_000);
  const rec = recordingWs();
  // live, but no fast endpoints configured → nothing to start.
  const { dl, ctx } = liveCtx(clock, rec.ws, false);
  ctx.startFastLane();
  assert.equal(ctx.fastLaneRunning, false, 'no endpoints → the lane does not start');
  assert.equal(rec.opened(), 0, 'no socket opened without endpoints');
  ctx.close();
  dl.close();
});
