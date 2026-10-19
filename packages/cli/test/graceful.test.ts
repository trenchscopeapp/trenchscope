// Graceful states (task-1305, QA M6): the live screener must say *why* it has no rows — connecting,
// offline, or rate-limited — rather than an indefinite "waiting for the feed". feedCondition is the
// pure classifier behind that banner; these tests pin each branch and its precedence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from '@dexterm/tui';
import { makeScreenerState, feedCondition, renderFrame, makeFixtureState } from '../src/index.ts';
import type { ScreenerState } from '../src/index.ts';

function liveState(errors: Record<string, string>): ScreenerState {
  const sc = makeScreenerState('live', []); // no rows
  sc.errors = errors;
  return sc;
}

test('rows present → ok, no banner', () => {
  const sc = makeScreenerState('fixtures');
  sc.rows = [{} as never]; // any row
  assert.equal(feedCondition(sc).kind, 'ok');
});

test('no rows and no error yet → connecting', () => {
  assert.equal(feedCondition(liveState({})).kind, 'connecting');
  assert.match(feedCondition(liveState({})).message, /connecting/i);
});

test('a network/DNS error → offline, with a doctor pointer', () => {
  for (const e of ['getaddrinfo ENOTFOUND api.dexscreener.com', 'fetch failed', 'ECONNREFUSED', 'network timeout']) {
    const cond = feedCondition(liveState({ dexscreener: e }));
    assert.equal(cond.kind, 'offline', e);
  }
  assert.match(feedCondition(liveState({ dexscreener: 'fetch failed' })).message, /doctor/);
});

test('an HTTP 429 → ratelimited, and 429 wins over a co-occurring network error', () => {
  assert.equal(feedCondition(liveState({ dexscreener: 'HTTP 429 Too Many Requests' })).kind, 'ratelimited');
  assert.equal(feedCondition(liveState({ dexscreener: 'rate limited' })).kind, 'ratelimited');
  // both a 429 and a transport error reported: the host answered, so report the rate limit
  assert.equal(feedCondition(liveState({ dexscreener: '429', jupiter: 'ENOTFOUND' })).kind, 'ratelimited');
});

test('the screener renders the offline banner (and it fits the frame)', () => {
  const state = makeFixtureState({ theme: THEMES.midnight, calm: true });
  // make it a live, empty, errored feed
  state.screener = makeScreenerState('live', []);
  state.screener.errors = { dexscreener: 'fetch failed' };
  const out = renderFrame(state, 120, 40).toPlain();
  assert.match(out, /offline/i);
  for (const row of out.split('\n')) assert.ok([...row].length <= 120);
});
