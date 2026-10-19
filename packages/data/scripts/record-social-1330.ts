// Record the keyless social/trending/news responses into fixtures/social-1330.json (task-1330, I-03).
// The ONLY network use of the social tests. Opt-in, paced and budgeted:
//   DEXTERM_LIVE=1 node packages/data/scripts/record-social-1330.ts
// 7 live requests, all through the normal limiter (Jupiter burst 1 → ≥ ~2.9 s apart), never retried;
// a 429 / Retry-After is honoured by the limiter and recorded as-is.

import { fileURLToPath } from 'node:url';
import { FixtureStore, createDataLayer, liveTransport, recordingTransport } from '../src/index.ts';
import { TrendingVenues } from '../src/social/venues.ts';
import { NewsRss, RSS_FEEDS } from '../src/social/rss.ts';

const MAX_REQUESTS = 9;
const OUT = fileURLToPath(new URL('../fixtures/social-1330.json', import.meta.url));

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to record fixtures');
  process.exit(2);
}

const fixtures = new FixtureStore();
const transport = recordingTransport(liveTransport(), fixtures, {
  maxRequests: MAX_REQUESTS,
  onRequest: (n, req, res) => console.error(`#${n} ${res.status} ${String(res.latencyMs).padStart(4)}ms age=${res.headers['age'] ?? '-'} ${req.url.slice(0, 110)}`),
});
const dl = createDataLayer({ transport });
const venues = new TrendingVenues({ http: dl.http, jupiter: dl.jupiter, dexscreener: dl.dexscreener });
// two of the four feeds keep the fixture small (CoinDesk + Decrypt were the freshest in the 1289 probe)
const news = new NewsRss(dl.http, RSS_FEEDS.filter((f) => f.id === 'coindesk' || f.id === 'decrypt'));

const t0 = Date.now();
try {
  const c = await venues.collect();
  console.error(`venues: ${c.signals.size} mints · errors ${JSON.stringify(c.errors)} · cg ${c.coingecko.length}`);
  const n = await news.fetchAll();
  console.error(`news: ${n.posts.length} items · errors ${JSON.stringify(n.errors)}`);
} finally {
  fixtures.save(OUT, `recorded by scripts/record-social-1330.ts (task-1330); ${transport.count()} live requests in ${Math.round((Date.now() - t0) / 1000)} s; jupiter host ${dl.jupiter.host}`);
  console.error(`saved ${fixtures.size} entries (${transport.count()} live requests, ${Math.round((Date.now() - t0) / 1000)} s) to ${OUT}`);
  dl.close();
}
