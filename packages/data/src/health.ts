// Per-source health registry (SPEC §3.5, learning CL-08).
//
// Rules: three consecutive failures, or two 429s inside a minute, flip a source
// to `degraded` for a backoff window (30 s, doubling per repeat up to 10 min).
// When the window ends the source is `probing` (half-open): requests are allowed
// again, one success returns it to `ok` and resets the backoff, one failure
// re-degrades it with the doubled window. Keyed sources without a key are
// `needs-key`; feature-flagged sources can be `disabled`.
//
// The registry gates which columns, features and AI tools are offered.

import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { Health, SourceId } from './model.ts';

/**
 * Registry-internal state. `probing` is the half-open state after a backoff
 * window; snapshot() maps it to the model's `degraded` with `ok: true`.
 */
export type SourceState = 'ok' | 'probing' | 'degraded' | 'needs-key' | 'disabled';

export interface HealthPolicy {
  failureThreshold: number;
  rateLimitThreshold: number;
  rateLimitWindowMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  failureThreshold: 3,
  rateLimitThreshold: 2,
  rateLimitWindowMs: 60_000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 600_000,
};

export interface Outcome {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export interface SourceHealth {
  source: SourceId;
  state: SourceState;
  since: number;
  consecutiveFailures: number;
  degradedUntil: number;
  backoffMs: number; // window applied by the most recent degrade (0 = never degraded since recovery)
  latencyMs?: number;
  lastError?: string;
  okCount: number;
  errorCount: number;
}

/** Sources that cannot work without a user-supplied key (SPEC §3.2 Tier 1). */
export const KEYED_SOURCES: ReadonlySet<SourceId> = new Set<SourceId>(['helius', 'birdeye', 'solanatracker', 'shrine']);

interface Entry {
  source: SourceId;
  base: 'ok' | 'degraded' | 'needs-key' | 'disabled';
  since: number;
  consecutiveFailures: number;
  recent429: number[];
  degradedUntil: number;
  backoffMs: number;
  nextBackoffMs: number;
  latencyMs?: number;
  lastError?: string;
  okCount: number;
  errorCount: number;
}

export interface HealthOptions {
  clock?: Clock;
  policy?: Partial<HealthPolicy>;
  /** Keyed sources the user has configured a key for. */
  keys?: Partial<Record<SourceId, boolean>>;
  /** Sources switched off by feature flag (e.g. `sources.pumpfun_frontend = false`). */
  disabled?: SourceId[];
  /** Live usage numbers for snapshot(), typically from the rate limiter. */
  usage?: (source: SourceId) => { rpmUsed: number; rpmLimit: number | null } | undefined;
}

export type HealthListener = (source: SourceId, state: SourceState) => void;

export class HealthRegistry {
  private readonly entries = new Map<SourceId, Entry>();
  private readonly clock: Clock;
  private readonly policy: HealthPolicy;
  private readonly keys: Partial<Record<SourceId, boolean>>;
  private readonly disabled: Set<SourceId>;
  private readonly usage?: HealthOptions['usage'];
  private readonly listeners = new Set<HealthListener>();

  constructor(opts: HealthOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.policy = { ...DEFAULT_HEALTH_POLICY, ...opts.policy };
    this.keys = { ...opts.keys };
    this.disabled = new Set(opts.disabled ?? []);
    this.usage = opts.usage;
  }

  onChange(fn: HealthListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setKey(source: SourceId, present: boolean): void {
    const before = this.state(source);
    this.keys[source] = present;
    this.rebase(source);
    this.emitIfChanged(source, before);
  }

  setDisabled(source: SourceId, disabled: boolean): void {
    const before = this.state(source);
    if (disabled) this.disabled.add(source);
    else this.disabled.delete(source);
    this.rebase(source);
    this.emitIfChanged(source, before);
  }

  /** Re-derive key/flag state; a degraded source stays degraded unless it is now gated off. */
  private rebase(source: SourceId): void {
    const e = this.entry(source);
    const base = this.initialBase(source);
    if (e.base !== 'degraded' || base !== 'ok') {
      if (e.base !== base) e.since = this.clock.now();
      e.base = base;
    }
  }

  /** Record the outcome of one call to `source`. */
  record(source: SourceId, outcome: Outcome): void {
    const now = this.clock.now();
    const before = this.state(source);
    const e = this.entry(source);
    if (outcome.latencyMs !== undefined) e.latencyMs = outcome.latencyMs;
    if (outcome.ok) {
      e.okCount++;
      e.consecutiveFailures = 0;
      if (e.base === 'degraded') {
        e.base = 'ok';
        e.since = now;
        e.degradedUntil = 0;
        e.backoffMs = 0;
        e.nextBackoffMs = this.policy.baseBackoffMs;
      }
    } else {
      e.errorCount++;
      e.consecutiveFailures++;
      e.lastError = outcome.error ?? (outcome.status ? `HTTP ${outcome.status}` : 'error');
      if (outcome.status === 429) e.recent429.push(now);
      e.recent429 = e.recent429.filter((t) => t > now - this.policy.rateLimitWindowMs);
      const probing = before === 'probing';
      const tripped =
        e.consecutiveFailures >= this.policy.failureThreshold || e.recent429.length >= this.policy.rateLimitThreshold;
      if ((probing || tripped) && (e.base === 'ok' || e.base === 'degraded') && before !== 'degraded') {
        this.degrade(e, now);
      }
    }
    this.emitIfChanged(source, before);
  }

  state(source: SourceId): SourceState {
    const e = this.entry(source);
    if (e.base === 'degraded') return this.clock.now() >= e.degradedUntil ? 'probing' : 'degraded';
    return e.base;
  }

  /** True when requests to `source` should be attempted (ok or probing). */
  isAvailable(source: SourceId): boolean {
    const s = this.state(source);
    return s === 'ok' || s === 'probing';
  }

  get(source: SourceId): SourceHealth {
    const e = this.entry(source);
    return {
      source,
      state: this.state(source),
      since: e.since,
      consecutiveFailures: e.consecutiveFailures,
      degradedUntil: e.degradedUntil,
      backoffMs: e.backoffMs,
      latencyMs: e.latencyMs,
      lastError: e.lastError,
      okCount: e.okCount,
      errorCount: e.errorCount,
    };
  }

  /** SPEC §3.3 `Health` records for every source seen (or the ones asked for). */
  snapshot(sources?: SourceId[]): Health[] {
    const ids = sources ?? [...this.entries.keys()];
    return ids.map((source) => {
      const h = this.get(source);
      const u = this.usage?.(source);
      return {
        source,
        ok: h.state === 'ok' || h.state === 'probing',
        state: h.state === 'probing' ? 'degraded' : h.state,
        latencyMs: h.latencyMs ?? null,
        rpmUsed: u?.rpmUsed ?? 0,
        rpmLimit: u?.rpmLimit ?? null,
        lastError: h.lastError ?? null,
        since: h.since,
      };
    });
  }

  private degrade(e: Entry, now: number): void {
    e.base = 'degraded';
    e.since = now;
    e.backoffMs = e.nextBackoffMs;
    e.degradedUntil = now + e.backoffMs;
    e.nextBackoffMs = Math.min(e.nextBackoffMs * 2, this.policy.maxBackoffMs);
    e.consecutiveFailures = 0;
    e.recent429 = [];
  }

  private initialBase(source: SourceId): Entry['base'] {
    if (this.disabled.has(source)) return 'disabled';
    if (KEYED_SOURCES.has(source) && !this.keys[source]) return 'needs-key';
    return 'ok';
  }

  private entry(source: SourceId): Entry {
    let e = this.entries.get(source);
    if (!e) {
      e = {
        source,
        base: this.initialBase(source),
        since: this.clock.now(),
        consecutiveFailures: 0,
        recent429: [],
        degradedUntil: 0,
        backoffMs: 0,
        nextBackoffMs: this.policy.baseBackoffMs,
        okCount: 0,
        errorCount: 0,
      };
      this.entries.set(source, e);
    }
    return e;
  }

  private emitIfChanged(source: SourceId, before: SourceState): void {
    const after = this.state(source);
    if (after !== before) for (const fn of this.listeners) fn(source, after);
  }
}

// ---------------------------------------------------------------------------
// Gating: which columns / features are offered given current health.

export type GateState = 'ok' | 'degraded' | 'needs-key' | 'disabled';

export interface GateSpec {
  /** Any one of these sources being available is enough. */
  anyOf: SourceId[];
  label?: string;
}

/** Screener columns (SPEC §4.2) and the sources that can fill them. */
export const COLUMN_SOURCES: Record<string, GateSpec> = {
  // Jupiter Tokens v2 carries price/stats too, so these survive a DexScreener outage.
  price: { anyOf: ['dexscreener', 'jupiter-tokens', 'jupiter-price'] },
  '5m': { anyOf: ['dexscreener', 'jupiter-tokens'] },
  '1h': { anyOf: ['dexscreener', 'jupiter-tokens'] },
  '6h': { anyOf: ['dexscreener', 'jupiter-tokens'] },
  '24h': { anyOf: ['dexscreener', 'jupiter-tokens'] },
  vol: { anyOf: ['dexscreener', 'jupiter-tokens'] },
  liq: { anyOf: ['dexscreener', 'jupiter-tokens'] },
  mcap: { anyOf: ['dexscreener', 'jupiter-tokens'] },
  age: { anyOf: ['dexscreener', 'jupiter-tokens'] },
  bs: { anyOf: ['dexscreener', 'jupiter-tokens'], label: 'buy/sell txns' },
  sparkline: { anyOf: ['dexscreener', 'jupiter-tokens'], label: 'local history of polled prices' },
  holders: { anyOf: ['jupiter-tokens'] },
  org: { anyOf: ['jupiter-tokens'], label: 'organic score' },
  flags: { anyOf: ['jupiter-tokens', 'solana-rpc', 'helius', 'goplus'], label: 'mint/freeze authority' },
  launchpad: { anyOf: ['jupiter-tokens'] },
  bonding: { anyOf: ['pumpfun', 'pumpportal'] },
  dev: { anyOf: ['jupiter-tokens', 'helius', 'solanatracker'] },
  snipers: { anyOf: ['helius', 'solanatracker'] },
  bundled: { anyOf: ['helius', 'solanatracker'] },
};

/** Screens, panels and AI tools that depend on specific sources (SPEC §3.2, §5.2). */
export const FEATURE_SOURCES: Record<string, GateSpec> = {
  screener: { anyOf: ['dexscreener', 'jupiter-tokens'] },
  'sol-price': { anyOf: ['jupiter-price', 'dexscreener'] },
  candles: { anyOf: ['shrine', 'geckoterminal', 'birdeye'] },
  'top-holders': { anyOf: ['helius', 'solana-rpc'] },
  'new-pairs-live': { anyOf: ['pumpportal', 'jupiter-tokens'] },
  rugcheck: { anyOf: ['rugcheck'] },
  security: { anyOf: ['rugcheck', 'goplus', 'solanatracker'], label: 'risk opinions' },
  authorities: { anyOf: ['helius', 'solana-rpc', 'goplus', 'jupiter-tokens'] },
  forensics: { anyOf: ['helius', 'solanatracker'] },
  'dev-history': { anyOf: ['helius', 'jupiter-tokens'] },
  'top-traders': { anyOf: ['birdeye', 'helius'] },
  'live-tape': { anyOf: ['geckoterminal', 'helius'] },
  'new-pairs-poll': { anyOf: ['jupiter-tokens', 'rugcheck'] },
  // Paper trading (task-1310): the ticket prices fills from the keyless swap quote only.
  'trade-quote': { anyOf: ['jupiter-swap'], label: 'paper trade quote' },
};

export interface Gate {
  id: string;
  state: GateState;
  available: boolean;
  /** Sources currently able to serve this gate. */
  via: SourceId[];
}

const GATE_RANK: Record<GateState, number> = { ok: 0, degraded: 1, 'needs-key': 2, disabled: 3 };

export function gate(registry: HealthRegistry, id: string, spec: GateSpec): Gate {
  const via = spec.anyOf.filter((s) => registry.isAvailable(s));
  if (via.length > 0) return { id, state: 'ok', available: true, via };
  // Report the most actionable reason: degraded beats needs-key beats disabled.
  let best: GateState = 'disabled';
  for (const s of spec.anyOf) {
    const st = registry.state(s);
    const g: GateState = st === 'degraded' ? 'degraded' : st === 'needs-key' ? 'needs-key' : st === 'disabled' ? 'disabled' : 'ok';
    if (GATE_RANK[g] < GATE_RANK[best]) best = g;
  }
  return { id, state: best, available: false, via };
}

export function gateAll(registry: HealthRegistry, specs: Record<string, GateSpec>): Record<string, Gate> {
  const out: Record<string, Gate> = {};
  for (const [id, spec] of Object.entries(specs)) out[id] = gate(registry, id, spec);
  return out;
}
