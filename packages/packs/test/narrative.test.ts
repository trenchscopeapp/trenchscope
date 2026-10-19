// Tier 2 — narrative board compute (offline, deterministic, no model, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '@dexterm/recorder';
import { computeBoard, loadDefaultLexicon, summaryText, summaryPrompt, recentNarrativeRows, type NarrativeRow } from '../src/narrative.ts';

const lex = loadDefaultLexicon();
const now = 1_760_000_000_000;

function rows(): NarrativeRow[] {
  const mk = (i: number, symbol: string, name: string, over: Partial<NarrativeRow> = {}): NarrativeRow => ({
    mint: `M${i}`.padEnd(43, '1'), symbol, name, vol_h1: 50000, vol_h24: 400000, chg_h1: 10, chg_h24: 20,
    holder_count: 500, liquidity_usd: 60000, mcap: 2_000_000, age_sec: 100000, feeds: ['jup:trending:1h'], t: now - 5000, ...over,
  });
  return [
    mk(1, 'DOGE', 'Doge Classic'),
    mk(2, 'SHIB', 'Shiba friend', { vol_h1: 80000 }),
    mk(3, 'WIF', 'dogwifhat', { vol_h1: 120000, chg_h1: 40 }),
    mk(4, 'CATZ', 'cat gang', { vol_h1: 30000 }),
    mk(5, 'KITTY', 'kitty coin'),
    mk(6, 'POPCAT', 'popcat', { liquidity_usd: 2000 }),
    mk(7, 'GPT', 'ai agent swarm', { vol_h1: 90000 }),
    mk(8, 'CLAUDE', 'claude agent'),
    mk(9, 'AGENTIC', 'agentic ai'),
    mk(10, 'ZZQQ', 'nothing here', { feeds: ['jup:recent'] }),
  ];
}

test('classifies tokens into narratives with a primary and honest unclassified bucket', () => {
  const board = computeBoard(rows(), lex, { now });
  const dogs = board.narratives.find((n) => n.narrative === 'dogs');
  const cats = board.narratives.find((n) => n.narrative === 'cats');
  const ai = board.narratives.find((n) => n.narrative === 'ai-agents');
  const unc = board.narratives.find((n) => n.narrative === 'unclassified');
  assert.ok(dogs && dogs.tokens >= 3, `dogs: ${dogs?.tokens}`);
  assert.ok(cats && cats.tokens >= 2);
  assert.ok(ai && ai.tokens >= 3);
  assert.ok(unc && unc.tokens >= 1, 'ZZQQ is unclassified');
  assert.equal(board.model_output, false);
});

test('a ranked narrative has a documented score and parts; unclassified is never ranked', () => {
  const board = computeBoard(rows(), lex, { now });
  const dogs = board.narratives.find((n) => n.narrative === 'dogs');
  assert.ok(dogs?.score != null, 'dogs is ranked');
  assert.ok(dogs?.score_parts && dogs.score_parts.V != null);
  const unc = board.narratives.find((n) => n.narrative === 'unclassified');
  assert.equal(unc?.score, null);
  assert.match(unc?.not_ranked_reason ?? '', /unclassified/);
});

test('volume sums are correct per narrative', () => {
  const board = computeBoard(rows(), lex, { now });
  const dogs = board.narratives.find((n) => n.narrative === 'dogs');
  // DOGE 50k + SHIB 80k + WIF 120k = 250k
  assert.equal(dogs?.vol_h1, 250000);
});

test('deterministic summary is grounded and labelled (no model)', () => {
  const board = computeBoard(rows(), lex, { now });
  const s = summaryText(board);
  assert.ok(s.words > 30, `words ${s.words}`);
  assert.match(s.text, /names only|name[- ]based/i);
  assert.match(s.text, /no model/i);
  // Every narrative name mentioned must be a real narrative on the board.
  const names = new Set(board.narratives.map((n) => n.narrative));
  for (const w of ['dogs', 'cats', 'ai-agents']) if (s.text.includes(w)) assert.ok(names.has(w));
});

test('summaryPrompt carries board facts and wraps symbols as untrusted', () => {
  const board = computeBoard(rows(), lex, { now });
  const p = summaryPrompt(board);
  assert.match(p, /FACTS:/);
  assert.match(p, /<untrusted>/);
  assert.match(p, /check the numbers against the board/);
});

test('recentNarrativeRows reads the newest live snapshot per mint from the recorder DB', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const ins = db.prepare(`INSERT INTO token_snapshots (mint, t, kind, hash, src_market, sources, symbol, name, vol_h1, vol_h24, chg_h1, liquidity_usd, mcap, age_sec) VALUES (?, ?, 'live', ?, 'dexscreener', '[]', ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('Mint1', now - 10000, 'h1', 'DOGE', 'Doge', 10000, 90000, 5, 50000, 1_000_000, 90000);
  ins.run('Mint1', now - 1000, 'h2', 'DOGE', 'Doge', 20000, 90000, 7, 55000, 1_100_000, 90000); // newer
  ins.run('Mint2', now - 2000, 'h3', 'CAT', 'Cat', 5000, 40000, -3, 12000, 300000, 50000);
  db.prepare('INSERT OR IGNORE INTO feed_members (t, feed, rank, mint) VALUES (?, ?, ?, ?)').run(now - 2000, 'jup:trending:1h', 0, 'Mint1');
  const nr = recentNarrativeRows(db, { now });
  assert.equal(nr.length, 2);
  const m1 = nr.find((r) => r.mint === 'Mint1');
  assert.equal(m1?.vol_h1, 20000, 'newest snapshot wins');
  assert.ok(m1?.feeds?.includes('jup:trending:1h'));
  const board = computeBoard(nr, lex, { now });
  assert.ok(board.narratives.find((n) => n.narrative === 'dogs'));
  db.close();
});
