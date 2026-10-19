// Tier 1 — token-dossier REASON stage: offline, a FAKE claude runner, verifying the tighten-only /
// flags-kept / grounding checks and the "model stage hidden on failure" rule. No `claude` binary spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleTokenDossier } from '../src/token-dossier.ts';
import { reasonTokenDossier, type ReasonRunner } from '../src/reason.ts';
import { TOKEN_DOSSIER_SCHEMA } from '../src/schema.ts';

const fx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

/** A fake runner that returns a crafted claude -p `--output-format json` payload. */
function fakeRunner(structured: Record<string, unknown> | null, extra: Record<string, unknown> = {}): ReasonRunner {
  return async () => ({ stdout: JSON.stringify({ structured_output: structured, total_cost_usd: 0.0041, duration_api_ms: 12000, num_turns: 1, ...extra }), exitCode: 0 });
}

const goodTokenVerdict = (verdict: string, flags: string[], facts: Array<Record<string, unknown>> = []) => ({
  pack: 'token-dossier', pack_version: '0.1.0', mint: 'x', verdict, confidence: 0.6, rug_probability: 0.3,
  summary: 'test', facts, flags, invalidation: 'liq drops below 50k', proposals: [], injection_detected: false, missing_data: [], sources_used: [],
});

test('a valid tighten (WATCH -> SPECULATIVE) passes checks and the model stage is shown and labelled', async () => {
  const d = assembleTokenDossier(fx('dossier-clean.json'));
  const facts = [{ claim: 'liquidity', tool: 'market', field: 'pair.liquidityUsd', value: 180000 }];
  const r = await reasonTokenDossier(d, TOKEN_DOSSIER_SCHEMA, { runner: fakeRunner(goodTokenVerdict('SPECULATIVE', [], facts)) });
  assert.equal(r.checks.ok, true, r.checks.failure ?? '');
  assert.equal(r.checks.tightenOnly, true);
  assert.equal(r.checks.flagsKept, true);
  assert.equal(r.checks.grounded, 1);
  assert.ok(r.output, 'output shown when checks pass');
  assert.equal(r.model_output, true);
  assert.equal(r.cost?.usd, 0.0041);
  assert.ok(r.sources_used.length >= 5, 'data ages echoed for the footer');
  assert.ok(r.sources_used.some((s) => s.source === 'dexscreener'));
});

test('a loosen (AVOID -> WATCH) fails tighten-only and the model stage is hidden', async () => {
  const d = assembleTokenDossier(fx('dossier-rug.json'));
  const r = await reasonTokenDossier(d, TOKEN_DOSSIER_SCHEMA, { runner: fakeRunner(goodTokenVerdict('WATCH', d.flags)) });
  assert.equal(r.checks.tightenOnly, false);
  assert.equal(r.checks.ok, false);
  assert.equal(r.output, null, 'a loosening model stage must be hidden');
  assert.match(r.checks.failure ?? '', /loosened AVOID->WATCH/);
});

test('dropping a deterministic flag fails flags-kept', async () => {
  const d = assembleTokenDossier(fx('dossier-rug.json'));
  const r = await reasonTokenDossier(d, TOKEN_DOSSIER_SCHEMA, { runner: fakeRunner(goodTokenVerdict('AVOID', ['organic_below_40'])) });
  assert.equal(r.checks.flagsKept, false);
  assert.equal(r.checks.ok, false);
});

test('an ungrounded fact (value not in the dossier) is caught', async () => {
  const d = assembleTokenDossier(fx('dossier-clean.json'));
  const facts = [{ claim: 'fabricated', tool: 'market', field: 'pair.liquidityUsd', value: 999999999 }];
  const r = await reasonTokenDossier(d, TOKEN_DOSSIER_SCHEMA, { runner: fakeRunner(goodTokenVerdict('WATCH', [], facts)) });
  assert.equal(r.checks.grounded, 0);
  assert.equal(r.checks.ok, false);
  assert.ok(r.checks.ungrounded.length === 1);
});

test('a missing claude CLI (exit 127) is reported, not thrown, and nothing is shown', async () => {
  const d = assembleTokenDossier(fx('dossier-clean.json'));
  const runner: ReasonRunner = async () => ({ stdout: '', exitCode: 127, stderr: 'not found' });
  const r = await reasonTokenDossier(d, TOKEN_DOSSIER_SCHEMA, { runner });
  assert.equal(r.checks.ok, false);
  assert.equal(r.output, null);
  assert.match(r.checks.failure ?? '', /claude CLI unavailable/);
});
