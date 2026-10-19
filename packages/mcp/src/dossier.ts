// task-1314: pre-assembled token dossier. The `get_dossier` tool fetches every per-token section in
// ONE parallel pass and hands the model a single object, so a dossier that used to take ~6 sequential
// model↔tool round trips needs one. buildDossier is pure (the tool does the I/O) and computes an
// explicit data-availability block so the skill can ground a partial verdict instead of defaulting to
// INSUFFICIENT_DATA: price and/or liquidity existing is the whole bar for producing a verdict.

type Rec = Record<string, unknown>;

/** A section result is "present" when it is an object without an `error` field. */
function present(r: unknown): r is Rec {
  return !!r && typeof r === 'object' && !(('error' in (r as Rec)) && (r as Rec).error);
}
function numOf(r: Rec | undefined, path: string): number | null {
  if (!r) return null;
  const v = r[path];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function errText(r: unknown, fallback: string): string {
  const e = r && typeof r === 'object' ? (r as Rec).error : null;
  return typeof e === 'string' && e ? e : fallback;
}

export interface DossierInput {
  mint: string;
  interval: string;
  now?: number;
  /** Each field is the raw result of the matching read-only tool (may carry an `error`). */
  token: unknown;
  holders: unknown;
  rugcheck: unknown;
  trades: unknown;
  candles: unknown;
  devHistory: unknown;
}

export interface DossierAvailability {
  hasPrice: boolean;
  hasLiquidity: boolean;
  /** The one gate for a verdict: a token with price or liquidity can always be judged. */
  canVerdict: boolean;
  present: string[];
  missing: string[];
  /** Structurally unavailable on the keyless tier — a known limitation, never a reason to refuse. */
  knownUnavailable: string[];
  note: string;
}

/**
 * Assemble the six per-token sections into one dossier with an availability summary. Pure: callers fetch
 * the sections (in parallel) and pass them here.
 */
export function buildDossier(inp: DossierInput): Rec {
  const now = inp.now ?? Date.now();
  const token = present(inp.token) ? inp.token : undefined;
  const pair = token && present(token.pair) ? (token.pair as Rec) : undefined;

  const priceUsd = numOf(pair, 'priceUsd');
  const liquidityUsd = numOf(pair, 'liquidityUsd');
  const hasPrice = priceUsd !== null && priceUsd > 0;
  const hasLiquidity = liquidityUsd !== null && liquidityUsd > 0;

  const presentSections: string[] = [];
  const missing: string[] = [];
  const mark = (name: string, good: boolean, why: string) => { if (good) presentSections.push(name); else missing.push(`${name}: ${why}`); };

  mark('market', !!token, errText(inp.token, 'no source could describe this mint'));

  const holdersOk = present(inp.holders)
    && (numOf(inp.holders, 'holderCount') !== null || numOf(inp.holders, 'top10PctExLp') !== null
      || (Array.isArray(inp.holders.holders) && inp.holders.holders.length > 0));
  mark('holders/concentration', holdersOk, errText(inp.holders, 'no holder count or top-10 share'));

  // Security = RugCheck risks/score + the mint/freeze authority truth carried in market.audit.
  const rugOk = present(inp.rugcheck) && (numOf(inp.rugcheck, 'scoreNormalised') !== null || (Array.isArray(inp.rugcheck.risks)));
  const authoritiesOk = !!(token && present(token.audit));
  mark('security', rugOk || authoritiesOk, errText(inp.rugcheck, 'rugcheck unavailable; authorities only from market.audit'));

  const candlesOk = present(inp.candles) && (numOf(inp.candles, 'bars') ?? 0) > 0;
  mark('candles', candlesOk, errText(inp.candles, 'no candles for this pool'));

  const tapeOk = present(inp.trades) && (numOf(inp.trades, 'count') ?? 0) > 0;
  mark('tape', tapeOk, errText(inp.trades, 'no recent trades'));

  const knownUnavailable = [
    'dev-history: prior rugs, sniper clusters and bundle share (Tier-1 forensics need a Helius/Birdeye key; null on the keyless tier)',
  ];

  const canVerdict = hasPrice || hasLiquidity;
  const availability: DossierAvailability = {
    hasPrice,
    hasLiquidity,
    canVerdict,
    present: presentSections,
    missing,
    knownUnavailable,
    note: canVerdict
      ? 'Produce a WATCH / SPECULATIVE / AVOID verdict from the present sections. Copy every entry of `missing` and `knownUnavailable` into the verdict `missing_data[]` and lower `confidence` for each. Do NOT answer INSUFFICIENT_DATA — price and/or liquidity exist, so a grounded verdict is required.'
      : 'No price and no liquidity from any source for this mint: this is the only case where INSUFFICIENT_DATA is correct.',
  };

  return {
    mint: inp.mint,
    interval: inp.interval,
    now,
    market: inp.token,
    concentration: inp.holders,
    security: inp.rugcheck,
    candles: inp.candles,
    tape: inp.trades,
    creator: inp.devHistory,
    availability,
  };
}
