import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaHandler } from '../api/ca.mjs';
import { liveAddress } from '../ca-watcher.js';

const MINT = 'So11111111111111111111111111111111111111112';
const CREATOR = '11111111111111111111111111111111';

function call(handler, method = 'GET') {
  const res = { code: 0, body: undefined, headers: {} };
  const response = {
    setHeader: (k, v) => { res.headers[k] = v; },
    status(code) { res.code = code; return response; },
    json(body) { res.body = body; return response; },
    end() { return response; },
  };
  return handler({ method }, response).then(() => res);
}

function fakeWatch(states) {
  let i = 0;
  let current = { state: 'tba', ca: null, checkedAt: null, stats: null };
  return () => ({
    status: () => current,
    check: async () => { current = states[Math.min(i++, states.length - 1)](); return current; },
  });
}

test('no reserved mint: unset, and the chain runtime is never loaded', async () => {
  const handler = createCaHandler({ env: {}, loadWatch: () => { throw new Error('loaded'); } });
  const res = await call(handler);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { state: 'unset', ca: null, checkedAt: null, stats: null });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('mint without creator or provider key: 503 tba with no address', async () => {
  const handler = createCaHandler({ env: { SOLGENT_RESERVED_MINT: MINT } });
  const res = await call(handler);
  assert.equal(res.code, 503);
  assert.equal(res.body.state, 'tba');
  assert.equal(res.body.ca, null);
});

test('reserved but not on chain: tba, the address stays on the server', async () => {
  let t = 1_000_000;
  const handler = createCaHandler({
    env: { SOLGENT_RESERVED_MINT: MINT, SOLGENT_CREATOR: CREATOR, HELIUS_API_KEY: 'k' },
    connection: async () => ({}),
    createWatch: fakeWatch([() => ({ state: 'tba', ca: null, checkedAt: new Date(t).toISOString(), stats: null })]),
    now: () => t,
  });
  const res = await call(handler);
  assert.equal(res.code, 200);
  assert.equal(res.body.state, 'tba');
  assert.ok(!JSON.stringify(res.body).includes(MINT));
});

test('live once the watch proves it, and it latches', async () => {
  let t = 1_000_000;
  const handler = createCaHandler({
    env: { SOLGENT_RESERVED_MINT: MINT, SOLGENT_CREATOR: CREATOR, HELIUS_API_KEY: 'k' },
    connection: async () => ({}),
    createWatch: fakeWatch([
      () => ({ state: 'tba', ca: null, checkedAt: new Date(t).toISOString(), stats: null }),
      () => ({ state: 'live', ca: MINT, checkedAt: new Date(t).toISOString(), stats: null }),
    ]),
    now: () => t,
  });
  assert.equal((await call(handler)).body.state, 'tba');
  t += 5_000;
  const live = await call(handler);
  assert.equal(live.body.state, 'live');
  assert.equal(live.body.ca, MINT);
  assert.equal((await call(handler)).body.ca, MINT);
});

test('a stale check (provider down) answers 503, never a stale tba as fresh', async () => {
  let t = 1_000_000;
  const handler = createCaHandler({
    env: { SOLGENT_RESERVED_MINT: MINT, SOLGENT_CREATOR: CREATOR, HELIUS_API_KEY: 'k' },
    connection: async () => ({}),
    createWatch: fakeWatch([() => ({ state: 'tba', ca: null, checkedAt: new Date(1).toISOString(), stats: null })]),
    now: () => t,
  });
  const res = await call(handler);
  assert.equal(res.code, 503);
  assert.equal(res.body.ca, null);
});

test('only GET and HEAD', async () => {
  const res = await call(createCaHandler({ env: {} }), 'POST');
  assert.equal(res.code, 405);
  assert.equal(res.headers.Allow, 'GET, HEAD');
});

test('the browser shows an address only for a live, well-formed status', () => {
  assert.equal(liveAddress({ state: 'live', ca: MINT }), MINT);
  assert.equal(liveAddress({ state: 'tba', ca: MINT }), null);
  assert.equal(liveAddress({ state: 'live', ca: '<img src=x>' }), null);
  assert.equal(liveAddress(null), null);
});
