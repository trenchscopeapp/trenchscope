// task-1323 item 2: LIVE timeframe-switch timing on the free tier, reproducing what the verifier did:
// open a token from the screener (it opens on 1h, the default), let the TUI's 10 s token poll run, then
// press a timeframe key ~2 s later and time how long until candles are on screen. One FRESH token per
// timeframe (cold), then a switch away and back on that token (warm, in-memory), then a brand-new data
// layer over the same SQLite file opening the same token at that timeframe (warm from disk).
//
// Every request is logged with its GRANT time (when the limiter let it go = when the transport was
// called) and its latency, relative to the keypress, so the queueing is visible, not inferred.
//
//   node packages/cli/test/measure/candles-1323.mjs [--delay 2000] [--log reqlog.txt] [--only 5m,1h] [--db path]
//
// Free-tier only: DexScreener + Jupiter for the token list, GeckoTerminal for the candles, public RPC /
// RugCheck / GoPlus for the other panels, through the app's own rate limiters.
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDataLayer, liveTransport } from '@dexterm/data';
import { TokenLive, INTERVALS } from '../../src/live/index.ts';
import * as tokenMod from '../../src/live/token.ts';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DELAY = Number(arg('--delay', '2000'));
const LOG = arg('--log', null);
const ONLY = arg('--only', null)?.split(',') ?? INTERVALS;
const HOVER = argv.includes('--hover'); // after-build only: hover-prefetch the row first, like the screener
const tmp = mkdtempSync(join(tmpdir(), 'dexterm-1323-candles-'));
const DB = arg('--db', join(tmp, 'cache.db'));
const POLL_MS = 10_000; // TOKEN_REFRESH_MS: the TUI reloads the open token this often
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];
let mark = performance.now();
const rel = () => (performance.now() - mark).toFixed(0).padStart(6);
const log = (s) => { lines.push(s); };

function makeDl(dbPath) {
  const inner = liveTransport();
  const transport = async (req) => {
    const u = new URL(req.url);
    const short = `${u.host}${u.pathname}`.replace(/\/networks\/solana\/pools\/([A-Za-z0-9]{6})[A-Za-z0-9]+/, '/pools/$1…').slice(0, 90);
    const t = rel();
    const res = await inner(req);
    log(`  grant ${t} ms  ${String(res.status).padStart(3)} ${String(res.latencyMs).padStart(5)}ms  ${short}${u.searchParams.get('limit') ? `?limit=${u.searchParams.get('limit')}` : ''}`);
    return res;
  };
  return createDataLayer({ dbPath, transport, rpcPublicPool: true });
}

/** Resolve with ms until the view shows candles for `iv` (painted, not 'loading'), or -1 after 30 s. */
function waitCandles(live, iv, t0) {
  return new Promise((resolve) => {
    const tick = () => {
      const v = live.view;
      if (v.interval === iv && v.candles.length > 0 && v.panels.candles.state !== 'loading') return resolve(Math.round(performance.now() - t0));
      if (performance.now() - t0 > 30_000) return resolve(-1);
      setTimeout(tick, 2);
    };
    tick();
  });
}

/** Wait until the GeckoTerminal bucket is idle (nothing queued, a token available) + `extra` ms. */
async function geckoIdle(dl, extra = 0) {
  const b = dl.limiter.bucket('geckoterminal');
  // A full bucket (the post-1323 limiter has delayFor('idle'): every token back) = nothing used Gecko lately.
  const ready = () => b.stats().queued === 0 && (typeof b.delayFor === 'function' ? b.delayFor('idle', Date.now()) : b.delay(Date.now())) === 0;
  for (let i = 0; i < 400; i++) { if (ready()) break; await sleep(250); }
  await sleep(extra);
}

/** Open like the TUI: TokenLive + first load + the 10 s poll. Returns { live, stop }. */
function openLikeTui(dl, seed, interval) {
  const live = new TokenLive(dl, seed, { interval, candleLimit: 120 });
  void live.load();
  const poll = setInterval(() => { void live.load(); }, POLL_MS);
  return { live, stop: () => clearInterval(poll) };
}

async function main() {
  const dl = makeDl(DB);
  log(`# candles-1323 ${new Date().toISOString()} delay=${DELAY}ms db=${DB}`);
  // A pool of real, liquid tokens with a known pair (the screener row carries DexScreener's pairAddress).
  mark = performance.now();
  const d = await dl.store.discover('trending', 40);
  const en = await dl.store.enrich(d.mints.slice(0, 40), { price: false });
  const SKIP = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
  const seeds = en.rows.filter((r) => r.pair?.pairAddress && !SKIP.has(r.mint) && (r.pair.liquidityUsd ?? 0) > 20_000)
    .map((r) => ({ mint: r.mint, symbol: r.token.symbol, name: r.token.name, launchpad: r.token.launchpad, pair: r.pair.pairAddress }));
  if (seeds.length < ONLY.length) throw new Error(`only ${seeds.length} usable tokens`);
  const results = [];
  for (let i = 0; i < ONLY.length; i++) {
    const iv = ONLY[i];
    const seed = seeds[i];
    await geckoIdle(dl, 1000); // a user arriving from the screener: nothing else is drawing on Gecko
    lines.push(`\n## ${iv}  token ${seed.symbol} ${seed.mint.slice(0, 6)}… pool ${seed.pair.slice(0, 6)}…`);
    let hoverMs = null;
    if (HOVER && tokenMod.CandlePrefetcher) {
      // The cursor rests on the row in the screener: the real hover prefetcher (debounced, idle priority).
      mark = performance.now();
      lines.push(`  t=0 hover row`);
      const pf = new tokenMod.CandlePrefetcher(dl, { interval: () => '1h' });
      pf.hover({ mint: seed.mint, pair: seed.pair });
      const has = () => dl.detail.candleStore.has(seed.pair, '1h', { limit: 1000, token: seed.mint });
      while (!has() && performance.now() - mark < 20_000) await sleep(20);
      hoverMs = has() ? Math.round(performance.now() - mark) : -1;
      lines.push(`  -> hover warmed 1h base in ${hoverMs} ms (sent ${pf.requests}, deferred ${pf.deferred})`);
      await sleep(1500); // the user reads the row, then presses enter
      pf.close();
    }
    mark = performance.now();
    lines.push(`  t=0 open token (1h)`);
    const { live, stop } = openLikeTui(dl, seed, '1h');
    let cold;
    if (iv === '1h') {
      cold = await waitCandles(live, '1h', mark);
    } else {
      await sleep(DELAY);
      lines.push(`  t=${rel().trim()} press ${iv}`);
      const t0 = performance.now();
      const done = waitCandles(live, iv, t0);
      void live.setInterval(iv);
      cold = await done;
    }
    lines.push(`  -> cold ${iv}: ${cold} ms`);
    // warm (in-memory): away to the other base and back
    const away = iv === '1h' ? '1m' : '1h';
    await live.setInterval(away).catch(() => {});
    await waitCandles(live, away, performance.now());
    const t1 = performance.now();
    const wdone = waitCandles(live, iv, t1);
    void live.setInterval(iv);
    const warm = await wdone;
    lines.push(`  -> warm ${iv} (in-memory): ${warm} ms`);
    stop();
    results.push({ iv, token: seed.symbol, cold, warm, hoverMs });
  }
  // warm from disk: a new process' data layer on the same DB opens each token AT that timeframe.
  await geckoIdle(dl, 0);
  dl.close();
  const dl2 = makeDl(DB);
  for (let i = 0; i < ONLY.length; i++) {
    const iv = ONLY[i];
    const seed = seeds[i];
    mark = performance.now();
    const live = new TokenLive(dl2, seed, { interval: iv, candleLimit: 120 });
    const done = waitCandles(live, iv, mark);
    void live.load();
    const disk = await done;
    lines.push(`  -> warm ${iv} (new data layer, same DB): ${disk} ms`);
    results.find((r) => r.iv === iv).disk = disk;
  }
  dl2.close();
  console.log('iv   token        cold_ms  warm_mem_ms  warm_disk_ms' + (HOVER ? '  hover_prefetch_ms' : ''));
  for (const r of results) console.log(`${r.iv.padEnd(4)} ${String(r.token).slice(0, 12).padEnd(12)} ${String(r.cold).padStart(7)}  ${String(r.warm).padStart(11)}  ${String(r.disk).padStart(12)}` + (HOVER ? `  ${String(r.hoverMs).padStart(17)}` : ''));
  if (LOG) writeFileSync(LOG, lines.join('\n') + '\n');
  if (!arg('--db', null)) rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => { console.error(e); if (LOG) writeFileSync(LOG, lines.join('\n') + '\n'); process.exit(1); });
