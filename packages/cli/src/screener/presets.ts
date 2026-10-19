// trenchscope — screener presets (SPEC §4.2): which discovery feeds to pull and which baked filter
// to apply on top. Availability comes from the health registry: a preset whose gate is not
// served (needs-key / degraded / disabled) is shown dim with a caption and cannot be selected.
import type { HealthRegistry, Preset as FeedPreset } from '@dexterm/data';
import { gate, COLUMN_SOURCES, FEATURE_SOURCES } from '@dexterm/data/core';
import { parseFilter, type Filter } from './filter.ts';

export type PresetId = 'trench' | 'trending' | 'runners' | 'organic' | 'graduating' | 'smart' | 'traded' | 'new' | 'boosted' | 'all';

export interface PresetSpec {
  id: PresetId;
  label: string;
  /** Discovery feeds pulled from the store (union, interleaved by the store). */
  feeds: FeedPreset[];
  /** Filter grammar applied on top of the feed (users' filters compose with it). */
  baked?: string;
  /** Gate id in COLUMN_SOURCES / FEATURE_SOURCES that must be served. */
  gate?: { id: string; of: 'column' | 'feature' };
  /** Card that delivers the feed; until then the preset is disabled with this caption. */
  pending?: string;
  /**
   * This preset ships a KEYLESS APPROXIMATION of its intent (task-1356 Tier 6): it is selectable now
   * from the baked filter over keyless fields, and the `gate` (when present) is an UPGRADE — when the
   * keyed source is served the preset swaps to the real signal. The caption is shown even when the
   * preset is available, so the UI never implies a keyed feature the keyless tier does not have.
   */
  approx?: string;
  /** Fold the live PumpPortal new-pairs stream into the candidate pool for this feed (task-1303). */
  live?: boolean;
}

/** Jupiter's "runner" criteria (SPEC §4.2): mcap ≥ $1M, liq ≥ $100K, holders ≥ 1K, organic ≥ 75 within 24h of launch. */
export const RUNNER_FILTER = 'mcap >= 1M  liq >= 100K  holders >= 1000  org >= 75  age < 24h';

/**
 * Trench feed (task-1311, QA M4): what a Solana memecoin trader wants first — fresh pump.fun and
 * young memecoins over a sane liquidity floor. `verified:no` drops the Jupiter-verified set (blue
 * chips, wrapped assets, tokenized stocks and stablecoins), which stay reachable under Trending /
 * Top traded / All. `live` folds the PumpPortal new-pairs stream in so fresh launches surface.
 */
export const TRENCH_FILTER = 'verified:no  liq >= 5K';

/**
 * Graduating — keyless approximation (task-1356 Tier 6). The real signal is bonding-curve progress
 * (COLUMN_SOURCES 'bonding', D-08), which needs a keyed launch source. Keyless we approximate "a
 * bonding-curve launch closing on graduation" by the mcap band a pump.fun/bonk/dbc coin sits in as it
 * fills (roughly $30K–$120K), still young, with a real-ish pool forming. It is an APPROXIMATION, not the
 * true graduation %, and the UI says so; when 'bonding' is served the preset swaps to the real column.
 */
export const GRADUATING_APPROX_FILTER = 'launchpad:pump  mcap >= 30K  mcap <= 120K  liq >= 4K  age < 24h';

export const PRESETS: PresetSpec[] = [
  { id: 'trench', label: 'Trench', feeds: ['trending', 'organic', 'recent'], baked: TRENCH_FILTER, live: true },
  { id: 'trending', label: 'Trending', feeds: ['trending'] },
  { id: 'runners', label: 'Runners', feeds: ['trending', 'organic', 'recent'], baked: RUNNER_FILTER },
  { id: 'organic', label: 'Organic', feeds: ['organic'] },
  { id: 'graduating', label: 'Graduating', feeds: ['recent'], baked: GRADUATING_APPROX_FILTER, live: true, gate: { id: 'bonding', of: 'column' }, approx: 'approx' },
  { id: 'smart', label: 'Smart money', feeds: ['trending'], gate: { id: 'top-traders', of: 'feature' } },
  // task-1303 feed switcher: the remaining Jupiter / DexScreener nets, keyless and always available.
  { id: 'traded', label: 'Top traded', feeds: ['traded'] },
  { id: 'new', label: 'New', feeds: ['recent'], live: true },
  { id: 'boosted', label: 'Boosted', feeds: ['boosted'] },
  { id: 'all', label: 'All', feeds: ['trending', 'organic', 'traded', 'recent', 'boosted'], live: true },
];

export function presetSpec(id: string): PresetSpec | undefined {
  return PRESETS.find((p) => p.id === id || p.label.toLowerCase() === id.toLowerCase());
}

export interface PresetView {
  id: PresetId;
  label: string;
  available: boolean;
  /** Short reason shown next to a disabled preset: 'needs key', 'degraded', 'off', 'D-08'. */
  caption: string | null;
  /** True when this preset is served by a keyless APPROXIMATION of a keyed signal (task-1356 Tier 6). */
  approx?: boolean;
}

const CAPTION: Record<string, string> = { 'needs-key': 'needs key', degraded: 'degraded', disabled: 'off', ok: '' };

/** Availability of every preset. Without a registry (fixtures mode) everything is on for the demo. */
export function presetViews(health?: HealthRegistry): PresetView[] {
  return PRESETS.map((p) => {
    if (!health) return { id: p.id, label: p.label, available: true, caption: p.approx ? p.approx : null, approx: !!p.approx };
    if (p.pending) return { id: p.id, label: p.label, available: false, caption: p.pending };
    // An approximation preset is served keyless by its baked filter over keyless fields, so it is always
    // selectable. The trenchscope filter grammar has no real bonding-% field at this tier, so the preset is
    // ALWAYS the approximation (the `gate` only marks the future upgrade to a real column); the 'approx'
    // caption therefore stays visible even when available, so the UI never implies the keyed signal.
    if (p.approx) return { id: p.id, label: p.label, available: true, caption: p.approx, approx: true };
    if (!p.gate) return { id: p.id, label: p.label, available: true, caption: null };
    const spec = p.gate.of === 'column' ? COLUMN_SOURCES[p.gate.id] : FEATURE_SOURCES[p.gate.id];
    const g = gate(health, p.gate.id, spec);
    return { id: p.id, label: p.label, available: g.available, caption: g.available ? null : CAPTION[g.state] || g.state };
  });
}

const bakedCache = new Map<string, Filter>();

export function bakedFilter(p: PresetSpec): Filter | null {
  if (!p.baked) return null;
  let f = bakedCache.get(p.baked);
  if (!f) {
    const r = parseFilter(p.baked);
    if (!r.ok) throw new Error(`preset ${p.id} has a bad baked filter: ${r.error}`);
    f = r.filter;
    bakedCache.set(p.baked, f);
  }
  return f;
}

/** Next/previous selectable preset from `cur` (wraps; disabled presets are skipped). */
export function cyclePreset(views: PresetView[], cur: PresetId, step: 1 | -1): PresetId {
  const i = Math.max(0, views.findIndex((v) => v.id === cur));
  for (let k = 1; k <= views.length; k++) {
    const v = views[(i + step * k + views.length * k) % views.length];
    if (v.available) return v.id;
  }
  return cur;
}
