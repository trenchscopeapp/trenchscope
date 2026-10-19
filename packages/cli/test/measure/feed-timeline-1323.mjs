// task-1323 item 1: request timeline of the live screener feed's FIRST refresh (in-process, free tier),
// so the time-to-first-rows can be attributed to individual requests. Mirrors the interactive loop:
// createLiveFeed (the app's live feed: trench preset, wide pool), visibleMints = the first screenful
// of the sorted/filtered view, onProgress counting the rows the screener would actually SHOW (trench's
// baked filter applied). Each request is printed with its grant time (transport call) and latency.
//
//   node packages/cli/test/measure/feed-timeline-1323.mjs [--db path] [--preset trench] [--seconds 25]
import { performance } from 'node:perf_hooks';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveFeed } from '../../src/feed.ts';
import { makeScreenerState, screenerView } from '../../src/screener/view.ts';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DB = arg('--db', join(mkdtempSync(join(tmpdir(), 'dexterm-1323-feed-')), 'cache.db'));
const PRESET = arg('--preset', undefined);
const SECONDS = Number(arg('--seconds', '25'));
const t0 = performance.now();
const ms = () => (performance.now() - t0).toFixed(0).padStart(6);

const feed = createLiveFeed({
  dbPath: DB, preset: PRESET,
  onRequest: (req, meta, o) => {
    const u = new URL(req.url);
    console.log(`${ms()} done  ${meta.bucket.padEnd(16)} ${String(o.status ?? 'ERR').padStart(3)} ${String(o.latencyMs).padStart(5)}ms ${u.host}${u.pathname.slice(0, 60)}`);
  },
});
const sc = makeScreenerState('live', [], { presets: feed.presets() });
sc.preset = feed.preset;
// real rows only: the post-1323 view returns placeholder (skeleton) rows while nothing has landed
const shown = () => { sc.rows = feed.rows; sc.preset = feed.preset; return screenerView(sc).filter((r) => !r.skeleton).length; };
feed.visibleMints = () => screenerView(sc).slice(0, 42).map((r) => r.mint);
let first = null;
const report = (why) => {
  const n = shown();
  if (n > 0 && first === null) first = performance.now() - t0;
  console.log(`${ms()} ${why.padEnd(5)} rows=${feed.rows.length} shown=${n} preset=${feed.preset}${feed.fromSnapshot ? ' (cached snapshot)' : ''}`);
};
report('start');
feed.onProgress = () => report('paint');
const stopper = setTimeout(() => { console.log(`${ms()} stop (timeout)`); finish(); }, SECONDS * 1000);
function finish() {
  clearTimeout(stopper);
  console.log(`FIRST ROWS SHOWN: ${first === null ? 'never' : `${first.toFixed(0)} ms`} · db ${DB}`);
  // task-1323: what the snapshot costs on the UI thread (synchronous SQLite write / read of the rows).
  if (typeof feed.saveSnapshot === 'function' && feed.rows.length) {
    feed.fromSnapshot = false;
    const w0 = performance.now(); feed.saveSnapshot(true); const w = performance.now() - w0;
    const r0 = performance.now(); const again = createLiveFeed({ dbPath: DB, preset: feed.preset }); const r = performance.now() - r0;
    console.log(`snapshot: write ${w.toFixed(1)} ms (${Math.min(feed.rows.length, 200)} rows) · new feed + restore ${r.toFixed(1)} ms → ${again.rows.length} rows`);
    again.close();
  }
  feed.close();
  process.exit(0);
}
await feed.refresh();
report('done');
finish();
