// Opt-in live smoke for the D-06 adapters (not part of `npm test`): GeckoTerminal
// pool + candles, Solana RPC mint authorities and top-20 holders, RugCheck summary.
//   DEXTERM_LIVE=1 node packages/data/scripts/smoke-d06.ts [mint]
// At most MAX_REQUESTS keyless requests, all through the normal limiter.

import { createDataLayer } from '../src/index.ts';

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to run the live smoke');
  process.exit(2);
}

const MINT = process.argv[2] ?? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
const MAX_REQUESTS = 8;

let requests = 0;
const dl = createDataLayer({
  onRequest: (req, meta, o) => {
    requests++;
    const what = req.body ? `${req.url} ${JSON.parse(req.body).method}` : req.url;
    console.error(`  req#${requests} ${meta.source.padEnd(14)} ${String(o.status).padStart(3)} ${String(o.latencyMs).padStart(5)}ms ${what.slice(0, 120)}`);
    if (requests >= MAX_REQUESTS) throw new Error(`smoke request budget (${MAX_REQUESTS}) exhausted`);
  },
});

async function step<T>(name: string, run: () => Promise<T>, show: (v: T) => string): Promise<void> {
  const t0 = performance.now();
  try {
    console.log(`${name.padEnd(10)} ok   ${show(await run())} (${Math.round(performance.now() - t0)}ms)`);
  } catch (err) {
    console.log(`${name.padEnd(10)} FAIL ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`dexterm D-06 live smoke ${new Date().toISOString()} · mint ${MINT}`);
let pool: string | undefined;
await step('pool', async () => (await dl.detail.topPool(MINT))!, (p) => ((pool = p.address), `${p.name} ${p.dex} ${p.address} reserve $${Math.round(p.reserveUsd ?? 0)}`));
for (const iv of ['1m', '1h'] as const) {
  if (!pool) break;
  await step(`candles ${iv}`, () => dl.detail.candles(pool!, iv, { limit: 100 }), (s) => {
    const last = s.candles[s.candles.length - 1];
    return `${s.candles.length} bars, last ${new Date(last.t).toISOString()} c=${last.c} open=${s.openBarT === last.t}`;
  });
}
await step('mint', async () => (await dl.detail.mintInfo(MINT)).value, (m) => `${m.program} decimals ${m.decimals} supply ${m.supply} mintAuth ${m.mintAuthority ?? 'revoked'} freezeAuth ${m.freezeAuthority ?? 'revoked'} ext [${m.extensions.join(',')}]`);
await step('holders', async () => (await dl.detail.holders(MINT)).value, (h) => `${h.holders.length} holders, top10 ${h.top10Pct}% (LP excluded), #1 ${h.holders[0]?.address} ${h.holders[0]?.pct}% ${h.holders[0]?.label ?? ''}`);
await step('rugcheck', async () => (await dl.detail.rugcheck(MINT)).value, (r) => `score ${r.score} (norm ${r.scoreNormalised}) lpLocked ${r.lpLockedPct}% risks [${r.risks.map((x) => `${x.level}:${x.name}`).join('; ')}]`);
console.log(`${requests} requests`);
console.log('health:', dl.health.snapshot(['geckoterminal', 'solana-rpc', 'rugcheck']).map((h) => `${h.source}=${h.state} ${h.latencyMs ?? '-'}ms rpm ${h.rpmUsed}/${h.rpmLimit}`).join(' · '));
dl.close();
