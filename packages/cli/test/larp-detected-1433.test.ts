import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExportRecord } from '@dexterm/recorder';
import { decodePng } from '@dexterm/data';
import { buildFollowUpDataset, renderHistoryDrafts, cardCanvas, historyDraft, LARP_DETECTED_HELP } from '../src/larp-detected.ts';

const NOW = Date.UTC(2026, 9, 16, 12);
const H = 259_200;
const mint = (ch: string) => ch.repeat(32);
const record = (id: string, label: 'dead' | 'flat', t0 = NOW - 5 * 86_400_000): ExportRecord => ({
  mint: mint(id), t0, known_sec: 0, feeds: ['trending'],
  features: {
    liquidity_usd: 1000, mcap: 100_000, age_sec: 300, top_holders_pct: 45, dev_pct: 12,
    organic_score: 2, holder_count: 20, mint_auth_enabled: 1, freeze_auth_enabled: 1,
    src_market: 'dexscreener', is_verified: 0,
  },
  outcomes: { [`${H}`]: { label, tier: 'keyless-proxy', t1: t0 + H * 1000, mcap_ratio: label === 'dead' ? 0.1 : 1, liq_ratio: label === 'dead' ? 0 : 1, price_ratio: label === 'dead' ? 0.1 : 1, max_mcap_ratio: 1, positive: label === 'dead' } },
});

test('dataset uses one point-in-time flag per mint and computes the same-dataset non-collapse count', () => {
  const a = record('A', 'dead'), duplicate = record('A', 'flat', NOW - 4 * 86_400_000), b = record('B', 'flat');
  const d = buildFollowUpDataset([a, duplicate, b]);
  assert.equal(d.flagged.length, 2);
  assert.equal(d.collapsed.length, 1);
  assert.equal(d.didNotCollapse, 1);
  assert.equal(d.collapsed[0].model, 'H1-v0.1');
});

test('thin sample writes no drafts and does not create the output directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'larp-thin-')), out = join(root, 'missing');
  try {
    const d = buildFollowUpDataset([record('C', 'dead')]);
    assert.deepEqual(renderHistoryDrafts(d, { outDir: out, minSample: 2, now: NOW }), { drafts: [], cards: [] });
    assert.equal(existsSync(out), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('eligible history writes private review drafts and PNG cards with timestamps, age, source and honest miss count', () => {
  const root = mkdtempSync(join(tmpdir(), 'larp-cards-'));
  try {
    const d = buildFollowUpDataset([record('D', 'dead'), record('E', 'flat')]);
    const saved = renderHistoryDrafts(d, { outDir: root, minSample: 2, limit: 1, now: NOW });
    assert.equal(saved.drafts.length, 1); assert.equal(saved.cards.length, 1);
    const text = readFileSync(saved.drafts[0], 'utf8');
    assert.match(text, /graded HIGH RISK 98\/100 at 2026-10-11T12:00Z/);
    assert.match(text, /Same-dataset follow-up: 1\/2 met the condition \(50\.0%\); 1\/2 did not/);
    assert.match(text, /Evidence: local trenchscope recorder; DexScreener \+ Jupiter; t0 data age 5d/);
    assert.match(text, /coin DDDD\.\.\.DDDD/);
    assert.doesNotMatch(text, new RegExp(mint('D')));
    assert.ok(decodePng(readFileSync(saved.cards[0])).w > 0);
    assert.equal(readdirSync(root).filter((f) => f.endsWith('.md')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('the cards, drafts and help say HIGH RISK from the rug heuristic, never "LARP DETECTED" (larp-fixes)', () => {
  const d = buildFollowUpDataset([record('F', 'dead'), record('G', 'flat')]);
  const row = d.collapsed[0];
  const card = cardCanvas(row, d, NOW).toPlain();
  const draft = historyDraft(row, d, NOW);
  for (const text of [card, draft]) {
    assert.doesNotMatch(text, /LARP DETECTED/i);
    assert.match(text, /HIGH RISK/);
  }
  assert.match(draft, /^HIGH RISK: recorded follow-up \(rug heuristic, not a LARP check\)/);
  assert.match(LARP_DETECTED_HELP, /not a LARP verdict/);
});
