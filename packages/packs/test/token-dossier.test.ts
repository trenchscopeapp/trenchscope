// Tier 1 — token-dossier ASSEMBLE stage over get_dossier fixtures (offline, no model, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleTokenDossier } from '../src/token-dossier.ts';

const fx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

test('clean token assembles to WATCH with no disqualifier flags and correct features', () => {
  const d = assembleTokenDossier(fx('dossier-clean.json'));
  assert.equal(d.status, 'OK');
  assert.equal(d.deterministic_verdict, 'WATCH');
  assert.deepEqual(d.flags, []);
  assert.equal(d.injection_suspected, false);
  assert.equal(d.features.liquidity_usd, 180000);
  assert.equal(d.features.mcap, 4200000);
  assert.equal(d.features.organic_score, 72);
  assert.equal(d.features.freeze_authority, false);
  assert.ok(d.features.age_sec !== null && d.features.age_sec > 600);
  assert.ok(d.input_hash.length === 16);
  assert.equal(d.data_ages.market?.source, 'dexscreener');
  assert.equal(d.data_ages.market?.age_sec, 3);
});

test('rug token assembles to AVOID with every deterministic flag', () => {
  const d = assembleTokenDossier(fx('dossier-rug.json'));
  assert.equal(d.deterministic_verdict, 'AVOID');
  for (const flag of ['freeze_authority_enabled', 'lp_unlocked_and_concentrated', 'bundled_over_15pct', 'dev_holds_over_10pct', 'serial_rugger', 'organic_below_40']) {
    assert.ok(d.flags.includes(flag), `missing ${flag}: ${d.flags.join(',')}`);
  }
  assert.equal(d.features.bundled_pct, 22);
  assert.equal(d.features.creator_rugged, 3);
});

test('injected instruction inside an <untrusted> risk block is detected, verdict stays deterministic', () => {
  const d = assembleTokenDossier(fx('dossier-injection.json'));
  assert.equal(d.injection_suspected, true, 'injection must be flagged');
  assert.equal(d.deterministic_verdict, 'WATCH', 'the injection must not change the deterministic verdict');
});

test('assemble is a pure function of its input (same hash twice)', () => {
  const a = assembleTokenDossier(fx('dossier-clean.json'));
  const b = assembleTokenDossier(fx('dossier-clean.json'));
  assert.equal(a.input_hash, b.input_hash);
});

test('a token with no price and no liquidity is INSUFFICIENT_DATA', () => {
  const base = fx('dossier-clean.json') as Record<string, Record<string, Record<string, unknown>>>;
  (base.market.pair as Record<string, unknown>).priceUsd = 0;
  (base.market.pair as Record<string, unknown>).liquidityUsd = 0;
  const d = assembleTokenDossier(base);
  assert.equal(d.deterministic_verdict, 'INSUFFICIENT_DATA');
  assert.equal(d.availability.canVerdict, false);
});
