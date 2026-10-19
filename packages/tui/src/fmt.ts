// @dexterm/tui — number/time formatting helpers (SPEC §7.6: compact currency, ages, subscript zeros).

const SUB = '₀₁₂₃₄₅₆₇₈₉';

export function fmtUsd(n: number | null | undefined, { digits = 2 }: { digits?: number } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(digits > 1 ? 1 : 0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(Math.round(n));
}

/**
 * A TOKEN QUANTITY (what you pay / receive / hold): compact above 10 000 like fmtNum, otherwise up to four
 * decimals with trailing zeros trimmed, and subscript-compressed below 0.01 (0.0000123 → 0.0₄123). task-1368:
 * `fmtNum` rounds to a whole number, so a $4.33 buy of a $300 token showed `You receive 0 AVGOx` — never again.
 * A true zero is "0"; null is a dash. Decimals unknown? Do not call this — say so (the ticket does).
 */
export function fmtAmount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e4) return `${sign}${fmtNum(a)}`;
  if (a >= 1) {
    const d = a >= 1000 ? 2 : 4;
    return `${sign}${trimZeros(a.toFixed(d))}`;
  }
  if (a >= 0.01) return `${sign}${trimZeros(a.toFixed(4))}`;
  return `${sign}${fmtPriceBare(a)}`;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * Price magnitude with subscript zero-compression, WITHOUT a currency symbol: 0.0000123 -> 0.0₄123.
 * Use this for amounts whose unit is written out separately (e.g. SOL per token); `fmtPrice` is the
 * USD-prefixed form. Mixing them is the task-1310 "$…​ SOL" bug: a `$` glued to a SOL amount.
 */
export function fmtPriceBare(p: number | null | undefined): string {
  if (p == null) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(p >= 100 ? 2 : 3);
  if (p >= 0.01) return p.toFixed(4);
  const s = p.toFixed(12);
  const m = s.match(/^0\.(0*)(\d+)/);
  if (!m) return `${p}`;
  const zeros = m[1].length;
  const digits = m[2].replace(/0+$/, '').slice(0, 4) || '0';
  if (zeros < 3) return `0.${m[1]}${digits}`;
  const sub = String(zeros).split('').map((c) => SUB[Number(c)]).join('');
  return `0.0${sub}${digits}`;
}

/** USD price with subscript zero-compression: 0.0000123 -> $0.0₄123 */
export function fmtPrice(p: number | null | undefined): string {
  const bare = fmtPriceBare(p);
  return bare === '—' ? bare : `$${bare}`;
}

/**
 * task-1366: market cap (or any large USD amount) on an axis / in a cell, compact K/M/B/T with at most three
 * significant digits and no currency symbol: 300000 → 300K, 1234567 → 1.23M, 1.2e9 → 1.2B, 950 → 950,
 * 0.42 → 0.42. The unit is rounded FIRST so 999 999 reads 1M, never 1000K. Non-finite → '—'.
 */
export function fmtMcapBare(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  let a = Math.abs(n);
  if (a === 0) return '0';
  if (a < 1) return sign + String(Number(a.toPrecision(2)));
  const units = ['', 'K', 'M', 'B', 'T'];
  let u = 0;
  while (u < units.length - 1 && a >= 1000) { a /= 1000; u++; }
  let r = Number(a.toPrecision(3));
  if (r >= 1000 && u < units.length - 1) { r = Number((r / 1000).toPrecision(3)); u++; }
  // three significant digits, trailing zeros dropped (1.20M → 1.2M); T stays plain digits beyond 999T
  const digits = r >= 1000 ? String(Math.round(r)) : String(r);
  return `${sign}${digits}${units[u]}`;
}

/** USD market cap, compact: `$1.2M`. See fmtMcapBare. */
export function fmtMcap(n: number | null | undefined): string {
  const bare = fmtMcapBare(n);
  if (bare === '—') return bare;
  return bare.startsWith('-') ? `-$${bare.slice(1)}` : `$${bare}`;
}

export function fmtPct(n: number | null | undefined, { sign = true, digits = 1 }: { sign?: boolean; digits?: number } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 0 : digits;
  const s = `${a.toFixed(d)}%`;
  if (!sign) return s;
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : ` ${s}`;
}

export function fmtAge(minutes: number): string {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 24) return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)}h`;
  if (minutes < 60 * 24 * 30) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 43200)}mo`;
}

export function fmtAgeSec(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return fmtAge(seconds / 60);
}

export function shortAddr(a: string | null | undefined, n = 4): string {
  if (!a) return '';
  return `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function pad(s: unknown, w: number, align: 'left' | 'right' = 'left'): string {
  let str = String(s);
  if (str.length >= w) return str.slice(0, w);
  const sp = ' '.repeat(w - str.length);
  return align === 'right' ? sp + str : str + sp;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * HH:MM:SS clock. `timeZone` pins the zone (fixtures and snapshot tests use
 * 'America/New_York' so renders are identical on every machine); omit for local time.
 */
export function clock(d: Date = new Date(), timeZone?: string): string {
  if (!timeZone) return d.toTimeString().slice(0, 8);
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone }).format(d);
}

/** Greedy word wrap; words longer than `width` are kept whole on their own line. */
export function wrap(s: string, width: number): string[] {
  const words = s.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const wd of words) {
    if ((cur + ' ' + wd).trim().length > width) { out.push(cur); cur = wd; } else cur = (cur + ' ' + wd).trim();
  }
  if (cur) out.push(cur);
  return out;
}
