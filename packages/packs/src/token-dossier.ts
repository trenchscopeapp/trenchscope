// token-dossier pack, ASSEMBLE stage (AI-SUITE-DESIGN §2, ported from research/task-1287/packs/token-dossier).
//
// Pure, deterministic, zero tokens: it reads the `get_dossier` object the MCP server already assembles
// (packages/mcp/src/dossier.ts `buildDossier`) and computes the numbers, the named rule flags, the
// deterministic verdict, the data ages and a cache key. This is what the UI chips, the batch scorer, the
// rug model and the backtest read; the optional REASON stage (reason.ts) runs one tool-less model call
// over this object and may only TIGHTEN the verdict.
//
// Thresholds are the task-1293 skill rules (owner: maintainers); the model stage may add flags, never remove.

import { createHash } from 'node:crypto';
import { scanForInjection } from './firewall.ts';

export const TOKEN_DOSSIER_PACK = 'token-dossier';
export const TOKEN_DOSSIER_VERSION = '0.1.0';

export type Verdict = 'WATCH' | 'SPECULATIVE' | 'AVOID' | 'INSUFFICIENT_DATA' | 'AMBIGUOUS';

/** The 40 deterministic numbers every downstream consumer reads. Null when the datum is unavailable. */
export interface TokenFeatures {
  age_sec: number | null;
  launchpad: string | null;
  price_usd: number | null; mcap: number | null; liquidity_usd: number | null;
  liq_to_mcap_pct: number | null;
  vol_h1: number | null; vol_h24: number | null; vol_h1_to_liq: number | null;
  buys_h1: number | null; sells_h1: number | null; buy_share_h1_pct: number | null;
  chg_h1_pct: number | null; chg_h24_pct: number | null;
  holder_count: number | null; holders_24h_delta: number | null;
  organic_score: number | null; num_traders_h1: number | null; net_buyers_h1: number | null;
  mint_authority: boolean | null; freeze_authority: boolean | null;
  top10_pct: number | null; top10_ex_lp_pct: number | null; dev_pct: number | null; dev_mints: number | null;
  lp_locked_pct: number | null; rug_score: number | null; rug_risk_count: number | null;
  tape_top2_share_pct: number | null; tape_buy_usd: number | null; tape_sell_usd: number | null; tape_distinct_wallets: number | null;
  drawdown_from_high_pct: number | null; chg_window_pct: number | null;
  creator_launches: number | null; creator_rugged: number | null; snipers: number | null; bundled_pct: number | null;
}

export interface DataAge { source: string | null; age_sec: number | null }

export interface AssembledTokenDossier {
  pack: typeof TOKEN_DOSSIER_PACK;
  pack_version: string;
  status: 'OK' | 'NOT_FOUND' | 'AMBIGUOUS' | 'ERROR';
  mint: string;
  symbol: string | null;
  assembled_at: string;
  input_hash: string;
  availability: { hasPrice: boolean; hasLiquidity: boolean; canVerdict: boolean; present: string[]; missing: string[]; knownUnavailable: string[] };
  features: TokenFeatures;
  flags: string[];
  deterministic_verdict: Verdict;
  /** A numeric p(rug) in [0,1], filled by the rug model (Tier 4); null until a scorer is passed. */
  rug_probability: number | null;
  rug_model: string | null;
  injection_suspected: boolean;
  data_ages: Record<string, DataAge>;
  /** The firewalled sections the model stage reads as data (the get_dossier object). */
  sections: Record<string, unknown>;
  error?: string;
}

type Rec = Record<string, unknown>;
const isObj = (r: unknown): r is Rec => !!r && typeof r === 'object';
const hasError = (r: unknown): boolean => isObj(r) && 'error' in r && !!(r as Rec).error;
const present = (r: unknown): r is Rec => isObj(r) && !hasError(r);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const boolOrNull = (x: unknown): boolean | null => (x === true || x === false ? x : null);
const pct = (a: number | null, b: number | null): number | null => (a === null || b === null || !b ? null : Math.round((a / b) * 1000) / 10);
const path = (r: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), r);

/** A scorer the rug model (Tier 4) can inject so the assembled dossier carries p(rug) at zero model cost. */
export interface RugScorer { id: string; score(f: TokenFeatures): number }

/**
 * Assemble a token-dossier from a `get_dossier` object (buildDossier output). `now` defaults to the
 * dossier's `now`. Pass a `rugScorer` to fill `rug_probability` (the deterministic rug model).
 */
export function assembleTokenDossier(dossier: Rec, opts: { now?: number; rugScorer?: RugScorer } = {}): AssembledTokenDossier {
  const now = opts.now ?? num(dossier.now) ?? Date.now();
  const market = dossier.market; // get_token: { token, pair, stats, audit, now }
  const concentration = dossier.concentration;
  const security = dossier.security;
  const candles = dossier.candles;
  const tape = dossier.tape;
  const creator = dossier.creator;

  const mint = String(dossier.mint ?? path(market, 'token', 'mint') ?? '');
  const tokenObj = path(market, 'token');
  const pair = path(market, 'pair');
  const stats = path(market, 'stats');
  const audit = path(market, 'audit');

  if (!present(market) || !present(tokenObj)) {
    return errDossier(mint, 'market section unavailable', dossier, now);
  }

  const createdAt = num(path(tokenObj, 'createdAt')) ?? num(path(pair, 'createdAt'));
  const ageSec = createdAt ? Math.max(0, Math.round((now - createdAt) / 1000)) : num(path(tokenObj, 'ageSec'));
  const h1 = path(stats, 'perWindow', 'h1');
  const buysH1 = num(path(pair, 'txns', 'h1', 'buys'));
  const sellsH1 = num(path(pair, 'txns', 'h1', 'sells'));
  const volH1 = num(path(pair, 'volume', 'h1'));
  const liq = num(path(pair, 'liquidityUsd'));
  const mcap = num(path(pair, 'mcapResolved')) ?? num(path(pair, 'mcap'));

  const f: TokenFeatures = {
    age_sec: ageSec,
    launchpad: (path(tokenObj, 'launchpad') as string) ?? null,
    price_usd: num(path(pair, 'priceUsd')), mcap, liquidity_usd: liq,
    liq_to_mcap_pct: pct(liq, mcap),
    vol_h1: volH1, vol_h24: num(path(pair, 'volume', 'h24')),
    vol_h1_to_liq: volH1 !== null && liq ? Math.round((volH1 / liq) * 100) / 100 : null,
    buys_h1: buysH1, sells_h1: sellsH1,
    buy_share_h1_pct: pct(buysH1, (buysH1 ?? 0) + (sellsH1 ?? 0)),
    chg_h1_pct: num(path(pair, 'priceChange', 'h1')), chg_h24_pct: num(path(pair, 'priceChange', 'h24')),
    holder_count: num(path(stats, 'holderCount')), holders_24h_delta: num(path(stats, 'holders24hDelta')),
    organic_score: num(path(stats, 'organicScore')),
    num_traders_h1: num(path(h1, 'numTraders')), net_buyers_h1: num(path(h1, 'numNetBuyers')),
    mint_authority: boolOrNull(path(audit, 'mintAuthority')), freeze_authority: boolOrNull(path(audit, 'freezeAuthority')),
    top10_pct: num(path(audit, 'top10Pct')), top10_ex_lp_pct: num(path(concentration, 'top10PctExLp')),
    dev_pct: num(path(audit, 'devPct')), dev_mints: num(path(audit, 'devMints')),
    lp_locked_pct: num(path(audit, 'lpLockedPct')) ?? num(path(security, 'lpLockedPct')),
    rug_score: num(path(security, 'scoreNormalised')) ?? num(path(audit, 'rugScore')),
    rug_risk_count: Array.isArray(path(security, 'risks')) ? (path(security, 'risks') as unknown[]).length : null,
    tape_top2_share_pct: num(path(tape, 'top2WalletVolumeSharePct')),
    tape_buy_usd: num(path(tape, 'buyUsd')), tape_sell_usd: num(path(tape, 'sellUsd')),
    tape_distinct_wallets: num(path(tape, 'distinctWallets')),
    drawdown_from_high_pct: num(path(candles, 'summary', 'drawdownFromHighPct')),
    chg_window_pct: num(path(candles, 'summary', 'changePct')),
    creator_launches: num(path(creator, 'devHistory', 'launches')),
    creator_rugged: num(path(creator, 'devHistory', 'rugged')),
    snipers: num(path(creator, 'snipers')), bundled_pct: num(path(creator, 'bundledPct')),
  };

  const tier1 = present(creator) && path(creator, 'tier') === 'tier1';
  const flags = computeFlags(f);
  const disqualifier = flags.some((x) => DISQUALIFIERS.has(x));
  const hasPrice = (f.price_usd ?? 0) > 0;
  const hasLiquidity = (f.liquidity_usd ?? 0) > 0;
  const deterministic_verdict: Verdict = !(hasPrice || hasLiquidity)
    ? 'INSUFFICIENT_DATA'
    : disqualifier ? 'AVOID'
    : flags.some((x) => SOFT_FLAGS.has(x)) ? 'SPECULATIVE'
    : (f.age_sec !== null && f.age_sec < 600 && !tier1 ? 'INSUFFICIENT_DATA' : 'WATCH');

  const avail = (isObj(dossier.availability) ? dossier.availability : {}) as Rec;
  const sections = { market, concentration, security, candles, tape, creator };
  const inputHash = createHash('sha256').update(stableStringify(sections)).digest('hex').slice(0, 16);

  const rug = opts.rugScorer ? Math.round(opts.rugScorer.score(f) * 1000) / 1000 : null;

  return {
    pack: TOKEN_DOSSIER_PACK, pack_version: TOKEN_DOSSIER_VERSION, status: 'OK', mint,
    symbol: (path(tokenObj, 'symbol') as string) ?? null,
    assembled_at: new Date(now).toISOString(), input_hash: inputHash,
    availability: {
      hasPrice, hasLiquidity, canVerdict: hasPrice || hasLiquidity,
      present: (avail.present as string[]) ?? [], missing: (avail.missing as string[]) ?? [],
      knownUnavailable: (avail.knownUnavailable as string[]) ?? [],
    },
    features: f, flags, deterministic_verdict,
    rug_probability: rug, rug_model: opts.rugScorer?.id ?? null,
    injection_suspected: scanForInjection(sections),
    data_ages: dataAges(sections),
    sections,
  };
}

/** The named rule flags (AI-SUITE-DESIGN §2; thresholds are the task-1293 skill rules, owner: maintainers). */
const DISQUALIFIERS = new Set(['freeze_authority_enabled', 'mint_authority_enabled', 'lp_unlocked_and_concentrated', 'wash_tape']);
const SOFT_FLAGS = new Set(['bundled_over_15pct', 'dev_holds_over_10pct', 'serial_rugger', 'organic_below_40']);

export function computeFlags(f: TokenFeatures): string[] {
  const flags: string[] = [];
  if (f.freeze_authority === true) flags.push('freeze_authority_enabled');
  if (f.mint_authority === true) flags.push('mint_authority_enabled');
  if (f.lp_locked_pct !== null && f.lp_locked_pct < 100 && f.launchpad !== 'pump.fun' && (f.top10_ex_lp_pct ?? 0) > 50) flags.push('lp_unlocked_and_concentrated');
  if (f.tape_top2_share_pct !== null && f.tape_top2_share_pct > 60 && f.tape_buy_usd && f.tape_sell_usd && Math.abs(f.tape_buy_usd - f.tape_sell_usd) / Math.max(f.tape_buy_usd, f.tape_sell_usd) < 0.15) flags.push('wash_tape');
  if ((f.bundled_pct ?? 0) > 15) flags.push('bundled_over_15pct');
  if ((f.dev_pct ?? 0) > 10) flags.push('dev_holds_over_10pct');
  if ((f.creator_rugged ?? 0) >= 2) flags.push('serial_rugger');
  if (f.organic_score !== null && f.organic_score < 40) flags.push('organic_below_40');
  if (f.age_sec !== null && f.age_sec < 600) flags.push('under_10_minutes');
  return flags;
}

/** Data age per section: look for an `ageSec`/`source` at the section root or on its `pair`. */
function dataAges(sections: Record<string, unknown>): Record<string, DataAge> {
  const out: Record<string, DataAge> = {};
  for (const [k, v] of Object.entries(sections)) {
    const root = isObj(v) ? v : undefined;
    const pr = isObj(path(v, 'pair')) ? (path(v, 'pair') as Rec) : undefined;
    out[k] = {
      source: (root?.source as string) ?? (pr?.source as string) ?? null,
      age_sec: num(root?.ageSec) ?? num(pr?.ageSec),
    };
  }
  return out;
}

function errDossier(mint: string, error: string, dossier: Rec, now: number): AssembledTokenDossier {
  return {
    pack: TOKEN_DOSSIER_PACK, pack_version: TOKEN_DOSSIER_VERSION, status: 'ERROR', mint, symbol: null,
    assembled_at: new Date(now).toISOString(), input_hash: '',
    availability: { hasPrice: false, hasLiquidity: false, canVerdict: false, present: [], missing: [error], knownUnavailable: [] },
    features: emptyFeatures(), flags: [], deterministic_verdict: 'INSUFFICIENT_DATA',
    rug_probability: null, rug_model: null, injection_suspected: false, data_ages: {},
    sections: { market: dossier.market ?? null }, error,
  };
}

function emptyFeatures(): TokenFeatures {
  return {
    age_sec: null, launchpad: null, price_usd: null, mcap: null, liquidity_usd: null, liq_to_mcap_pct: null,
    vol_h1: null, vol_h24: null, vol_h1_to_liq: null, buys_h1: null, sells_h1: null, buy_share_h1_pct: null,
    chg_h1_pct: null, chg_h24_pct: null, holder_count: null, holders_24h_delta: null, organic_score: null,
    num_traders_h1: null, net_buyers_h1: null, mint_authority: null, freeze_authority: null, top10_pct: null,
    top10_ex_lp_pct: null, dev_pct: null, dev_mints: null, lp_locked_pct: null, rug_score: null, rug_risk_count: null,
    tape_top2_share_pct: null, tape_buy_usd: null, tape_sell_usd: null, tape_distinct_wallets: null,
    drawdown_from_high_pct: null, chg_window_pct: null, creator_launches: null, creator_rugged: null, snipers: null, bundled_pct: null,
  };
}

/** Deterministic JSON for the input hash: object keys sorted so the cache key is stable across runs. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Rec)[k])}`).join(',')}}`;
}
