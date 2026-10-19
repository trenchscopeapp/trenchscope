// One-line digests (AI-SUITE-DESIGN §3/§12, the card's "one-line digests on watchlist + new pairs").
//
// A digest is the DETERMINISTIC one-liner the batch-score model stage would produce, computed by code
// from the assembled features so it is always current and free (`model_output: false`). The screener's
// AI column, the watchlist and the new-pairs list all read it. It carries the deterministic verdict, the
// code rug model's p(rug) (when a scorer filled it), the one or two sharpest flags, and the oldest data
// age — never model prose, never a buy signal. The model's one-liner (batch-score, L-02) replaces it
// when present and is labelled with its age; the digest is the floor that never stalls.

import type { AssembledTokenDossier, TokenFeatures, Verdict } from './token-dossier.ts';

export interface Digest {
  mint: string;
  verdict: Verdict;
  rug_p: number | null;
  rug_model: string | null;
  /** The short line for a row (<= 90 chars so it fits the AI column at wide width). */
  text: string;
  /** The one or two flags that most explain the line, in priority order. */
  highlights: string[];
  /** Oldest contributing data age in seconds (so the UI can dim a stale digest). */
  oldest_data_age_sec: number | null;
  injection_suspected: boolean;
  model_output: false;
}

/** Human flag labels (short, screener-column width). Order = display priority (worst first). */
const FLAG_LABEL: Record<string, string> = {
  freeze_authority_enabled: 'freeze on',
  mint_authority_enabled: 'mint on',
  lp_unlocked_and_concentrated: 'LP unlocked+concentrated',
  wash_tape: 'wash tape',
  serial_rugger: 'serial rugger',
  bundled_over_15pct: 'bundled',
  dev_holds_over_10pct: 'dev heavy',
  organic_below_40: 'low organic',
  under_10_minutes: 'brand new',
};
const FLAG_PRIORITY = Object.keys(FLAG_LABEL);

const VERDICT_WORD: Record<Verdict, string> = {
  AVOID: 'AVOID', SPECULATIVE: 'SPEC', WATCH: 'WATCH', INSUFFICIENT_DATA: 'THIN', AMBIGUOUS: 'MIXED',
};

function compactUsd(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

function pct(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  const s = v >= 0 ? '+' : '';
  return `${s}${Math.round(v)}%`;
}

/** The one or two most-telling non-flag facts for a row that has no hard flag (so WATCH rows say something). */
function positiveFacts(f: TokenFeatures): string[] {
  const out: string[] = [];
  const liq = compactUsd(f.liquidity_usd);
  if (liq) out.push(`liq ${liq}`);
  if (f.organic_score !== null && f.organic_score >= 60) out.push(`organic ${Math.round(f.organic_score)}`);
  const c = pct(f.chg_h1_pct);
  if (c && f.chg_h1_pct !== null && Math.abs(f.chg_h1_pct) >= 10) out.push(`1h ${c}`);
  if (f.holders_24h_delta !== null && f.holders_24h_delta >= 10) out.push(`+holders`);
  return out.slice(0, 2);
}

/**
 * Build a digest from an assembled token-dossier. Pure. The text is: `VERDICT [p(rug) NN%] · <highlights>`,
 * highlights being the worst flags if any, else a couple of positive facts. Everything is already
 * firewalled (the dossier assembles from the firewalled sections) and length-capped to 90.
 */
export function buildDigest(d: AssembledTokenDossier): Digest {
  const highlights: string[] = [];
  const flags = [...d.flags].sort((a, b) => (FLAG_PRIORITY.indexOf(a) + 1 || 999) - (FLAG_PRIORITY.indexOf(b) + 1 || 999));
  const hardFlags = flags.filter((x) => x !== 'under_10_minutes');
  if (hardFlags.length) {
    for (const flag of hardFlags.slice(0, 2)) highlights.push(FLAG_LABEL[flag] ?? flag);
  } else {
    highlights.push(...positiveFacts(d.features));
    if (flags.includes('under_10_minutes') && highlights.length < 2) highlights.push(FLAG_LABEL.under_10_minutes);
  }

  const parts: string[] = [VERDICT_WORD[d.deterministic_verdict]];
  if (d.rug_probability !== null) parts.push(`p(rug) ${Math.round(d.rug_probability * 100)}%`);
  const tail = highlights.join(', ');
  let text = tail ? `${parts.join(' ')} · ${tail}` : parts.join(' ');
  if (text.length > 90) text = text.slice(0, 89) + '…';

  const ages = Object.values(d.data_ages).map((a) => a.age_sec).filter((a): a is number => typeof a === 'number');
  return {
    mint: d.mint,
    verdict: d.deterministic_verdict,
    rug_p: d.rug_probability,
    rug_model: d.rug_model,
    text,
    highlights,
    oldest_data_age_sec: ages.length ? Math.max(...ages) : null,
    injection_suspected: d.injection_suspected,
    model_output: false,
  };
}
