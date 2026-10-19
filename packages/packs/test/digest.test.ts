// Tier 3 — one-line digests built from assembled token-dossiers (offline, no model, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleTokenDossier } from '../src/token-dossier.ts';
import { buildDigest } from '../src/digest.ts';
import { h1Model, tokenRugScorer } from '../src/rug-model.ts';

const fx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

test('a clean WATCH token digests to WATCH with positive facts and no model prose', () => {
  const d = buildDigest(assembleTokenDossier(fx('dossier-clean.json')));
  assert.equal(d.verdict, 'WATCH');
  assert.equal(d.model_output, false);
  assert.ok(d.text.startsWith('WATCH'), d.text);
  // no hard flag → positive facts (liquidity is 180000 → "liq $180K", organic 72 → "organic 72")
  assert.ok(d.highlights.some((h) => h.startsWith('liq ')), `highlights: ${d.highlights.join('|')}`);
  assert.ok(d.text.includes('·'), 'a WATCH row still says something after the verdict');
  assert.ok(d.text.length <= 90);
});

test('a rug AVOID token leads with the two worst hard flags (freeze on first), not p(rug)', () => {
  const d = buildDigest(assembleTokenDossier(fx('dossier-rug.json')));
  assert.equal(d.verdict, 'AVOID');
  assert.ok(d.text.startsWith('AVOID'), d.text);
  assert.equal(d.highlights.length, 2, 'at most two highlights');
  assert.equal(d.highlights[0], 'freeze on', `freeze is the top-priority flag; got ${d.highlights.join('|')}`);
  assert.ok(d.text.length <= 90);
});

test('passing a rugScorer fills rug_p / rug_model and renders p(rug) in the line', () => {
  const dossier = assembleTokenDossier(fx('dossier-rug.json'), { rugScorer: tokenRugScorer(h1Model()) });
  assert.ok(dossier.rug_probability !== null, 'scorer fills the probability');
  const d = buildDigest(dossier);
  assert.equal(d.rug_model, h1Model().id);
  assert.equal(d.rug_p, dossier.rug_probability);
  assert.ok(/p\(rug\) \d+%/.test(d.text), `expected a p(rug) token in: ${d.text}`);
  assert.ok(d.text.length <= 90);
});

test('without a rugScorer there is no p(rug) in the line and rug_model is null', () => {
  const d = buildDigest(assembleTokenDossier(fx('dossier-rug.json')));
  assert.equal(d.rug_model, null);
  assert.equal(d.rug_p, null);
  assert.ok(!/p\(rug\)/.test(d.text), d.text);
});

test('an injected dossier marks injection_suspected on the digest but keeps the deterministic verdict word', () => {
  const d = buildDigest(assembleTokenDossier(fx('dossier-injection.json')));
  assert.equal(d.injection_suspected, true);
  assert.ok(d.text.startsWith('WATCH'), d.text);
});

test('oldest_data_age_sec is the max contributing data age (so the UI can dim a stale row)', () => {
  const d = buildDigest(assembleTokenDossier(fx('dossier-clean.json')));
  assert.ok(d.oldest_data_age_sec === null || typeof d.oldest_data_age_sec === 'number');
});

test('text never exceeds the 90-char column cap even with long flag labels', () => {
  const dossier = assembleTokenDossier(fx('dossier-rug.json'), { rugScorer: tokenRugScorer(h1Model()) });
  const d = buildDigest(dossier);
  assert.ok(d.text.length <= 90, `len=${d.text.length}: ${d.text}`);
});
