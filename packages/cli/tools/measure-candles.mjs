// measure-candles.mjs — wall-clock timing of the timeframe switch (task-1314).
// Drives a real TokenLive against the live keyless data layer and reports, per
// scenario, the ms from setInterval() to the first candles painted on screen.
//
//   node packages/cli/tools/measure-candles.mjs [mint]
//
// Scenarios:
//   cold        switch to an interval never loaded this run (network fetch)
//   cached      switch back to an interval already loaded (should be instant)
//   prefetched  switch to a neighbour the background prefetch warmed
//
// Honest numbers: it uses the real GeckoTerminal (rate-limited); run it twice
// (before/after) on the same mint for a fair comparison.

import { createDataLayer } from '@dexterm/data';
import { TokenLive, INTERVALS } from '../src/live/index.ts';

const MINT = process.argv[2] ?? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
const now = () => Date.now();

/** Resolve after the view shows candles for `iv` (or a 20 s timeout). Returns ms waited. */
function waitForCandles(live, iv, t0) {
  return new Promise((resolve) => {
    const tick = () => {
      const v = live.view;
      if (v.interval === iv && v.candles.length > 0 && v.panels.candles.state !== 'loading') {
        return resolve(Date.now() - t0);
      }
      if (Date.now() - t0 > 20000) return resolve(-1);
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Time a single switch to `iv`: ms until candles first appear on screen. */
async function timeSwitch(live, iv) {
  const t0 = Date.now();
  const done = waitForCandles(live, iv, t0);
  void live.setInterval(iv);
  return done;
}

async function main() {
  const dl = createDataLayer();
  const live = new TokenLive(dl, { mint: MINT, symbol: '?', name: '?', launchpad: 'unknown' }, { interval: '1h', candleLimit: 120, now });

  const t0 = Date.now();
  await live.load();
  const firstLoad = Date.now() - t0;
  console.log(`initial load (all panels): ${firstLoad} ms · interval 1h · candles=${live.view.candles.length}`);

  const results = [];

  // cold: switch to each not-yet-loaded interval, in order (skip the one we opened on).
  for (const iv of INTERVALS) {
    if (iv === '1h') continue;
    const ms = await timeSwitch(live, iv);
    results.push({ scenario: 'cold', iv, ms });
    console.log(`cold   ${iv.padEnd(3)} ${ms} ms`);
  }

  // cached: switch back to intervals we already loaded.
  for (const iv of ['1h', '1m', '15m']) {
    const ms = await timeSwitch(live, iv);
    results.push({ scenario: 'cached', iv, ms });
    console.log(`cached ${iv.padEnd(3)} ${ms} ms`);
  }

  // prefetched: if the build exposes prefetchAdjacent, warm a neighbour then switch.
  if (typeof live.prefetchAdjacent === 'function') {
    await live.setInterval('1h');
    await live.prefetchAdjacent();
    await new Promise((r) => setTimeout(r, 1500)); // let background prefetch settle within budget
    for (const iv of ['4h', '5m']) {
      const ms = await timeSwitch(live, iv);
      results.push({ scenario: 'prefetched', iv, ms });
      console.log(`prefE  ${iv.padEnd(3)} ${ms} ms`);
    }
  } else {
    console.log('(no prefetchAdjacent on this build — prefetched scenario skipped)');
  }

  const by = (s) => results.filter((r) => r.scenario === s && r.ms >= 0).map((r) => r.ms);
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : NaN);
  console.log('\nSUMMARY (avg ms to first candles):');
  console.log(`  cold       ${avg(by('cold'))}`);
  console.log(`  cached     ${avg(by('cached'))}`);
  console.log(`  prefetched ${avg(by('prefetched'))}`);
  dl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
