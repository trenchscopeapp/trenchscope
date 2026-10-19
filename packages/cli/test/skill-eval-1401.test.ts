// task-1401: building the skill eval set from a recorder DB (point-in-time link evidence only, no URLs/names
// written, a fixed time split) and the `trenchscope backtest --subject skills` command. Offline, temp DBs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL } from '@dexterm/recorder';
import { buildSkillEvalSet } from '../src/skill-eval-build.ts';
import { backtestCommand } from '../src/backtest-cmd.ts';

const H = 259_200;
const T = 1_790_000_000_000;
const HOUR = 3_600_000;

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA_SQL);
  d.exec('CREATE TABLE cache (ns TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, fetched_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL, source TEXT, PRIMARY KEY (ns, key)) WITHOUT ROWID');
  return d;
}
function coin(d: DatabaseSync, mint: string, t0: number, label: string, fetchedAt: number, socials: { web?: string | null; x?: string | null; tg?: string | null }, extra: Record<string, unknown> = {}): void {
  d.prepare('INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, evidence, labeler_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(mint, t0, H, t0 + H * 1000, label, 'keyless-proxy', '{}', '0.2.0');
  d.prepare(`INSERT INTO token_snapshots (mint, t, kind, hash, is_t0, symbol, name, launchpad, created_at, price_usd, liquidity_usd, dev_pct, organic_score, top_holders_pct, mint_auth_enabled, freeze_auth_enabled, src_market, sources)
    VALUES (?, ?, 'live', 'h', 1, 'SYM', 'Some Name', 'pump.fun', ?, ?, ?, ?, ?, ?, 0, 0, 'dexscreener', '[]')`).run(mint, t0, t0 - HOUR, 0.001, (extra.liq as number) ?? 20_000, 1, 60, 20);
  d.prepare('INSERT INTO cache (ns, key, json, fetched_at, ttl_ms, source) VALUES (?, ?, ?, ?, ?, ?)').run('ds:token', mint, JSON.stringify({ token: { mint, symbol: 'SYM', name: 'Some Name', socials: { web: null, x: null, tg: null, ...socials } } }), fetchedAt, 60_000, 'dexscreener');
}

test('buildSkillEvalSet: point-in-time link records only, late records excluded (anti-leak), no URL/name written, time split', () => {
  const d = db();
  for (let i = 0; i < 10; i++) coin(d, `IN${i}`, T + i * HOUR, i % 2 ? 'dead' : 'flat', T + i * HOUR + 600_000, { web: 'https://sym.example', x: 'https://x.com/sym', tg: null });
  coin(d, 'LATE', T, 'runner', T + 50 * HOUR, { web: 'https://late.example' }); // fetched 50 h after t0 → would leak
  coin(d, 'BEFORE', T, 'flat', T - HOUR, { web: 'https://early.example' });    // fetched before t0 → not point in time
  const set = buildSkillEvalSet(d, { horizonSec: H, maxLagSec: 3600, testFrac: 0.3, now: T });
  assert.equal(set.counts.rows, 10);
  assert.equal(set.counts.excluded.no_point_in_time_link_record, 2);
  assert.ok(!set.rows.some((r) => r.mint === 'LATE' || r.mint === 'BEFORE'));
  assert.equal(set.counts.test, 3); assert.equal(set.counts.train, 7);
  for (const r of set.rows) assert.equal(r.split, r.t0 >= set.cutoff_t0 ? 'test' : 'train');
  const r0 = set.rows[0];
  assert.deepEqual(r0.link, { web: 'own-domain', x: 'profile', tg: false, webMatchesToken: true, cheapTld: false });
  assert.equal(r0.link_lag_sec, 600);
  assert.equal(r0.rug.liquidity_usd, 20_000);
  assert.equal(r0.rug.age_sec, 3600);
  const json = JSON.stringify(set);
  assert.doesNotMatch(json, /https?:|example|Some Name|"SYM"/, 'no URL, name or symbol leaves the DB');
});

test('trenchscope backtest --build-eval then --subject skills [--tune] [--json]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1401-'));
  try {
    const path = join(dir, 'h.db');
    const d = new DatabaseSync(path);
    d.exec(SCHEMA_SQL);
    d.exec('CREATE TABLE cache (ns TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, fetched_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL, source TEXT, PRIMARY KEY (ns, key)) WITHOUT ROWID');
    for (let i = 0; i < 40; i++) {
      const bad = i % 3 === 0;
      coin(d, `C${i}`, T + i * HOUR, bad ? 'rug' : 'flat', T + i * HOUR + 1000, bad ? { x: 'https://x.com/a/status/1' } : { web: 'https://sym.example', x: 'https://x.com/sym', tg: 'https://t.me/sym' }, { liq: bad ? 1_000 : 30_000 });
    }
    d.close();
    const out: string[] = []; const err: string[] = [];
    const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: {} };
    const evalPath = join(dir, 'eval.json');
    assert.equal(backtestCommand(['--build-eval', evalPath, '--db', path], io), 0, err.join(''));
    assert.match(out.join(''), /eval set: 40 rows/);
    out.length = 0;
    assert.equal(backtestCommand(['--subject', 'skills', '--eval', evalPath, '--tune'], io), 0, err.join(''));
    const text = out.join('');
    assert.match(text, /SKILL BACKTEST/); assert.match(text, /larp-check · links-only baseline/); assert.match(text, /rug-check · verdict rules/);
    assert.match(text, /TEST /); assert.match(text, /not measured:/);
    out.length = 0;
    const reportPath = join(dir, 'report.json');
    assert.equal(backtestCommand(['--subject', 'skills', '--eval', evalPath, '--json', '--report', reportPath], io), 0);
    const j = JSON.parse(out.join(''));
    assert.equal(j.schema, 'dexterm/packs/skill-backtest/1');
    assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), j);
    assert.equal(backtestCommand(['--subject', 'skills', '--eval', join(dir, 'missing.json')], io), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
