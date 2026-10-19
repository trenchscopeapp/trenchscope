// Record live keyless responses for the D-06 adapters (GeckoTerminal OHLCV,
// Solana RPC, RugCheck) into fixtures/d06-sample.json for offline tests.
// Opt-in and budgeted:
//   DEXTERM_LIVE=1 node packages/data/scripts/record-d06.ts
// Hard cap: MAX_REQUESTS live requests, all through the normal limiter (which
// paces GeckoTerminal to 7/min and honors 429 / Retry-After / x-ratelimit-*).

import { fileURLToPath } from 'node:url';
import { CANDLE_INTERVALS, FixtureStore, SOLANA_PUBLIC_RPC, createDataLayer, liveTransport, recordingTransport, replayTransport } from '../src/index.ts';
import type { HttpRequest } from '../src/index.ts';

const MAX_REQUESTS = 16;
const OUT = fileURLToPath(new URL('../fixtures/d06-sample.json', import.meta.url));
const D06_MINTS = {
  /** Classic SPL token, authorities revoked, deep pools. */
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  /** Token-2022 with extensions and live mint/freeze authorities. */
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  /** pump.fun launch from the D-02 trending sample. */
  PUMP: 'BrUimx7KncgRNTggAdZdaX2s5XUqQyR6XMRmEg4mpump',
};

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to record fixtures');
  process.exit(2);
}

// Top-up mode: the public RPC answered getTokenLargestAccounts with 429 in the full
// run. `--holders` retries only the pump.fun launch's top-20 (largest accounts +
// owners, at most 2 live requests), replaying the recorded mint account and keeping
// every other entry (including the BONK 429, which the health tests replay).
if (process.argv.includes('--holders')) {
  const fixtures = FixtureStore.load(OUT);
  const before = fixtures.size;
  const live = recordingTransport(liveTransport(), fixtures, {
    maxRequests: 2,
    onRequest: (n, req, res) => console.error(`#${n} ${res.status} ${res.latencyMs}ms ${JSON.parse(req.body ?? '{}').method ?? req.url} retry-after=${res.headers['retry-after'] ?? '-'}`),
  });
  const replay = replayTransport(fixtures);
  // Recorded 2xx entries replay; misses and recorded 429s go live (and replace the 429).
  const transport = async (req: HttpRequest) => {
    const e = fixtures.find(req);
    return e && e.status !== 429 ? replay(req) : live(req);
  };
  const dl = createDataLayer({ transport });
  try {
    const info = await dl.rpc.mintInfo(D06_MINTS.PUMP);
    const h = await dl.rpc.topHolders(D06_MINTS.PUMP, { info });
    console.error(`PUMP top-20: ${h.holders.length} holders, owners resolved ${h.holders.filter((x) => x.owner).length}, top10Pct ${h.top10Pct}`);
  } catch (err) {
    console.error(`holders PUMP: ${err instanceof Error ? err.message : err} (kept in fixtures)`);
  } finally {
    fixtures.save(OUT, `recorded by scripts/record-d06.ts; 14 live requests + ${live.count()} in the --holders top-up`);
    console.error(`saved ${fixtures.size} entries (was ${before}; ${live.count()} live requests) to ${OUT}`);
    dl.close();
  }
  process.exit(0);
}

const fixtures = new FixtureStore();
const transport = recordingTransport(liveTransport(), fixtures, {
  maxRequests: MAX_REQUESTS,
  onRequest: (n, req, res) => {
    const what = req.body ? `${req.url} ${JSON.parse(req.body).method}` : req.url;
    const rl = Object.entries(res.headers).filter(([k]) => k !== 'content-type').map(([k, v]) => `${k}=${v}`).join(' ');
    console.error(`#${n} ${res.status} ${res.latencyMs}ms ${what.slice(0, 150)} ${rl}`);
  },
});
const dl = createDataLayer({ transport });

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`${name}: ${err instanceof Error ? err.message : err} (kept in fixtures)`);
  }
}

try {
  // GeckoTerminal: pool lookup + all six timeframes (7 requests, paced by the 7/min bucket).
  const pools = await dl.gecko.tokenPools(D06_MINTS.BONK).catch(() => []);
  const pool = pools[0]?.address;
  console.error(`BONK top pool: ${pool} (${pools[0]?.name}, ${pools[0]?.dex})`);
  if (pool) for (const iv of CANDLE_INTERVALS) await step(`ohlcv ${iv}`, () => dl.gecko.ohlcv(pool, iv, { limit: 100 }));
  // Solana RPC: mints (base64) for three token kinds, a jsonParsed copy to cross-check the decoder, top-20 holders.
  let bonkInfo: Awaited<ReturnType<typeof dl.rpc.mintInfo>> | undefined;
  await step('mint BONK', async () => (bonkInfo = await dl.rpc.mintInfo(D06_MINTS.BONK)));
  await step('mint PYUSD', () => dl.rpc.mintInfo(D06_MINTS.PYUSD));
  let pumpInfo: Awaited<ReturnType<typeof dl.rpc.mintInfo>> | undefined;
  await step('mint PUMP', async () => (pumpInfo = await dl.rpc.mintInfo(D06_MINTS.PUMP)));
  await step('mint PYUSD jsonParsed', () =>
    dl.http.postJson(SOLANA_PUBLIC_RPC, { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [D06_MINTS.PYUSD, { encoding: 'jsonParsed', commitment: 'confirmed' }] }, { source: 'solana-rpc', bucket: 'solana-rpc' }),
  );
  // Reuse the decoded mint so topHolders costs exactly 2 requests (largest accounts + owners).
  // A pump.fun launch (reliable on the public RPC) and BONK (Raydium v4 vaults should label as LP).
  if (pumpInfo) await step('holders PUMP', () => dl.rpc.topHolders(D06_MINTS.PUMP, { info: pumpInfo }));
  if (bonkInfo) await step('holders BONK', () => dl.rpc.topHolders(D06_MINTS.BONK, { info: bonkInfo }));
  // RugCheck summary for the pump.fun launch (risks are more interesting than BONK's).
  await step('rugcheck PUMP', () => dl.rugcheck.summary(D06_MINTS.PUMP));
} finally {
  fixtures.save(OUT, `recorded by scripts/record-d06.ts; ${transport.count()} live requests`);
  console.error(`saved ${fixtures.size} entries (${transport.count()} live requests) to ${OUT}`);
  console.error('health:', dl.health.snapshot().filter((h) => ['geckoterminal', 'solana-rpc', 'rugcheck'].includes(h.source)).map((h) => `${h.source}=${h.state}`).join(' '));
  dl.close();
}
