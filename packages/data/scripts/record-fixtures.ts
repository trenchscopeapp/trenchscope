// Record live keyless responses into fixtures/live-sample.json for offline tests.
// This is the ONLY network use in the test workflow. Opt-in and budgeted:
//   DEXTERM_LIVE=1 node packages/data/scripts/record-fixtures.ts
// Hard cap: MAX_REQUESTS live requests, all through the normal limiter.

import { fileURLToPath } from 'node:url';
import { FixtureStore, createDataLayer, liveTransport, recordingTransport } from '../src/index.ts';

const MAX_REQUESTS = 15;
const OUT = fileURLToPath(new URL('../fixtures/live-sample.json', import.meta.url));
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to record fixtures');
  process.exit(2);
}

const fixtures = new FixtureStore();
const transport = recordingTransport(liveTransport(), fixtures, {
  maxRequests: MAX_REQUESTS,
  onRequest: (n, req, res) => console.error(`#${n} ${res.status} ${res.latencyMs}ms ${req.url.slice(0, 140)}`),
});
const dl = createDataLayer({ transport });

try {
  // The same flow the tests replay: trending discovery -> enrichment with price.
  const disc = await dl.store.discover('trending', 30);
  const enriched = await dl.store.enrich(disc.mints, { price: true });
  console.error(`discover: ${disc.mints.length} mints; enrich: ${enriched.rows.length} rows, missing ${enriched.missing.length}`, enriched.errors);
  // Single-endpoint samples for adapter tests. A failure (e.g. a 429) is recorded too and kept as a fixture.
  const samples: [string, () => Promise<unknown>][] = [
    ['ds search', () => dl.dexscreener.search('bonk')],
    ['ds token-pairs', () => dl.dexscreener.tokenPairs(BONK)],
    ['jup recent', () => dl.jupiter.recent()],
    ['jup toporganicscore', () => dl.jupiter.category('toporganicscore', '1h', 30)],
    ['jup search symbol', () => dl.jupiter.search('BONK')],
  ];
  for (const [name, run] of samples) {
    try {
      await run();
    } catch (err) {
      console.error(`${name}: ${err instanceof Error ? err.message : err} (kept in fixtures)`);
    }
  }
} finally {
  fixtures.save(OUT, `recorded by scripts/record-fixtures.ts; ${transport.count()} live requests; jupiter host ${dl.jupiter.host}`);
  console.error(`saved ${fixtures.size} entries (${transport.count()} live requests) to ${OUT}`);
  dl.close();
}
