// task-1324 AI SCAN MODE — the engine on RECORDED data (packages/data/fixtures): the live-sample screener
// pool through the real replay feed + cache (vol / flow / vetoes / score, default = no lock, forced =
// lock, no-hop across repeated replay refreshes, caps + cooldown on real coins) and the recorded
// GeckoTerminal BONK candles (breakout on real bars). Replay transport only: no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayFeed, type ScreenerFeed } from '../src/feed.ts';
import { buildObservations } from '../src/scan/observe.ts';
import { ScanEngine, scanConfig, flowTrigger, volTrigger, breakoutTrigger, type ScanConfig, type ScanObservation } from '../src/scan/engine.ts';
import { buyShare, DS_TOKEN_CACHE_NS } from '../src/live/flow.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, '..', '..', 'data', 'fixtures');

async function recorded(): Promise<{ feed: ScreenerFeed; obs: (cfg?: Partial<ScanConfig>) => ScanObservation[] }> {
  const feed = createReplayFeed(resolve(FIX, 'live-sample.json'));
  await feed.refresh();
  const obs = (cfg: Partial<ScanConfig> = {}) => buildObservations({ rows: feed.rows, cacheGet: (ns, k) => feed.dl.cache.get(ns, k), now: 1, minLiqUsd: scanConfig(cfg).minLiqUsd });
  return { feed, obs };
}

test('recorded pool: observations carry the recorded row fields and the cached DexScreener txns verbatim', async () => {
  const { feed, obs } = await recorded();
  const list = obs();
  assert.ok(list.length >= 20, `${list.length} observed`);
  for (const o of list) {
    const row = feed.rows.find((r) => r.mint === o.mint)!;
    assert.equal(o.vol5m, row.vol5m);
    assert.equal(o.vol6h, row.vol6h);
    assert.equal(o.liq, row.liq);
    const pair = (feed.dl.cache.get(DS_TOKEN_CACHE_NS, o.mint)?.value as { pair: { txns: { m5: unknown; h1: unknown } } } | undefined)?.pair;
    assert.deepEqual(o.m5, pair?.txns.m5 ?? null, 'm5 from the cached pair (no fetch)');
    assert.deepEqual(o.h1, pair?.txns.h1 ?? null);
  }
  feed.close();
});

test('recorded pool @ defaults: vol + flow recomputed by hand match; authority vetoes match the rows; nothing EXCITING → no lock', async () => {
  const { feed, obs } = await recorded();
  const cfg = scanConfig();
  const list = obs();
  let volFires = 0, vetoes = 0;
  for (const o of list) {
    const v = volTrigger(o, cfg);
    const pace = (o.vol6h ?? 0) > 0 ? (o.vol6h as number) / 72 : null;
    const manualVol = pace !== null && (o.vol5m ?? 0) >= cfg.volMinUsd && (o.vol5m as number) / pace >= cfg.volX;
    assert.equal(!!v, manualVol, `vol ${o.symbol}`);
    if (v) { volFires++; assert.match(v.reason, new RegExp(`= ${((o.vol5m as number) / (pace as number)).toFixed(1)}× its 6h pace`)); }
    const f = flowTrigger(o, cfg);
    const s5 = buyShare(o.m5), s1 = buyShare(o.h1);
    const manualFlow = !!o.m5 && s5 !== null && s1 !== null && o.m5.buys + o.m5.sells >= cfg.flowMinTxns && s5 >= cfg.flowShare && s1 <= cfg.flowPrevMax;
    assert.equal(!!f, manualFlow, `flow ${o.symbol}`);
    if (o.mintAuth || o.freezeAuth) vetoes++;
  }
  const e = new ScanEngine({ warmupS: 0 });
  e.start(0);
  e.observe(list, 0);
  assert.equal(e.tick(0), null, 'the recorded snapshot has no coin with ≥ 2 triggers at score ≥ 45');
  assert.equal(volFires, 2, 'two recorded volume spikes (see replay-scores.mjs)');
  assert.equal(list.filter((o) => e.score(o.mint)!.veto).length, vetoes, 'vetoes are exactly the rows with a live authority');
  assert.ok(e.ticker.length >= 2 && e.ticker.every((s) => !s.exciting));
  // deterministic: a second engine over the same recording scores identically
  const e2 = new ScanEngine({ warmupS: 0 });
  e2.start(0); e2.observe(obs(), 0); e2.tick(0);
  assert.deepEqual(e2.ticker, e.ticker);
  feed.close();
});

test('recorded pool @ forced thresholds: locks the top real coin; repeated replay refreshes never hop; caps + cooldown hold', async () => {
  const { feed, obs } = await recorded();
  const forced = { warmupS: 0, minScore: 20, minTriggers: 1, refreshS: 1e6, postLockS: 0, maxAiPerHour: 2, coinCooldownS: 900 };
  const e = new ScanEngine(forced);
  e.start(0);
  e.observe(obs(forced), 0);
  const d1 = e.tick(0);
  assert.equal(d1?.kind, 'lock');
  const top = e.ticker[0];
  assert.equal(d1!.mint, top.mint, 'the highest-scoring recorded coin');
  for (let i = 1; i <= 10; i++) {
    await feed.refresh(); // replay the recording again (same responses)
    e.observe(obs(forced), i * 2000);
    const d = e.tick(i * 2000);
    assert.ok(d === null || (d.kind === 'refresh' && d.mint === d1!.mint), `refresh ${i}: no hop`);
    assert.equal(e.lock!.mint, d1!.mint);
  }
  e.resume(30_000);
  const d2 = e.tick(30_000);
  assert.equal(d2?.kind, 'lock');
  assert.notEqual(d2!.mint, d1!.mint, 'the released coin is cooling down; the next real coin locks');
  e.resume(31_000);
  assert.equal(e.tick(31_000), null, 'only two recorded coins fire at all, and both are cooling down');
  assert.equal(e.usage(31_000).hour, 2);
  // past the 15-min coin cooldown but inside the hour: the first coin is eligible again, the cap binds
  e.observe(obs(forced), 1_000_000);
  assert.equal(e.tick(1_000_000), null, 'hourly cap 2/2 — the eligible real coin is refused');
  assert.match(e.note!, /ai cap 2\/2 per hour/);
  e.observe(obs(forced), 3_700_000);
  assert.equal(e.tick(3_700_000)?.kind, 'lock', 'the hour rolled');
  feed.close();
});

test('recorded BONK candles (GeckoTerminal, 6 intervals × 100 bars): breakout over every rolling window matches a hand recompute', () => {
  const rec = JSON.parse(readFileSync(resolve(FIX, 'd06-sample.json'), 'utf8')) as { entries: Array<{ url: string; body: { data?: { attributes?: { ohlcv_list?: number[][] } } } }> };
  const series = rec.entries.filter((x) => x.url.includes('/ohlcv/')).map((x) => ({
    url: x.url.replace(/^.*\/ohlcv\//, '').slice(0, 24),
    bars: (x.body.data?.attributes?.ohlcv_list ?? []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })).reverse(), // oldest first
  }));
  assert.equal(series.length, 6);
  for (const pct of [2, 0.5]) {
    const cfg = scanConfig({ breakoutPct: pct });
    let fires = 0, windows = 0;
    for (const s of series) {
      assert.ok(s.bars.length >= 100, s.url);
      for (let i = cfg.breakoutLookback + 1; i <= s.bars.length; i++) {
        const cs = s.bars.slice(0, i);
        windows++;
        const hi = Math.max(...cs.slice(-1 - cfg.breakoutLookback, -1).map((b) => b.h));
        const manual = (cs[cs.length - 1].c / hi - 1) * 100 >= pct;
        const got = breakoutTrigger({ mint: 'BONK', symbol: 'BONK', t: 0, price: null, vol5m: null, vol1h: null, vol6h: null, vol24: null, liq: 1e6, holders: null, ageMin: null, m5: null, h1: null, candles: cs }, cfg);
        assert.equal(!!got, manual, `${s.url} window ${i}`);
        if (got) fires++;
      }
    }
    assert.ok(windows > 400, `${windows} real windows`);
    if (pct === 0.5) assert.ok(fires > 0, `at 0.5% the real bars do break out (${fires} windows)`);
    // printed for the README
    console.log(`  breakout ≥ ${pct}%: ${fires}/${windows} recorded windows`);
  }
});
