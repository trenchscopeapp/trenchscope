// trenchscope — screener view-model (D-03): the state behind the screener screen and the pure
// transitions the keys drive (filter editor, sort menu, preset cycling, selection). Rows come
// from fixtures (demo / snapshot parity) or from the data-store feed; the screen only ever sees
// `ScreenerRow`s plus the health gates that say which columns may be trusted.
import type { Gate } from '@dexterm/data';
import type { Key } from '@dexterm/tui';
import { skeletonRows, type ScreenerRow } from './rows.ts';
import { applyFilter, parseFilter, type Filter } from './filter.ts';
import { DEFAULT_SORT, SORT_KEYS, sortRows, sortSpec, type SortDir } from './sort.ts';
import { PRESETS, bakedFilter, cyclePreset, presetSpec, presetViews, type PresetId, type PresetView } from './presets.ts';

export type ScreenerSource = 'fixtures' | 'live' | 'replay';
export type ScreenerMode = 'table' | 'filter' | 'sort';

export interface ParseError { error: string; at: number }

export interface ScreenerState {
  source: ScreenerSource;
  /** Every row the source produced, unfiltered and unsorted. */
  rows: ScreenerRow[];
  /** Applied filter text as typed ('' = none) and its parsed form. */
  query: string;
  filter: Filter | null;
  sort: { key: string; dir: SortDir };
  preset: PresetId;
  presets: PresetView[];
  /** Column gates from the health registry; null in fixtures mode (everything trusted). */
  gates: Record<string, Gate> | null;
  mode: ScreenerMode;
  /** Filter editor buffer and the live parse error for what is typed so far. */
  edit: { text: string; error: ParseError | null };
  sortCursor: number;
  /** Header status override, e.g. '◐ degraded: jup'. */
  headerStatus?: string;
  /** Size of the de-duplicated candidate pool the feed last considered (task-1303); undefined on fixtures. */
  pool?: number;
  /** True while the wide-pool background fill is throttling DexScreener (task-1303); drives the header hint. */
  slowing?: boolean;
  /** Last per-source error strings from the feed (already redacted); drives the empty-state banner (task-1305 M6). */
  errors?: Record<string, string>;
  /** One-line transient note shown in the filter bar (cleared on the next key). */
  notice: string | null;
}

/** Why the live feed has no rows yet — turns a silent "waiting" into a plain, honest banner (task-1305 M6). */
export type FeedCondition = 'ok' | 'connecting' | 'offline' | 'ratelimited';

/**
 * Classify the live feed's current condition from the rows it produced and the errors it reported.
 * `ok` once any row is present; otherwise connecting (no error yet), offline (a network/DNS failure),
 * or ratelimited (an HTTP 429). 429 wins over a network error because the host did answer.
 */
export function feedCondition(sc: ScreenerState): { kind: FeedCondition; message: string } {
  if (sc.rows.length > 0) return { kind: 'ok', message: '' };
  const joined = Object.values(sc.errors ?? {}).join(' ').toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/.test(joined)) {
    return { kind: 'ratelimited', message: 'rate-limited by the data feed — backing off and retrying (press r to retry now)' };
  }
  if (/enotfound|econnrefused|eai_again|getaddrinfo|fetch failed|network|timeout|etimedout|socket|dns/.test(joined)) {
    return { kind: 'offline', message: "offline — can't reach the data feed; retrying (press r to retry, or run `trenchscope doctor`)" };
  }
  return { kind: 'connecting', message: 'connecting to the live feed…' };
}

export function makeScreenerState(source: ScreenerSource, rows: ScreenerRow[] = [], opts: { presets?: PresetView[]; gates?: Record<string, Gate> | null } = {}): ScreenerState {
  return {
    source, rows, query: '', filter: null, sort: { ...DEFAULT_SORT }, preset: 'trending',
    presets: opts.presets ?? presetViews(), gates: opts.gates ?? null, mode: 'table',
    edit: { text: '', error: null }, sortCursor: 0, notice: null,
  };
}

const SKELETON = skeletonRows();

/**
 * True while a live/replay feed has produced nothing yet and nothing went wrong (task-1323): the table
 * shows placeholder rows instead of an empty box. An error (offline / 429) keeps the explicit banner.
 */
export function showsSkeleton(s: ScreenerState): boolean {
  return s.source !== 'fixtures' && s.rows.length === 0 && feedCondition(s).kind === 'connecting';
}

/** Rows as the table shows them: preset's baked filter, then the user's filter, then the sort. */
export function screenerView(s: ScreenerState): ScreenerRow[] {
  if (showsSkeleton(s)) return SKELETON;
  const spec = presetSpec(s.preset) ?? PRESETS[0];
  const base = s.source === 'fixtures' || spec.baked ? applyFilter(s.rows, bakedFilter(spec)) : s.rows;
  return sortRows(applyFilter(base, s.filter), s.sort.key, s.sort.dir);
}

/** Set the applied filter from text. Returns the parse error (and leaves the old filter) on bad input. */
export function setFilter(s: ScreenerState, text: string): ParseError | null {
  const trimmed = text.trim();
  if (!trimmed) { s.query = ''; s.filter = null; return null; }
  const r = parseFilter(trimmed);
  if (!r.ok) return { error: r.error, at: r.at };
  s.query = trimmed;
  s.filter = r.filter;
  return null;
}

export function setSort(s: ScreenerState, key: string, dir?: SortDir): void {
  const spec = sortSpec(key);
  if (!spec) return;
  s.sort = { key: spec.key, dir: dir ?? spec.defaultDir };
}

/** Select a preset; disabled ones (needs key / pending card) are refused. Returns true when it changed. */
export function setPreset(s: ScreenerState, id: PresetId): boolean {
  const v = s.presets.find((p) => p.id === id);
  if (!v || !v.available || s.preset === id) return false;
  s.preset = id;
  return true;
}

export function stepPreset(s: ScreenerState, step: 1 | -1): boolean {
  return setPreset(s, cyclePreset(s.presets, s.preset, step));
}

export function clampSelection(s: ScreenerState, selected: number): number {
  const n = screenerView(s).length;
  return n === 0 ? 0 : Math.max(0, Math.min(n - 1, selected));
}

// ---- modes --------------------------------------------------------------------------------

export function openFilterEditor(s: ScreenerState): void {
  s.mode = 'filter';
  s.edit = { text: s.query, error: null };
  s.notice = null;
}

export function openSortMenu(s: ScreenerState): void {
  s.mode = 'sort';
  s.sortCursor = Math.max(0, SORT_KEYS.findIndex((k) => k.key === s.sort.key));
  s.notice = null;
}

/** What a key did in an editor/menu mode: handled (redraw), applied (filter/sort changed), or ignored. */
export type ModeResult = 'handled' | 'applied' | 'closed' | 'ignored';

/** Keys while the filter editor is open. Enter applies (only when the text parses), esc cancels. */
export function filterEditorKey(s: ScreenerState, k: Key): ModeResult {
  const e = s.edit;
  const revalidate = () => { const t = e.text.trim(); if (!t) { e.error = null; return; } const r = parseFilter(t); e.error = r.ok ? null : { error: r.error, at: r.at }; };
  if (k.name === 'esc') { s.mode = 'table'; return 'closed'; }
  if (k.name === 'enter') {
    const err = setFilter(s, e.text);
    if (err) { e.error = err; return 'handled'; }
    s.mode = 'table';
    return 'applied';
  }
  if (k.name === 'backspace') { e.text = e.text.slice(0, -1); revalidate(); return 'handled'; }
  if (k.ctrl && k.ch === 'u') { e.text = ''; e.error = null; return 'handled'; }
  if (k.ctrl && k.ch === 'w') { e.text = e.text.replace(/\s*\S+\s*$/, ''); revalidate(); return 'handled'; }
  if ((k.name === 'char' || k.name === 'space') && k.ch && !k.ctrl && !k.alt) {
    if (e.text.length >= 200) return 'handled';
    e.text += k.ch;
    revalidate();
    return 'handled';
  }
  return 'ignored';
}

/** Keys while the sort menu is open: j/k move, enter picks (same key toggles direction), esc/s close. */
export function sortMenuKey(s: ScreenerState, k: Key): ModeResult {
  const n = SORT_KEYS.length;
  if (k.name === 'esc' || (k.name === 'char' && (k.ch === 's' || k.ch === 'q'))) { s.mode = 'table'; return 'closed'; }
  if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) { s.sortCursor = (s.sortCursor + 1) % n; return 'handled'; }
  if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) { s.sortCursor = (s.sortCursor + n - 1) % n; return 'handled'; }
  if (k.name === 'home' || (k.name === 'char' && k.ch === 'g')) { s.sortCursor = 0; return 'handled'; }
  if (k.name === 'end' || (k.name === 'char' && k.ch === 'G')) { s.sortCursor = n - 1; return 'handled'; }
  if (k.name === 'enter' || k.name === 'space') {
    const pick = SORT_KEYS[s.sortCursor];
    if (pick.key === s.sort.key) s.sort = { key: pick.key, dir: s.sort.dir === 'desc' ? 'asc' : 'desc' };
    else s.sort = { key: pick.key, dir: pick.defaultDir };
    s.mode = 'table';
    return 'applied';
  }
  return 'ignored';
}

/** Caption fragment for columns the registry says cannot be trusted right now, e.g. 'holders, org: degraded'. */
export function gateCaption(gates: Record<string, Gate> | null, columns: readonly string[]): string {
  if (!gates) return '';
  const by = new Map<string, string[]>();
  for (const id of columns) {
    const g = gates[id];
    if (!g || g.available) continue;
    const label = g.state === 'needs-key' ? 'needs key' : g.state === 'disabled' ? 'off' : 'degraded';
    (by.get(label) ?? by.set(label, []).get(label)!).push(id);
  }
  return [...by.entries()].map(([label, ids]) => `${ids.join(', ')}: ${label}`).join(' · ');
}
