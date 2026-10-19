// RugCheck adapter (SPEC §3.1 S5). Keyless, read-only, summary endpoint only
// (the full report may need a JWT; we never send one).
//   GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary
//       -> { tokenProgram, tokenType, risks: [{ name, value, description, score, level }],
//            score, score_normalised, lpLockedPct }
// Limits are undocumented (community: ~20 full reports/day/IP); the bucket is a
// conservative guess and results are cached 10 min (TTL.rugcheck).
// `name`/`description`/`value` are third-party text: firewall before any model sees them (CL-06).

import type { HttpClient } from '../http.ts';
import type { Audit } from '../model.ts';
import { num, numOrNull } from '../util.ts';

export const RUGCHECK_BASE = 'https://api.rugcheck.xyz/v1';
const META = { source: 'rugcheck', bucket: 'rugcheck' } as const;

export type RugLevel = 'danger' | 'warn' | 'info' | 'unknown';

export interface RugRisk {
  name: string;
  level: RugLevel;
  score: number;
  value: string | null;
  description: string | null;
}

export interface RugSummary {
  mint: string;
  /** Raw risk score (higher = riskier, unbounded). */
  score: number | null;
  /** RugCheck's 0..100 normalisation of `score`. */
  scoreNormalised: number | null;
  lpLockedPct: number | null;
  tokenProgram: string | null;
  tokenType: string | null;
  /** Most severe first. */
  risks: RugRisk[];
  source: 'rugcheck';
  fetchedAt: number;
}

interface RawSummary {
  tokenProgram?: string;
  tokenType?: string;
  risks?: { name?: string; value?: string; description?: string; score?: number; level?: string }[] | null;
  score?: number;
  score_normalised?: number;
  lpLockedPct?: number;
}

const LEVEL_RANK: Record<RugLevel, number> = { danger: 0, warn: 1, info: 2, unknown: 3 };

function level(v: unknown): RugLevel {
  return v === 'danger' || v === 'warn' || v === 'info' ? v : 'unknown';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function normalizeRugSummary(mint: string, raw: RawSummary, fetchedAt: number): RugSummary {
  const risks = (raw.risks ?? [])
    .filter((r) => typeof r?.name === 'string' && r.name !== '')
    .map((r): RugRisk => ({ name: r.name!, level: level(r.level), score: num(r.score), value: str(r.value), description: str(r.description) }))
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.score - a.score);
  return {
    mint,
    score: numOrNull(raw.score),
    scoreNormalised: numOrNull(raw.score_normalised),
    lpLockedPct: numOrNull(raw.lpLockedPct),
    tokenProgram: str(raw.tokenProgram),
    tokenType: str(raw.tokenType),
    risks,
    source: 'rugcheck',
    fetchedAt,
  };
}

/** The Audit fields RugCheck owns (SPEC §3.3/§3.6): LP locked, risk names, score. */
export function auditPatchFromRug(s: RugSummary): Pick<Audit, 'lpLockedPct' | 'rugRisks' | 'rugScore'> {
  return { lpLockedPct: s.lpLockedPct, rugRisks: s.risks.map((r) => r.name), rugScore: s.scoreNormalised ?? s.score };
}

/** `/v1/stats/new_tokens` row (inventory 2026-10-06 §1d): creator + authorities per fresh mint. */
export interface RawNewToken {
  mint?: string;
  decimals?: number;
  symbol?: string;
  creator?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  program?: string;
  createAt?: string;
  updatedAt?: string;
  events?: unknown[];
}

export interface RugNewToken {
  mint: string;
  symbol: string;
  creator: string | null;
  /** true = authority still set (address present), false = null/absent in the row. */
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  program: string | null;
  decimals: number | null;
  createdAt: number | null;
  source: 'rugcheck';
  fetchedAt: number;
}

export function normalizeNewToken(raw: RawNewToken, fetchedAt: number): RugNewToken | null {
  if (!raw || typeof raw.mint !== 'string' || !raw.mint) return null;
  const auth = (v: unknown): boolean | null => (v === undefined ? null : typeof v === 'string' && v !== '' ? true : false);
  const created = typeof raw.createAt === 'string' ? Date.parse(raw.createAt) : NaN;
  return {
    mint: raw.mint,
    symbol: typeof raw.symbol === 'string' ? raw.symbol : '',
    creator: str(raw.creator),
    mintAuthority: auth(raw.mintAuthority),
    freezeAuthority: auth(raw.freezeAuthority),
    program: str(raw.program),
    decimals: numOrNull(raw.decimals),
    createdAt: Number.isFinite(created) ? created : null,
    source: 'rugcheck',
    fetchedAt,
  };
}

export class RugCheck {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async summary(mint: string): Promise<RugSummary> {
    const r = await this.http.getJson<RawSummary>(`${RUGCHECK_BASE}/tokens/${encodeURIComponent(mint)}/report/summary`, META);
    return normalizeRugSummary(mint, r.data ?? {}, r.fetchedAt);
  }

  /** Newest mints RugCheck has indexed (≈10 rows, 103 ms measured): creator and authority cross-check for new pairs. */
  async newTokens(): Promise<RugNewToken[]> {
    const r = await this.http.getJson<RawNewToken[] | { tokens?: RawNewToken[] }>(`${RUGCHECK_BASE}/stats/new_tokens`, META);
    const list = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.tokens) ? r.data.tokens : [];
    return list.map((t) => normalizeNewToken(t, r.fetchedAt)).filter((t): t is RugNewToken => t !== null);
  }
}
