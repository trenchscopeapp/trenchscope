// Opt-in live smoke (not part of `npm test`): prints 30 enriched tokens from
// DexScreener + Jupiter with per-row sources and per-source latency.
//   DEXTERM_LIVE=1 node packages/data/scripts/smoke-live.ts [--limit 30]
// Uses ~5-7 keyless requests, all through the normal limiter (SPEC §3.4).

import { createDataLayer } from '../src/index.ts';
import type { EnrichedRow } from '../src/index.ts';

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to run the live smoke');
  process.exit(2);
}

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Math.min(30, Number(process.argv[limitArg + 1]) || 30) : 30;
const MAX_REQUESTS = 10;

let requests = 0;
const dl = createDataLayer({
  onRequest: (req, meta, o) => {
    requests++;
    console.error(`  req#${requests} ${meta.source.padEnd(14)} ${String(o.status).padStart(3)} ${String(o.latencyMs).padStart(5)}ms ${req.url.slice(0, 110)}`);
    if (requests > MAX_REQUESTS) throw new Error(`smoke request budget (${MAX_REQUESTS}) exceeded`);
  },
});

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? '-' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
const price = (n: number) => (n >= 1 ? `$${n.toFixed(4)}` : n > 0 ? `$${n.toPrecision(4)}` : '-');
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
const clean = (s: string, w: number) => s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').slice(0, w).padEnd(w);
const src = (r: EnrichedRow) => r.sources.map((s) => ({ dexscreener: 'ds', 'jupiter-tokens': 'jupT', 'jupiter-price': 'jupP' })[s as string] ?? s).join('+');

const t0 = performance.now();
const disc = await dl.store.discover('trending', LIMIT);
const res = await dl.store.enrich(disc.mints, { price: true });
const wall = Math.round(performance.now() - t0);

console.log(`dexterm live smoke ${new Date().toISOString()} · preset trending · ${res.rows.length}/${disc.mints.length} rows · ${requests} requests · ${wall}ms`);
console.log(`latency per source (this call): ${Object.entries(res.latencyMs).map(([k, v]) => `${k} ${v}ms`).join(' · ')}`);
if (Object.keys({ ...disc.errors, ...res.errors }).length) console.log('errors:', { ...disc.errors, ...res.errors });
console.log('');
console.log(`  # ${'SYMBOL'.padEnd(10)} ${'NAME'.padEnd(18)} ${'PRICE'.padStart(12)} ${'24H'.padStart(8)} ${'VOL24'.padStart(9)} ${'LIQ'.padStart(9)} ${'MCAP'.padStart(9)} ${'HOLDERS'.padStart(8)} ${'ORG'.padStart(4)} ${'LP'.padEnd(8)} SOURCES          FEED`);
res.rows.forEach((r, i) => {
  const feed = (disc.origin[r.mint] ?? []).map((f) => f.replace(/^(ds|jup):/, '')).join(',');
  console.log(
    `${String(i + 1).padStart(3)} ${clean(r.token.symbol, 10)} ${clean(r.token.name, 18)} ${price(r.pair.priceUsd).padStart(12)} ${pct(r.pair.priceChange.h24).padStart(8)} ${usd(r.pair.volume.h24).padStart(9)} ${usd(r.pair.liquidityUsd).padStart(9)} ${usd(r.pair.mcap).padStart(9)} ${String(r.stats?.holderCount ?? '-').padStart(8)} ${String(r.stats?.organicScore === null || r.stats?.organicScore === undefined ? '-' : Math.round(r.stats.organicScore)).padStart(4)} ${r.token.launchpad.padEnd(8)} ${src(r).padEnd(16)} ${feed}`,
  );
});
if (res.missing.length) console.log(`missing (no source knew them): ${res.missing.join(', ')}`);
console.log('');
console.log('health:', dl.health.snapshot().map((h) => `${h.source}=${h.state} ${h.latencyMs ?? '-'}ms rpm ${h.rpmUsed}/${h.rpmLimit}`).join(' · '));
dl.close();
