// DEV HISTORY (task-1425): the creator index and the point-in-time track-record query, on a seeded recorder DB.
// Offline: no data layer, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder, creatorOf, devHistoryLine, queryDevHistory, SERIAL_RUGGER_MIN } from '../src/index.ts';

const DEV = 'DevW1111111111111111111111111111111111111111';
const OTHER = 'DevW2222222222222222222222222222222222222222';
const m = (i: number): string => `Mint${String(i).replace(/0/g, 'z').padStart(3, 'z')}${'1'.repeat(40)}`.slice(0, 44); // base58: no 0
const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 10);

export function seed(): { rec: Recorder; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devhist-')), 'h.db');
  const rec = new Recorder({ path: file, clock: { now: () => T0 } as never });
  const db = rec.database;
  const out = db.prepare('INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, evidence, labeler_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const snap = db.prepare("INSERT INTO token_snapshots (mint, t, kind, hash, src_market, sources, dev_pct, symbol) VALUES (?, ?, 'live', 'h', 'dexscreener', '[]', ?, ?)");
  // DEV launched 4 coins: two rugs (72 h), one dead (only a 24 h label), one runner; plus a coin labelled LATER.
  const plan: Array<[number, string, number, number | null]> = [ // [i, label, horizonSec, launch offset h]
    [1, 'rug', 259200, 0], [2, 'rug', 259200, 10], [3, 'dead', 86400, 20], [4, 'runner', 259200, 30],
  ];
  for (const [i, label, h, off] of plan) {
    const t = T0 + (off as number) * H;
    rec.recordCreator(m(i), DEV, 'jupiter-tokens', t, t);
    out.run(m(i), t, h, t + h * 1000, label, 'keyless-proxy', '{}', '0.2.0');
    out.run(m(i), t, 3600, t + 3_600_000, 'flat', 'keyless-proxy', '{}', '0.2.0'); // a shorter label too: the longest wins
    snap.run(m(i), t, 5, `S${i}`);
  }
  // coin 1: the dev held 5 % then sold within 30 min; coin 4: held 2 % and sold after 3 h
  snap.run(m(1), T0 + 30 * 60_000, 0.05, 'S1');
  snap.run(m(4), T0 + 33 * H, 0.0, 'S4');
  // coin 5: recorded but no label yet
  rec.recordCreator(m(5), DEV, 'pumpportal', T0 + 40 * H, T0 + 40 * H);
  // the coin being judged, also by DEV
  rec.recordCreator(m(9), DEV, 'jupiter-tokens', T0 + 100 * H, null);
  // an unrelated wallet
  rec.recordCreator(m(20), OTHER, 'jupiter-tokens', T0, null);
  return { rec, file };
}

test('recordCreator: first writer wins, base58 only, self-links refused, counted once per run', () => {
  const { rec } = seed();
  assert.equal(rec.recordCreator(m(1), OTHER, 'rugcheck'), false, 'already linked this run');
  assert.equal(rec.recordCreator('not-a-mint', DEV, 'x'), false);
  assert.equal(rec.recordCreator(m(30), 'bad wallet', 'x'), false);
  assert.equal(rec.recordCreator(DEV, DEV, 'x'), false, 'a wallet is not its own coin');
  assert.equal(creatorOf(rec.database, m(1))?.creator, DEV);
  assert.equal(creatorOf(rec.database, m(1))?.source, 'jupiter-tokens');
  assert.equal(creatorOf(rec.database, m(31)), null);
});

test('observe() stores the creator Jupiter names on a row (audit.devAddress), once', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devhist-obs-')), 'h.db');
  const rec = new Recorder({ path: file });
  const row = (t: number) => ({
    mint: m(40), sources: ['jupiter-tokens'], stale: false,
    token: { mint: m(40), symbol: 'X', name: 'X', decimals: 6, launchpad: 'pump.fun', createdAt: T0, image: null, socials: { x: false, tg: false, web: false }, verified: false, sus: false, source: 'jupiter-tokens', fetchedAt: t },
    pair: { source: 'jupiter-tokens', fetchedAt: t, pairAddress: '', dex: 'unknown', baseMint: m(40), quoteMint: '', priceUsd: 1, priceNative: 0, liquidityUsd: 1, fdv: 1, mcap: 1, txns: {}, volume: {}, priceChange: {}, createdAt: null },
    audit: { source: 'jupiter-tokens', fetchedAt: t, mint: m(40), mintAuthority: false, freezeAuthority: false, top10Pct: 1, devPct: 1, devMints: 3, devAddress: DEV, lpLockedPct: null, rugRisks: [], rugScore: null },
  });
  rec.observe([row(T0) as never], T0);
  rec.observe([row(T0 + 1000) as never], T0 + 1000);
  const link = creatorOf(rec.database, m(40))!;
  assert.equal(link.creator, DEV);
  assert.equal(link.createdAt, T0);
});

test('queryDevHistory: counts with sample size + age, longest known label, dev-exit timing, the coin itself excluded', () => {
  const { rec } = seed();
  const now = T0 + 200 * H;
  const r = queryDevHistory(rec.database, { creator: DEV, mint: m(9), asOf: now });
  assert.equal(r.status, 'ok');
  assert.equal(r.launches.n, 5, 'five prior launches; the judged coin is not its own history');
  assert.equal(r.labelled.n, 4);
  assert.deepEqual([r.labelled.rug, r.labelled.dead, r.labelled.runner, r.labelled.flat], [2, 1, 1, 0], 'the 72 h / 24 h label wins over the 1 h one');
  assert.equal(r.rugRate, 0.5);
  assert.equal(r.badRate, 0.75);
  assert.equal(r.serialRugger, r.labelled.rug >= SERIAL_RUGGER_MIN);
  assert.equal(r.devExit.n, 2);
  assert.equal(r.devExit.within60m, 1);
  assert.equal(r.devExit.medianMin, (30 + 180) / 2);
  assert.ok(r.labelled.ageSec !== null && r.launches.ageSec !== null);
  assert.equal(r.source.includes('keyless'), true);
  assert.match(devHistoryLine(r), /^rugged 2 of 4 labelled prior launches \(\+1 dead\) · 5 recorded · labels \d+[mhd] ago$/);
});

test('queryDevHistory is point-in-time: nothing recorded or labelled after asOf counts (no leakage)', () => {
  const { rec } = seed();
  // 2 h after coin 2 launched: coins 1-2 are recorded, neither 72 h label is known yet
  const early = queryDevHistory(rec.database, { creator: DEV, asOf: T0 + 12 * H });
  assert.equal(early.launches.n, 2);
  assert.equal(early.labelled.rug, 0);
  assert.equal(early.labelled.flat, 2, 'only the 1 h labels were known then');
  // 73 h after coin 1: its rug label is known, coin 2's is not
  const mid = queryDevHistory(rec.database, { creator: DEV, asOf: T0 + 73 * H });
  assert.equal(mid.labelled.rug, 1);
});

test('no record is `unknown`, never clean; a wallet with launches but no labels says so', () => {
  const { rec } = seed();
  const none = queryDevHistory(rec.database, { creator: 'Nobody111111111111111111111111111111111111' });
  assert.equal(none.status, 'unknown');
  assert.equal(none.rugRate, null);
  assert.match(devHistoryLine(none), /^unknown: /);
  const fresh = queryDevHistory(rec.database, { creator: DEV, asOf: T0 + 1000 });
  assert.equal(fresh.labelled.n, 0);
  assert.match(devHistoryLine(fresh), /1 prior launch recorded, none labelled yet/);
});

test('an old DB without the creators table reads as unknown (never throws)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  assert.equal(queryDevHistory(db, { creator: DEV }).status, 'unknown');
  assert.equal(creatorOf(db, m(1)), null);
});
