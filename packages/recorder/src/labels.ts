// Outcome labeler (lane R-01): a port of dexterm/research/task-1287/recorder/labels.mjs. Deterministic,
// code only, never a model (CLAUDE-LAYER §7 circularity rule). Rules: research/task-1287/recorder/labels.md
// (v0.1) plus the two v0.2 additions BACKTEST.md §3/§4 proposed after the t1 sweep:
//   D2 curve-dead  a bonding-curve launch whose t1 shows liquidity <= $100 and vol_h1 < $100 is `dead`
//                  regardless of market source and mcap ratio (a never-traded curve keeps its mcap pinned
//                  at the floor, so no ratio rule can see it);
//   source rule    t0 without a pair (market source = Jupiter) and t1 with a DexScreener pair is no
//                  longer `unobserved`: ratios are computed across sources but the evidence says so
//                  (`cross_source: true`). Non-curve tokens keep the strict same-source rule.
// `version: '0.1'` reproduces the prototype byte for byte (the test replays its 178 labels).

export const LABELER_VERSION = '0.2.0';
export type LabelerRules = '0.1' | '0.2';

export type Label = 'rug' | 'dead' | 'fade' | 'flat' | 'runner' | 'unobserved';
export type LabelTier = 'keyless-proxy' | 'chain-verified';

/** The subset of a token_snapshots row the labeler reads. */
export interface Observation {
  mint: string;
  t: number;
  mcap: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  vol_h1: number | null;
  pair_address: string | null;
  src_market: string | null;
  launchpad?: string | null;
}

export interface OutcomeRow {
  mint: string;
  t0: number;
  horizon_sec: number;
  t1: number | null;
  label: Label;
  label_tier: LabelTier;
  mcap_ratio: number | null;
  liq_ratio: number | null;
  price_ratio: number | null;
  max_mcap_ratio: number | null;
  evidence: string;
  labeler_version: string;
}

export const HORIZONS = [3600, 7200, 21600, 86400, 259200] as const;

/**
 * Launchpads (the data layer's normalised `Launchpad`) whose tokens start on a bonding curve with no
 * pool until migration: pump.fun, bonk (letsbonk), Meteora DBC, and Raydium LaunchLab (`raydium`).
 */
export const CURVE_LAUNCHPADS = new Set(['pump.fun', 'bonk', 'dbc', 'raydium']);

/** Thresholds (labels.md). */
export const RULES = {
  rugMinLiqT0: 5000,
  rugLiqRatio: 0.10,
  rugPriceRatio: 0.50,
  deadMcapRatio: 0.20,
  deadVolH1: 500,
  fadeMcapRatio: 0.50,
  runnerRatio: 2.0,
  curveDeadLiq: 100,
  curveDeadVolH1: 100,
} as const;

export interface LabelOptions {
  /** Rule set; default the current one. */
  rules?: LabelerRules;
  /**
   * Prototype mode only: the single t1 sweep yields one row per t0 whose horizon is the nearest bucket at or
   * below the actual Δt; Δt below `minDtSec` is `unobserved`. The app labels per fixed horizon instead (see
   * `labelAtHorizon`).
   */
  minDtSec?: number;
  /** Chain-verified events between t0 and t1 (R-02); empty today. */
  chainEvents?: readonly { kind: string; amount?: number | null }[];
}

const ratio = (a: number | null, b: number | null): number | null => (a === null || b === null || !b ? null : a / b);

/**
 * Label one (t0, observations) pair. `obs` are the observations after t0 for the same mint, ascending
 * by t; the LAST one is t1 (the caller picks the window). Returns null for an empty `obs`.
 * This is the prototype's `label()` with the horizon bucketed from Δt (for the replay test); the app
 * calls `labelAtHorizon` which fixes the horizon and passes the right window.
 */
export function label(t0: Observation, obs: readonly Observation[], opts: LabelOptions = {}): OutcomeRow | null {
  if (!obs.length) return null;
  const t1 = obs[obs.length - 1];
  const dt = Math.round((t1.t - t0.t) / 1000);
  const horizon = [...HORIZONS].reverse().find((h) => dt >= h) ?? null;
  const minDt = opts.minDtSec ?? 3000;
  if (horizon === null || dt < minDt) return classify(t0, obs, 0, opts, 'below-min-horizon');
  return classify(t0, obs, horizon, opts);
}

const isJup = (s: string | null | undefined): boolean => !!s && s.startsWith('jupiter');

/**
 * Label a t0 row at a fixed horizon: `obs` = observations in (t0, t1] with t1 the first observation at or
 * after t0 + horizon (the caller enforces the ≤ 2x window). An empty `obs` means the window closed with
 * nothing seen → `unobserved` with t1 = null.
 */
export function labelAtHorizon(t0: Observation, obs: readonly Observation[], horizonSec: number, opts: LabelOptions = {}): OutcomeRow {
  if (!obs.length) return outcome(t0, null, horizonSec, 'unobserved', null, null, null, null, { reason: 'no-observation-in-window' }, opts);
  return classify(t0, obs, horizonSec, opts);
}

function classify(t0: Observation, obs: readonly Observation[], horizon: number, opts: LabelOptions, forceUnobserved?: string): OutcomeRow {
  const rules: LabelerRules = opts.rules ?? '0.2';
  const t1 = obs[obs.length - 1];
  const dt = Math.round((t1.t - t0.t) / 1000);
  const vanished = t0.pair_address !== null && t1.pair_address === null;
  const r_mcap = vanished ? 0 : ratio(t1.mcap, t0.mcap);
  const r_liq = vanished ? 0 : ratio(t1.liquidity_usd, t0.liquidity_usd);
  const r_price = vanished ? 0 : ratio(t1.price_usd, t0.price_usd);
  const max_r = Math.max(...obs.map((o) => ratio(o.mcap, t0.mcap) ?? 0), r_mcap ?? 0);
  const ev: Record<string, unknown> = {
    dt_sec: dt, r_mcap, r_liq, r_price, max_mcap_ratio: max_r, vanished,
    t0: { mcap: t0.mcap, liq: t0.liquidity_usd, price: t0.price_usd, vol_h1: t0.vol_h1, src: t0.src_market },
    t1: { mcap: t1.mcap, liq: t1.liquidity_usd, price: t1.price_usd, vol_h1: t1.vol_h1, src: t1.src_market },
  };
  const curve = CURVE_LAUNCHPADS.has(t0.launchpad ?? '');
  const sourceMismatch = t0.src_market !== t1.src_market && !vanished;
  let lab: Label;
  let tier: LabelTier = 'keyless-proxy';
  const chain = chainVerified(opts.chainEvents);
  if (forceUnobserved) {
    lab = 'unobserved'; ev.reason = forceUnobserved;
  } else if (chain) {
    lab = chain.label; tier = 'chain-verified'; ev.rule = chain.rule;
  } else if (rules === '0.2' && curve && (t1.liquidity_usd ?? 0) <= RULES.curveDeadLiq && (t1.vol_h1 ?? 0) < RULES.curveDeadVolH1 && t1.src_market !== null && t1.src_market !== 'none') {
    // D2 (v0.2): a bonding-curve launch with no pool and no trades at t1 is dead, whatever the ratios say.
    lab = 'dead'; ev.rule = 'D2 curve-dead: liq<=100 & vol_h1<100';
    if (sourceMismatch) ev.cross_source = true;
  } else if (sourceMismatch && !(rules === '0.2' && curve && isJup(t0.src_market) && t1.src_market === 'dexscreener')) {
    lab = 'unobserved'; ev.reason = 'source-mismatch';
  } else if (t0.mcap === null || t0.mcap === 0) {
    lab = 'unobserved'; ev.reason = 'no-mcap-at-t0';
  } else {
    if (sourceMismatch) ev.cross_source = true;
    if ((t0.liquidity_usd ?? 0) >= RULES.rugMinLiqT0 && r_liq !== null && r_liq <= RULES.rugLiqRatio && r_price !== null && r_price <= RULES.rugPriceRatio) { lab = 'rug'; ev.rule = 'R1 liq<=10% & price<=50%'; }
    else if (r_mcap !== null && r_mcap <= RULES.deadMcapRatio && (t1.vol_h1 ?? 0) < RULES.deadVolH1) { lab = 'dead'; ev.rule = 'D1 mcap<=20% & vol_h1<500'; }
    else if (r_mcap !== null && r_mcap <= RULES.fadeMcapRatio) { lab = 'fade'; ev.rule = 'F1 mcap<=50%'; }
    else if (max_r >= RULES.runnerRatio) { lab = 'runner'; ev.rule = 'U1 max mcap>=2x'; }
    else lab = 'flat';
  }
  return outcome(t0, t1, horizon, lab, r_mcap, r_liq, r_price, max_r, ev, opts, tier);
}

/** Tier-1 override (labels.md): LP withdraw / freeze / dev sell ≥ 20 % between t0 and t1 is a chain-verified rug. */
function chainVerified(events: LabelOptions['chainEvents']): { label: Label; rule: string } | null {
  if (!events || !events.length) return null;
  for (const e of events) {
    if (e.kind === 'lp_withdraw') return { label: 'rug', rule: 'C1 lp_withdraw' };
    if (e.kind === 'freeze') return { label: 'rug', rule: 'C2 freeze' };
    if (e.kind === 'dev_sell' && (e.amount ?? 0) >= 20) return { label: 'rug', rule: 'C3 dev_sell>=20%' };
  }
  return null;
}

function outcome(t0: Observation, t1: Observation | null, horizon: number, lab: Label, r_mcap: number | null, r_liq: number | null, r_price: number | null, max_r: number | null, ev: Record<string, unknown>, opts: LabelOptions, tier: LabelTier = 'keyless-proxy'): OutcomeRow {
  const rules = opts.rules ?? '0.2';
  return {
    mint: t0.mint, t0: t0.t, horizon_sec: horizon, t1: t1 ? t1.t : null, label: lab, label_tier: tier,
    mcap_ratio: r_mcap, liq_ratio: r_liq, price_ratio: r_price, max_mcap_ratio: max_r,
    evidence: JSON.stringify(ev), labeler_version: rules === '0.1' ? '0.1.0' : LABELER_VERSION,
  };
}

/** Positive class for the rug model on keyless data (labels.md): rug ∪ dead. */
export function isPositive(l: Label, tier: LabelTier = 'keyless-proxy'): boolean {
  return l === 'rug' || (tier === 'keyless-proxy' && l === 'dead');
}
