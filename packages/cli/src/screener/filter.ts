// trenchscope — screener filter grammar (SPEC §4.1 row 6, §8 D-03).
//
//   vol24 > 250K  liq > 50K  age < 30d  org >= 60  launchpad:pump  !flag:mint  cat
//
// clause := field op value | [!] tag ':' word | word
// op     := > >= < <= = == !=
// value  := [$] number [K|M|B]        for money and counts
//         | number [%]                for percentages
//         | number (s|m|h|d|w|mo)     for age
// tag    := chain | launchpad (alias lp) | flag | verified | sus
// word   := free text, matched case-insensitively against symbol and name
//
// Comparisons against a missing value (null) are false, so `holders > 1000` drops rows whose
// holder source is down rather than letting them through. parseFilter() never throws: bad input
// returns { ok: false, error, at } with a column number for the editor to highlight.
import type { Launchpad } from '@dexterm/data';
import { auditState, type ScreenerRow, type RiskFlag } from './rows.ts';

export type FilterOp = '>' | '>=' | '<' | '<=' | '=' | '!=';
export type FieldKind = 'usd' | 'num' | 'pct' | 'age' | 'price';

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  label: string;
  get: (r: ScreenerRow) => number | null;
}

const F = (key: string, kind: FieldKind, label: string, get: (r: ScreenerRow) => number | null): FieldSpec => ({ key, kind, label, get });

/**
 * Own-property lookup for the alias tables below. User text indexes these tables, and a plain
 * `table[key]` would hand back inherited members for `__proto__`, `constructor`, `toString`, …
 * (a function where a string was expected, which is how `__proto__:yes` once crashed the TUI).
 */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Canonical fields; FIELD_ALIASES maps the spellings people type onto them. */
export const FIELDS: FieldSpec[] = [
  F('vol24', 'usd', 'volume 24h', (r) => r.vol24),
  F('vol6h', 'usd', 'volume 6h', (r) => r.vol6h),
  F('vol1h', 'usd', 'volume 1h', (r) => r.vol1h),
  F('vol5m', 'usd', 'volume 5m', (r) => r.vol5m),
  F('liq', 'usd', 'liquidity', (r) => r.liq),
  F('mcap', 'usd', 'market cap', (r) => r.mcap),
  F('fdv', 'usd', 'FDV', (r) => r.fdv),
  F('price', 'price', 'price', (r) => r.price),
  F('age', 'age', 'age', (r) => r.ageMin),
  F('holders', 'num', 'holders', (r) => r.holders),
  F('buys', 'num', 'buys 24h', (r) => r.buys),
  F('sells', 'num', 'sells 24h', (r) => r.sells),
  F('org', 'num', 'organic score', (r) => r.org),
  F('top10', 'pct', 'top-10 share', (r) => r.top10),
  F('dev', 'pct', 'dev share', (r) => r.dev),
  F('lplocked', 'pct', 'LP locked', (r) => r.lpLocked),
  F('bundled', 'pct', 'bundled', (r) => r.bundled),
  F('snipers', 'num', 'snipers', (r) => r.snipers),
  F('m5', 'pct', 'change 5m', (r) => r.chg.m5),
  F('h1', 'pct', 'change 1h', (r) => r.chg.h1),
  F('h6', 'pct', 'change 6h', (r) => r.chg.h6),
  F('h24', 'pct', 'change 24h', (r) => r.chg.h24),
];

const FIELD_ALIASES: Record<string, string> = {
  vol: 'vol24', volume: 'vol24', v24: 'vol24', v6h: 'vol6h', v1h: 'vol1h', v5m: 'vol5m',
  liquidity: 'liq', lp: 'liq', marketcap: 'mcap', cap: 'mcap', mc: 'mcap',
  holder: 'holders', h: 'holders', organic: 'org', score: 'org',
  top: 'top10', 'top-10': 'top10', devpct: 'dev', locked: 'lplocked', lplock: 'lplocked', bundle: 'bundled', sniper: 'snipers',
  chg5m: 'm5', '5m': 'm5', chg1h: 'h1', '1h': 'h1', chg6h: 'h6', '6h': 'h6', chg24: 'h24', chg24h: 'h24', '24h': 'h24', change: 'h24',
};

const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export function fieldSpec(name: string): FieldSpec | undefined {
  const k = name.toLowerCase();
  return FIELD_BY_KEY.get(k) ?? FIELD_BY_KEY.get(own(FIELD_ALIASES, k) ?? '');
}

export type Tag = 'chain' | 'launchpad' | 'flag' | 'verified' | 'sus';
const TAG_ALIASES: Record<string, Tag> = { chain: 'chain', launchpad: 'launchpad', lp: 'launchpad', pad: 'launchpad', flag: 'flag', flags: 'flag', verified: 'verified', sus: 'sus' };

const LAUNCHPAD_ALIASES: Record<string, Launchpad> = {
  pump: 'pump.fun', pumpfun: 'pump.fun', 'pump.fun': 'pump.fun', dbc: 'dbc', 'meteora-dbc': 'dbc',
  raydium: 'raydium', ray: 'raydium', meteora: 'meteora', met: 'meteora', bonk: 'bonk', letsbonk: 'bonk', unknown: 'unknown',
};
const FLAG_ALIASES: Record<string, RiskFlag | 'clean'> = {
  mint: 'MINT', freeze: 'FREEZE', top10: 'TOP10', dev: 'DEV', bundle: 'BUNDLE', bundled: 'BUNDLE', lp: 'LP', dead: 'DEAD', clean: 'clean', none: 'clean',
};

export type Clause =
  | { kind: 'cmp'; field: FieldSpec; op: FilterOp; value: number; raw: string }
  | { kind: 'tag'; tag: Tag; value: string; not: boolean; raw: string }
  | { kind: 'text'; value: string; raw: string };

export interface Filter {
  /** The query as typed, whitespace-normalised. */
  text: string;
  clauses: Clause[];
  predicate: (r: ScreenerRow) => boolean;
}

export type ParseResult = { ok: true; filter: Filter } | { ok: false; error: string; at: number };

interface Tok { kind: 'word' | 'op' | 'colon' | 'not'; text: string; at: number }

const OPS: Record<string, FilterOp> = { '>': '>', '>=': '>=', '<': '<', '<=': '<=', '=': '=', '==': '=', '!=': '!=' };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s+|(>=|<=|!=|==|>|<|=)|(:)|(!)|([^\s<>=!:]+)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[0].length === 0) break;
    const at = m.index + 1;
    if (m[1]) out.push({ kind: 'op', text: m[1], at });
    else if (m[2]) out.push({ kind: 'colon', text: ':', at });
    else if (m[3]) out.push({ kind: 'not', text: '!', at });
    else if (m[4]) out.push({ kind: 'word', text: m[4], at });
  }
  return out;
}

const MONEY_UNITS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const AGE_UNITS: Record<string, number> = { s: 1 / 60, m: 1, min: 1, h: 60, hr: 60, d: 1440, w: 10080, mo: 43200 };

/** Parse a value for a field kind. Returns a number or an error string. */
export function parseValue(raw: string, kind: FieldKind): number | string {
  let s = raw.toLowerCase().replace(/,/g, '');
  if (kind === 'usd' || kind === 'price') s = s.replace(/^\$/, '');
  if (kind === 'pct') s = s.replace(/%$/, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)([a-z]*)$/);
  if (!m) return `bad number "${raw}"`;
  const n = Number(m[1]);
  const unit = m[2];
  if (kind === 'age') {
    if (!unit) return `"${raw}" needs an age unit (s, m, h, d, w, mo)`;
    const mult = own(AGE_UNITS, unit);
    if (mult === undefined) return `unknown age unit "${unit}" in "${raw}" (use s, m, h, d, w, mo)`;
    return n * mult;
  }
  if (!unit) return n;
  if (kind === 'pct') return `unknown suffix "${unit}" in "${raw}" (percentages take an optional %)`;
  const mult = own(MONEY_UNITS, unit);
  if (mult === undefined) return `unknown unit "${unit}" in "${raw}" (use K, M, B)`;
  return n * mult;
}

export function parseFilter(src: string): ParseResult {
  const toks = tokenize(src);
  const clauses: Clause[] = [];
  const fail = (error: string, at: number): ParseResult => ({ ok: false, error, at });
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    const next = toks[i + 1];
    if (t.kind === 'op') return fail(`"${t.text}" has no field in front of it`, t.at);
    if (t.kind === 'colon') return fail(`":" has no tag in front of it (try chain:, launchpad:, flag:)`, t.at);
    if (t.kind === 'not') {
      if (!next || next.kind !== 'word' || toks[i + 2]?.kind !== 'colon') return fail(`"!" must be followed by a tag like !launchpad:pump`, t.at);
      const r = parseTag(toks, i + 1, true);
      if (typeof r === 'string') return fail(r, next.at);
      clauses.push(r.clause); i = r.next; continue;
    }
    // word
    if (next?.kind === 'op') {
      const field = fieldSpec(t.text);
      if (!field) return fail(`unknown field "${t.text}" (try ${FIELDS.slice(0, 7).map((f) => f.key).join(', ')}, …)`, t.at);
      const op = own(OPS, next.text);
      if (!op) return fail(`unknown operator "${next.text}"`, next.at);
      const val = toks[i + 2];
      if (!val || val.kind !== 'word') return fail(`"${t.text} ${next.text}" needs a value`, val ? val.at : next.at + next.text.length);
      const v = parseValue(val.text, field.kind);
      if (typeof v === 'string') return fail(`${v} for ${field.key}`, val.at);
      clauses.push({ kind: 'cmp', field, op, value: v, raw: `${field.key} ${op} ${val.text}` });
      i += 3; continue;
    }
    if (next?.kind === 'colon') {
      const r = parseTag(toks, i, false);
      if (typeof r === 'string') return fail(r, t.at);
      clauses.push(r.clause); i = r.next; continue;
    }
    clauses.push({ kind: 'text', value: t.text.toLowerCase(), raw: t.text });
    i += 1;
  }
  const preds = clauses.map(clausePredicate);
  const predicate = (r: ScreenerRow) => preds.every((p) => p(r));
  return { ok: true, filter: { text: clauses.map((c) => (c.kind === 'tag' && c.not ? '!' : '') + c.raw).join('  '), clauses, predicate } };
}

function parseTag(toks: Tok[], i: number, not: boolean): { clause: Clause; next: number } | string {
  const name = toks[i];
  const val = toks[i + 2];
  const tag = own(TAG_ALIASES, name.text.toLowerCase());
  if (!tag) return `unknown tag "${name.text}:" (chain, launchpad, flag, verified, sus)`;
  if (!val || val.kind !== 'word') return `"${name.text}:" needs a value`;
  const v = val.text.toLowerCase();
  let value = v;
  if (tag === 'chain') {
    if (v !== 'solana' && v !== 'sol') return `chain:${val.text} is not supported (solana only)`;
    value = 'solana';
  } else if (tag === 'launchpad') {
    const lp = own(LAUNCHPAD_ALIASES, v);
    if (!lp) return `unknown launchpad "${val.text}" (pump, dbc, raydium, meteora, bonk)`;
    value = lp;
  } else if (tag === 'flag') {
    const f = own(FLAG_ALIASES, v);
    if (!f) return `unknown flag "${val.text}" (mint, freeze, top10, dev, bundle, lp, clean)`;
    value = f;
  } else {
    if (!['yes', 'no', 'true', 'false', '1', '0'].includes(v)) return `${tag}: takes yes or no`;
    value = v === 'yes' || v === 'true' || v === '1' ? 'yes' : 'no';
  }
  return { clause: { kind: 'tag', tag, value, not, raw: `${tag}:${value}` }, next: i + 3 };
}

function cmp(a: number, op: FilterOp, b: number): boolean {
  switch (op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '=': return a === b;
    case '!=': return a !== b;
  }
}

export function clausePredicate(c: Clause): (r: ScreenerRow) => boolean {
  if (c.kind === 'cmp') {
    const { field, op, value } = c;
    return (r) => { const v = field.get(r); return v !== null && v !== undefined && !Number.isNaN(v) && cmp(v, op, value); };
  }
  if (c.kind === 'text') {
    const q = c.value;
    return (r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
  }
  let p: (r: ScreenerRow) => boolean;
  switch (c.tag) {
    case 'chain': p = () => true; break;
    case 'launchpad': p = (r) => r.launchpad === c.value; break;
    case 'flag': p = c.value === 'clean' ? (r) => auditState(r) === 'clean' : (r) => r.flags.includes(c.value as RiskFlag); break; // clean = fully audited, nothing flagged
    case 'verified': p = (r) => r.verified === (c.value === 'yes'); break;
    case 'sus': p = (r) => r.sus === (c.value === 'yes'); break;
    // parseTag only emits the tags above; a clause built by hand with a stray tag matches nothing
    default: p = () => false;
  }
  return c.not ? (r) => !p(r) : p;
}

/** Apply a parsed filter (or none) to rows, keeping order. */
export function applyFilter(rows: readonly ScreenerRow[], f: Filter | null | undefined): ScreenerRow[] {
  if (!f || f.clauses.length === 0) return rows.slice();
  return rows.filter(f.predicate);
}
