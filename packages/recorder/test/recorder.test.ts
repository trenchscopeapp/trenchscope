// Recorder over the data layer's offline fixtures (live-sample.json replayed, network blocked by the
// shared test helper): snapshot-on-change + heartbeat, feed membership, focus raw JSON, t0 anchors,
// outcome sweeps at low limiter priority within the budget, labels, retention, export, disable switch.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { before, test } from 'node:test';
import { currentPriority, type DsRawPair, type EnrichedRow, type HttpRequest, type HttpResponse, type Transport } from '@dexterm/data';
import { drive, json, loadSample, sampleLayer } from '../../data/test/helpers.ts';
import { replayTransport } from '../../data/src/fixtures.ts';
import { FakeClock } from '../../data/src/clock.ts';
import { Recorder, DEFAULT_HEARTBEAT_MS, DEFAULT_T0_EVERY_MS, LABEL_RETRY_MS, SEEN_EVICT_MS } from '../src/recorder.ts';
import { exportRecorded } from '../src/export.ts';
import { fromEnrichedRow, cleanText, hashColumns, isMaterialChange } from '../src/snapshot.ts';
import { HORIZONS_SEC, ALL_HORIZONS_MASK } from '../src/schema.ts';
import { dueHorizons, selectDue } from '../src/sweep.ts';

const H1 = 3600_000;
const MIN = 60_000;

/** Rows from the sample recording (30 trending mints enriched from DexScreener + Jupiter). */
let rows: EnrichedRow[] = [];
let mints: string[] = [];
before(async () => {
  const { dl, clock } = sampleLayer();
  const disc = await drive(clock, dl.store.discover('trending', 30));
  const res = await drive(clock, dl.store.enrich(disc.mints, { price: true }));
  rows = res.rows;
  mints = rows.map((r) => r.mint);
  dl.close();
  assert.ok(rows.length >= 28);
});

/** A fresh in-memory recorder on a fake clock. */
function make(opts: ConstructorParameters<typeof Recorder>[0] = {}): { rec: Recorder; clock: FakeClock } {
  const clock = new FakeClock(Date.parse('2026-10-10T00:00:00Z'));
  const rec = new Recorder({ path: ':memory:', clock, ...opts });
  return { rec, clock };
}

/** Rows re-timestamped to `t` with an optional tweak (what a later refresh would deliver). */
function at(t: number, tweak?: (r: EnrichedRow, i: number) => EnrichedRow): EnrichedRow[] {
  return rows.map((r, i) => {
    const row: EnrichedRow = { ...r, token: { ...r.token, fetchedAt: t }, pair: { ...r.pair, fetchedAt: t }, stats: r.stats ? { ...r.stats, fetchedAt: t } : undefined, audit: r.audit ? { ...r.audit, fetchedAt: t } : undefined };
    return tweak ? tweak(row, i) : row;
  });
}
const bump = (f: number) => (r: EnrichedRow): EnrichedRow => ({ ...r, pair: { ...r.pair, priceUsd: r.pair.priceUsd * f, mcap: r.pair.mcap === null ? null : r.pair.mcap * f } });
const q = <T>(rec: Recorder, sql: string, ...args: (string | number)[]): T => rec.database.prepare(sql).get(...args) as T;
const n = (rec: Recorder, sql: string, ...args: (string | number)[]): number => Number(q<{ n: number }>(rec, sql, ...args).n);

test('normaliser: columns from the enriched row, hash ignores fetchedAt, strings are firewalled', () => {
  const r = rows[0];
  const s = fromEnrichedRow(r);
  assert.equal(s.columns.mint, r.mint);
  assert.equal(s.columns.price_usd, r.pair.priceUsd);
  assert.equal(s.columns.liquidity_usd, r.pair.liquidityUsd);
  assert.equal(s.columns.src_market, 'dexscreener');
  assert.equal(s.columns.mcap_resolved, r.mcap?.value ?? null);
  assert.equal(s.columns.holder_count, r.stats?.holderCount ?? null);
  assert.equal(s.columns.mint_auth_enabled, r.audit ? (r.audit.mintAuthority === null ? null : r.audit.mintAuthority ? 1 : 0) : null);
  assert.equal(s.t, Math.max(r.token.fetchedAt, r.pair.fetchedAt, r.stats?.fetchedAt ?? 0, r.audit?.fetchedAt ?? 0));
  const later = fromEnrichedRow(at(s.t + 5000)[0]);
  assert.equal(later.hash, s.hash, 'same numbers, later fetch: same hash');
  assert.notEqual(fromEnrichedRow(bump(1.002)(r)).hash, s.hash, 'the stored hash is exact: any change');
  assert.equal(s.hash, hashColumns(s.columns));
  // material change: 5 % price / mcap / liq, 10 % holders, 20 % volume, 25 % counts, 5 points for a pct-change field, 2 for a share, any flag
  const c = s.columns;
  assert.equal(isMaterialChange(c, { ...c, price_usd: c.price_usd! * 1.04 }), false);
  assert.equal(isMaterialChange(c, { ...c, price_usd: c.price_usd! * 1.051 }), true);
  assert.equal(isMaterialChange(c, { ...c, price_usd: c.price_usd! * 0.949 }), true);
  assert.equal(isMaterialChange({ ...c, holder_count: 1000 }, { ...c, holder_count: 1099 }), false);
  assert.equal(isMaterialChange({ ...c, holder_count: 1000 }, { ...c, holder_count: 1100 }), true);
  assert.equal(isMaterialChange({ ...c, vol_h1: 1000 }, { ...c, vol_h1: 1190 }), false);
  assert.equal(isMaterialChange({ ...c, vol_h1: 1000 }, { ...c, vol_h1: 1200 }), true);
  assert.equal(isMaterialChange({ ...c, buys_h1: 100 }, { ...c, buys_h1: 124 }), false);
  assert.equal(isMaterialChange({ ...c, buys_h1: 100 }, { ...c, buys_h1: 125 }), true);
  assert.equal(isMaterialChange({ ...c, buys_h1: 0 }, { ...c, buys_h1: 1 }), true, '0 → anything is a move');
  assert.equal(isMaterialChange({ ...c, chg_h1: 3.2 }, { ...c, chg_h1: 7.9 }), false);
  assert.equal(isMaterialChange({ ...c, chg_h1: 3.2 }, { ...c, chg_h1: 8.3 }), true);
  assert.equal(isMaterialChange({ ...c, organic_score: 70 }, { ...c, organic_score: 71.9 }), false);
  assert.equal(isMaterialChange({ ...c, organic_score: 70 }, { ...c, organic_score: 72 }), true);
  assert.equal(isMaterialChange({ ...c, mint_auth_enabled: 0 }, { ...c, mint_auth_enabled: 1 }), true);
  assert.equal(isMaterialChange({ ...c, liquidity_usd: null }, { ...c, liquidity_usd: 5 }), true);
  assert.equal(isMaterialChange(c, { ...c, sources: [...c.sources, 'jupiter-price'] }), true);
  assert.equal(isMaterialChange(c, { ...c }), false);
  assert.equal(cleanText('a​b‮c\x01d  e', 16), 'abcd e');
  assert.equal(cleanText('x'.repeat(40), 16), 'x'.repeat(16) + '…');
  assert.equal(hashColumns(s.columns).length, 22);
});

test('material change detection: wiggles are ignored, a slow drift is written once it adds up (hysteresis), exact mode writes everything', () => {
  const { rec, clock } = make();
  const t0 = clock.now();
  rec.observe(at(t0), t0);
  assert.equal(rec.observe(at(t0 + 10_000, bump(1.01)), t0 + 10_000).written, 0, '1 % everywhere: nothing');
  assert.equal(rec.observe(at(t0 + 20_000, bump(1.03)), t0 + 20_000).written, 0, '3 % vs the last written row: still nothing');
  assert.equal(rec.observe(at(t0 + 30_000, bump(1.06)), t0 + 30_000).written, rows.length, '6 % vs the last written row: every row');
  assert.equal(rec.observe(at(t0 + 40_000, bump(1.08)), t0 + 40_000).written, 0, 'and the new baseline is the written row (8 % vs t0 is < 5 % vs the 6 % row)');
  // across runs: a fresh recorder on the same DB compares against the stored row, not against nothing
  const path = `/tmp/r01-hyst-${process.pid}.db`;
  const a = new Recorder({ path, clock });
  a.observe(at(t0), t0);
  a.close();
  const b = new Recorder({ path, clock });
  assert.equal(b.observe(at(t0 + 10_000, bump(1.01)), t0 + 10_000).written, 0, 'seeded from the DB: the wiggle is not written');
  assert.equal(b.observe(at(t0 + 20_000, bump(1.10)), t0 + 20_000).written, rows.length);
  b.close();
  for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
  const exact = new Recorder({ path: ':memory:', clock, changeDetection: 'exact' });
  exact.observe(at(t0), t0);
  assert.equal(exact.observe(at(t0 + 10_000, bump(1.003)), t0 + 10_000).written, rows.length, 'exact mode writes the wiggle');
  rec.close(); exact.close();
});

test('t0 anchors are written on the hour even when nothing changed and the heartbeat is not due', () => {
  const { rec, clock } = make({ heartbeatMs: 24 * H1 });
  const t0 = clock.now();
  rec.observe(at(t0), t0);
  assert.equal(rec.observe(at(t0 + 59 * MIN), t0 + 59 * MIN).written, 0);
  const r = rec.observe(at(t0 + 60 * MIN), t0 + 60 * MIN);
  assert.equal(r.written, rows.length);
  assert.equal(r.t0, rows.length, 'every row is a new anchor');
  assert.equal(r.heartbeat, rows.length, 'counted as unchanged (anchor-forced)');
  assert.equal(rec.observe(at(t0 + 61 * MIN), t0 + 61 * MIN).written, 0);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots WHERE is_t0 = 1'), 2 * rows.length);
  rec.close();
});

test('observe: writes once per change, skips identical fetches, heartbeat after 30 min, t0 anchors hourly', () => {
  const { rec, clock } = make();
  const t0 = clock.now();
  const r1 = rec.observe(at(t0), t0);
  assert.equal(r1.written, rows.length);
  assert.equal(r1.t0, rows.length, 'first sighting of every mint is a t0 anchor');
  // the same fetch handed over again (served from cache): nothing
  assert.deepEqual(rec.observe(at(t0), t0), { written: 0, skipped: rows.length, heartbeat: 0, t0: 0 });
  // a newer fetch with identical numbers inside the heartbeat window: nothing
  assert.equal(rec.observe(at(t0 + 10_000), t0 + 10_000).written, 0);
  // a 6 % price move on 3 rows: exactly 3 rows, none of them t0 anchors
  const r2 = rec.observe(at(t0 + 20_000, (r, i) => (i < 3 ? bump(1.06)(r) : r)), t0 + 20_000);
  assert.deepEqual([r2.written, r2.t0], [3, 0]);
  // heartbeat: unchanged rows are written again once the last stored row is DEFAULT_HEARTBEAT_MS (30 min) old
  // (the 3 bumped rows revert to their old numbers here: that is a change, not a heartbeat)
  const r3 = rec.observe(at(t0 + DEFAULT_HEARTBEAT_MS + 1000), t0 + DEFAULT_HEARTBEAT_MS + 1000);
  assert.equal(r3.heartbeat, rows.length - 3, '27 unchanged rows hit the heartbeat');
  assert.equal(r3.written, rows.length, '27 heartbeats + 3 reverted rows');
  // inside the next heartbeat window nothing is written again
  assert.equal(rec.observe(at(t0 + DEFAULT_HEARTBEAT_MS + 60_000), t0 + DEFAULT_HEARTBEAT_MS + 60_000).written, 0);
  // t0 cadence: a change one hour later is a new anchor
  const r4 = rec.observe(at(t0 + DEFAULT_T0_EVERY_MS, bump(1.1)), t0 + DEFAULT_T0_EVERY_MS);
  assert.equal(r4.t0, rows.length);
  assert.equal(n(rec, "SELECT COUNT(*) AS n FROM token_snapshots WHERE kind = 'live'"), rows.length + 3 + rows.length + rows.length);
  const m = q<{ first_t: number; last_live_t: number; snapshots: number }>(rec, 'SELECT first_t, last_live_t, snapshots FROM mints WHERE mint = ?', mints[0]);
  assert.equal(m.first_t, t0);
  assert.equal(m.last_live_t, t0 + DEFAULT_T0_EVERY_MS);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots WHERE raw_json IS NOT NULL'), 0, 'no focus set: no raw JSON anywhere');
  rec.close();
});

test('focus rows (watchlist / open token) keep the raw normalised JSON; others never do', () => {
  const focus = new Set([mints[1]]);
  const { rec, clock } = make({ focus: () => focus });
  rec.observe(at(clock.now()), clock.now());
  const raw = q<{ raw_json: string | null; focus: number }>(rec, 'SELECT raw_json, focus FROM token_snapshots WHERE mint = ?', mints[1]);
  assert.equal(raw.focus, 1);
  const parsed = JSON.parse(raw.raw_json!) as { token: { mint: string }; pair: { priceUsd: number } };
  assert.equal(parsed.token.mint, mints[1]);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots WHERE raw_json IS NOT NULL'), 1);
  rec.close();
});

test('feed membership: full list on first sight and every 10 min, entrants at once with their rank', () => {
  const { rec, clock } = make();
  const t = clock.now();
  assert.equal(rec.recordMembers('jup:toptrending-1h', ['a', 'b', 'c'], t), 3);
  assert.equal(rec.recordMembers('jup:toptrending-1h', ['c', 'b', 'a'], t + 10_000), 0, 'same set reshuffled: nothing until the next full write');
  assert.equal(rec.recordMembers('jup:toptrending-1h', ['d', 'c', 'b', 'a'], t + 20_000), 1, 'one entrant');
  assert.deepEqual({ ...q<object>(rec, 'SELECT rank, mint FROM feed_members WHERE t = ?', t + 20_000) }, { rank: 0, mint: 'd' });
  assert.equal(rec.recordMembers('jup:toptrending-1h', ['d', 'c'], t + 11 * MIN), 2, 'full rewrite after 10 min');
  assert.equal(rec.recordMembers('ds:boosts-top', ['x'], t), 1, 'feeds are independent');
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM feed_members'), 7);
  rec.close();
});

test('attach: the Store listener records what discover()/enrich() produce, with no request of its own', async () => {
  const fixtures = loadSample();
  const calls: string[] = [];
  const spyT: Transport = async (req: HttpRequest) => { calls.push(req.url); return replayTransport(fixtures)(req); };
  const { dl, clock } = sampleLayer({ transport: spyT });
  const rec = new Recorder({ path: ':memory:', clock });
  rec.attach(dl.store);
  const disc = await drive(clock, dl.store.discover('trending', 30));
  const withDiscover = calls.length;
  await drive(clock, dl.store.enrich(disc.mints, { price: true }));
  const withEnrich = calls.length - withDiscover;
  assert.equal(n(rec, "SELECT COUNT(*) AS n FROM token_snapshots WHERE kind = 'live'"), rows.length);
  assert.equal(n(rec, "SELECT COUNT(DISTINCT feed) AS n FROM feed_members"), 2, 'ds:boosts-top + jup:toptrending-1h');
  assert.ok(n(rec, 'SELECT COUNT(*) AS n FROM feed_members') >= 30);
  // the recorder added no request: the same sequence without a listener issues exactly the same calls
  const calls2: string[] = [];
  const { dl: dl2, clock: c2 } = sampleLayer({ transport: async (req) => { calls2.push(req.url); return replayTransport(fixtures)(req); } });
  const d2 = await drive(c2, dl2.store.discover('trending', 30));
  const withoutDiscover = calls2.length;
  await drive(c2, dl2.store.enrich(d2.mints, { price: true }));
  assert.equal(withDiscover, withoutDiscover, 'discover: same request count with and without the recorder attached');
  assert.equal(withEnrich, calls2.length - withoutDiscover, 'enrich: same request count with and without the recorder attached');
  assert.deepEqual(calls, calls2, 'and the same URLs');
  dl.close(); dl2.close(); rec.close();
});

test('sweep rule: a horizon is due once the live row is h..2h old and nothing newer exists; sweeps never repeat a horizon', () => {
  const m = { mint: 'm', last_live_t: 0, last_any_t: 0 };
  assert.deepEqual(dueHorizons(m, 30 * MIN), []);
  assert.deepEqual(dueHorizons(m, H1), [3600]);
  assert.deepEqual(dueHorizons(m, 2 * H1 - 1), [3600]);
  assert.deepEqual(dueHorizons(m, 2 * H1), [7200]);
  assert.deepEqual(dueHorizons({ ...m, last_any_t: H1 + MIN }, 90 * MIN), [], 'the 1 h sweep already happened');
  assert.deepEqual(dueHorizons({ ...m, last_any_t: H1 + MIN }, 2 * H1), [7200]);
  assert.deepEqual(dueHorizons({ ...m, last_any_t: 3 * H1 }, 4 * H1), [], 'between 2 h and 6 h nothing is due');
  assert.deepEqual(dueHorizons(m, 30 * H1), [86400], 'app was closed for a day: the open 24 h window is served by one row');
  assert.deepEqual(dueHorizons(m, 100 * H1), [259200], 'the 24 h window closed at 48 h; only 72 h is still open');
  assert.deepEqual(dueHorizons(m, 200 * H1), [], 'every window closed: unobserved, no request');
  const sel = selectDue([{ mint: 'late', last_live_t: 0, last_any_t: 0 }, { mint: 'soon', last_live_t: -30 * MIN, last_any_t: -30 * MIN }], H1 + MIN, 10);
  assert.deepEqual(sel.map((d) => d.mint), ['soon', 'late'], 'soonest-closing window first');
  assert.equal(selectDue([m, m, m], H1, 2).length, 2);
});

/** A transport that answers DexScreener tokens/v1 for any mint list from the sample's own pairs, scaled. */
function dsAnswering(scale: (mint: string) => { price: number; liq: number; vol: number } | null, log: { urls: string[]; priorities: (string | undefined)[] }): Transport {
  const fixtures = loadSample();
  const byMint = new Map<string, DsRawPair>();
  for (const e of fixtures.list()) {
    if (!e.url.includes('/tokens/v1/')) continue;
    for (const p of (Array.isArray(e.body) ? e.body : []) as DsRawPair[]) byMint.set(p.baseToken.address, p);
  }
  return async (req: HttpRequest): Promise<HttpResponse> => {
    log.urls.push(req.url);
    log.priorities.push(currentPriority()?.level);
    const m = /\/tokens\/v1\/solana\/([^?]+)/.exec(req.url);
    if (!m) throw new Error(`unexpected request ${req.url}`);
    const out: DsRawPair[] = [];
    for (const mint of decodeURIComponent(m[1]).split(',')) {
      const s = scale(mint);
      const p = byMint.get(mint);
      if (!s || !p) continue;
      out.push({ ...p, priceUsd: String(s.price), liquidity: { usd: s.liq }, volume: { ...p.volume, h1: s.vol }, marketCap: s.price * 1_000_000 });
    }
    return json(200, out);
  };
}

test('outcome sweep: due mints only, 30 per call, low priority, capped per sweep and per day, skipped while paused; rows land as kind=sweep', async () => {
  const log = { urls: [] as string[], priorities: [] as (string | undefined)[] };
  const vanished = new Set([mints[0]]);
  const { dl, clock } = sampleLayer({ transport: dsAnswering((m) => (vanished.has(m) ? null : { price: 0.5, liq: 100, vol: 10 }), log) });
  const rec = new Recorder({ path: ':memory:', clock, sweep: { maxCallsPerSweep: 1, maxCallsPerDay: 2 } });
  const t0 = clock.now();
  rec.observe(at(t0), t0);
  // nothing due before 1 h
  assert.equal((await rec.sweep(dl, t0 + 30 * MIN)).skipped, 'not-due');
  await clock.advance(H1 + MIN);
  const now = clock.now();
  assert.equal(rec.due(now).length, rows.length);
  // paused bucket (a 429 happened): wait for the next tick
  dl.limiter.pause('dexscreener', 5_000);
  assert.equal((await rec.sweep(dl, now)).skipped, 'paused');
  await clock.advance(6_000);
  const s1 = await drive(clock, rec.sweep(dl, clock.now()));
  assert.equal(s1.skipped, null);
  assert.equal(s1.calls, 1, 'maxCallsPerSweep = 1');
  assert.equal(s1.mints, 30, 'one DexScreener batch');
  assert.equal(s1.answered, 29, 'the vanished mint had no pair in the answer');
  assert.equal(log.urls.length, 1);
  assert.match(log.urls[0], /api\.dexscreener\.com\/tokens\/v1\/solana\//);
  assert.deepEqual(log.priorities, ['low'], 'queued at the lowest priority that still queues');
  assert.equal(n(rec, "SELECT COUNT(*) AS n FROM token_snapshots WHERE kind = 'sweep'"), 30);
  assert.equal(q<{ src_market: string }>(rec, "SELECT src_market FROM token_snapshots WHERE kind = 'sweep' AND mint = ?", mints[0]).src_market, 'none');
  assert.equal(q<{ src_market: string; liquidity_usd: number }>(rec, "SELECT src_market, liquidity_usd FROM token_snapshots WHERE kind = 'sweep' AND mint = ?", mints[1]).liquidity_usd, 100);
  // the swept mints are no longer due at 1 h; the rest (if any) are; the mints summary moved last_any only
  const m = q<{ last_live_t: number; last_any_t: number }>(rec, 'SELECT last_live_t, last_any_t FROM mints WHERE mint = ?', mints[1]);
  assert.equal(m.last_live_t, t0);
  assert.ok(m.last_any_t > t0 + H1);
  assert.equal(rec.due(clock.now()).length, Math.max(0, rows.length - 30));
  // day cap: 2 calls; the second sweep spends it, the third is refused
  await clock.advance(MIN);
  const s2 = await drive(clock, rec.sweep(dl, clock.now()));
  assert.equal(s2.skipped, rows.length > 30 ? null : 'not-due');
  await clock.advance(H1); // 2 h horizon opens for every mint
  const s3 = await rec.sweep(dl, clock.now());
  assert.equal(s3.skipped, rows.length > 30 ? 'day-cap' : null);
  assert.ok(rec.sweepCallsToday(clock.now()) <= 2);
  // the ledger
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM sweeps WHERE finished_at IS NOT NULL AND error IS NULL'), rows.length > 30 ? 2 : 2);
  dl.close(); rec.close();
});

test('labels: per (t0, horizon) from recorded rows; open windows wait, closed windows are unobserved', async () => {
  const log = { urls: [] as string[], priorities: [] as (string | undefined)[] };
  const { dl, clock } = sampleLayer({ transport: dsAnswering(() => ({ price: 0.001, liq: 50, vol: 0 }), log) });
  const rec = new Recorder({ path: ':memory:', clock, sweep: { maxCallsPerSweep: 6 } });
  const t0 = clock.now();
  rec.observe(at(t0), t0);
  // 30 min in: a +150 % spike on every row (an intermediate observation for max_mcap_ratio), then the token leaves the screen
  rec.observe(at(t0 + 30 * MIN, bump(2.5)), t0 + 30 * MIN);
  assert.deepEqual(rec.labelPending(t0 + 30 * MIN), { labelled: 0, pending: 0, counts: {} }, 'nothing due before the first horizon');
  // 1 h after the LAST live row (t0 + 1 h 31 min, inside t0's [1 h, 2 h] window): the sweep observes the
  // collapse (liq 50, vol 0 → D2 curve-dead for launchpad rows, D1/fade otherwise)
  await clock.advance(H1 + 31 * MIN);
  assert.equal(rec.due(clock.now()).length, rows.length);
  const s = await drive(clock, rec.sweep(dl, clock.now()));
  assert.equal(s.answered, rows.length);
  const l1 = rec.labelPending(clock.now());
  assert.equal(l1.labelled, rows.length, 'one outcome per t0 at the 1 h horizon');
  assert.equal(l1.pending, rows.length, 'the other four horizons are still open');
  const o = q<{ label: string; max_mcap_ratio: number; t1: number; mcap_ratio: number; evidence: string }>(rec, 'SELECT label, max_mcap_ratio, t1, mcap_ratio, evidence FROM outcomes WHERE mint = ? AND horizon_sec = 3600', mints[2]);
  assert.ok(o.max_mcap_ratio >= 2.4 && o.max_mcap_ratio <= 2.6, `max over intermediate rows: ${o.max_mcap_ratio}`);
  assert.ok(o.mcap_ratio < 0.2);
  assert.ok(['dead', 'fade', 'rug'].includes(o.label), o.label);
  assert.equal(o.t1, q<{ t: number }>(rec, "SELECT MAX(t) AS t FROM token_snapshots WHERE kind = 'sweep' AND mint = ?", mints[2]).t, 'the sweep row is t1');
  assert.ok(JSON.parse(o.evidence).dt_sec >= 3600);
  // horizons_done bit 0 set, next_due at t0+2h
  const snap = q<{ horizons_done: number; next_due_t: number }>(rec, 'SELECT horizons_done, next_due_t FROM token_snapshots WHERE mint = ? AND is_t0 = 1', mints[2]);
  assert.equal(snap.horizons_done, 1);
  assert.equal(snap.next_due_t, t0 + 2 * H1);
  // 2 h horizon: window open, no observation yet → retry later, nothing written
  await clock.advance(30 * MIN);
  const l2 = rec.labelPending(clock.now());
  assert.equal(l2.labelled, 0);
  assert.equal(q<{ next_due_t: number }>(rec, 'SELECT next_due_t FROM token_snapshots WHERE mint = ? AND is_t0 = 1', mints[2]).next_due_t, clock.now() + LABEL_RETRY_MS);
  // far future with no further observations: every remaining horizon closes unobserved
  await clock.advance(200 * H1);
  const l3 = rec.labelPending(clock.now());
  assert.equal(l3.labelled, rows.length * 4);
  assert.equal(l3.counts.unobserved, rows.length * 4);
  assert.equal(l3.pending, 0);
  assert.equal(n(rec, `SELECT COUNT(*) AS n FROM token_snapshots WHERE is_t0 = 1 AND horizons_done = ${ALL_HORIZONS_MASK}`), rows.length);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM outcomes'), rows.length * HORIZONS_SEC.length);
  // export: features from t0 only, outcomes per horizon, feeds (none recorded here), leakage rule stated
  const doc = exportRecorded(rec.database, {}, clock.now());
  assert.equal(doc.counts.records, rows.length);
  assert.equal(doc.counts.with_any_outcome, rows.length);
  const rec2 = doc.records.find((r) => r.mint === mints[2])!;
  assert.equal(rec2.t0, t0);
  assert.equal(rec2.features.price_usd, rows[2].pair.priceUsd, 'the t0 price, not the spike or the collapse');
  assert.equal(Object.keys(rec2.outcomes).length, 5);
  assert.equal(rec2.outcomes['7200']!.label, 'unobserved');
  assert.equal(typeof rec2.outcomes['3600']!.positive, 'boolean');
  assert.match(doc.leakage_rule, /t0 row only/);
  // age at t0 is exported (it was null in every row, so the backtest scored everything as a fresh launch)
  const created = rows[2].token.createdAt ?? rows[2].pair.createdAt;
  if (created) assert.equal(rec2.features.age_sec, Math.max(0, Math.round((t0 - created) / 1000)));
  assert.ok(doc.records.filter((r) => r.features.age_sec !== null).length > 0, 'age_sec present on exported rows');
  assert.equal(exportRecorded(rec.database, { labelledOnly: true, since: t0 + 1 }, clock.now()).counts.records, 0);
  assert.equal(exportRecorded(rec.database, { limit: 3 }, clock.now()).records.length, 3);
  dl.close(); rec.close();
});

test('retention: raw JSON after 7 d, one row per mint per minute after 24 h (t0 anchors and cited t1 rows kept), columns after 90 d', () => {
  const focus = new Set([mints[0]]);
  const { rec, clock } = make({ focus: () => focus, heartbeatMs: 1 });
  const start = clock.now();
  // 6 observations 10 s apart inside one minute, all changed (heartbeat 1 ms forces a write anyway)
  for (let i = 0; i < 6; i++) rec.observe(at(start + i * 10_000, bump(1 + i / 100)), start + i * 10_000);
  const perMint = 6;
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots'), rows.length * perMint);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots WHERE raw_json IS NOT NULL'), perMint);
  // cite one non-anchor row as an outcome's t1 so the downsampler must keep it
  const cited = q<{ t: number }>(rec, 'SELECT t FROM token_snapshots WHERE mint = ? AND is_t0 = 0 ORDER BY t DESC LIMIT 1', mints[3]).t;
  rec.database.prepare("INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, evidence, labeler_version) VALUES (?, ?, 3600, ?, 'flat', 'keyless-proxy', '{}', 'test')").run(mints[3], start, cited);
  // 25 h later: downsample. Per mint: the t0 anchor (first row) is the minute's first row → 1 kept, 5 deleted; mints[3] keeps its cited row too.
  const p1 = rec.prune(start + 25 * H1);
  assert.equal(p1.rawCleared, 0);
  assert.equal(p1.downsampled, rows.length * (perMint - 1) - 1);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots WHERE mint = ?', mints[3]), 2);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots WHERE mint = ?', mints[4]), 1);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots WHERE is_t0 = 1'), rows.length, 'anchors survive');
  // incremental: a second pass over the same hours finds nothing
  assert.equal(rec.prune(start + 26 * H1).downsampled, 0);
  // 8 d: raw JSON gone, rows stay
  const p2 = rec.prune(start + 8 * 24 * H1);
  assert.equal(p2.rawCleared, 1);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots'), rows.length + 1);
  // 91 d: columns gone, outcomes stay
  const p3 = rec.prune(start + 91 * 24 * H1);
  assert.equal(p3.expired, rows.length + 1);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM token_snapshots'), 0);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM outcomes'), 1);
  assert.equal(n(rec, 'SELECT COUNT(*) AS n FROM mints'), 0);
  rec.close();
});

test('disable switch: enabled=false records nothing, sweeps nothing, still answers stats', async () => {
  const log = { urls: [] as string[], priorities: [] as (string | undefined)[] };
  const { dl, clock } = sampleLayer({ transport: dsAnswering(() => ({ price: 1, liq: 1, vol: 1 }), log) });
  const rec = new Recorder({ path: ':memory:', clock, enabled: false });
  rec.attach(dl.store);
  assert.deepEqual(rec.observe(at(clock.now()), clock.now()), { written: 0, skipped: 0, heartbeat: 0, t0: 0 });
  assert.equal(rec.recordMembers('f', ['a'], clock.now()), 0);
  assert.equal((await rec.sweep(dl, clock.now() + 2 * H1)).skipped, 'disabled');
  const s = rec.stats();
  assert.equal(s.enabled, false);
  assert.equal(s.snapshots, 0);
  assert.equal(log.urls.length, 0);
  dl.close(); rec.close();
});

test('maintain(): runs sweep + labels + prune on their own spacing and swallows errors', async () => {
  const log = { urls: [] as string[], priorities: [] as (string | undefined)[] };
  const { dl, clock } = sampleLayer({ transport: dsAnswering(() => ({ price: 1, liq: 1, vol: 1 }), log) });
  const lines: string[] = [];
  const rec = new Recorder({ path: ':memory:', clock, onLog: (l) => lines.push(l) });
  rec.observe(at(clock.now()), clock.now());
  const r0 = await rec.maintain(dl, clock.now());
  assert.equal(r0.sweep?.skipped, 'not-due');
  assert.ok(r0.labels && r0.prune, 'first call runs every job');
  const r1 = await rec.maintain(dl, clock.now() + 1000);
  assert.deepEqual(r1, { sweep: null, labels: null, prune: null }, 'nothing is re-run inside the spacing');
  await clock.advance(H1 + 2 * MIN);
  const r2 = await drive(clock, rec.maintain(dl, clock.now()));
  assert.equal(r2.sweep?.calls, 1);
  assert.equal(r2.labels?.labelled, rows.length);
  assert.ok(lines.some((l) => /recorder: sweep: /.test(l)) && lines.some((l) => /recorder: labels: /.test(l)));
  // the in-memory last-row cache forgets mints not seen for 2 h and re-seeds from the DB when they return
  assert.equal(rec.cachedMints, rows.length);
  await clock.advance(SEEN_EVICT_MS);
  await rec.maintain(dl, clock.now());
  assert.equal(rec.cachedMints, 0);
  const back = rec.observe(at(clock.now(), bump(1.001)), clock.now());
  assert.equal(back.heartbeat, rows.length, 're-seeded from the DB: the wiggle is "unchanged" (so these are heartbeat rows, not changes)');
  assert.equal(back.written, rows.length, 'and the heartbeat is long overdue, so they are written');
  assert.equal(rec.cachedMints, rows.length);
  assert.equal(rec.observe(at(clock.now() + 10_000, bump(1.002)), clock.now() + 10_000).written, 0, 'now cached again: nothing');
  dl.close(); rec.close();
});

test('stats(): counts, bytes per snapshot, span', () => {
  const { rec, clock } = make();
  rec.observe(at(clock.now()), clock.now());
  const s = rec.stats(clock.now());
  assert.equal(s.snapshots, rows.length);
  assert.equal(s.live, rows.length);
  assert.equal(s.t0, rows.length);
  assert.equal(s.mints, rows.length);
  assert.ok(s.bytesPerSnapshot !== null && s.bytesPerSnapshot > 100 && s.bytesPerSnapshot < 2000, `bytes/row ${s.bytesPerSnapshot}`);
  assert.equal(s.oldestT, clock.now());
  assert.equal(s.labelerVersion, '0.2.0');
  rec.close();
});
