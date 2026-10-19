// task-1404: the LIVE holder/rug signals engine. Pure + deterministic — a scripted sequence of observations
// replays to the same signals, so every rule (dev-sell, concentration, LP unlock, liquidity, authority flip,
// bundle / sniper / fresh cumulative, bonding, migration) and the baseline discipline (first-obs baseline,
// stale never fires or advances, cumulative accumulation) is asserted directly. No clock, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveSignalsEngine, type SignalObservation, type FieldReading, type AuthReading } from '../src/intel/live-signals.ts';

const MINT = 'So11111111111111111111111111111111111111112';

function fr(value: number | null, at: number, source = 'helius', stale = false): FieldReading {
  return { value, source, fetchedAt: at, stale };
}
function au(present: boolean | null, at: number, source = 'solana-rpc', stale = false): AuthReading {
  return { present, source, fetchedAt: at, stale };
}

test('first observation of a mint sets the baseline and fires nothing', () => {
  const e = new LiveSignalsEngine();
  const sigs = e.observe({ mint: MINT, at: 1000, dev: fr(10, 1000), top10: fr(40, 1000), lpLocked: fr(100, 1000), mintAuth: au(false, 1000), freezeAuth: au(false, 1000) });
  assert.deepEqual(sigs, []);
  // fields() reflects the baseline immediately
  const f = e.fields(MINT);
  assert.equal(f.dev, 10);
  assert.equal(f.top10, 40);
  assert.equal(f.lpLocked, 100);
  assert.equal(f.mintable, 0);
  assert.equal(f.freezable, 0);
});

test('dev-sell fires on a creator-share drop and carries source + data age', () => {
  const e = new LiveSignalsEngine();
  e.observe({ mint: MINT, at: 1000, dev: fr(12, 1000) });
  const sigs = e.observe({ mint: MINT, at: 5000, dev: fr(4, 4000, 'helius') }); // dropped 8, reading fetched at 4000
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].kind, 'dev-sell');
  assert.equal(sigs[0].level, 'warn');
  assert.equal(sigs[0].source, 'helius');
  assert.equal(sigs[0].dataAgeMs, 1000); // now 5000 − fetchedAt 4000
  assert.equal(sigs[0].value, 4);
  assert.equal(sigs[0].delta, -8);
  assert.match(sigs[0].text, /creator sold/);
  // a tiny further drop below the threshold does not fire
  assert.deepEqual(e.observe({ mint: MINT, at: 6000, dev: fr(3.5, 6000) }), []);
});

test('concentration fires up (warn) and down (info); below threshold is silent', () => {
  const e = new LiveSignalsEngine();
  e.observe({ mint: MINT, at: 0, top10: fr(40, 0) });
  assert.deepEqual(e.observe({ mint: MINT, at: 1, top10: fr(42, 1) }), [], 'within 3 pts: silent');
  const up = e.observe({ mint: MINT, at: 2, top10: fr(46, 2) }); // 42 → 46 = +4
  assert.equal(up[0].kind, 'concentration');
  assert.equal(up[0].level, 'warn');
  const down = e.observe({ mint: MINT, at: 3, top10: fr(40, 3) }); // 46 → 40 = -6
  assert.equal(down[0].level, 'info');
  assert.equal(down[0].title, 'top-10 down');
});

test('LP unlock and liquidity-drop fire with plain wording', () => {
  const e = new LiveSignalsEngine();
  e.observe({ mint: MINT, at: 0, lpLocked: fr(100, 0, 'rugcheck'), liq: fr(50_000, 0, 'dexscreener') });
  const lp = e.observe({ mint: MINT, at: 1, lpLocked: fr(0, 1, 'rugcheck') });
  assert.equal(lp[0].kind, 'lp-unlock');
  assert.equal(lp[0].level, 'down');
  assert.equal(lp[0].source, 'rugcheck');
  const liq = e.observe({ mint: MINT, at: 2, liq: fr(20_000, 2, 'dexscreener') }); // -60%
  assert.equal(liq[0].kind, 'liquidity');
  assert.match(liq[0].text, /liquidity fell ~60%/);
  // a 10% dip is below the 25% threshold
  assert.deepEqual(e.observe({ mint: MINT, at: 3, liq: fr(18_000, 3, 'dexscreener') }), []);
});

test('authority flips: false→true warns (re-enabled), true→false is good news (up)', () => {
  const e = new LiveSignalsEngine();
  e.observe({ mint: MINT, at: 0, mintAuth: au(false, 0), freezeAuth: au(false, 0) });
  const on = e.observe({ mint: MINT, at: 1, mintAuth: au(true, 1) });
  assert.equal(on[0].kind, 'authority');
  assert.equal(on[0].level, 'warn');
  assert.match(on[0].text, /new supply can be minted/);
  assert.equal(e.fields(MINT).mintable, 1);
  const off = e.observe({ mint: MINT, at: 2, mintAuth: au(false, 2) });
  assert.equal(off[0].level, 'up');
  assert.match(off[0].text, /revoked/);
  const fz = e.observe({ mint: MINT, at: 3, freezeAuth: au(true, 3) });
  assert.match(fz[0].text, /transfers can be frozen/);
});

test('bundle / sniper / fresh are CUMULATIVE: gradual drift accumulates until it crosses the threshold, once', () => {
  const e = new LiveSignalsEngine();
  e.observe({ mint: MINT, at: 0, bundled: fr(0, 0), snipers: fr(2, 0), fresh: fr(0, 0) });
  // bundled rises 0 → 0.5 → 0.9 (never a 1-pt step), then 0.9 → 1.2: +1.2 vs the anchor (0) fires once.
  assert.deepEqual(e.observe({ mint: MINT, at: 1, bundled: fr(0.5, 1) }), []);
  assert.deepEqual(e.observe({ mint: MINT, at: 2, bundled: fr(0.9, 2) }), []);
  const b = e.observe({ mint: MINT, at: 3, bundled: fr(1.2, 3) });
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'bundle');
  assert.equal(b[0].value, 1.2);
  // anchor advanced to 1.2; a further 0.5 rise is below the next 1-pt step → silent
  assert.deepEqual(e.observe({ mint: MINT, at: 4, bundled: fr(1.7, 4) }), []);
  // snipers +1 fires
  assert.equal(e.observe({ mint: MINT, at: 5, snipers: fr(3, 5) })[0].kind, 'sniper');
  // fresh needs +5
  assert.deepEqual(e.observe({ mint: MINT, at: 6, fresh: fr(3, 6) }), []);
  assert.equal(e.observe({ mint: MINT, at: 7, fresh: fr(6, 7) })[0].kind, 'fresh-wallet');
});

test('bonding is cumulative: 5-pt steps fire; fields() always reports the CURRENT value, not the anchor', () => {
  const e = new LiveSignalsEngine();
  e.observe({ mint: MINT, at: 0, bonding: fr(50, 0, 'onchain-curve') });
  assert.deepEqual(e.observe({ mint: MINT, at: 1, bonding: fr(52, 1, 'onchain-curve') }), [], '+2 below step');
  assert.equal(e.fields(MINT).bonding, 52, 'fields tracks the latest value even without a signal');
  const b = e.observe({ mint: MINT, at: 2, bonding: fr(56, 2, 'onchain-curve') }); // +6 vs anchor 50
  assert.equal(b[0].kind, 'bonding');
  assert.equal(b[0].source, 'onchain-curve');
  assert.equal(e.fields(MINT).bonding, 56);
});

test('migration fires exactly once on the false→true flip', () => {
  const e = new LiveSignalsEngine();
  e.observe({ mint: MINT, at: 0, migrated: { value: false, source: 'onchain-curve', fetchedAt: 0, stale: false } });
  const m = e.observe({ mint: MINT, at: 1, migrated: { value: true, source: 'onchain-curve', fetchedAt: 1, stale: false } });
  assert.equal(m[0].kind, 'migrated');
  assert.deepEqual(e.observe({ mint: MINT, at: 2, migrated: { value: true, source: 'onchain-curve', fetchedAt: 2, stale: false } }), [], 'never a second time');
});

test('a STALE reading neither fires nor advances the baseline; the next fresh reading catches the real change', () => {
  const e = new LiveSignalsEngine();
  e.observe({ mint: MINT, at: 0, dev: fr(20, 0) });
  // stale reading (source kept the last value after a failed refresh): no signal, baseline stays 20
  const staleSigs = e.observe({ mint: MINT, at: 1000, dev: fr(5, 1000, 'helius', true) });
  assert.deepEqual(staleSigs, [], 'stale never fires');
  // a reading older than staleAfterMs is also treated stale even without the flag
  const oldSigs = e.observe({ mint: MINT, at: 200_000, dev: fr(5, 100_000, 'helius', false) });
  assert.deepEqual(oldSigs, [], 'too old never fires');
  // fresh again: compared to the last value we actually saw (20), so the drop is caught
  const fresh = e.observe({ mint: MINT, at: 200_000, dev: fr(5, 200_000, 'helius') });
  assert.equal(fresh[0].kind, 'dev-sell');
  assert.equal(fresh[0].delta, -15);
});

test('snapshot reports per-field age + stale honestly; fields/snapshot are null before any observation', () => {
  const e = new LiveSignalsEngine({ thresholds: { staleAfterMs: 10_000 } });
  assert.deepEqual(e.fields('nope'), { top10: null, dev: null, bundled: null, snipers: null, fresh: null, cluster: null, lpLocked: null, bonding: null, mintable: null, freezable: null });
  e.observe({ mint: MINT, at: 1000, top10: fr(30, 1000, 'helius') });
  const snapFresh = e.snapshot(MINT, 3000);
  assert.equal(snapFresh.top10.value, 30);
  assert.equal(snapFresh.top10.source, 'helius');
  assert.equal(snapFresh.top10.ageMs, 2000);
  assert.equal(snapFresh.top10.stale, false);
  const snapStale = e.snapshot(MINT, 20_000); // 19s old > 10s staleAfterMs
  assert.equal(snapStale.top10.stale, true);
  assert.equal(snapStale.dev.value, null, 'unobserved field is null');
});

test('observations for different mints are independent', () => {
  const e = new LiveSignalsEngine();
  const A = MINT, B = 'EaD4STv3YNLaq2dpKWh6JaZTLLs9MAEHyyNUMfMUpump';
  e.observe({ mint: A, at: 0, dev: fr(10, 0) });
  e.observe({ mint: B, at: 0, dev: fr(10, 0) });
  assert.equal(e.observe({ mint: A, at: 1, dev: fr(2, 1) })[0].kind, 'dev-sell');
  assert.deepEqual(e.observe({ mint: B, at: 1, dev: fr(10, 1) }), [], 'B unchanged, no cross-talk');
  e.forget(A);
  assert.deepEqual(e.fields(A).dev, null, 'forgotten');
  assert.equal(e.fields(B).dev, 10);
});
