// trenchscope — screener sort keys and the `s` sort menu model.
import type { ScreenerRow } from './rows.ts';
import { RUG_MODEL_LABEL, rugP } from './rug.ts';

export type SortDir = 'asc' | 'desc';

export interface SortSpec {
  /** Matches the table column key so the header arrow lands on the right column. */
  key: string;
  label: string;
  /** Direction the key starts in when picked from the menu. */
  defaultDir: SortDir;
  get: (r: ScreenerRow) => number | null;
}

export const SORT_KEYS: SortSpec[] = [
  { key: 'vol', label: 'vol 24h', defaultDir: 'desc', get: (r) => r.vol24 },
  { key: 'liq', label: 'liquidity', defaultDir: 'desc', get: (r) => r.liq },
  { key: 'mcap', label: 'mcap', defaultDir: 'desc', get: (r) => r.mcap },
  { key: 'price', label: 'price', defaultDir: 'desc', get: (r) => r.price },
  { key: 'age', label: 'age', defaultDir: 'asc', get: (r) => r.ageMin },
  { key: 'm5', label: '5m change', defaultDir: 'desc', get: (r) => r.chg.m5 },
  { key: 'h1', label: '1h change', defaultDir: 'desc', get: (r) => r.chg.h1 },
  { key: 'h6', label: '6h change', defaultDir: 'desc', get: (r) => r.chg.h6 },
  { key: 'h24', label: '24h change', defaultDir: 'desc', get: (r) => r.chg.h24 },
  { key: 'holders', label: 'holders', defaultDir: 'desc', get: (r) => r.holders },
  { key: 'org', label: 'organic score', defaultDir: 'desc', get: (r) => r.org },
  { key: 'top10', label: 'top-10 share', defaultDir: 'asc', get: (r) => r.top10 },
  // task-1361: the H1-v0.1 heuristic's p(rug) (a model output, see screener/rug.ts); safest first.
  { key: 'rug', label: `p(rug) ${RUG_MODEL_LABEL}`, defaultDir: 'asc', get: (r) => rugP(r) },
];

export const DEFAULT_SORT: { key: string; dir: SortDir } = { key: 'vol', dir: 'desc' };

export function sortSpec(key: string): SortSpec | undefined {
  return SORT_KEYS.find((s) => s.key === key);
}

/** Parse `--sort key[:asc|desc]`. */
export function parseSortArg(s: string): { key: string; dir: SortDir } {
  const [k, d] = s.split(':');
  const spec = sortSpec(k);
  if (!spec) throw new Error(`unknown sort key ${k} (expected ${SORT_KEYS.map((x) => x.key).join('|')})`);
  if (d !== undefined && d !== 'asc' && d !== 'desc') throw new Error(`sort direction must be asc or desc, got ${d}`);
  return { key: spec.key, dir: (d as SortDir | undefined) ?? spec.defaultDir };
}

/** Stable sort; rows without the value go last whichever direction is chosen. */
export function sortRows(rows: readonly ScreenerRow[], key: string, dir: SortDir): ScreenerRow[] {
  const spec = sortSpec(key);
  if (!spec) return rows.slice();
  const sign = dir === 'desc' ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i, v: spec.get(r) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined || Number.isNaN(a.v);
      const bn = b.v === null || b.v === undefined || Number.isNaN(b.v);
      if (an && bn) return a.i - b.i;
      if (an) return 1;
      if (bn) return -1;
      return (a.v as number) === (b.v as number) ? a.i - b.i : ((a.v as number) - (b.v as number)) * sign;
    })
    .map((x) => x.r);
}
