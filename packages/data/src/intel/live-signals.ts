// trenchscope — LIVE holder / rug SIGNALS engine (task-1404). Pure + deterministic.
//
// The token screen used to read holders and safety ONCE, when you opened it. This engine turns a stream of
// repeated OBSERVATIONS of a token's holder/rug state into SIGNAL events — the changes worth telling a trader
// about while the token is open or on the watchlist: a dev/creator sell, a top-holder / top-10 concentration
// shift, LP removal or an unlock change, a mint/freeze authority flip, a new bundle / sniper cluster, a
// fresh-wallet inflow, bonding-curve progress, a migration.
//
// Every signal is a RISK FLAG, never a certificate, and carries its SOURCE and the AGE of the data it read, with
// an honest `stale` flag. No I/O, no clock, no randomness: the caller feeds `now` and already-fetched readings,
// so a recording replays to the same signals and the tests can assert each one. Nothing here signs or trades.
//
// Baseline rule: a signal only fires on a comparison between two FRESH readings of the same field. A reading that
// is stale (its panel kept the last value after a failed refresh, or it is older than `staleAfterMs`) updates the
// latest-known value but never fires a signal off it — we cannot honestly timestamp a change we did not see land.
// The first observation of a mint sets the baseline and fires nothing (so opening a token never floods).

/** Signal severity, aligned 1:1 with @dexterm/custom's AlertLevel (kept local so this package imports nothing). */
export type SignalLevel = 'up' | 'down' | 'info' | 'warn';

export type SignalKind =
  | 'dev-sell'
  | 'concentration'
  | 'lp-unlock'
  | 'liquidity'
  | 'authority'
  | 'bundle'
  | 'sniper'
  | 'fresh-wallet'
  | 'bonding'
  | 'migrated';

/** One fetched numeric reading with its provenance. `value` null = the source did not answer (no signal). */
export interface FieldReading {
  value: number | null;
  /** Safe-to-print source label (`helius`, `rugcheck`, `solana-rpc`, `onchain-curve`, `dexscreener`, …). */
  source: string;
  /** Local ms the reading was fetched (panel `fetchedAt` / tick time). */
  fetchedAt: number;
  /** The source's own stale flag (SWR kept the last value after a failed refresh). */
  stale: boolean;
}

/** A present/absent authority reading (mint or freeze). */
export interface AuthReading {
  present: boolean | null;
  source: string;
  fetchedAt: number;
  stale: boolean;
}

/** A migration (bonding curve closed) reading. */
export interface MigratedReading {
  value: boolean | null;
  source: string;
  fetchedAt: number;
  stale: boolean;
}

/** One moment's readings for a mint. Omit / null a field the caller cannot read this tick (no signal for it). */
export interface SignalObservation {
  mint: string;
  at: number;
  /** Top-10 concentration %, pools excluded (the token screen's ex-pool figure). */
  top10?: FieldReading | null;
  /** Creator / dev share held now, %. */
  dev?: FieldReading | null;
  /** Bundled supply %, of the fetched top sample. */
  bundled?: FieldReading | null;
  /** Sniper count in the launch window. */
  snipers?: FieldReading | null;
  /** Fresh-at-buy wallets %, of the fetched top sample. */
  fresh?: FieldReading | null;
  /** Top linked-cluster share %, from wallet intel. */
  cluster?: FieldReading | null;
  /** LP locked %. */
  lpLocked?: FieldReading | null;
  /** Liquidity, USD. */
  liq?: FieldReading | null;
  /** Bonding-curve progress %, 0..100. */
  bonding?: FieldReading | null;
  /** Mint authority present (a false→true flip re-enables minting new supply). */
  mintAuth?: AuthReading | null;
  /** Freeze authority present (a false→true flip re-enables freezing transfers). */
  freezeAuth?: AuthReading | null;
  /** Bonding curve `complete` (migrated to a DEX pool). */
  migrated?: MigratedReading | null;
}

/** A change worth surfacing. `dataAgeMs`/`stale` describe the reading this fired from, at `at`. */
export interface LiveSignal {
  kind: SignalKind;
  mint: string;
  level: SignalLevel;
  /** Short label for a chip / log (≤ ~18 chars). */
  title: string;
  /** Plain-wording sentence, numbers included. A risk flag, never "rug confirmed". */
  text: string;
  /** The data source this fired from. */
  source: string;
  /** Age of the reading that produced it, ms. */
  dataAgeMs: number;
  /** The reading was already stale when read (shown, never hidden). Always false for a fired signal (see module note). */
  stale: boolean;
  /** Current value (null for the pure boolean kinds). */
  value: number | null;
  /** Change vs the previous fresh value (null for boolean kinds / first-after-baseline). */
  delta: number | null;
  at: number;
}

/** The numeric fields the rules engine reads so every signal is an ALERT TRIGGER (merged into @dexterm/custom RuleRow). */
export interface LiveSignalFields {
  top10: number | null;
  dev: number | null;
  bundled: number | null;
  snipers: number | null;
  fresh: number | null;
  cluster: number | null;
  lpLocked: number | null;
  bonding: number | null;
  /** 1 when a mint authority is present (new supply can be minted), 0 when revoked, null when unknown. */
  mintable: number | null;
  /** 1 when a freeze authority is present, 0 when revoked, null when unknown. */
  freezable: number | null;
}

/** A per-field snapshot with its age — what the token screen's LIVE SIGNALS panel shows (source + age + stale). */
export interface SignalFieldSnapshot {
  value: number | null;
  source: string | null;
  ageMs: number | null;
  stale: boolean;
}

export interface SignalThresholds {
  /** Creator % dropped by at least this many points → dev-sell. */
  devSellPct: number;
  /** |top-10 %| moved by at least this many points → concentration. */
  concentrationPct: number;
  /** LP locked % dropped by at least this many points → lp-unlock. */
  lpDropPct: number;
  /** Liquidity fell by at least this fraction (0.25 = 25%) → liquidity. */
  liqDropFrac: number;
  /** Bundled % rose by at least this many points → bundle. */
  bundlePct: number;
  /** Sniper count rose by at least this many → sniper. */
  sniperCount: number;
  /** Fresh-at-buy % rose by at least this many points → fresh-wallet. */
  freshPct: number;
  /** Bonding progress rose by at least this many points → bonding. */
  bondingStepPct: number;
  /** A reading older than this (or flagged stale by its source) never fires a signal. */
  staleAfterMs: number;
}

export const DEFAULT_SIGNAL_THRESHOLDS: Readonly<SignalThresholds> = {
  devSellPct: 1,
  concentrationPct: 3,
  lpDropPct: 1,
  liqDropFrac: 0.25,
  bundlePct: 1,
  sniperCount: 1,
  freshPct: 5,
  bondingStepPct: 5,
  staleAfterMs: 60_000,
};

/** Every signal kind, for docs / UI / the alerts trigger catalogue. */
export const SIGNAL_KINDS: readonly SignalKind[] = [
  'dev-sell', 'concentration', 'lp-unlock', 'liquidity', 'authority', 'bundle', 'sniper', 'fresh-wallet', 'bonding', 'migrated',
];

interface NumState { value: number; source: string; fetchedAt: number }
interface BoolState { value: boolean; source: string; fetchedAt: number }

type NumKey = 'top10' | 'dev' | 'bundled' | 'snipers' | 'fresh' | 'cluster' | 'lpLocked' | 'liq' | 'bonding';
type BoolKey = 'mintAuth' | 'freezeAuth' | 'migrated';

/**
 * Per-mint memory. `latest` is the most recent FRESH value of each field (what `fields()` / `snapshot()` report
 * to the rules engine and the UI). `anchor` is the comparison baseline for the CUMULATIVE fields only (bonding /
 * bundled / snipers / fresh): it advances only when a signal fires, so slow drift between fast pushes accumulates
 * until it crosses the threshold. For LEVEL fields the comparison is simply against the previous `latest`.
 */
interface MintState {
  latest: Partial<Record<NumKey, NumState>>;
  latestBool: Partial<Record<BoolKey, BoolState>>;
  /** Comparison anchors for the CUMULATIVE fields only (other keys are never written). */
  anchor: Partial<Record<NumKey, number>>;
}

const CUMULATIVE: ReadonlySet<NumKey> = new Set<NumKey>(['bonding', 'bundled', 'snipers', 'fresh']);

const r1 = (n: number): number => Math.round(n * 10) / 10;

export class LiveSignalsEngine {
  private readonly thresholds: SignalThresholds;
  private readonly state = new Map<string, MintState>();

  constructor(opts: { thresholds?: Partial<SignalThresholds> } = {}) {
    this.thresholds = { ...DEFAULT_SIGNAL_THRESHOLDS, ...opts.thresholds };
  }

  /** Whether a reading is too stale to fire a signal from (still updates the latest-known baseline). */
  private stale(reading: { fetchedAt: number; stale: boolean }, now: number): boolean {
    return reading.stale || now - reading.fetchedAt > this.thresholds.staleAfterMs;
  }

  /**
   * Record one observation and return the signals it produced (empty for the first observation of a mint, or
   * when nothing crossed a threshold). Baseline discipline (see module note):
   *  - the first reading of a field sets the baseline and fires nothing;
   *  - a STALE reading neither fires nor advances the baseline (so when it is fresh again we compare to the last
   *    value we actually saw and never miss a change that happened while stale, nor fire off stale data);
   *  - a fresh LEVEL field (dev / top10 / lpLocked / liq / authorities) is compared to the previous value and the
   *    baseline then advances to the current value;
   *  - a fresh CUMULATIVE field (bonding / bundled / snipers / fresh) advances its baseline ONLY when it fires, so
   *    gradual drift between fast pushes accumulates until it crosses the threshold instead of being lost.
   */
  observe(obs: SignalObservation): LiveSignal[] {
    const t = this.thresholds;
    const now = obs.at;
    const prev = this.state.get(obs.mint) ?? { latest: {}, latestBool: {}, anchor: {} };
    const next: MintState = { latest: { ...prev.latest }, latestBool: { ...prev.latestBool }, anchor: { ...prev.anchor } };
    const out: LiveSignal[] = [];
    const mk = (kind: SignalKind, level: SignalLevel, title: string, text: string, reading: { source: string; fetchedAt: number }, value: number | null, delta: number | null): true => {
      out.push({ kind, mint: obs.mint, level, title, text, source: reading.source, dataAgeMs: Math.max(0, now - reading.fetchedAt), stale: false, value, delta, at: now });
      return true;
    };

    const num = (
      key: NumKey,
      reading: FieldReading | null | undefined,
      fire: (anchor: number, curVal: number, reading: FieldReading) => boolean | void,
    ): void => {
      if (!reading || reading.value === null || !Number.isFinite(reading.value)) return;
      const cur = reading.value;
      const prevLatest = prev.latest[key];
      const state: NumState = { value: cur, source: reading.source, fetchedAt: reading.fetchedAt };
      const cumulative = CUMULATIVE.has(key);
      if (!prevLatest) { next.latest[key] = state; if (cumulative) next.anchor[key] = cur; return; } // first: baseline only
      if (this.stale(reading, now)) return; // stale: keep the last fresh value, fire nothing, do not advance
      next.latest[key] = state; // latest always tracks the newest fresh value
      const anchor = cumulative ? (prev.anchor[key] ?? prevLatest.value) : prevLatest.value;
      const fired = fire(anchor, cur, reading) === true;
      if (cumulative && fired) next.anchor[key] = cur; // cumulative anchor advances only when a signal fires
    };

    num('dev', obs.dev, (was, cur, reading) =>
      was - cur >= t.devSellPct && mk('dev-sell', 'warn', 'dev sold', `creator sold — dev holding ${r1(was)}% → ${r1(cur)}%`, reading, r1(cur), r1(cur - was)));
    num('top10', obs.top10, (was, cur, reading) => {
      const d = cur - was;
      return Math.abs(d) >= t.concentrationPct && mk('concentration', d > 0 ? 'warn' : 'info', d > 0 ? 'top-10 up' : 'top-10 down', `top-10 concentration ${r1(was)}% → ${r1(cur)}% (pools excluded)`, reading, r1(cur), r1(d));
    });
    num('lpLocked', obs.lpLocked, (was, cur, reading) =>
      was - cur >= t.lpDropPct && mk('lp-unlock', 'down', 'LP unlocked', `LP locked dropped ${r1(was)}% → ${r1(cur)}%`, reading, r1(cur), r1(cur - was)));
    num('liq', obs.liq, (was, cur, reading) => {
      if (was > 0 && cur < was && (was - cur) / was >= t.liqDropFrac) {
        const pct = Math.round(((was - cur) / was) * 100);
        return mk('liquidity', 'down', 'liquidity fell', `liquidity fell ~${pct}% ($${fmtUsd(was)} → $${fmtUsd(cur)})`, reading, Math.round(cur), Math.round(cur - was));
      }
      return false;
    });
    num('bundled', obs.bundled, (was, cur, reading) =>
      cur - was >= t.bundlePct && mk('bundle', 'warn', 'bundle up', `bundled supply ${r1(was)}% → ${r1(cur)}% of the top sample`, reading, r1(cur), r1(cur - was)));
    num('snipers', obs.snipers, (was, cur, reading) =>
      cur - was >= t.sniperCount && mk('sniper', 'warn', 'snipers up', `snipers ${Math.round(was)} → ${Math.round(cur)} in the launch window`, reading, Math.round(cur), Math.round(cur - was)));
    num('fresh', obs.fresh, (was, cur, reading) =>
      cur - was >= t.freshPct && mk('fresh-wallet', 'warn', 'fresh wallets', `fresh-at-buy wallets ${r1(was)}% → ${r1(cur)}% of the top sample`, reading, r1(cur), r1(cur - was)));
    num('cluster', obs.cluster, () => false); // tracked for the rules field only; concentration covers the UI
    num('bonding', obs.bonding, (was, cur, reading) =>
      cur - was >= t.bondingStepPct && mk('bonding', 'info', 'bonding', `bonding curve ${r1(was)}% → ${r1(cur)}%`, reading, r1(cur), r1(cur - was)));

    // --- authorities: a false→true flip is the risk (minting / freezing re-enabled); true→false is good news.
    const auth = (key: 'mintAuth' | 'freezeAuth', reading: AuthReading | null | undefined, label: string, risk: string): void => {
      if (!reading || reading.present === null) return;
      const cur = reading.present;
      const was = prev.latestBool[key];
      const state: BoolState = { value: cur, source: reading.source, fetchedAt: reading.fetchedAt };
      if (!was) { next.latestBool[key] = state; return; }
      if (this.stale(reading, now)) return;
      if (was.value !== cur) {
        if (cur) mk('authority', 'warn', `${label} on`, `${label} re-enabled — ${risk}`, reading, 1, 1);
        else mk('authority', 'up', `${label} revoked`, `${label} revoked`, reading, 0, -1);
      }
      next.latestBool[key] = state;
    };
    auth('mintAuth', obs.mintAuth, 'mint authority', 'new supply can be minted');
    auth('freezeAuth', obs.freezeAuth, 'freeze authority', 'transfers can be frozen');

    // --- migration: once, on the false→true flip.
    if (obs.migrated && obs.migrated.value !== null) {
      const cur = obs.migrated.value;
      const was = prev.latestBool.migrated;
      const state: BoolState = { value: cur, source: obs.migrated.source, fetchedAt: obs.migrated.fetchedAt };
      if (!was) { next.latestBool.migrated = state; }
      else if (!this.stale(obs.migrated, now)) {
        if (!was.value && cur) mk('migrated', 'info', 'migrated', 'migrated to a DEX pool — bonding curve closed', obs.migrated, 1, 1);
        next.latestBool.migrated = state;
      }
    }

    this.state.set(obs.mint, next);
    return out;
  }

  /** The latest-known numeric fields for a mint, for the rules engine (null when never observed). */
  fields(mint: string): LiveSignalFields {
    const s = this.state.get(mint);
    const n = (x?: NumState): number | null => (x ? x.value : null);
    const b = (x?: BoolState): number | null => (x ? (x.value ? 1 : 0) : null);
    return {
      top10: n(s?.latest.top10), dev: n(s?.latest.dev), bundled: n(s?.latest.bundled), snipers: n(s?.latest.snipers), fresh: n(s?.latest.fresh),
      cluster: n(s?.latest.cluster), lpLocked: n(s?.latest.lpLocked), bonding: n(s?.latest.bonding),
      mintable: b(s?.latestBool.mintAuth), freezable: b(s?.latestBool.freezeAuth),
    };
  }

  /** A per-field snapshot with age + stale for the UI (null source = never observed). */
  snapshot(mint: string, now: number): Record<keyof LiveSignalFields | 'liq' | 'migrated', SignalFieldSnapshot> {
    const s = this.state.get(mint);
    const fromNum = (x?: NumState): SignalFieldSnapshot => this.snap(x, now);
    const fromBool = (x?: BoolState): SignalFieldSnapshot => (x ? { value: x.value ? 1 : 0, source: x.source, ageMs: Math.max(0, now - x.fetchedAt), stale: now - x.fetchedAt > this.thresholds.staleAfterMs } : { value: null, source: null, ageMs: null, stale: false });
    return {
      top10: fromNum(s?.latest.top10), dev: fromNum(s?.latest.dev), bundled: fromNum(s?.latest.bundled), snipers: fromNum(s?.latest.snipers),
      fresh: fromNum(s?.latest.fresh), cluster: fromNum(s?.latest.cluster), lpLocked: fromNum(s?.latest.lpLocked), bonding: fromNum(s?.latest.bonding),
      liq: fromNum(s?.latest.liq), mintable: fromBool(s?.latestBool.mintAuth), freezable: fromBool(s?.latestBool.freezeAuth), migrated: fromBool(s?.latestBool.migrated),
    };
  }

  private snap(x: NumState | undefined, now: number): SignalFieldSnapshot {
    if (!x) return { value: null, source: null, ageMs: null, stale: false };
    return { value: x.value, source: x.source, ageMs: Math.max(0, now - x.fetchedAt), stale: now - x.fetchedAt > this.thresholds.staleAfterMs };
  }

  /** Drop a mint's baseline (closed token the UI no longer tracks). */
  forget(mint: string): void { this.state.delete(mint); }

  /** Known mints (for hygiene / tests). */
  tracked(): string[] { return [...this.state.keys()]; }
}

function fmtUsd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${r1(n / 1e9)}B`;
  if (a >= 1e6) return `${r1(n / 1e6)}M`;
  if (a >= 1e3) return `${r1(n / 1e3)}K`;
  return String(Math.round(n));
}
