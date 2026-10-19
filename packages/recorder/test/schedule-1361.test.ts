// task-1361: why sweeps / outcomes never fired in the real DB, pinned as tests.
//   1. The app's maintenance schedule: first pass RECORDER_FIRST_TICK_MS after launch (not a full tick),
//      then every RECORDER_TICK_MS, once per window.
//   2. A run shorter than the first pass still leaves outcomes: close() labels the due anchors.
//   3. A cold DB full of overdue anchors (what two days of 10-second runs left behind): the FIRST
//      maintain() call labels them and sweeps the mints whose horizon windows are open.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { currentPriority, type DsRawPair, type EnrichedRow, type HttpRequest, type HttpResponse, type Transport } from '@dexterm/data';
import { drive, json, loadSample, sampleLayer } from '../../data/test/helpers.ts';
import { FakeClock } from '../../data/src/clock.ts';
import { Recorder } from '../src/recorder.ts';
import { MaintenanceSchedule, RECORDER_FIRST_TICK_MS, RECORDER_TICK_MS } from '../src/schedule.ts';
import { HORIZONS_SEC } from '../src/schema.ts';

const H1 = 3600_000;

let rows: EnrichedRow[] = [];
before(async () => {
  const { dl, clock } = sampleLayer();
  const disc = await drive(clock, dl.store.discover('trending', 30));
  rows = (await drive(clock, dl.store.enrich(disc.mints, { price: true }))).rows;
  dl.close();
  assert.ok(rows.length >= 28);
});

/** A DexScreener tokens/v1 transport answering every fixture mint from the sample recording (sweep target). */
function dsAnswering(log: { urls: string[]; priorities: (string | undefined)[] }): Transport {
  const byMint = new Map<string, DsRawPair>();
  for (const e of loadSample().list()) {
    if (!e.url.includes('/tokens/v1/')) continue;
    for (const p of (Array.isArray(e.body) ? e.body : []) as DsRawPair[]) byMint.set(p.baseToken.address, p);
  }
  return async (req: HttpRequest): Promise<HttpResponse> => {
    log.urls.push(req.url);
    log.priorities.push(currentPriority()?.level);
    const m = /\/tokens\/v1\/solana\/([^?]+)/.exec(req.url);
    if (!m) throw new Error(`unexpected request ${req.url}`);
    const out: DsRawPair[] = [];
    for (const mint of decodeURIComponent(m[1]).split(',')) { const p = byMint.get(mint); if (p) out.push(p); }
    return json(200, out);
  };
}

/** Rows re-timestamped to `t` (what a refresh at `t` would deliver). */
function at(t: number): EnrichedRow[] {
  return rows.map((r) => ({ ...r, token: { ...r.token, fetchedAt: t }, pair: { ...r.pair, fetchedAt: t }, stats: r.stats ? { ...r.stats, fetchedAt: t } : undefined, audit: r.audit ? { ...r.audit, fetchedAt: t } : undefined }));
}

test('MaintenanceSchedule: first pass RECORDER_FIRST_TICK_MS after launch, then every RECORDER_TICK_MS, once per window', () => {
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  const s = new MaintenanceSchedule(t0);
  assert.equal(RECORDER_FIRST_TICK_MS, 5_000, 'the first pass lands inside even a short run');
  assert.ok(RECORDER_FIRST_TICK_MS < RECORDER_TICK_MS);
  assert.equal(s.due(t0), false, 'not during the first paint');
  assert.equal(s.due(t0 + 500), false);
  assert.equal(s.due(t0 + RECORDER_FIRST_TICK_MS - 1), false);
  assert.equal(s.nextDueAt(), t0 + RECORDER_FIRST_TICK_MS);
  assert.equal(s.due(t0 + RECORDER_FIRST_TICK_MS), true, 'first pass at +5 s');
  assert.equal(s.lastRunAt, t0 + RECORDER_FIRST_TICK_MS);
  assert.equal(s.due(t0 + RECORDER_FIRST_TICK_MS + 500), false, 'once per window');
  assert.equal(s.due(t0 + RECORDER_FIRST_TICK_MS + RECORDER_TICK_MS - 1), false);
  assert.equal(s.due(t0 + RECORDER_FIRST_TICK_MS + RECORDER_TICK_MS), true, 'then every 60 s');
  assert.equal(s.nextDueAt(), t0 + RECORDER_FIRST_TICK_MS + 2 * RECORDER_TICK_MS);
  // the regression: the old loop's `lastTick = launch` meant nothing before launch + 60 s
  const old = new MaintenanceSchedule(t0, RECORDER_TICK_MS);
  assert.equal(old.due(t0 + 14_000), false, 'a 14 s run under the old rule never maintained');
  assert.equal(new MaintenanceSchedule(t0).due(t0 + 14_000), true, 'under the new rule it does');
});

test('close() labels the due anchors, so a run shorter than the first tick still leaves outcomes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r1361-close-'));
  const path = join(dir, 'dexterm.db');
  try {
    const clock = new FakeClock(Date.parse('2026-10-10T00:00:00Z'));
    const lines: string[] = [];
    // run 1 (10 s): writes t0 anchors and quits before any maintenance tick; nothing is due yet, so close labels 0
    const r1 = new Recorder({ path, clock, onLog: (l) => lines.push(l) });
    r1.observe(at(clock.now()), clock.now());
    await clock.advance(10_000);
    assert.equal(r1.close().labelled, 0);
    // run 2, three hours later (10 s): the 1 h horizon windows [t0+1h, t0+2h] closed unobserved; close() labels them
    await clock.advance(3 * H1);
    const r2 = new Recorder({ path, clock, onLog: (l) => lines.push(l) });
    r2.observe(at(clock.now()), clock.now());
    const beforeClose = Number(r2.database.prepare('SELECT COUNT(*) AS n FROM outcomes').get()!.n);
    assert.equal(beforeClose, 0, 'no maintenance tick ran in this short run');
    const closed = r2.close();
    // two outcomes per mint: the 1 h window closed with nothing in it, and this run's own row lands inside the
    // 2 h window [t0+2h, t0+4h], so a 10 s run three hours later still labels a real horizon
    assert.equal(closed.labelled, 2 * rows.length, 'one outcome per mint per horizon that is decidable now');
    const db = new DatabaseSync(path, { readOnly: true });
    const out = (db.prepare('SELECT horizon_sec, label, COUNT(*) AS n FROM outcomes GROUP BY horizon_sec, label ORDER BY horizon_sec, label').all() as { horizon_sec: number; label: string; n: number }[])
      .map((o) => ({ horizon_sec: Number(o.horizon_sec), label: String(o.label), n: Number(o.n) })); // node:sqlite rows are null-prototype objects
    db.close();
    assert.deepEqual(out.filter((o) => o.horizon_sec === HORIZONS_SEC[0]), [{ horizon_sec: HORIZONS_SEC[0], label: 'unobserved', n: rows.length }], 'nothing observed the 1 h window: unobserved, honestly');
    const h2 = out.filter((o) => o.horizon_sec === HORIZONS_SEC[1]);
    assert.equal(h2.reduce((s, o) => s + Number(o.n), 0), rows.length, 'every mint has a 2 h outcome');
    assert.ok(h2.every((o) => o.label !== 'unobserved'), `the 2 h horizon was observed by this run: ${JSON.stringify(h2)}`);
    assert.ok(lines.some((l) => /recorder: labels: \d+ written/.test(l)));
    // a closed recorder is inert
    assert.equal(r2.close().labelled, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cold DB with overdue anchors: the first maintain() labels them and sweeps the open windows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r1361-cold-'));
  const path = join(dir, 'dexterm.db');
  try {
    const log = { urls: [] as string[], priorities: [] as (string | undefined)[] };
    const { dl, clock } = sampleLayer({ transport: dsAnswering(log) });
    // yesterday's 10 s run: anchors + mints, no maintenance (the pre-task-1361 state of the real DB)
    const r1 = new Recorder({ path, clock, enabled: true });
    r1.observe(at(clock.now()), clock.now());
    r1.database.close(); // bypass close() labelling on purpose: this is the old on-disk state
    // today: the app opens the same DB 90 min later. Horizon 1 h is open ([L+1h, L+2h]) → sweep due; nothing
    // observed yet → the labeler must wait (retry), not write.
    await clock.advance(90 * 60_000);
    const r2 = new Recorder({ path, clock });
    const first = await drive(clock, r2.maintain(dl, clock.now()));
    assert.ok(first.sweep && first.sweep.skipped === null, `first call sweeps: ${JSON.stringify(first.sweep)}`);
    assert.equal(first.sweep.mints, rows.length);
    assert.ok(first.labels, 'labels ran');
    assert.equal(Number(r2.database.prepare("SELECT COUNT(*) AS n FROM sweeps").get()!.n), 1, 'a sweeps row exists');
    assert.equal(Number(r2.database.prepare("SELECT COUNT(*) AS n FROM token_snapshots WHERE kind = 'sweep'").get()!.n), rows.length);
    // the sweep observation answers the 1 h horizon for every mint
    const after = r2.labelPending(clock.now());
    const outcomes = Number(r2.database.prepare('SELECT COUNT(*) AS n FROM outcomes').get()!.n);
    assert.equal(outcomes, rows.length, `one labelled outcome per mint (labelled now ${after.labelled} + earlier ${first.labels.labelled})`);
    assert.equal(Number(r2.database.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE label = 'unobserved'").get()!.n), 0, 'swept windows are observed, not unobserved');
    r2.close();
    dl.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
