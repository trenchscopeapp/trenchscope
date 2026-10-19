#!/usr/bin/env node
// Offline trainer for the v1 logistic rug model (AI-SUITE-DESIGN §4.3, lane M-01). Reads a recorder
// export doc (produced by `dexterm recorder export`), trains a logistic regression on a TIME-SPLIT
// (train on the earlier window, test on the later one; NEVER a random split — adjacent snapshots of one
// token are near-duplicates and a random split leaks), and writes the model JSON the app ships.
//
//   node tools/train-rug-model.mjs --in export.json --out model.json [--horizon 3600] [--test-frac 0.25]
//
// The feature transform (log1p on heavy-tailed features, mean-impute missing) MUST match the app's
// evaluator (src/rug-model.ts rugFeatureValue / evalLogistic). This script re-implements it in plain JS
// rather than importing the .ts module so it runs under node without a loader; the packs test
// `rug-model.test.ts` asserts the two agree on a fixture.
//
// This is a training SCRIPT, not an app code path: nothing here runs in the live app, no model is ever
// trained on the fly, and the output carries its honest time-split test metrics so the UI can print them.

import fs from 'node:fs';

const RUG_FEATURE_ORDER = ['liquidity_usd', 'mcap', 'age_sec', 'top_holders_pct', 'dev_pct', 'organic_score', 'holder_count', 'mint_auth_enabled', 'freeze_auth_enabled', 'has_pool', 'is_verified'];
const LOG_FEATURES = new Set(['liquidity_usd', 'mcap', 'holder_count', 'age_sec']);

const args = Object.fromEntries(process.argv.slice(2).map((a, i, xs) => (a.startsWith('--') ? [a.slice(2), xs[i + 1] && !xs[i + 1].startsWith('--') ? xs[i + 1] : true] : null)).filter(Boolean));
const inPath = String(args.in ?? '');
if (!inPath) { console.error('usage: train-rug-model.mjs --in export.json --out model.json [--horizon 3600] [--test-frac 0.25]'); process.exit(2); }
const horizon = Number(args.horizon ?? 3600);
const testFrac = Number(args['test-frac'] ?? 0.25);
const doc = JSON.parse(fs.readFileSync(inPath, 'utf8'));

function featuresFromRecord(c) {
  const numf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const bool = (v) => (v === null || v === undefined ? null : Number(v) !== 0);
  return {
    liquidity_usd: numf(c.liquidity_usd), mcap: numf(c.mcap), age_sec: numf(c.age_sec),
    top_holders_pct: numf(c.top_holders_pct), dev_pct: numf(c.dev_pct), organic_score: numf(c.organic_score), holder_count: numf(c.holder_count),
    mint_auth_enabled: bool(c.mint_auth_enabled), freeze_auth_enabled: bool(c.freeze_auth_enabled),
    has_pool: c.src_market === null || c.src_market === undefined ? null : c.src_market === 'dexscreener',
    is_verified: bool(c.is_verified),
  };
}
function rawValue(name, f) {
  const v = f[name];
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return LOG_FEATURES.has(name) ? Math.log1p(Math.max(0, n)) : n;
}

// Collect labelled rows at the horizon, sorted by t0 (time split).
const rows = [];
for (const rec of doc.records) {
  const o = rec.outcomes?.[String(horizon)];
  if (!o || o.label === 'unobserved') continue;
  rows.push({ t0: rec.t0, f: featuresFromRecord(rec.features), y: o.positive ? 1 : 0 });
}
rows.sort((a, b) => a.t0 - b.t0);
if (rows.length < 20) { console.error(`only ${rows.length} labelled rows at horizon ${horizon}s; need >= 20 to train honestly`); process.exit(1); }

const splitIdx = Math.floor(rows.length * (1 - testFrac));
const train = rows.slice(0, splitIdx);
const test = rows.slice(splitIdx);

// Standardisation stats from TRAIN only (mean-impute uses the train mean).
const F = RUG_FEATURE_ORDER;
const means = F.map((name) => { const xs = train.map((r) => rawValue(name, r.f)).filter((x) => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; });
const stds = F.map((name, i) => { const xs = train.map((r) => rawValue(name, r.f)).filter((x) => x !== null); const m = means[i]; const v = xs.length ? xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length : 1; return Math.sqrt(v) || 1; });
const z = (r) => F.map((name, i) => { const raw = rawValue(name, r.f); const x = raw === null ? means[i] : raw; return (x - means[i]) / stds[i]; });

// Logistic regression by gradient descent with L2 (standardised space).
const L2 = 1.0;
const LR = 0.1;
const EPOCHS = 2000;
let w = new Array(F.length).fill(0);
let bias = 0;
const sigmoid = (t) => 1 / (1 + Math.exp(-t));
const X = train.map(z);
const Y = train.map((r) => r.y);
for (let e = 0; e < EPOCHS; e++) {
  const gw = new Array(F.length).fill(0);
  let gb = 0;
  for (let i = 0; i < X.length; i++) {
    const p = sigmoid(bias + X[i].reduce((a, v, j) => a + w[j] * v, 0));
    const d = p - Y[i];
    gb += d;
    for (let j = 0; j < F.length; j++) gw[j] += d * X[i][j];
  }
  bias -= LR * (gb / X.length);
  for (let j = 0; j < F.length; j++) w[j] -= LR * (gw[j] / X.length + L2 * w[j] / X.length);
}

// Metrics on the TEST window.
const predict = (r) => { const t = bias + z(r).reduce((a, v, j) => a + w[j] * v, 0); return Math.min(0.98, Math.max(0.02, sigmoid(t))); };
const scoredTest = test.map((r) => ({ p: predict(r), y: r.y }));
const posP = scoredTest.filter((x) => x.y).map((x) => x.p);
const negP = scoredTest.filter((x) => !x.y).map((x) => x.p);
let wins = 0; for (const a of posP) for (const b of negP) wins += a > b ? 1 : a === b ? 0.5 : 0;
const auc = posP.length && negP.length ? wins / (posP.length * negP.length) : null;
const brier = scoredTest.length ? scoredTest.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / scoredTest.length : null;
const baseTest = scoredTest.length ? scoredTest.reduce((a, x) => a + x.y, 0) / scoredTest.length : 0;
const brierBase = scoredTest.length ? scoredTest.reduce((a, x) => a + (baseTest - x.y) ** 2, 0) / scoredTest.length : null;

const r = (x, n = 4) => (x === null ? null : Math.round(x * 10 ** n) / 10 ** n);
const model = {
  schema: 'dexterm-rug-model/1',
  id: 'rug-lr-v1',
  version: '1.0.0',
  features: F,
  means: means.map((x) => r(x, 6)),
  stds: stds.map((x) => r(x, 6)),
  weights: w.map((x) => r(x, 6)),
  bias: r(bias, 6),
  threshold: 0.5,
  trained_on: { from: new Date(train[0].t0).toISOString(), to: new Date(train[train.length - 1].t0).toISOString(), n: train.length, positives: train.filter((x) => x.y).length },
  metrics: { auc_test: r(auc, 3), brier_test: r(brier), brier_base_rate: r(brierBase), n_test: test.length },
  labeler_version: doc.labeler_version ?? 'unknown',
  positive_class: 'rug|dead',
};
const out = String(args.out ?? 'model.json');
fs.writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
console.error(`trained rug-lr-v1 on ${train.length} rows (${model.trained_on.positives} positive), tested on ${test.length}: AUC ${model.metrics.auc_test}, Brier ${model.metrics.brier_test} vs base ${model.metrics.brier_base_rate}`);
console.log(out);
