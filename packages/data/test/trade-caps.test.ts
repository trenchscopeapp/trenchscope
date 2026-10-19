// task-1310 T1 — signer-side caps (SPEC §6.0/§6.2): the policy the UI cannot bypass. These prove the
// refusal set (network, per-trade USD, daily USD, price impact, simulation), the devnet default, and
// plan-hash binding.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import {
  defaultCaps, checkCaps, planHash, samePlan, CapLedger,
  DEFAULT_PER_TRADE_USD, DEFAULT_DAILY_USD, MAX_PRICE_IMPACT_PCT,
  type TradePlan, type TradeCaps,
} from '../src/trade/caps.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    network: 'devnet', mint: MINT, symbol: 'USDC', side: 'buy',
    amountInRaw: 500_000_000n, amountOutRaw: 2_000_000n, slippageBps: 50, route: ['Meteora'],
    priceImpactPct: 0.5, notionalUsd: 3, simulated: true, simOk: true, simError: null,
    // Round 2: the simulated SOL delta (0.5 SOL + fees) and the decoded-tx policy verdict.
    solOutLamports: 500_005_000n, solLegLamports: 500_000_000n, txPolicy: { ok: true }, ...over,
  };
}

test('defaults are safe: devnet, mainnet off, tiny caps, 3% impact', () => {
  const c = defaultCaps();
  assert.equal(c.network, 'devnet');
  assert.equal(c.mainnetEnabled, false);
  assert.equal(c.perTradeUsd, DEFAULT_PER_TRADE_USD);
  assert.equal(c.dailyUsd, DEFAULT_DAILY_USD);
  assert.equal(c.maxPriceImpactPct, MAX_PRICE_IMPACT_PCT);
});

test('defaults clamp bad overrides to the safe value and refuse implicit mainnet', () => {
  const c = defaultCaps({ perTradeUsd: -1, dailyUsd: 0, maxPriceImpactPct: NaN, network: 'mainnet' });
  assert.equal(c.perTradeUsd, DEFAULT_PER_TRADE_USD);
  assert.equal(c.dailyUsd, DEFAULT_DAILY_USD);
  assert.equal(c.maxPriceImpactPct, MAX_PRICE_IMPACT_PCT);
  assert.equal(c.network, 'devnet', 'network=mainnet without mainnetEnabled falls back to devnet');
});

test('devnet plan passes with a good sim and low impact (USD caps do not gate devnet)', () => {
  const r = checkCaps(plan({ notionalUsd: null }), defaultCaps(), 0);
  assert.equal(r.ok, true, 'devnet has no USD value and that is fine');
});

test('REFUSE: a mainnet plan without --mainnet', () => {
  const r = checkCaps(plan({ network: 'mainnet', notionalUsd: 3 }), defaultCaps(), 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mainnet-not-enabled');
});

test('REFUSE: simulation failed (any network), and REFUSE: not simulated', () => {
  const failed = checkCaps(plan({ simOk: false, simError: 'insufficient lamports' }), defaultCaps(), 0);
  assert.equal(failed.reason, 'simulation-failed');
  const notSim = checkCaps(plan({ simulated: false }), defaultCaps(), 0);
  assert.equal(notSim.reason, 'not-simulated');
});

test('REFUSE: price impact over the 3% ceiling', () => {
  const r = checkCaps(plan({ priceImpactPct: 3.01 }), defaultCaps(), 0);
  assert.equal(r.reason, 'price-impact');
  assert.equal(checkCaps(plan({ priceImpactPct: 3.0 }), defaultCaps(), 0).ok, true, '3.0% exactly is allowed');
});

const MAIN: TradeCaps = defaultCaps({ network: 'mainnet', mainnetEnabled: true });

test('REFUSE: mainnet per-trade USD cap exceeded', () => {
  const r = checkCaps(plan({ network: 'mainnet', notionalUsd: 5.01 }), MAIN, 0);
  assert.equal(r.reason, 'per-trade-cap');
  assert.equal(checkCaps(plan({ network: 'mainnet', notionalUsd: 5 }), MAIN, 0).ok, true, '$5 exactly is allowed');
});

test('REFUSE: mainnet daily cap exceeded (counting prior spend)', () => {
  // $18 spent today + a $3 trade would be $21 > $20.
  const r = checkCaps(plan({ network: 'mainnet', notionalUsd: 3 }), MAIN, 18);
  assert.equal(r.reason, 'daily-cap');
  assert.equal(checkCaps(plan({ network: 'mainnet', notionalUsd: 2 }), MAIN, 18).ok, true, '$18 + $2 = $20 is allowed');
});

test('REFUSE: mainnet trade with no USD value is refused, not waved through', () => {
  const r = checkCaps(plan({ network: 'mainnet', notionalUsd: null }), MAIN, 0);
  assert.equal(r.reason, 'no-usd-value');
});

test('plan-hash binds the material fields: a swapped mint / size / route changes the hash', () => {
  const base = plan();
  assert.equal(planHash(base), planHash(plan()), 'same plan → same hash');
  assert.ok(samePlan(base, plan()));
  assert.notEqual(planHash(base), planHash(plan({ mint: 'So11111111111111111111111111111111111111112' })), 'mint change → new hash');
  assert.notEqual(planHash(base), planHash(plan({ amountInRaw: 500_000_001n })), 'size change → new hash');
  assert.notEqual(planHash(base), planHash(plan({ route: ['Orca'] })), 'route change → new hash');
  assert.notEqual(planHash(base), planHash(plan({ side: 'sell' })), 'side change → new hash');
  assert.ok(!samePlan(base, plan({ amountOutRaw: 1n })), 'output change → not the same plan');
});

test('CapLedger persists the daily spend across reopen (a relaunch cannot forget it)', () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 8, 12, 0, 0)); // 2026-10-08
  const path = `/tmp/dexterm-capledger-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
  let led = new CapLedger({ path, clock });
  assert.equal(led.spentToday(), 0);
  led.record(5, clock.now());
  led.record(3.5, clock.now());
  assert.equal(led.spentToday(), 8.5);
  led.close();
  led = new CapLedger({ path, clock }); // reopen the same file
  assert.equal(led.spentToday(), 8.5, 'spend survived a restart');
  // A new UTC day resets the budget.
  const tomorrow = Date.UTC(2026, 9, 9, 1, 0, 0);
  assert.equal(led.spentToday(tomorrow), 0, 'a new day has a fresh budget');
  led.close();
});
