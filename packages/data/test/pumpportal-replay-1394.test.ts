// task-1394: PumpPortalClient.replay() used to stamp each message's receivedAt with clock.now() read fresh
// per message. During the synchronous replay loop the real wall clock ticks over a millisecond boundary at a
// non-deterministic point, so the row's createdAt — and therefore the newest-first order on the NEW PAIRS
// screen — flipped between runs. That was the Node-22-only CI flake in the new-pairs replay test (Node 24,
// being faster, crossed the boundary less often). The fix anchors receive times to the recording's own `tMs`
// offsets from a single clock read, so replay is deterministic on every engine. This test drives a clock that
// deliberately advances on every read; the fix must ignore those per-message reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Clock } from '../src/clock.ts';
import { PumpPortalClient, type PumpEvent } from '../src/sources/pumpportal.ts';
import type { StreamRecording } from '../src/fixtures.ts';

/** A clock whose now() jumps forward by `step` every single call (mimics real time ticking mid-loop). */
function tickingClock(start: number, step: number): Clock {
  let t = start;
  return { now: () => { const v = t; t += step; return v; }, sleep: async () => {} };
}

function createMsg(mint: string): string {
  return JSON.stringify({ txType: 'create', mint, name: mint, symbol: mint.slice(0, 4), pool: 'pump', vTokensInBondingCurve: 1_000_000_000 });
}

function recording(tMs: number[]): StreamRecording {
  return { url: 'wss://pump', startedAt: new Date(0).toISOString(), sent: [], messages: tMs.map((t, i) => ({ tMs: t, text: createMsg(`M${i}pump`) })) };
}

test('task-1394: replay receive times come from the recording tMs, not per-message clock reads', async () => {
  const START = 1_000_000;
  const STEP = 5; // every now() read advances 5 ms — the old code would have used these ticking values
  const events: PumpEvent[] = [];
  const client = new PumpPortalClient({ clock: tickingClock(START, STEP), onEvent: (ev) => events.push(ev) });
  const tMs = [0, 0, 7, 9]; // two tied, then later — this is what must drive createdAt order
  await client.replay(recording(tMs), 0);

  assert.equal(events.length, 4);
  // The replay anchor is the FIRST clock read (set(state:open) also reads once after startedAt).
  const startedAt = START; // startedAt is read first, before any status set
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].receivedAt, startedAt + tMs[i], `event ${i} receivedAt is anchored to tMs, not the ticking clock`);
  }
  // Proof it is NOT the per-message clock value: message 2 (tMs 7) would have been a multiple of STEP under the bug.
  assert.notEqual(events[2].receivedAt, startedAt + 2 * STEP);
});

test('task-1394: two replays of the same recording produce identical receive times (deterministic)', async () => {
  const run = async () => {
    const got: number[] = [];
    const client = new PumpPortalClient({ clock: tickingClock(Math.floor(Math.random() * 1e6), 3), onEvent: (ev) => got.push(ev.receivedAt) });
    await client.replay(recording([0, 2, 2, 11]), 0);
    return got.map((r, i) => r - got[0]); // normalize to the first event so a different random start does not matter
  };
  assert.deepEqual(await run(), await run());
});
