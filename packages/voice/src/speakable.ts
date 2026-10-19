// Make a line "speakable" like a trader, not digit by digit (task-1411). A tester heard Jarvis read a raw
// per-token price ("zero point zero zero zero zero zero two nine") and big raw numbers, which sounds
// crazy. This normaliser runs on EVERY spoken line (controller.speak) and applies these rules, in order:
//
//   1. Tiny per-token prices are NEVER read digit by digit. A sub-cent decimal ($0.0000029), the app's
//      own subscript rendering ($0.0₅29), or any value below a cent becomes the coin's MARKET CAP when
//      the line (or the caller) knows it, else the phrase "a tiny price". We NEVER invent a number.
//      A sub-cent value that is an AMOUNT of something (e.g. "0.005 SOL", "0.0025 SOL fee") is left
//      alone — it is a quantity, not a per-token price.
//   2. Big raw numbers become human words: 340000 → "340 thousand", 1200000 → "1.2 million",
//      4500000000 → "4.5 billion". Word boundaries keep digits inside an address untouched, and a bare
//      4-digit YEAR (1900–2099) is left as-is so "launched in 2024" never reads "launched in 2 thousand".
//   3. Percentages read naturally: "12%" → "12 percent".
//
// Pure and dependency-free so every rule is unit-tested without spawning a voice.

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'; // ₀..₉

// Units that follow a small decimal and mark it as an AMOUNT, not a per-token price (so "0.005 SOL" is
// a quantity we read normally). Case-insensitive, whole word.
const AMOUNT_UNIT = /^\s*(sol|eth|btc|usdc|usdt|tokens?|coins?)\b/i;

export interface SpeakableOpts {
  /**
   * The coin's market-cap phrase (already human, e.g. "340 thousand") substituted for a tiny per-token
   * price. When omitted, speakable() tries to read a market cap out of the line itself (rule 1); failing
   * that, a tiny price becomes "a tiny price" (never a made-up number).
   */
  marketCap?: string | null;
}

/** Round to one decimal and drop a trailing ".0" so "1.0 million" reads "1 million". */
function trimNum(n: number): string {
  const r = Math.round(n * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1));
}

/** A raw number (>= 1000) as human words: "340 thousand", "1.2 million", "4.5 billion". */
export function humanizeNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trimNum(n / 1e9)} billion`;
  if (abs >= 1e6) return `${trimNum(n / 1e6)} million`;
  if (abs >= 1e3) return `${trimNum(n / 1e3)} thousand`;
  return trimNum(n);
}

/** A number is a 4-digit calendar year (1900–2099): spoken as-is, never "2 thousand twenty four". */
function isYear(v: number): boolean {
  return Number.isInteger(v) && v >= 1900 && v <= 2099;
}

/**
 * Read a market cap out of the analyst line, e.g. "market cap $340K", "mcap of 1.2M", "cap: 340000",
 * returned as a human phrase ("340 thousand"). The brief: a tiny price is replaced WITH THE COIN'S
 * MARKET CAP WHEN THE ANALYST TEXT INCLUDES IT. Returns null when the line names no market cap.
 */
function marketCapFromText(text: string): string | null {
  const m = /\b(?:market\s*cap|mcap|m\.?c\.?|cap)\b[^$\d]{0,8}\$?([\d,]+(?:\.\d+)?)\s*([KkMmBb])?\b/.exec(text);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  const suf = m[2];
  if (suf) v *= /[Kk]/.test(suf) ? 1e3 : /[Mm]/.test(suf) ? 1e6 : 1e9;
  if (v < 1000) return null; // "cap 2 holders" etc. is not a market cap
  return humanizeNumber(v);
}

/**
 * Normalise a spoken line. `opts.marketCap`, when given, is the human market-cap phrase substituted for
 * a tiny per-token price; otherwise speakable reads a market cap out of the line, and failing that uses
 * "a tiny price" (never a made-up number).
 */
export function speakable(text: string, opts: SpeakableOpts = {}): string {
  let s = String(text ?? '');
  const mcap = (opts.marketCap && opts.marketCap.trim()) || marketCapFromText(s);
  const tiny = mcap ? `a market cap of ${String(mcap).trim()}` : 'a tiny price';

  // 1a. Subscript price forms the app renders, e.g. "$0.0₅29" / "0.0₄1686" — never read the digits.
  s = s.replace(new RegExp(`\\$?\\d*\\.?\\d*[${SUBSCRIPT}]+[${SUBSCRIPT}0-9]*`, 'g'), tiny);
  // 1b. Sub-cent decimal prices, e.g. "$0.0000029", "0.00004". A value below a cent is a per-token price,
  //     not an amount; the leading-zeros case (>=2 zeros after the point) is always a price — UNLESS it
  //     is immediately followed by a unit word (SOL/ETH/tokens…), in which case it is an AMOUNT: leave it.
  s = s.replace(/\$?\d*\.\d+/g, (m, idx: number, full: string) => {
    const v = parseFloat(m.replace(/[$,]/g, ''));
    if (!Number.isFinite(v)) return m;
    const after = full.slice(idx + m.length);
    if (AMOUNT_UNIT.test(after)) return m; // "0.005 SOL" is a quantity, not a per-token price
    if (/\.0{2,}/.test(m) || (v > 0 && v < 0.01)) return tiny;
    return m;
  });

  // 2. Percentages read as words before the big-number pass (so "12%" isn't seen as a bare number).
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, '$1 percent');

  // 2b. Abbreviated magnitudes the app and analysts use: "$340K" / "2.1M" / "4.5B" → words. Lowercase
  //     "m" is intentionally EXCLUDED: "15m" / "6h" are a token's AGE (minutes), not millions.
  s = s.replace(/\$?(\d+(?:\.\d+)?)\s*([KkMBb])\b/g, (_m, num: string, suf: string) => {
    const word = /[Kk]/.test(suf) ? 'thousand' : suf === 'M' ? 'million' : 'billion';
    return `${num} ${word}`;
  });

  // 3. Big raw numbers -> human words. `\b` keeps runs of digits inside an address/word untouched, and a
  //    number already followed by a scale word (k/m/b/thousand/…) or "percent" is left alone, as is a
  //    bare 4-digit year.
  s = s.replace(/\$?\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\$?\b\d{4,}(?:\.\d+)?\b/g, (m, ...rest) => {
    const full = rest[rest.length - 1] as string; // the whole input string
    const idx = rest[rest.length - 2] as number;
    const after = full.slice(idx + m.length).trimStart().toLowerCase();
    if (/^(k|m|b|bn|thousand|million|billion|percent|%)\b/.test(after)) return m;
    const v = parseFloat(m.replace(/[$,]/g, ''));
    if (!Number.isFinite(v) || Math.abs(v) < 1000) return m;
    // A bare 4-digit year ("launched in 2024") stays a year; a dollar-prefixed or comma-grouped number
    // ("$2024", "2,024") is a real amount and is humanised.
    if (isYear(v) && !/[$,]/.test(m)) return m;
    return humanizeNumber(v);
  });

  return s;
}
