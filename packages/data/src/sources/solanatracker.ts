// Solana Tracker adapter (keyed, read-only). One request per token carries the risk fields the keyless
// sources cannot: dev holdings, snipers, insiders, bundlers, top-10 share, LP burn, a rugged flag and a
// 0..10 risk score with named risks.
//   GET https://data.solanatracker.io/tokens/{mint}   header x-api-key
//       -> { token: { creation: { creator } }, pools: [{ deployer, lpBurn, curvePercentage, liquidity: { usd },
//            security: { mintAuthority, freezeAuthority } }], holders,
//            risk: { score, rugged, top10, dev: { percentage }, snipers|insiders|bundlers: { count, totalPercentage },
//                    risks: [{ name, level, score, description } | string] } }
// The key goes in the header only (tracker-config.ts). Risk names and descriptions are third-party text:
// firewall before any model sees them (CL-06). Every field is optional: absent = null, never 0.

import type { HttpClient } from '../http.ts';
import type { Audit } from '../model.ts';

export const SOLANATRACKER_HOST = 'data.solanatracker.io';
export const SOLANATRACKER_BASE = `https://${SOLANATRACKER_HOST}`;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const META = { source: 'solanatracker', bucket: 'solanatracker' } as const;

export type TrackerRiskLevel = 'danger' | 'warning' | 'info' | 'unknown';

export interface TrackerRiskItem {
  name: string;
  level: TrackerRiskLevel;
  score: number | null;
}

export interface TrackerRisk {
  mint: string;
  /** Solana Tracker's 0..10 risk score (higher = riskier). */
  score: number | null;
  /** The provider's own verdict that the token has rugged (LP pulled / price collapsed). */
  rugged: boolean | null;
  top10Pct: number | null;
  devPct: number | null;
  sniperCount: number | null;
  sniperPct: number | null;
  insiderCount: number | null;
  insiderPct: number | null;
  bundlerCount: number | null;
  bundlerPct: number | null;
  holders: number | null;
  /** Best LP burn across pools (0..100); null when no pool reports it. Meaningless on a bonding curve. */
  lpBurnPct: number | null;
  /** true while the main pool is still a bonding curve (curvePercentage < 100). */
  onCurve: boolean | null;
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  creator: string | null;
  liquidityUsd: number | null;
  /** Most severe first. */
  risks: TrackerRiskItem[];
  source: 'solanatracker';
  fetchedAt: number;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const numOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const strOr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** A percentage the provider may send as 0..100 or (rarely) 0..1: clamp to 0..100, null when absent. */
const pct = (v: unknown): number | null => { const n = numOr(v); return n === null ? null : Math.max(0, Math.min(100, n)); };
/** An authority field: an address string = still enabled, null/'' = revoked, absent = unknown. */
const authority = (o: Rec | null, k: string): boolean | null => {
  if (!o || !(k in o)) return null;
  const v = o[k];
  return typeof v === 'string' && v !== '' ? true : v === null || v === '' || v === false ? false : null;
};

function level(v: unknown): TrackerRiskLevel {
  return v === 'danger' || v === 'warning' || v === 'info' ? v : 'unknown';
}

const LEVEL_RANK: Record<TrackerRiskLevel, number> = { danger: 0, warning: 1, info: 2, unknown: 3 };

export function normalizeTrackerToken(mint: string, raw: unknown, fetchedAt: number): TrackerRisk {
  const root = rec(raw) ?? {};
  const risk = rec(root.risk);
  const group = (k: string) => rec(risk?.[k]);
  const pools = Array.isArray(root.pools) ? root.pools.map(rec).filter((p): p is Rec => p !== null) : [];
  // The deepest pool decides liquidity and the curve state; LP burn is the best any pool reports.
  const main = pools.slice().sort((a, b) => (numOr(rec(b.liquidity)?.usd) ?? 0) - (numOr(rec(a.liquidity)?.usd) ?? 0))[0] ?? null;
  const burns = pools.map((p) => pct(p.lpBurn)).filter((n): n is number => n !== null);
  const curve = main ? numOr(main.curvePercentage) : null;
  const security = rec(main?.security);
  const risks = (Array.isArray(risk?.risks) ? risk.risks : [])
    .map((r): TrackerRiskItem | null => {
      if (typeof r === 'string') return r ? { name: r, level: 'unknown', score: null } : null;
      const o = rec(r);
      const name = strOr(o?.name);
      return name ? { name, level: level(o?.level), score: numOr(o?.score) } : null;
    })
    .filter((r): r is TrackerRiskItem => r !== null)
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (b.score ?? 0) - (a.score ?? 0));
  const token = rec(root.token);
  return {
    mint,
    score: numOr(risk?.score),
    rugged: typeof risk?.rugged === 'boolean' ? risk.rugged : null,
    top10Pct: pct(risk?.top10),
    devPct: pct(group('dev')?.percentage),
    sniperCount: numOr(group('snipers')?.count),
    sniperPct: pct(group('snipers')?.totalPercentage),
    insiderCount: numOr(group('insiders')?.count),
    insiderPct: pct(group('insiders')?.totalPercentage),
    bundlerCount: numOr(group('bundlers')?.count),
    bundlerPct: pct(group('bundlers')?.totalPercentage),
    holders: numOr(root.holders),
    lpBurnPct: burns.length ? Math.max(...burns) : null,
    onCurve: curve === null ? null : curve < 100,
    mintAuthority: authority(security, 'mintAuthority'),
    freezeAuthority: authority(security, 'freezeAuthority'),
    creator: strOr(rec(token?.creation)?.creator) ?? strOr(main?.deployer),
    liquidityUsd: numOr(rec(main?.liquidity)?.usd),
    risks,
    source: 'solanatracker',
    fetchedAt,
  };
}

/**
 * The Audit fields Solana Tracker fills. Only non-null values are returned, so merging this over another
 * source's audit never erases a value the other source had. LP burn is skipped while the token is still on
 * a bonding curve: there is no LP to burn, and "0 % burned" would read as a red flag.
 */
export function auditPatchFromTracker(t: TrackerRisk): Partial<Audit> {
  const p: Partial<Audit> = {};
  if (t.mintAuthority !== null) p.mintAuthority = t.mintAuthority;
  if (t.freezeAuthority !== null) p.freezeAuthority = t.freezeAuthority;
  if (t.top10Pct !== null) p.top10Pct = t.top10Pct;
  if (t.devPct !== null) p.devPct = t.devPct;
  if (t.creator !== null) p.devAddress = t.creator;
  if (t.lpBurnPct !== null && t.onCurve !== true) p.lpLockedPct = t.lpBurnPct;
  if (t.sniperCount !== null) p.sniperCount = t.sniperCount;
  if (t.sniperPct !== null) p.sniperPct = t.sniperPct;
  if (t.insiderCount !== null) p.insiderCount = t.insiderCount;
  if (t.insiderPct !== null) p.insiderPct = t.insiderPct;
  if (t.bundlerCount !== null) p.bundlerCount = t.bundlerCount;
  if (t.bundlerPct !== null) p.bundledPct = t.bundlerPct;
  if (t.rugged !== null) p.rugged = t.rugged;
  if (t.score !== null) p.trackerScore = t.score;
  return p;
}

export class SolanaTracker {
  private readonly http: HttpClient;
  readonly #key: string; // a true private field: never enumerable, never serialised with the data layer

  constructor(http: HttpClient, key: string) {
    this.http = http;
    this.#key = key;
  }

  async token(mint: string): Promise<TrackerRisk> {
    if (!MINT_RE.test(mint)) throw new Error('solanatracker: not a mint address');
    const r = await this.http.getJsonKeyed<unknown>(`${SOLANATRACKER_BASE}/tokens/${mint}`, { key: this.#key, host: SOLANATRACKER_HOST }, META);
    return normalizeTrackerToken(mint, r.data, r.fetchedAt);
  }
}
