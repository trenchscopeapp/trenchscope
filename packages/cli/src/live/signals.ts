// trenchscope — LIVE holder/rug SIGNALS binding (task-1404). Turns the open token's repeatedly-refreshed holder and
// safety reads (market/authorities/rugcheck panels + the wallet-intel scan + the fast-lane bonding curve) into
// SIGNAL events through the pure @dexterm/data LiveSignalsEngine, keeps a small per-mint log for the token screen,
// and exposes the latest numeric values as RULE FIELDS so every signal is an alert trigger (task-1398 pattern).
//
// It owns no timers and does no I/O: the UI loop / LiveContext calls observe() whenever the token, the intel scan
// or a fast-lane push changed something. The engine dedups (only a threshold-crossing change emits), so calling it
// on every redraw is cheap. Read-only: nothing here trades or signs.
import {
  LiveSignalsEngine,
  bondingProgress,
  type LiveSignal,
  type LiveSignalFields,
  type SignalFieldSnapshot,
  type SignalObservation,
  type FieldReading,
  type AuthReading,
  type IntelAnalysis,
  type BondingCurve,
  type SignalThresholds,
} from '@dexterm/data';
import type { TokenView, PanelStatus } from './token.ts';

/** Max signals kept per mint for the token-screen strip (newest first). */
export const SIGNALS_LOG_MAX = 40;

/** What the binding needs to read one moment of a token's state. All optional so a partial read still works. */
export interface SignalInputs {
  view: TokenView;
  /** The settled wallet-intel scan for this mint (null when it has not landed / is keyless). */
  intel: { analysis: IntelAnalysis | null; fetchedAt: number | null; via: string | null } | null;
  /** The last decoded fast-lane bonding curve + when it was decoded (null when not streaming). */
  curve: { curve: BondingCurve; at: number } | null;
}

function fromPanel(p: PanelStatus | undefined, value: number | null | undefined, fallbackSource: string): FieldReading | null {
  if (!p || value == null || !Number.isFinite(value) || p.fetchedAt == null) return null;
  return { value, source: p.via ?? fallbackSource, fetchedAt: p.fetchedAt, stale: p.stale || p.state === 'error' };
}

function authFromPanel(p: PanelStatus | undefined, present: boolean | null | undefined): AuthReading | null {
  if (!p || present == null || p.fetchedAt == null) return null;
  return { present, source: p.via ?? 'authorities', fetchedAt: p.fetchedAt, stale: p.stale || p.state === 'error' };
}

function fromIntel(value: number | null | undefined, intel: SignalInputs['intel']): FieldReading | null {
  if (value == null || !Number.isFinite(value) || !intel || intel.fetchedAt == null) return null;
  return { value, source: intel.via ?? 'helius', fetchedAt: intel.fetchedAt, stale: false };
}

/**
 * Build one observation from the token view + intel scan + fast-lane curve. Each field keeps its OWN source and
 * fetch time so a signal is honest about where it came from and how old the data is. The richer wallet-intel
 * figures (ex-pool top-10, creator %, bundled, snipers, fresh, cluster) are preferred when the scan has landed;
 * otherwise the panel reads (Jupiter audit top-10/dev) stand in. Pure + exported for the tests.
 */
export function buildObservation(inputs: SignalInputs, now: number): SignalObservation {
  const v = inputs.view;
  const I = inputs.intel?.analysis?.insights ?? null;
  const panels: Partial<Record<keyof TokenView['panels'], PanelStatus>> = v.panels ?? {};
  const obs: SignalObservation = { mint: v.mint, at: now };

  // top-10 concentration (pools excluded): the scan's ex-pool figure first, else the holders panel's top-10.
  obs.top10 = (I && typeof I.top10.exPool === 'number' ? fromIntel(I.top10.exPool, inputs.intel) : null) ?? fromPanel(panels.holders, v.top10, 'holders');
  // creator / dev share: the scan's creatorPctNow first, else the market panel's Jupiter audit devPct.
  obs.dev = (I ? fromIntel(I.dev.creatorPctNow, inputs.intel) : null) ?? fromPanel(panels.market, v.dev, 'jupiter');
  // bundled / snipers / fresh / cluster only exist once the launch window / funders were read (Helius).
  if (I && I.coverage.launchTxs > 0) {
    obs.bundled = fromIntel(I.bundle.bundlePctOfTopSample, inputs.intel);
    obs.snipers = fromIntel(I.snipers.count, inputs.intel);
  }
  if (I && I.coverage.fundingLookups > 0) obs.fresh = fromIntel(I.fresh.freshAtBuyPctOfTopSample, inputs.intel);
  const cluster = inputs.intel?.analysis?.clusters?.[0]?.pct ?? null;
  obs.cluster = fromIntel(cluster, inputs.intel);
  // LP locked (RugCheck), liquidity (market), mint/freeze authority (authorities panel).
  obs.lpLocked = fromPanel(panels.rugcheck, v.lpLocked, 'rugcheck');
  obs.liq = fromPanel(panels.market, v.liq, 'market');
  obs.mintAuth = authFromPanel(panels.authorities, v.mintAuth);
  obs.freezeAuth = authFromPanel(panels.authorities, v.freezeAuth);
  // bonding-curve progress + migration from the on-chain fast-lane push (sub-second), when streaming.
  if (inputs.curve) {
    const bp = bondingProgress(inputs.curve.curve.vToken);
    if (bp != null) obs.bonding = { value: bp, source: 'onchain-curve', fetchedAt: inputs.curve.at, stale: false };
    obs.migrated = { value: inputs.curve.curve.complete, source: 'onchain-curve', fetchedAt: inputs.curve.at, stale: false };
  }
  return obs;
}

export interface LiveSignalsOptions {
  now?: () => number;
  /** Fired for every new signal (LiveContext routes it to the toast + the rules/alerts log). */
  onSignal?: (s: LiveSignal) => void;
  thresholds?: Partial<SignalThresholds>;
}

export class LiveSignalsLive {
  readonly engine: LiveSignalsEngine;
  private readonly now: () => number;
  private readonly onSignal?: (s: LiveSignal) => void;
  private readonly logByMint = new Map<string, LiveSignal[]>();
  /** Signals emitted this session (all mints), newest last — a cheap counter/feed for the smoke script + tests. */
  readonly emitted: LiveSignal[] = [];

  constructor(opts: LiveSignalsOptions = {}) {
    this.engine = new LiveSignalsEngine({ thresholds: opts.thresholds });
    this.now = opts.now ?? (() => Date.now());
    this.onSignal = opts.onSignal;
  }

  /** Observe one moment of a token's state; records and returns any new signals. */
  observe(inputs: SignalInputs): LiveSignal[] {
    const obs = buildObservation(inputs, this.now());
    const sigs = this.engine.observe(obs);
    for (const s of sigs) {
      const arr = this.logByMint.get(s.mint) ?? [];
      arr.unshift(s);
      if (arr.length > SIGNALS_LOG_MAX) arr.length = SIGNALS_LOG_MAX;
      this.logByMint.set(s.mint, arr);
      this.emitted.push(s);
      this.onSignal?.(s);
    }
    return sigs;
  }

  /** Recent signals for a mint, newest first (token-screen LIVE SIGNALS strip). */
  recent(mint: string, limit = 8): LiveSignal[] {
    return (this.logByMint.get(mint) ?? []).slice(0, limit);
  }

  /** Latest numeric fields for the rules engine (merged into the open-token RuleRow in ruleRowsOf). */
  fields(mint: string): LiveSignalFields {
    return this.engine.fields(mint);
  }

  /** Per-field snapshot (value + source + age + stale) for the strip header. */
  snapshot(mint: string, now = this.now()): Record<keyof LiveSignalFields | 'liq' | 'migrated', SignalFieldSnapshot> {
    return this.engine.snapshot(mint, now);
  }

  /** Drop a mint the UI no longer tracks. */
  forget(mint: string): void {
    this.engine.forget(mint);
    this.logByMint.delete(mint);
  }
}
