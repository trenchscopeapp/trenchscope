// trenchscope — live binding for WALLET INTEL (task-1340): runs the data layer's WalletIntel scan for the token on
// screen (light tier) or a watchlist coin (deep tier), keeps the result per mint, and builds the two view models
// the bubble map is drawn from: the terminal screen's (tui BubbleVM) and the popup's (popup BubbleVM, text-only,
// no keys). Every state is explicit: loading → ok (possibly degraded: keyless) → unavailable (with the reason and
// the fix), never a fake picture. Read-only: nothing here trades or signs.
import { WalletIntel, HIDDEN_LABELS, visibleLabels, EX_POOL_TAGS, BIG_HOLDER_PCT, type DataLayer, type ScanResult, type ScanDepth, type IntelAnalysis, type HolderClass } from '@dexterm/data';
import { bubbleVM, fmtNum, type BubbleVM as TuiBubbleVM } from '@dexterm/tui';
import type { BubbleVM as PopupBubbleVM, BubbleInsightsVM } from '@dexterm/popup';

export interface IntelEntry {
  mint: string;
  symbol: string;
  name: string;
  holderCount: number | null;
  state: 'loading' | 'ok' | 'unavailable';
  result: ScanResult | null;
  /** The terminal renderer's view model (null unless ok). */
  bubbles: TuiBubbleVM | null;
  at: number;
  error: string | null;
}

export interface IntelScanSeed { mint: string; symbol: string; name?: string; holderCount?: number | null }

export interface IntelLiveOptions {
  now?: () => number;
  onChange?: () => void;
  /** Deep tier for coins the user watches (design: deep scan for the watchlist). */
  isWatched?: (mint: string) => boolean;
  /** Test seam. */
  intel?: WalletIntel;
  /** Show the cabal-class labels (hidden by default until their precision is measured; design §5). */
  showHidden?: boolean;
}

/** Delay before an opened token is scanned, so flipping through tokens never spends history credits. */
export const INTEL_AUTOSCAN_DELAY_MS = 1_500;

export class IntelLive {
  private readonly intel: WalletIntel;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly isWatched: (mint: string) => boolean;
  private readonly showHidden: boolean;
  private readonly entries = new Map<string, IntelEntry>();
  private gen = new Map<string, number>();
  private autoscan: ReturnType<typeof setTimeout> | null = null;

  constructor(dl: DataLayer, opts: IntelLiveOptions = {}) {
    this.intel = opts.intel ?? new WalletIntel({ cache: dl.cache, http: dl.http, pool: dl.rpcPool, detail: dl.detail, health: dl.health, credits: dl.credits, clock: dl.clock });
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange ?? (() => {});
    this.isWatched = opts.isWatched ?? (() => false);
    this.showHidden = opts.showHidden ?? false;
  }

  /** The depth a mint gets: deep when watched, else light. */
  depthFor(mint: string): ScanDepth { return this.isWatched(mint) ? 'deep' : 'light'; }

  /** Whether the history leg (funders + launch window) can run; the screen prints the reason when not. */
  historyAvailable(): { ok: true } | { ok: false; why: string } { return this.intel.historyAvailable(); }

  entry(mint: string): IntelEntry | null { return this.entries.get(mint) ?? null; }

  /** Run (or re-run) the scan for a mint. Resolves when it settles; `view()` is readable throughout. */
  async scan(seed: IntelScanSeed, opts: { depth?: ScanDepth; force?: boolean } = {}): Promise<IntelEntry> {
    const depth = opts.depth ?? this.depthFor(seed.mint);
    const my = (this.gen.get(seed.mint) ?? 0) + 1;
    this.gen.set(seed.mint, my);
    const prev = this.entries.get(seed.mint);
    const e: IntelEntry = { mint: seed.mint, symbol: seed.symbol, name: seed.name ?? prev?.name ?? '', holderCount: seed.holderCount ?? prev?.holderCount ?? null, state: 'loading', result: prev?.result ?? null, bubbles: prev?.bubbles ?? null, at: this.now(), error: null };
    this.entries.set(seed.mint, e);
    this.onChange();
    try {
      const r = await this.intel.scan(seed.mint, depth, { force: opts.force });
      if (this.gen.get(seed.mint) !== my) return this.entries.get(seed.mint) ?? e;
      e.result = r;
      e.at = this.now();
      if (r.state === 'ok') {
        e.state = 'ok';
        const a = this.showHidden ? r.analysis : hideLabels(r.analysis);
        e.bubbles = bubbleVM(a, { symbol: e.symbol, name: e.name, mint: e.mint, holderCount: e.holderCount });
      } else { e.state = 'unavailable'; e.bubbles = null; }
    } catch (err) {
      if (this.gen.get(seed.mint) !== my) return this.entries.get(seed.mint) ?? e;
      e.state = 'unavailable'; e.error = err instanceof Error ? err.message : String(err); e.bubbles = null;
    } finally {
      if (this.gen.get(seed.mint) === my) this.onChange();
    }
    return e;
  }

  /** Schedule a light scan for an opened token after INTEL_AUTOSCAN_DELAY_MS (cancelled by the next open). */
  autoscanLater(seed: IntelScanSeed, delayMs = INTEL_AUTOSCAN_DELAY_MS): void {
    if (this.autoscan) clearTimeout(this.autoscan);
    const h = setTimeout(() => { this.autoscan = null; void this.scan(seed).catch(() => {}); }, delayMs);
    (h as { unref?: () => void }).unref?.();
    this.autoscan = h;
  }

  /**
   * task-1359: the NEW PAIRS list scans the row the cursor rests on (same delay as a token open, cancelled by
   * the next move), but only when the history leg can run: without a Helius key a scan cannot read the
   * launch window, so it would spend public-RPC calls to still print a dash. A mint already scanned or in
   * flight is left alone. Returns whether a scan was scheduled.
   */
  scanSelectedLater(seed: IntelScanSeed, delayMs = INTEL_AUTOSCAN_DELAY_MS): boolean {
    if (!this.intel.historyAvailable().ok) return false;
    const e = this.entries.get(seed.mint);
    if (e && (e.state === 'loading' || e.state === 'ok')) return false;
    this.autoscanLater(seed, delayMs);
    return true;
  }

  /** Cancel a pending autoscan (token closed). */
  cancelAutoscan(): void { if (this.autoscan) { clearTimeout(this.autoscan); this.autoscan = null; } }

  /** The analysis for a mint when the scan is ok, else null (the token screen's ON-CHAIN rows read this). */
  analysis(mint: string): IntelAnalysis | null {
    const e = this.entries.get(mint);
    return e && e.state === 'ok' && e.result?.state === 'ok' ? e.result.analysis : null;
  }

  close(): void { this.cancelAutoscan(); }
}

/** Drop the hidden-by-default labels from every holder (the renderer never sees a cabal-class label). */
export function hideLabels(a: IntelAnalysis): IntelAnalysis {
  return { ...a, holders: a.holders.map((h) => ({ ...h, labels: visibleLabels(h.labels, false) })), clusters: a.clusters.map((c) => ({ ...c, labels: c.labels.filter((l) => !HIDDEN_LABELS.has(l)) })) };
}

// ---------------------------------------------------------------------------------------------- launch cells (task-1359)
export type IntelLevel = 'ok' | 'warn' | 'bad' | 'na';
export interface IntelCell { /** Spotlight / token-row text. */ text: string; /** Table-column text (≤ 6 chars). */ short: string; level: IntelLevel }
export interface LaunchIntelCells { snipers: IntelCell; bundle: IntelCell; /** True only when the launch window was actually read (launchTxs > 0). */ measured: boolean }

/**
 * Snipers / bundled supply for one mint, from the wallet-intel scan only (never a guess). Shared by the token
 * screen's ON-CHAIN rows and the live NEW PAIRS columns + spotlight. Before a scan has read the launch window
 * both cells say why (scanning / needs a free Helius key / not scanned yet) and the short form is a dash.
 */
export function launchIntelCells(intel: Pick<IntelLive, 'entry' | 'analysis' | 'historyAvailable'> | null | undefined, mint: string, notScanned = 'not scanned yet'): LaunchIntelCells {
  const a = intel?.analysis(mint) ?? null;
  const I = a && a.insights.coverage.launchTxs > 0 ? a.insights : null;
  if (I) {
    const s = I.snipers, b = I.bundle;
    return {
      measured: true,
      snipers: { text: `${s.count} · ${s.launchWindowSharePct.toFixed(1)}% at launch`, short: String(s.count), level: s.launchWindowSharePct > 20 ? 'bad' : s.count > 3 ? 'warn' : 'ok' },
      bundle: { text: `${b.bundlePctOfTopSample.toFixed(1)}% · ${b.sameSlotCohorts} cohorts`, short: `${b.bundlePctOfTopSample.toFixed(0)}%`, level: b.bundlePctOfTopSample > 15 ? 'bad' : b.bundlePctOfTopSample > 5 ? 'warn' : 'ok' },
    };
  }
  const e = intel?.entry(mint) ?? null;
  const loading = e?.state === 'loading';
  const hist = intel ? intel.historyAvailable() : { ok: false as const, why: 'live mode only' };
  const r = e?.result?.state === 'ok' ? e.result : null;
  const why = loading ? 'scanning…' : a && r ? noLaunchWhy(r, hist) : !hist.ok ? historyWhy(hist.why, !intel) : notScanned;
  const na: IntelCell = { text: why, short: loading ? '…' : '—', level: 'na' };
  return { measured: false, snipers: na, bundle: { ...na } };
}

/**
 * task-1367: why an ok scan has no launch window. Before, every case printed "needs Helius key" — also with a key
 * configured, when Helius was rate-limited, the daily credit cap was hit or the history call failed. Now the
 * reason is the scan's own: only a missing key says "needs Helius key".
 */
function noLaunchWhy(r: Extract<ScanResult, { state: 'ok' }>, hist: { ok: true } | { ok: false; why: string }): string {
  if (r.via.history === 'helius') return r.degraded ? 'history failed · r' : 'no launch txs read';
  return historyWhy(r.degraded ?? (hist.ok ? '' : hist.why), false, hist.ok);
}

function historyWhy(why: string, noBinding: boolean, nowOk = false): string {
  if (noBinding || /Helius key/i.test(why)) return 'needs Helius key';
  if (/credit budget/i.test(why)) return 'Helius cap today';
  if (/Helius is/i.test(why)) return 'Helius paused · r';
  return nowOk ? 'not read · r retry' : 'needs Helius key';
}

/** Whether `r` on the token screen should re-run this mint's scan (an ok scan whose history leg did not land). */
export function launchRetryable(intel: Pick<IntelLive, 'entry' | 'historyAvailable'> | null | undefined, mint: string): boolean {
  const e = intel?.entry(mint);
  if (!intel || !e || e.state !== 'ok' || e.result?.state !== 'ok') return false;
  return e.result.analysis.insights.coverage.launchTxs === 0 && intel.historyAvailable().ok;
}

// ---------------------------------------------------------------------------------------------- holder classes (task-1367)
export interface HolderTagsView {
  /** owner → class, from the ok scan (empty before it lands). */
  byOwner: Map<string, HolderClass>;
  /** Raw (what explorers show) and ex-pool (no POOL/CURVE/VAULT/LOCK/BURN owners) top-10, null before the scan. */
  top10: { raw: number; exPool: number; dropped: number; droppedPct: number } | null;
  /** The one line the HOLDERS panel prints under its header: the main risk, or why the biggest holder is not one. */
  note: { text: string; level: 'bad' | 'info' } | null;
}

const shortA = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** The token screen's holder classes + concentration for a mint (pure over the IntelLive state). */
export function holderTags(intel: Pick<IntelLive, 'analysis'> | null | undefined, mint: string): HolderTagsView {
  const a = intel?.analysis(mint) ?? null;
  const byOwner = new Map<string, HolderClass>();
  if (!a) return { byOwner, top10: null, note: null };
  for (const h of a.holders) if (h.cls) byOwner.set(h.owner, h.cls);
  const T = a.insights.top10;
  const top10 = typeof T.exPool === 'number' ? { raw: T.byTokenAccount, exPool: T.exPool, dropped: T.exPoolDropped ?? 0, droppedPct: T.exPoolDroppedPct ?? 0 } : null;
  let note: HolderTagsView['note'] = null;
  const big = a.insights.bigHolder ?? null;
  if (big) {
    note = { text: `main risk: ${big.tag === 'DEV' ? 'CREATOR' : big.tag} ${shortA(big.owner)} holds ${big.pct.toFixed(1)}%`, level: 'bad' };
  } else {
    const top = a.holders[0];
    if (top?.cls && top.pct > BIG_HOLDER_PCT && EX_POOL_TAGS.has(top.cls.tag)) {
      const c = top.cls;
      const what = c.lock ? `${c.lock.program} escrow ${shortA(c.lock.escrow)}, ${c.lock.unlock ?? 'unlock not decoded'}` : c.program ?? 'burn address';
      note = { text: `top holder ${top.pct.toFixed(1)}% is ${c.tag} (${what}): not counted in ex-pool`, level: 'info' };
    }
  }
  return { byOwner, top10, note };
}

/** "unavailable: <reason> — <fix>" for the screen / popup banner. */
export function unavailableText(e: IntelEntry | null): { reason: string; fix: string | null } {
  if (!e) return { reason: 'no scan yet', fix: null };
  if (e.error) return { reason: e.error, fix: null };
  if (e.result?.state === 'unavailable') return { reason: e.result.reason, fix: e.result.fix };
  return { reason: 'no holder source answered', fix: null };
}

/** Build the popup's text-only view model from an entry (never a key, never a URL). */
export function popupBubbleVM(e: IntelEntry | null, seed: IntelScanSeed, selected: number | null, image: string | null = null): PopupBubbleVM {
  const base: PopupBubbleVM = { symbol: seed.symbol, name: seed.name ?? e?.name ?? '', mint: seed.mint, state: 'loading', reason: null, fix: null, depth: null, degraded: null, holders: [], clusters: [], insights: null, selected, via: null, updatedAt: e?.at ?? null, image };
  if (!e || e.state === 'loading') return base;
  if (e.state !== 'ok' || !e.result || e.result.state !== 'ok' || !e.bubbles) { const u = unavailableText(e); return { ...base, state: 'unavailable', reason: u.reason, fix: u.fix }; }
  const r = e.result;
  const I = r.analysis.insights;
  const clsOf = new Map(r.analysis.holders.map((h) => [h.owner, h.cls] as const));
  const insights: BubbleInsightsVM = {
    top10Raw: I.top10.byTokenAccount, top10Adjusted: I.top10.clusterAdjusted, excludedCount: I.top10.excludedCount,
    top10ExPool: I.top10.exPool ?? null, exPoolDropped: I.top10.exPoolDropped ?? 0,
    bigHolder: I.bigHolder ? { owner: I.bigHolder.owner, pct: I.bigHolder.pct, tag: I.bigHolder.tag } : null,
    snipers: I.coverage.launchTxs > 0 ? { count: I.snipers.count, launchSharePct: I.snipers.launchWindowSharePct } : null,
    bundlePct: I.coverage.launchTxs > 0 ? I.bundle.bundlePctOfTopSample : null,
    cohorts: I.coverage.launchTxs > 0 ? I.bundle.sameSlotCohorts : null,
    devPct: I.dev.creatorPctNow, devUpperBoundPct: I.dev.creatorUpperBoundPct,
    freshPct: I.coverage.fundingLookups > 0 ? I.fresh.freshAtBuyPctOfTopSample : null, freshMeasuredPct: I.coverage.fundingLookups > 0 ? I.fresh.measuredPct : null,
    sample: `sample top ${I.coverage.topHoldersFetched} accts${e.holderCount ? ` of ${fmtNum(e.holderCount)} holders` : ''} · ${I.coverage.supplyCoveredPct}% supply · funders ${I.coverage.fundingLookups}/${I.coverage.topHoldersFetched} · launch ${I.coverage.launchTxs} txs${I.coverage.launchMorePages ? '+' : ''}`,
  };
  return {
    ...base, state: 'ok', depth: r.depth, degraded: r.degraded, via: r.via.history ? `${r.via.holders} + helius history` : r.via.holders,
    holders: e.bubbles.holders.map((h) => ({ owner: h.owner, pct: h.pct, kind: h.kind, labels: h.labels.map((l) => ({ label: l.label, rule: l.rule, confidence: l.confidence })), funder: h.funder ? { address: h.funder.address, label: h.funder.label, blockTime: h.funder.blockTime } : null, walletFirstSeen: h.walletFirstSeen, cluster: h.cluster, cls: clsVM(clsOf.get(h.owner)) })),
    clusters: e.bubbles.clusters.filter((c) => c.members.length > 1).map((c) => ({ name: c.name, kind: c.kind, members: c.members.slice(), pct: c.pct, evidence: c.evidence.map((v) => ({ a: v.a, b: v.b, rule: v.rule, linked: v.linked })) })),
    insights,
  };
}

function clsVM(c: HolderClass | undefined): NonNullable<PopupBubbleVM['holders'][number]['cls']> | null {
  return c ? { tag: c.tag, reason: c.reason, lock: c.lock ? { escrow: c.lock.escrow, program: c.lock.program, unlock: c.lock.unlock, note: c.lock.note } : null } : null;
}
