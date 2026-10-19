// task-1356: `trenchscope backtest` CLI over a recorder DB. Builds a tiny real recorder DB (schema + two
// labelled t0 snapshots) on a temp file, runs the command end to end, and asserts honest metrics come
// out. Also covers the empty/missing-history paths and the pure renderer. Offline; no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL } from '@dexterm/recorder';
import { backtestCommand, renderBacktestText } from '../src/backtest-cmd.ts';
import type { BacktestResult } from '@dexterm/packs';

function io() {
  let out = '';
  let errOut = '';
  return {
    stdout: { write: (s: string) => { out += s; return true; } },
    stderr: { write: (s: string) => { errOut += s; return true; } },
    env: {} as NodeJS.ProcessEnv,
    get out() { return out; },
    get err() { return errOut; },
  };
}

function withDb(fn: (path: string, db: DatabaseSync) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-bt-'));
  const path = join(dir, 'history.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA_SQL);
    fn(path, db);
  } finally {
    db.close();
  }
  return dir;
}

let snapId = 0;
function insertT0(db: DatabaseSync, o: { mint: string; t0: number; liq: number; mcap: number; age: number; src: string; holders: number; freeze?: number; organic?: number }) {
  db.prepare(
    `INSERT INTO token_snapshots (mint, t, kind, hash, is_t0, src_market, liquidity_usd, mcap, age_sec, holder_count, freeze_auth_enabled, organic_score, sources)
     VALUES (?, ?, 'sweep', ?, 1, ?, ?, ?, ?, ?, ?, ?, '[]')`,
  ).run(o.mint, o.t0, `h${snapId++}`, o.src, o.liq, o.mcap, o.age, o.holders, o.freeze ?? 0, o.organic ?? null);
  db.prepare('INSERT INTO mints (mint, first_t, last_live_t, last_any_t, last_t0_t, last_hash, snapshots) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(o.mint, o.t0, o.t0, o.t0, o.t0, `h${snapId}`);
}
function insertOutcome(db: DatabaseSync, mint: string, t0: number, label: string, mcapRatio: number) {
  db.prepare(
    `INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, mcap_ratio, liq_ratio, price_ratio, max_mcap_ratio, evidence, labeler_version)
     VALUES (?, ?, 3600, ?, ?, 'keyless-proxy', ?, 1, 1, ?, '{}', '0.2.0')`,
  ).run(mint, t0, t0 + 3_600_000, label, mcapRatio, mcapRatio);
}

test('--help prints usage and returns 0', () => {
  const o = io();
  assert.equal(backtestCommand(['--help'], o), 0);
  assert.ok(o.out.includes('trenchscope backtest'));
});

test('a missing DB table returns 2 with a clear message', () => {
  const dir = withDb((_path, db) => { db.exec('DROP TABLE token_snapshots'); });
  const o = io();
  o.env.DEXTERM_DB_PATH = join(dir, 'history.db');
  assert.equal(backtestCommand([], o), 2);
  assert.ok(o.err.includes('no recorded history'));
  rmSync(dir, { recursive: true, force: true });
});

test('an empty (no labelled outcomes) DB returns 0 and says so, never fabricates metrics', () => {
  const dir = withDb(() => { /* schema only */ });
  const o = io();
  o.env.DEXTERM_DB_PATH = join(dir, 'history.db');
  assert.equal(backtestCommand([], o), 0);
  assert.ok(o.out.includes('no outcome-labelled snapshots yet'));
  assert.ok(!/precision/.test(o.out));
  rmSync(dir, { recursive: true, force: true });
});

test('heuristic subject over two labelled rows prints honest metrics and a leakage line', () => {
  const dir = withDb((_path, db) => {
    insertT0(db, { mint: 'Mrug1111111111111111111111111111111111111111', t0: 1_700_000_000_000, liq: 500, mcap: 20000, age: 120, src: 'jupiter-tokens', holders: 10, freeze: 1, organic: 3 });
    insertOutcome(db, 'Mrug1111111111111111111111111111111111111111', 1_700_000_000_000, 'rug', 0.1);
    insertT0(db, { mint: 'Mok22222222222222222222222222222222222222222', t0: 1_700_000_100_000, liq: 300000, mcap: 10_000_000, age: 30 * 86400, src: 'dexscreener', holders: 8000, freeze: 0, organic: 85 });
    insertOutcome(db, 'Mok22222222222222222222222222222222222222222', 1_700_000_100_000, 'flat', 1.0);
  });
  const o = io();
  o.env.DEXTERM_DB_PATH = join(dir, 'history.db');
  assert.equal(backtestCommand(['--subject', 'heuristic', '--model', 'h1', '--horizon', '3600'], o), 0);
  assert.ok(o.out.includes('subject=H1-v0.1'), o.out);
  assert.ok(o.out.includes('n=2'), o.out);
  assert.ok(/precision=100%/.test(o.out), o.out);
  assert.ok(/recall=100%/.test(o.out), o.out);
  assert.ok(o.out.includes('leakage:'), o.out);
  rmSync(dir, { recursive: true, force: true });
});

test('--json emits a parseable result with the labeler version', () => {
  const dir = withDb((_path, db) => {
    insertT0(db, { mint: 'Mrug1111111111111111111111111111111111111111', t0: 1_700_000_000_000, liq: 500, mcap: 20000, age: 120, src: 'jupiter-tokens', holders: 10, freeze: 1, organic: 3 });
    insertOutcome(db, 'Mrug1111111111111111111111111111111111111111', 1_700_000_000_000, 'rug', 0.1);
    insertT0(db, { mint: 'Mok22222222222222222222222222222222222222222', t0: 1_700_000_100_000, liq: 300000, mcap: 10_000_000, age: 30 * 86400, src: 'dexscreener', holders: 8000, organic: 85 });
    insertOutcome(db, 'Mok22222222222222222222222222222222222222222', 1_700_000_100_000, 'flat', 1.0);
  });
  const o = io();
  assert.equal(backtestCommand(['--json', '--model', 'h1', '--db', join(dir, 'history.db')], o), 0);
  const parsed = JSON.parse(o.out);
  assert.equal(parsed.subject, 'H1-v0.1');
  assert.equal(parsed.n, 2);
  assert.equal(parsed.labeler_version, '0.2.0');
  rmSync(dir, { recursive: true, force: true });
});

test('renderBacktestText shows a not-enough-data note without a metrics table', () => {
  const r: BacktestResult = {
    n: 0, base_rate: 0, precision: null, recall: null, brier: null, brier_base_rate: null, auc: null,
    generated_at: '2026-10-11T00:00:00Z', data_tier: 'keyless-proxy',
    leakage_checks: { features_from_t0_only: true, labels_after_t0: true, no_future_feeds: true },
    note: 'nothing yet',
  };
  const txt = renderBacktestText('H1-v0.1', 3600, '0.2.0', r);
  assert.ok(txt.includes('nothing yet'));
  assert.ok(!txt.includes('precision='));
});
