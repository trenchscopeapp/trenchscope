// Rug-probability model (AI-SUITE-DESIGN §4.3, lane M-01). Features in, p(rug) out, evaluated in-app at
// zero model cost. Two implementations behind one `RugScorer` seam (the token-dossier pack already reads
// a `RugScorer`, token-dossier.ts):
//
//   v0 = H1   the hand-written heuristic, PRE-REGISTERED before the first outcome sweep
//             (research/task-1287/recorder/H1-preregistration.txt, sha256 of backtest.mjs). Reproduced
//             here byte for byte so the number on screen on day one is the one that was backtested.
//   v1 = LR   a logistic regression over the same features, trained OFFLINE by a script on a time-split
//             of recorder history, shipped as JSON weights {means, stds, weights, bias, ...} and
//             evaluated here in microseconds. Never trained on the fly.
//
// A canonical `RugFeatures` vector is the single feature contract both the live dossier (TokenFeatures)
// and the recorder export (t0 snapshot columns) adapt to, so the backtest scores EXACTLY what the UI
// shows. Every feature is a t0 datum (the row the user would have seen); the leakage rule is the
// backtest harness's to enforce (backtest.ts), not this module's.
//
// Honest-reporting rule (ROADMAP / §4.3): the model stage of a pack may READ this probability as a
// feature and may never override it downward; the UI prints the model id and, for v1, its training date
// and test metrics. All of that is carried on the `RugScorer` (`id`, `trained_on`, `metrics`).

/** The canonical t0 feature vector the rug model scores. Null = datum unavailable at t0. */
export interface RugFeatures {
  liquidity_usd: number | null;
  mcap: number | null;
  age_sec: number | null;
  top_holders_pct: number | null;
  dev_pct: number | null;
  organic_score: number | null;
  holder_count: number | null;
  mint_auth_enabled: boolean | null;
  freeze_auth_enabled: boolean | null;
  /** True when the token had a DexScreener market pair at t0 (vs a bonding-curve-only Jupiter row). */
  has_pool: boolean | null;
  is_verified: boolean | null;
  // ---- H2 extras (optional: absent = unknown). Not part of RUG_FEATURE_ORDER, so v1 weights are unaffected.
  chg_h1?: number | null;
  chg_h6?: number | null;
  chg_h24?: number | null;
  /** Prior launches by the same creator. */
  dev_mints?: number | null;
  /** true = graduated to a real pool (PumpSwap/AMM), false = still on a bonding curve. */
  graduated?: boolean | null;
  /** Token-2022 extensions that let an authority take or freeze funds (permanent delegate, transfer hook, pausable, default-frozen). */
  risky_ext?: boolean | null;
  /** A transfer fee whose authority can still change it. */
  transfer_fee_live?: boolean | null;
  bundled_pct?: number | null;
  sniper_pct?: number | null;
  insider_pct?: number | null;
  /** A keyed provider's own "has rugged" verdict. */
  rugged?: boolean | null;
}

/** The feature order the v1 weight vector is indexed by. Appending is a new model version, not an edit. */
export const RUG_FEATURE_ORDER = [
  'liquidity_usd', 'mcap', 'age_sec', 'top_holders_pct', 'dev_pct', 'organic_score', 'holder_count',
  'mint_auth_enabled', 'freeze_auth_enabled', 'has_pool', 'is_verified',
] as const satisfies readonly (keyof RugFeatures)[];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const b2n = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

/**
 * Adapt the live token-dossier `TokenFeatures` (token-dossier.ts) to the canonical vector. `has_pool` is
 * inferred from a positive liquidity (a DexScreener market row); the dossier does not carry src_market.
 */
export function rugFeaturesFromToken(f: {
  liquidity_usd: number | null; mcap: number | null; age_sec: number | null;
  top10_pct: number | null; dev_pct: number | null; organic_score: number | null; holder_count: number | null;
  mint_authority: boolean | null; freeze_authority: boolean | null;
}): RugFeatures {
  return {
    liquidity_usd: f.liquidity_usd, mcap: f.mcap, age_sec: f.age_sec,
    top_holders_pct: f.top10_pct, dev_pct: f.dev_pct, organic_score: f.organic_score, holder_count: f.holder_count,
    mint_auth_enabled: f.mint_authority, freeze_auth_enabled: f.freeze_authority,
    has_pool: f.liquidity_usd === null ? null : f.liquidity_usd > 0,
    is_verified: null,
  };
}

/**
 * Adapt a recorder export record's `features` block (token_snapshots columns, export.ts) to the canonical
 * vector. This is the backtest / training path; it reads the exact t0 columns.
 */
export function rugFeaturesFromRecord(c: Record<string, string | number | null>): RugFeatures {
  const bool = (v: string | number | null): boolean | null => (v === null ? null : Number(v) !== 0);
  return {
    liquidity_usd: num(c.liquidity_usd), mcap: num(c.mcap), age_sec: num(c.age_sec),
    top_holders_pct: num(c.top_holders_pct), dev_pct: num(c.dev_pct), organic_score: num(c.organic_score),
    holder_count: num(c.holder_count),
    mint_auth_enabled: bool(c.mint_auth_enabled), freeze_auth_enabled: bool(c.freeze_auth_enabled),
    has_pool: c.src_market === null ? null : c.src_market === 'dexscreener',
    is_verified: bool(c.is_verified),
    chg_h1: num(c.chg_h1), chg_h6: num(c.chg_h6), chg_h24: num(c.chg_h24), dev_mints: num(c.dev_mints),
    graduated: c.dex === 'pumpswap' ? true : c.dex === 'pumpfun' ? false : c.dex ? true : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// v0: H1 (pre-registered). Reproduces research/task-1287/recorder/backtest.mjs `h1()` exactly.
// ---------------------------------------------------------------------------------------------------

export const H1_VERSION = 'H1-v0.1';
export const H1_FLAG_THRESHOLD = 0.5;

/** Additive-points heuristic. Pure; identical points/order to the pre-registered prototype. */
export function h1Score(f: RugFeatures): number {
  let p = 0.15; // base
  const liq = f.liquidity_usd ?? 0;
  const mcap = f.mcap ?? 0;
  const age = f.age_sec ?? 0;
  if (f.freeze_auth_enabled === true) p += 0.35;
  if (f.mint_auth_enabled === true) p += 0.25;
  if ((f.top_holders_pct ?? 0) >= 30) p += 0.15;
  if ((f.dev_pct ?? 0) >= 10) p += 0.15;
  if (f.organic_score !== null && f.organic_score < 10) p += 0.10;
  if (liq < 5000) p += 0.20; // no real pool (bonding curve or drained)
  if (age < 3600) p += 0.10; // fresh launches mostly die
  if (mcap > 0 && liq > 0 && liq / mcap < 0.03) p += 0.10; // thin liquidity vs cap
  if ((f.holder_count ?? 0) >= 1000 && liq >= 50000) p -= 0.25; // established
  if (age >= 7 * 86400 && liq >= 100000) p -= 0.20;
  return Math.min(0.98, Math.max(0.02, p));
}

// ---------------------------------------------------------------------------------------------------
// v1: logistic regression over standardised features, shipped as JSON weights. Trained offline by
// tools/train-rug-model.mjs; evaluated here. The feature transform must match the trainer exactly, so it
// lives here and the trainer imports it.
// ---------------------------------------------------------------------------------------------------

export interface LogisticRugModel {
  schema: 'dexterm-rug-model/1';
  id: string; // e.g. "rug-lr-v1"
  version: string;
  /** Feature names in weight order; must be a prefix-compatible subset of RUG_FEATURE_ORDER. */
  features: string[];
  /** Standardisation stats, same order as `features`. */
  means: number[];
  stds: number[];
  /** Weights (standardised space) + bias; p = sigmoid(bias + Σ w_i z_i). */
  weights: number[];
  bias: number;
  /** Flag threshold chosen on the training window (not the test window). */
  threshold: number;
  trained_on: { from: string; to: string; n: number; positives: number };
  /** Honest test-window metrics (time-split; never random split). */
  metrics: { auc_test: number | null; brier_test: number | null; brier_base_rate: number | null; n_test: number };
  labeler_version: string;
  positive_class: string; // "rug|dead"
}

/**
 * Transform a RugFeatures vector to the numeric feature array the model consumes, in the model's feature
 * order. Missing numerics become the feature's training mean (so a missing datum is "average", i.e. adds
 * nothing after standardisation); booleans missing become 0. `age_sec`, `liquidity_usd`, `mcap`,
 * `holder_count` are log1p-compressed BEFORE standardisation (heavy right tails), which the trainer mirrors.
 */
const LOG_FEATURES = new Set(['liquidity_usd', 'mcap', 'holder_count', 'age_sec']);

export function rugFeatureValue(name: string, f: RugFeatures): number | null {
  const raw = (f as unknown as Record<string, number | boolean | null | undefined>)[name];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return LOG_FEATURES.has(name) ? Math.log1p(Math.max(0, v)) : v;
}

/** Evaluate a logistic model. Missing numeric features fall back to the model's mean (z = 0 contribution). */
export function evalLogistic(model: LogisticRugModel, f: RugFeatures): number {
  let z = model.bias;
  for (let i = 0; i < model.features.length; i++) {
    const name = model.features[i];
    const std = model.stds[i] || 1;
    const raw = rugFeatureValue(name, f);
    const x = raw === null ? model.means[i] : raw; // missing → mean → standardised 0
    z += model.weights[i] * ((x - model.means[i]) / std);
  }
  const p = 1 / (1 + Math.exp(-z));
  return Math.min(0.98, Math.max(0.02, p));
}

// ---------------------------------------------------------------------------------------------------
// H2 (2026-10-18, trenchscope). H1's points plus the signals a ground-truth audit showed H1 missing:
// price collapse, liquidity flowing back into a dead pool, serial-launcher devs, Token-2022 extensions
// that let an authority take funds, and keyed holder forensics. A missing datum earns no points except
// top-10, where "unknown" costs a little because it is the most common way a coin hides concentration.
// Hard floors: a rugged verdict, risky extensions and a live freeze authority. NOT yet backtested: the
// recorder needs days of labelled outcomes; compare with `trenchscope backtest --model h1|h2`.
// ---------------------------------------------------------------------------------------------------

export const H2_VERSION = 'H2-v0.1';
export const H2_FLAG_THRESHOLD = 0.5;

export function h2Score(f: RugFeatures): number {
  let p = 0.10;
  const liq = f.liquidity_usd, mcap = f.mcap, age = f.age_sec;
  if (f.mint_auth_enabled === true) p += 0.25;
  if (f.transfer_fee_live === true) p += 0.25;
  // price collapse
  if (f.chg_h24 != null && f.chg_h24 <= -70) p += 0.25;
  if (f.chg_h6 != null && f.chg_h6 <= -50) p += 0.15;
  if (f.chg_h1 != null && f.chg_h1 <= -40) p += 0.10;
  // liquidity
  if (liq != null && liq < 5000) p += 0.20;
  if (liq != null && mcap != null && mcap > 0 && liq > 0) {
    if (liq / mcap < 0.03) p += 0.10; // thin vs cap
    if (f.graduated === true && liq / mcap >= 0.6) p += 0.15; // the cap drained back into the pool
  }
  // the dev
  if (f.dev_mints != null) p += f.dev_mints >= 100 ? 0.20 : f.dev_mints >= 10 ? 0.10 : 0;
  if (f.dev_pct != null && f.dev_pct >= 10) p += 0.15;
  // holders
  if (f.top_holders_pct == null) p += 0.05;
  else if (f.top_holders_pct >= 30) p += 0.15;
  if (f.bundled_pct != null && f.bundled_pct >= 25) p += 0.15;
  if (f.sniper_pct != null && f.sniper_pct >= 20) p += 0.10;
  if (f.insider_pct != null && f.insider_pct >= 20) p += 0.10;
  if (f.organic_score != null && f.organic_score < 10) p += 0.10;
  if (age != null && age < 3600) p += 0.10;
  // established
  if ((f.holder_count ?? 0) >= 1000 && (liq ?? 0) >= 50000) p -= 0.25;
  if (age != null && age >= 7 * 86400 && (liq ?? 0) >= 100000) p -= 0.20;
  p = Math.min(0.98, Math.max(0.02, p));
  if (f.rugged === true) p = Math.max(p, 0.95);
  if (f.risky_ext === true) p = Math.max(p, 0.85);
  if (f.freeze_auth_enabled === true) p = Math.max(p, 0.70);
  return p;
}

// ---------------------------------------------------------------------------------------------------
// RugScorer construction (the seam token-dossier.ts and the digest read).
// ---------------------------------------------------------------------------------------------------

/** A scorer that reads the canonical RugFeatures, plus provenance the UI prints. */
export interface RugModel {
  id: string;
  kind: 'heuristic' | 'logistic';
  score(f: RugFeatures): number;
  threshold: number;
  trained_on?: LogisticRugModel['trained_on'];
  metrics?: LogisticRugModel['metrics'];
}

/** H2: H1 plus collapse, dead-pool, serial-dev, Token-2022 and keyed-forensics signals. The screener default. */
export function h2Model(): RugModel {
  return { id: H2_VERSION, kind: 'heuristic', score: h2Score, threshold: H2_FLAG_THRESHOLD };
}

/** The v0 model: the pre-registered H1 heuristic. Always available (no training data needed). */
export function h1Model(): RugModel {
  return { id: H1_VERSION, kind: 'heuristic', score: h1Score, threshold: H1_FLAG_THRESHOLD };
}

/** A v1 model from shipped JSON weights. */
export function logisticModel(m: LogisticRugModel): RugModel {
  return {
    id: m.id, kind: 'logistic', score: (f) => evalLogistic(m, f), threshold: m.threshold,
    trained_on: m.trained_on, metrics: m.metrics,
  };
}

/**
 * Wrap a RugModel as the token-dossier's `RugScorer` (which scores the dossier's TokenFeatures). This is
 * how the live screener / Analyst panel gets p(rug) at zero model cost.
 */
export function tokenRugScorer(model: RugModel): {
  id: string;
  score(f: Parameters<typeof rugFeaturesFromToken>[0]): number;
  model: RugModel;
} {
  return { id: model.id, score: (f) => model.score(rugFeaturesFromToken(f)), model };
}

export { b2n as rugBoolToNum };
