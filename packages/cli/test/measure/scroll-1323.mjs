// task-1323 item 2: GeckoTerminal requests per minute while the user scrolls the screener with the hover
// prefetch on (LIVE, free tier). A scripted cursor scrolls fast (a move every 80-150 ms) in bursts and
// rests on random rows (0.3-6 s), over ~100 real screener rows, for --seconds. Every --open-every
// seconds it opens the row under the cursor like ⏎ does (TokenLive on 1h + the 10 s poll), presses 5m
// 2 s later (a cold base fetch unless hover/prefetch warmed it), and returns to the list 6 s later.
//
// Reported: Gecko requests in every rolling 60 s window (max + per-minute), how many the prefetcher
// sent vs deferred (bucket not idle: nothing sent), any 429s, and the foreground chart latencies.
//
//   node packages/cli/test/measure/scroll-1323.mjs [--seconds 180] [--open-every 45] [--seed 7] [--log file]
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDataLayer } from '@dexterm/data';
import { TokenLive } from '../../src/live/index.ts';
import { CandlePrefetcher } from '../../src/live/token.ts';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg('--seconds', '180'));
const OPEN_EVERY = Number(arg('--open-every', '45'));
const LOG = arg('--log', null);
let seed = Number(arg('--seed', '7'));
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'dexterm-1323-scroll-'));
const t0 = performance.now();
const at = () => performance.now() - t0;
const lines = [];
const gecko = []; // { t, status, path }

const dl = createDataLayer({
  dbPath: join(tmp, 'cache.db'),
  onRequest: (req, meta, o) => {
    if (meta.bucket !== 'geckoterminal') return;
    const u = new URL(req.url);
    const path = u.pathname.replace(/\/api\/v2\/networks\/solana\/pools\/([A-Za-z0-9]{6})[A-Za-z0-9]+/, '/pools/$1…');
    gecko.push({ t: at(), status: o.status, path });
    lines.push(`${(at() / 1000).toFixed(1).padStart(6)}s gecko ${o.status} ${path}`);
  },
});

// ~100 real rows with pairs: trending + organic + traded, enriched (DexScreener + Jupiter, not Gecko).
const mints = [];
for (const p of ['trending', 'organic', 'traded']) { const d = await dl.store.discover(p, 50); for (const m of d.mints) if (!mints.includes(m)) mints.push(m); }
const rows = [];
for (let i = 0; i < mints.length; i += 75) {
  const en = await dl.store.enrich(mints.slice(i, i + 75), { price: false });
  for (const r of en.rows) if (r.pair?.pairAddress) rows.push({ mint: r.mint, symbol: r.token.symbol, name: r.token.name, launchpad: r.token.launchpad, pair: r.pair.pairAddress });
}
lines.push(`# scroll-1323 ${new Date().toISOString()} rows=${rows.length} seconds=${SECONDS} openEvery=${OPEN_EVERY}`);
const startAt = at();
const pf = new CandlePrefetcher(dl, { interval: () => '1h' });
let cursor = 0;
let moves = 0;
let screen = 'screener';
const opens = [];
const hover = () => pf.hover(screen === 'screener' ? { mint: rows[cursor].mint, pair: rows[cursor].pair } : null);

async function openRow() {
  const seedRow = rows[cursor];
  screen = 'token';
  hover();
  const tOpen = performance.now();
  const live = new TokenLive(dl, seedRow, { interval: '1h', candleLimit: 120 });
  void live.load();
  const poll = setInterval(() => { void live.load(); }, 10_000);
  const wait = (iv, from) => new Promise((resolve) => {
    const tick = () => {
      const v = live.view;
      if (v.interval === iv && v.candles.length > 0 && v.panels.candles.state !== 'loading') return resolve(Math.round(performance.now() - from));
      if (performance.now() - from > 30_000) return resolve(-1);
      setTimeout(tick, 2);
    };
    tick();
  });
  const open1h = await wait('1h', tOpen);
  await sleep(Math.max(0, 2000 - (performance.now() - tOpen)));
  const tPress = performance.now();
  const done = wait('5m', tPress);
  void live.setInterval('5m');
  const press5m = await done;
  opens.push({ at: ((tOpen - t0 - startAt) / 1000).toFixed(1), symbol: seedRow.symbol, open1h, press5m });
  lines.push(`${(at() / 1000).toFixed(1).padStart(6)}s OPEN ${seedRow.symbol}: 1h chart ${open1h} ms · 5m press ${press5m} ms`);
  await sleep(6000);
  clearInterval(poll);
  screen = 'screener';
  hover();
}

let nextOpen = startAt + OPEN_EVERY * 1000;
while (at() - startAt < SECONDS * 1000) {
  if (OPEN_EVERY > 0 && at() >= nextOpen) { await openRow(); nextOpen = at() + OPEN_EVERY * 1000; continue; }
  // a fast scroll burst...
  const burst = 3 + Math.floor(rnd() * 25);
  for (let i = 0; i < burst; i++) {
    cursor = Math.max(0, Math.min(rows.length - 1, cursor + (rnd() < 0.8 ? 1 : -1)));
    moves++;
    hover();
    await sleep(80 + rnd() * 70);
  }
  // ...then rest on a row (sometimes long enough for the debounce, sometimes not)
  await sleep(300 + rnd() * 5700);
}
pf.close();
const endAt = at();

// Rolling 60 s windows over the scroll period (1 s step).
let maxWin = 0;
for (let s = startAt; s + 60_000 <= endAt + 1; s += 1000) maxWin = Math.max(maxWin, gecko.filter((g) => g.t >= s && g.t < s + 60_000).length);
const perMin = [];
for (let s = startAt; s < endAt; s += 60_000) perMin.push(gecko.filter((g) => g.t >= s && g.t < s + 60_000).length);
const total = gecko.filter((g) => g.t >= startAt).length;
const r429 = gecko.filter((g) => g.status === 429).length;
const summary = [
  `scroll ${((endAt - startAt) / 1000).toFixed(0)} s over ${rows.length} rows · ${moves} cursor moves · ${opens.length} opens`,
  `gecko requests: ${total} total · per minute ${JSON.stringify(perMin)} · max in any rolling 60 s: ${maxWin} (bucket budget 7) · 429s: ${r429}`,
  `hover prefetcher: sent ${pf.requests} · deferred (bucket not idle, nothing sent) ${pf.deferred}`,
  ...opens.map((o) => `open @${o.at}s ${o.symbol}: 1h chart ${o.open1h} ms · cold 5m press ${o.press5m} ms`),
];
console.log(summary.join('\n'));
if (LOG) writeFileSync(LOG, [...lines, '', ...summary].join('\n') + '\n');
dl.close();
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
