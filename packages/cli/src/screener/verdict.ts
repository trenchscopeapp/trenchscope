// trenchscope: the plain-English safety verdict for one screener row (AVOID / CAREFUL / NO RED FLAGS).
// Moved out of screens/simple.ts (which re-exports it) so a headless consumer, the paper bot, can score rows
// without loading the interactive app's state and screens. Pure: reads only the row (and an optional LARP grade).
import { fmtUsd } from '@dexterm/tui';
import type { ScreenerRow } from './rows.ts';
import { rugP, RUG_FLAG_THRESHOLD } from './rug.ts';

export type VerdictWord = 'AVOID' | 'CAREFUL' | 'NO RED FLAGS';
export interface Reason { mark: '✗' | '◐' | '✓'; text: string }
export interface Verdict { word: VerdictWord; reasons: Reason[]; p: number | null }

const pct = (n: number) => `${Math.abs(n) >= 100 ? Math.round(Math.abs(n)) : Math.abs(n).toFixed(1)}%`;

/**
 * The plain-English read of one row. AVOID: a hard red flag (collapsed, dev can mint or freeze, or the risk
 * score is over the model's flag line). CAREFUL: any other red flag or a middling score. NO RED FLAGS is not
 * "safe": it only means nothing we checked came back bad, and unknown checks are listed as unknown.
 */
export function verdictFor(r: ScreenerRow, larp: string | null = null): Verdict {
  const reasons: Reason[] = [];
  let hard = false, soft = false;
  const bad = (text: string, isHard = false) => { reasons.push({ mark: '✗', text }); if (isHard) hard = true; else soft = true; };
  const unknown = (text: string) => reasons.push({ mark: '◐', text });
  const good = (text: string) => reasons.push({ mark: '✓', text });

  if (r.flags.includes('DEAD')) bad(`collapsed: ${r.chg.h24 !== null && r.chg.h24 < 0 ? `down ${pct(r.chg.h24)} today, ` : ''}${r.liq !== null ? `${fmtUsd(r.liq, { digits: 0 })} liquidity` : 'no liquidity'}`, true);
  else if (r.chg.h24 !== null && r.chg.h24 <= -50) bad(`down ${pct(r.chg.h24)} today`);
  if (!r.flags.includes('DEAD')) {
    if (r.liq !== null && r.liq < 10_000) bad(`only ${fmtUsd(r.liq, { digits: 0 })} liquidity`);
    else if (r.liq === null && r.dex === 'pumpfun') unknown('still on the pump.fun bonding curve');
  }
  if (r.mintAuth === true) bad('the dev can mint more tokens', true);
  if (r.freezeAuth === true) bad('the dev can freeze your tokens', true);
  if (r.mintAuth === false && r.freezeAuth === false) good('mint and freeze revoked');
  else if (r.mintAuth === null || r.freezeAuth === null) unknown('mint / freeze not checked yet');
  if (r.top10 !== null) { if (r.top10 > 35) bad(`top 10 wallets hold ${pct(r.top10)}`); else good(`top 10 wallets hold ${pct(r.top10)}`); }
  else unknown('holder spread unknown');
  if (r.dev !== null) { if (r.dev > 5) bad(`dev still holds ${pct(r.dev)}`); else good(`dev holds ${pct(r.dev)}`); }
  else unknown('dev holding unknown');
  if (r.bundled !== null && r.bundled > 15) bad(`${pct(r.bundled)} bought in bundles`);
  if (r.lpLocked !== null && r.lpLocked < 50) bad(`only ${pct(r.lpLocked)} of LP locked`);
  if (r.ageMin !== null && r.ageMin < 60) unknown(`launched ${Math.max(1, Math.round(r.ageMin))} min ago`);
  // the LARP check, only when it actually ran for this mint (press a on the coin to run it)
  if (larp === 'LARP') bad('website claims a product that does not check out (LARP)', true);
  else if (larp === 'NO_PRODUCT_CLAIMED') unknown('a meme: no product claimed');
  else if (larp === 'REAL_PRODUCT' || larp === 'EARLY_BUT_REAL') good(larp === 'REAL_PRODUCT' ? 'a real product checks out' : 'early, but the product looks real');

  const p = rugP(r);
  if (p !== null && p >= RUG_FLAG_THRESHOLD) hard = true;
  else if (p !== null && p >= 0.35) soft = true;
  // most important first: red flags, then unknowns, then passes
  const rank = { '✗': 0, '◐': 1, '✓': 2 } as const;
  reasons.sort((a, b) => rank[a.mark] - rank[b.mark]);
  return { word: hard ? 'AVOID' : soft ? 'CAREFUL' : 'NO RED FLAGS', reasons, p };
}

/** The short list-column word for a row (same rules as verdictFor). */
export function riskWord(r: ScreenerRow, larp: string | null = null): 'avoid' | 'careful' | 'low' {
  const w = verdictFor(r, larp).word;
  return w === 'AVOID' ? 'avoid' : w === 'CAREFUL' ? 'careful' : 'low';
}
