// CLI ↔ popup-host wiring (task-1290; chart v2 task-1325). Maps the app's live TokenView + active Theme into the
// popup protocol's view models and theme tokens, and owns the window lifecycle for the token screen's chart
// popup. The heavy lifting (loopback server, frameless shell, browser fallback) lives in @dexterm/popup;
// this file is the thin, app-aware adapter the interactive loop calls.
//
// task-1325: the chart popup is a TradingView Lightweight Charts page with its OWN timeframe. When it asks
// for an interval, this adapter answers from TokenLive's in-memory candle cache (1m/1h bases, 5m/15m/4h/1d
// derived locally) — never a fetch. Every terminal tick re-sends the view model: a full series when the series
// changed, otherwise just the last two bars ("tail"), so a live tick costs the page one `series.update`.
// When the coin is held (task-1323 PositionSource) the VM carries the position row + entry/stop/target levels
// and the fills of the current position from the paper ledger. Read-only: nothing here can trade.
import { createPopupManager, loadConfig, nativeShellAvailable, TerminalDock, CHART_INTERVALS, type DockPlacement, type PopupConfig, type PopupManager, type PopupManagerOptions, type ChartVM, type TokenDetailVM, type ThemeTokens, type ChartPrefs, type ChartPosition, type ChartFill, type PositionCell, type ChartIndicator, type ServerEvent, type BubbleVM, type NarrativeBoardVM, type PlansVM, type FeedVM, type WidgetPage, type WidgetTopic, type WidgetPayload } from '@dexterm/popup';
import type { Candle, CandleInterval } from '@dexterm/data';
import type { Theme } from '@dexterm/tui';
import { fmtPrice, fmtNum } from '@dexterm/tui';
import type { TokenView } from './live/token.ts';
import { positionRow, type HeldPosition, type HeldRow, type PositionSource } from './live/trade.ts';
import { signedUsd, signedPctOf, fmtUsdFine, sol as fmtSol, signedSol } from './screens/positions.ts';
import { supplyRatio, positionPriceCells, type PriceMode } from './display.ts';

/** The subset of the popup controller the interactive loop (and AppState) depends on. */
export interface PopupController {
  /** Open the chart popup for a token (or no-op if already open), and push its first view model. */
  openChart(view: TokenView): Promise<{ native: boolean; reason: string }>;
  /** Close the chart popup if open; never affects the terminal. */
  closeChart(): void;
  /** Push a fresh view model to the open chart popup (the popup follows the open/highlighted coin). */
  syncChart(view: TokenView): void;
  /** Whether a chart popup is currently open. */
  chartOpen(): boolean;
  /** True once a popup opened in a native frameless window (false under the browser fallback). */
  readonly native: boolean | null;
  /** Tear down the window host + loopback server. Safe to call more than once. */
  shutdown(): void;
  // ---- task-1340 bubble map popup (optional so older fakes still type-check)
  openBubbles?(vm: BubbleVM): Promise<{ native: boolean; reason: string }>;
  closeBubbles?(): void;
  syncBubbles?(vm: BubbleVM): void;
  bubblesOpen?(): boolean;
  // ---- task-1356 narrative board popup
  openNarrative?(vm: NarrativeBoardVM): Promise<{ native: boolean; reason: string }>;
  closeNarrative?(): void;
  syncNarrative?(vm: NarrativeBoardVM): void;
  narrativeOpen?(): boolean;
  // ---- task-1355 order plans & mandates popup (read-only HUD; the only write is plan.cancel)
  openPlans?(vm: PlansVM): Promise<{ native: boolean; reason: string }>;
  closePlans?(): void;
  syncPlans?(vm: PlansVM): void;
  plansOpen?(): boolean;
  // ---- task-1359 token-detail + feeds popups (read-only HUDs; the feeds window may only ask to open a coin)
  openToken?(vm: TokenDetailVM): Promise<{ native: boolean; reason: string }>;
  closeToken?(): void;
  syncToken?(vm: TokenDetailVM): void;
  tokenOpen?(): boolean;
  openFeeds?(vm: FeedVM, mints: readonly (string | null)[]): Promise<{ native: boolean; reason: string }>;
  closeFeeds?(): void;
  syncFeeds?(vm: FeedVM, mints: readonly (string | null)[]): void;
  feedsOpen?(): boolean;
  // ---- task-1358 Tier 5 pack widgets (read-only HUDs served from an ENABLED pack; they can only receive view models)
  openWidget?(page: WidgetPage): Promise<{ native: boolean; reason: string }>;
  closeWidget?(key: string): void;
  widgetOpen?(key: string): boolean;
  /** Every open widget with the topics it declared (the sync path pushes exactly those). */
  openWidgets?(): Array<{ key: string; topics: WidgetTopic[] }>;
  syncWidget?(key: string, topic: WidgetTopic, payload: WidgetPayload): void;
}

/** Map the app's active Theme to the popup protocol's theme-token subset. */
export function popupThemeFrom(t: Theme): ThemeTokens {
  return {
    bg: t.bg, panel: t.panel, panelAlt: t.panelAlt, border: t.border, borderFocus: t.borderFocus,
    text: t.text, muted: t.muted, dim: t.dim, accent: t.accent, up: t.up, down: t.down, warn: t.warn, ai: t.ai,
    pump: t.pump, dbc: t.dbc, rain: t.rain, rainPump: t.rainPump, rainDump: t.rainDump, scan: t.scan, glow: t.glow,
  };
}

// ---------------------------------------------------------------------------------------------- chart v2 VM
/** A cached candle series as TokenLive.cachedSeries returns it. */
export interface CachedSeries { candles: Candle[]; fetchedAt: number; stale: boolean; derived: boolean }

/** A ledger fill as the paper wallet stores it (`PaperWallet.trades()` rows satisfy this structurally). */
export interface LedgerFill { t: number; side: 'buy' | 'sell'; grossLamports: bigint; tokenDelta: bigint; decimals: number; priceUsd: number | null }

/** Most bars one VM carries (the 1m base is 1000 bars; this only guards a future bigger base). */
export const CHART_MAX_BARS = 1500;
export const DEFAULT_CHART_PREFS: ChartPrefs = { style: 'candles', scale: 'auto', indicators: ['volume', 'tape', 'ema9', 'ema21'] };

/** Everything beyond the TokenView the chart VM needs; all optional (defaults = the task-1290 behaviour). */
export interface ChartExtras {
  /** The popup's own timeframe (defaults to the terminal's `view.interval`). */
  interval?: CandleInterval;
  /** The cached/derived series for `interval` (TokenLive.cachedSeries), or null when that base is cold. */
  series?: CachedSeries | null;
  feed?: 'LIVE' | 'POLL';
  /** The price the terminal header shows (fast-lane push when LIVE). */
  livePrice?: number | null;
  /** task-1323 PositionSource lookup result for this mint (null = flat). */
  held?: HeldPosition | null;
  positionKind?: 'paper' | 'live';
  solUsd?: number | null;
  /** Fills of the current position, oldest first. */
  fills?: ChartFill[];
  prefs?: ChartPrefs;
  now?: number;
  /** task-1326: the coin image as a same-origin popup path (`/img/<key>.png`) when cached, else null. */
  image?: string | null;
  /** task-1366: the terminal's price display mode (default price). */
  priceMode?: PriceMode;
}

const finitePos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
/** Token amounts up to trillions (same rule as the terminal's position row). */
function fmtAmt(n: number): string { return n >= 1e12 ? `${(n / 1e12).toFixed(2)}T` : fmtNum(n); }
function pxText(usd: number | null, solPx: number | null): string {
  if (usd !== null) return fmtPrice(usd);
  if (solPx !== null) return `${fmtPrice(solPx).replace('$', '')} SOL`;
  return '—';
}

/**
 * The popup's position row cells — the SAME fields, order and formatting as the terminal's task-1323 row
 * (token-live.ts positionPanel): SIDE · SIZE · VALUE · AVG ENTRY · PRICE · UNREALIZED, then REALIZED (only
 * when non-zero) and STOP / TARGET (only when set). The page renders them as text only.
 */
export function positionCells(r: HeldRow, mode: PriceMode = 'price', supply: number | null = null): PositionCell[] {
  const usd = r.solUsd !== null;
  const tone = (n: number | null): PositionCell['tone'] => (n === null ? 'muted' : n > 0 ? 'up' : n < 0 ? 'down' : 'muted');
  const cells: PositionCell[] = [];
  cells.push({ label: 'SIDE', value: r.side.toUpperCase(), tone: r.side === 'long' ? 'up' : 'down' });
  cells.push({ label: 'SIZE', value: `${fmtAmt(r.tokens)} ${r.symbol}`, tone: 'text' });
  cells.push({ label: 'VALUE', value: r.valueUsd !== null ? fmtUsdFine(r.valueUsd) : r.valueSol !== null ? `${fmtSol(r.valueSol)} SOL` : '—', tone: 'text' });
  // task-1366: in mcap mode (supply known) AVG / PRICE read market cap, exactly like the terminal's row; PnL stays USD
  const pc = positionPriceCells(mode, supply, r.avgEntryUsd, r.priceUsd, pxText(r.avgEntryUsd, r.avgEntrySol), pxText(r.priceUsd, r.priceSol));
  cells.push({ label: pc.avg.label, value: pc.avg.value, tone: 'muted' });
  cells.push({ label: pc.price.label, value: pc.price.value, tone: 'text' });
  const uAmt = usd ? (r.unrealizedUsd !== null ? signedUsd(r.unrealizedUsd) : null) : (r.unrealizedSol !== null ? `${signedSol(r.unrealizedSol)} SOL` : null);
  cells.push({ label: 'UNREALIZED', value: uAmt === null ? '—' : `${uAmt}${r.unrealizedPct !== null ? ` ${signedPctOf(r.unrealizedPct)}` : ''}`, tone: tone(r.unrealizedSol) });
  if (r.realizedSol !== 0) cells.push({ label: 'REALIZED', value: usd && r.realizedUsd !== null ? signedUsd(r.realizedUsd) : `${signedSol(r.realizedSol)} SOL`, tone: tone(r.realizedSol) });
  if (r.stopUsd !== null) cells.push({ label: 'STOP', value: `${fmtPrice(r.stopUsd)}${r.stopDistPct !== null ? ` ${signedPctOf(r.stopDistPct)}` : ''}`, tone: 'down' });
  if (r.targetUsd !== null) cells.push({ label: 'TARGET', value: `${fmtPrice(r.targetUsd)}${r.targetDistPct !== null ? ` ${signedPctOf(r.targetDistPct)}` : ''}`, tone: 'up' });
  return cells;
}

/** The chart's position model from the shared task-1323 selector (PositionSource → positionRow). */
export function chartPositionFrom(held: HeldPosition, tickUsd: number | null, solUsd: number | null, kind: 'paper' | 'live', fills: ChartFill[] = [], mode: PriceMode = 'price', supply: number | null = null): ChartPosition {
  const r = positionRow(held, tickUsd, solUsd);
  const caption = r.basis === 'none' ? 'no price yet' : r.solUsd !== null ? `${kind} ledger · SOL $${r.solUsd.toFixed(2)}` : `${kind} ledger · SOL units (no SOL/USD yet)`;
  return {
    kind, side: r.side, symbol: r.symbol, tokens: r.tokens, sizeLabel: `${fmtAmt(r.tokens)} ${r.symbol}`,
    avgEntryUsd: finitePos(r.avgEntryUsd) ? r.avgEntryUsd : null,
    priceUsd: r.priceUsd, unrealizedPct: r.unrealizedPct, stopUsd: r.stopUsd, targetUsd: r.targetUsd,
    caption, cells: positionCells(r, mode, supply), fills,
  };
}

/**
 * Fills of the CURRENT position: replay the ledger oldest → newest and keep only the fills since the
 * balance was last flat, so markers from a closed earlier round-trip do not clutter the chart.
 */
export function currentPositionFills(trades: readonly LedgerFill[]): ChartFill[] {
  const sorted = [...trades].sort((a, b) => a.t - b.t);
  let bal = 0n;
  let cycle: ChartFill[] = [];
  for (const f of sorted) {
    bal += f.tokenDelta;
    const gross = f.grossLamports < 0n ? -f.grossLamports : f.grossLamports;
    const tokRaw = f.tokenDelta < 0n ? -f.tokenDelta : f.tokenDelta;
    cycle.push({ t: f.t, side: f.side, priceUsd: f.priceUsd ?? null, sol: Number(gross) / 1e9, tokens: Number(tokRaw) / 10 ** f.decimals });
    if (bal <= 0n) { bal = 0n; cycle = []; }
  }
  return cycle;
}

/**
 * Build the chart popup view model from the live TokenView (candles + header stats; no keys, no commands).
 * With no extras this is the task-1290 VM (the terminal's interval and its visible candles). With extras it
 * is the task-1325 VM: the popup's own interval from the cache, the tape, the feed + live price, the held
 * position and the run's chart preferences.
 */
export function chartVMFromView(v: TokenView, x: ChartExtras = {}): ChartVM {
  const iv = x.interval ?? v.interval;
  let candles: Candle[];
  let cold = false;
  let source: ChartVM['source'];
  if (x.series && x.series.candles.length) {
    candles = x.series.candles.length > CHART_MAX_BARS ? x.series.candles.slice(-CHART_MAX_BARS) : x.series.candles;
    source = iv === v.interval
      ? { state: v.panels.candles.state, stale: v.panels.candles.stale, reason: v.panels.candles.reason }
      : { state: 'ok', stale: x.series.stale, reason: null };
  } else if (iv === v.interval) {
    candles = v.candles;
    source = { state: v.panels.candles.state, stale: v.panels.candles.stale, reason: v.panels.candles.reason };
  } else {
    candles = [];
    cold = true;
    source = { state: 'loading', stale: false, reason: null };
  }
  const bars = candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
  const openBarT = bars.length ? bars[bars.length - 1].t : null;
  const vm: ChartVM = {
    symbol: v.symbol, name: v.name, mint: v.mint, interval: iv,
    price: v.price, chg: { m5: v.chg.m5, h1: v.chg.h1, h6: v.chg.h6, h24: v.chg.h24 },
    liq: v.liq, vol24: v.vol24, mcap: v.mcap,
    candles: bars, openBarT, updatedAt: v.updatedAt,
  };
  // task-1290 shape when called without extras (kept byte-compatible for the v1 test and the self-test)
  if (Object.keys(x).length === 0) return vm;
  const tick = x.feed === 'LIVE' && finitePos(x.livePrice) ? x.livePrice : v.price;
  vm.mode = 'full';
  vm.seriesKey = `${v.mint}|${iv}|${bars.length ? bars[0].t : 'none'}`;
  vm.cold = cold;
  vm.source = source;
  vm.feed = x.feed ?? 'POLL';
  vm.livePrice = x.feed === 'LIVE' && finitePos(x.livePrice) ? x.livePrice : null;
  vm.trades = v.trades.map((t) => ({ t: t.t, side: t.side, usd: t.usd, price: t.price })); // no wallet addresses
  const mode: PriceMode = x.priceMode === 'mcap' ? 'mcap' : 'price';
  const supply = mode === 'mcap' ? supplyRatio(v.price, v.mcap) : null;
  vm.position = x.held ? chartPositionFrom(x.held, tick, x.solUsd ?? null, x.positionKind ?? 'paper', x.fills ?? [], mode, supply) : null;
  vm.prefs = x.prefs ?? DEFAULT_CHART_PREFS;
  vm.sentAt = x.now ?? Date.now();
  vm.image = x.image ?? null;
  // task-1366: display only — the bars stay USD prices; the page formats the axis as price × supply in mcap mode
  vm.priceMode = mode;
  vm.supply = supply;
  return vm;
}

/** Build the token-detail popup view model from the live TokenView (reused by the openPopup interface / Jarvis). */
export function tokenDetailVMFromView(v: TokenView, intel: TokenDetailVM['intel'] = null): TokenDetailVM {
  return {
    intel,
    symbol: v.symbol, name: v.name, mint: v.mint, launchpad: v.launchpad,
    price: v.price, chg: { m5: v.chg.m5, h1: v.chg.h1, h6: v.chg.h6, h24: v.chg.h24 },
    mcap: v.mcap, fdv: v.fdv, liq: v.liq, vol24: v.vol24, holders: v.holders, top10: v.top10,
    dev: v.dev, lpLocked: v.lpLocked, mintAuth: v.mintAuth, freezeAuth: v.freezeAuth,
    rugScore: v.rug?.score ?? null, risks: (v.rug?.risks ?? []).map((r) => ({ name: r.name, level: r.level })),
    flags: v.flags.map((f) => String(f)), holdersSample: v.holdersSample, updatedAt: v.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------- the controller
/** Where the chart popup reads the terminal's live state from. Every method is local + synchronous: no fetches. */
export interface ChartSource {
  /** TokenLive.cachedSeries for the open token (null when `mint` is not the open token or the base is cold). */
  series(mint: string, iv: CandleInterval): CachedSeries | null;
  /** The fast-lane price the terminal header shows while LIVE, else null. */
  livePrice(mint: string): number | null;
  feed(mint: string): 'LIVE' | 'POLL';
  /** The task-1323 positions selector (paper ledger today). */
  positions: PositionSource | null;
  /** The ledger's fills for this mint (any order). */
  fills(mint: string): readonly LedgerFill[];
  /** SOL/USD as the terminal knows it (header SOL price, else the position source's). */
  solUsd(): number | null;
  /** task-1326: the popup image path for the open token when its thumbnail is cached, else null. */
  imagePath?(view: TokenView): string | null;
  /** task-1366: the terminal's price display mode right now (`$` toggles it); absent = price. */
  priceMode?(): PriceMode;
}

/** What TokenPopups needs from the dock (TerminalDock in the app; a fake in tests). */
export interface DockLike {
  readonly kind: string;
  place(timeoutMs?: number): Promise<DockPlacement | null>;
  follow(onPlace: (p: DockPlacement) => void): void;
  stop(): void;
}

/** "docked right of Terminal" / "screen right (unknown terminal)" — for the TUI toast. */
export function describeDock(p: DockPlacement | null): string | null {
  if (!p) return null;
  const app = p.kind === 'terminal' ? 'Terminal' : p.kind === 'iterm' ? 'iTerm2' : 'the terminal';
  if (p.mode === 'right') return `docked right of ${app}`;
  if (p.mode === 'left') return `docked left of ${app} (no room on the right)`;
  if (p.mode === 'overlap') return `pinned at the screen edge over ${app} (no room beside it)`;
  return 'screen right (terminal not detected)';
}

/** Measured popup timings (exposed for the self-test / measurement harness). */
export interface ChartMetrics {
  openedAt: number | null;
  /** Dock probe (osascript) time before the window opens. */
  dockProbeMs: number | null;
  /** Re-docks sent while following the terminal. */
  redocks: number;
  /** TokenPopups.openChart → the page's first painted chart, wall ms (includes ticket, page load, WS, first paint). */
  openToFirstPaintMs: number | null;
  /** setData (VM built) → page repaint, wall ms, as reported by the page. */
  dataToPaintMs: number[];
  intervalRequests: number;
  pushes: { full: number; tail: number };
}

export interface TokenPopupsOptions {
  theme: Theme;
  env?: NodeJS.ProcessEnv;
  /** A note the loop can surface as a toast (fallback reason, interval change, errors). */
  onNote?: (msg: string) => void;
  /** Notified when the popup switches ITS timeframe (task-1325: the terminal's own timeframe is untouched). */
  onInterval?: (interval: string) => void;
  /** task-1325: the live state the chart reads (cache, feed, positions). Absent → the task-1290 VM. */
  source?: ChartSource | null;
  /** Minimum spacing between pushes to the page (trailing-edge coalesced). Default 50 ms. */
  syncMinMs?: number;
  now?: () => number;
  /** Test seam: override how the popup manager is constructed (defaults to @dexterm/popup createPopupManager). */
  createManager?: (opts: PopupManagerOptions) => PopupManager;
  /** task-1325 docking: 'auto' = TerminalDock when it can work (macOS + native shell + popup.json dock.enabled);
   *  a DockLike (tests); null/absent = off (the default, so unit tests never spawn osascript). */
  dock?: DockLike | null | 'auto';
  /** task-1326: serves the terminal's cached coin thumbnails to the popup server's `/img/<key>.png` route. */
  imageProvider?: (key: string) => Uint8Array | null;
  /** task-1340: the bubble-map popup reported a click on a holder (validated base58 address). */
  onHolderSelected?: (address: string) => void;
  /** task-1355: the plans popup asked to cancel a plan (id already shape-checked; the TUI re-validates it
   *  against its own live plan list before acting). This is the ONLY write the plans popup can request. */
  onPlanCancel?: (id: string) => void;
  /** task-1359: the feeds popup asked to open the coin behind item `i` (resolved terminal-side; never a URL). */
  onFeedSelected?: (mint: string) => void;
  /** task-1358 Tier 5: a pack widget page connected and said ready (push its first view models now). */
  onWidgetReady?: (key: string) => void;
}

/**
 * Owns the token screen's chart popup. Lazily starts the popup host on first open. If the native shell or a
 * display is unavailable the manager falls back to the OS browser and `onNote` explains it; closing the
 * popup (or quitting) never touches the terminal.
 */
export class TokenPopups implements PopupController {
  private mgr: PopupManager | null = null;
  private chartId: string | null = null;
  private chartHandle: { id: string; close: () => void; setData: (d: ChartVM) => void; setBounds?: (r: { x: number; y: number; w: number; h: number }) => void } | null = null;
  private readonly theme: Theme;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onNote?: (msg: string) => void;
  private readonly onInterval?: (interval: string) => void;
  private readonly makeManager: (opts: PopupManagerOptions) => PopupManager;
  private readonly source: ChartSource | null;
  private readonly syncMinMs: number;
  private readonly now: () => number;
  /** The popup's own timeframe (null = follow the terminal's until the popup asks for one). */
  private interval: CandleInterval | null = null;
  /** Chart preferences remembered for the run (re-applied on reopen). */
  prefs: ChartPrefs = { ...DEFAULT_CHART_PREFS, indicators: [...DEFAULT_CHART_PREFS.indicators] };
  private ready = false;
  private forceFull = true;
  private lastKey: string | null = null;
  private lastLen = 0;
  private lastPushAt = -Infinity;
  private lastView: TokenView | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private fillsMemo: { mint: string; at: number; v: ChartFill[] } | null = null;
  private readonly dockOpt: DockLike | null | 'auto';
  private readonly imageProvider?: (key: string) => Uint8Array | null;
  private readonly onHolderSelected?: (address: string) => void;
  /** task-1340 bubble-map popup (independent of the chart: both may be open). */
  private bubblesId: string | null = null;
  private bubblesHandle: { id: string; close: () => void; setData: (d: BubbleVM) => void } | null = null;
  private narrativeId: string | null = null;
  private narrativeHandle: { id: string; close: () => void; setData: (d: NarrativeBoardVM) => void } | null = null;
  private readonly onPlanCancel?: (id: string) => void;
  private plansId: string | null = null;
  private plansHandle: { id: string; close: () => void; setData: (d: PlansVM) => void } | null = null;
  private readonly onFeedSelected?: (mint: string) => void;
  private tokenId: string | null = null;
  private tokenHandle: { id: string; close: () => void; setData: (d: TokenDetailVM) => void } | null = null;
  private feedsId: string | null = null;
  private feedsHandle: { id: string; close: () => void; setData: (d: FeedVM) => void } | null = null;
  /** The mint behind each feeds item, in the newest-first order the page indexes (`feed.selected` → { i }). */
  private feedsMints: readonly (string | null)[] = [];
  /** task-1358 Tier 5: open pack widgets by key (`<pack>/<widget>/<id>`). */
  private widgets = new Map<string, { id: string; handle: { close: () => void; sendData?: (t: WidgetTopic, p: WidgetPayload) => void }; topics: WidgetTopic[] }>();
  private readonly onWidgetReady?: (key: string) => void;
  private dockImpl: DockLike | null = null;
  private cfg: PopupConfig | null = null;
  /** Where the chart window was placed (null = shell default / browser). */
  placement: DockPlacement | null = null;
  /** True once the user dragged the window away: stop following the terminal until the next open. */
  undocked = false;
  readonly metrics: ChartMetrics = { openedAt: null, dockProbeMs: null, redocks: 0, openToFirstPaintMs: null, dataToPaintMs: [], intervalRequests: 0, pushes: { full: 0, tail: 0 } };
  native: boolean | null = null;

  constructor(opts: TokenPopupsOptions) {
    this.theme = opts.theme; this.env = opts.env ?? process.env; this.onNote = opts.onNote; this.onInterval = opts.onInterval;
    this.makeManager = opts.createManager ?? createPopupManager;
    this.source = opts.source ?? null;
    this.syncMinMs = opts.syncMinMs ?? 50;
    this.now = opts.now ?? (() => Date.now());
    this.dockOpt = opts.dock ?? null;
    this.imageProvider = opts.imageProvider;
    this.onHolderSelected = opts.onHolderSelected;
    this.onPlanCancel = opts.onPlanCancel;
    this.onFeedSelected = opts.onFeedSelected;
    this.onWidgetReady = opts.onWidgetReady;
  }

  private config(): PopupConfig { return (this.cfg ??= loadConfig(this.env)); }

  /** The dock for this run: injected, or a TerminalDock when docking can actually happen (macOS, native shell). */
  private dock(): DockLike | null {
    if (this.dockOpt !== 'auto') return this.dockOpt;
    if (this.dockImpl) return this.dockImpl;
    const cfg = this.config();
    if (!cfg.dock.enabled || process.platform !== 'darwin' || !nativeShellAvailable(this.env)) return null;
    this.dockImpl = new TerminalDock({ env: this.env, width: cfg.dock.width, followEvery: cfg.dock.followEvery });
    return this.dockImpl;
  }

  private manager(): PopupManager {
    if (this.mgr) return this.mgr;
    const cfg = this.config();
    this.mgr = this.makeManager({
      theme: popupThemeFrom(this.theme), rain: cfg.rain, hotkey: cfg.hotkey, hotkeyClose: cfg.hotkeyClose, env: this.env,
      onWarn: (m) => this.onNote?.(m),
      onEvent: (ev) => this.onPopupEvent(ev),
      ...(this.imageProvider ? { imageProvider: this.imageProvider } : {}),
    });
    return this.mgr;
  }

  /** Popup → TUI events. Payloads were already validated by the server against closed sets (task-1325). */
  private onPopupEvent(ev: ServerEvent): void {
    // task-1358 r4: the native shell's sink proxy refused a connection to somewhere other than the popup server — a
    // widget page (or anything in a WebView) tried to reach a host:port of its own. Nothing left this machine; say so.
    if (ev.ev === 'proxy.refused') { this.onNote?.(`popup shell: connection to ${ev.target} refused by the sink proxy (${ev.method}); only the popup server is reachable`); return; }
    // task-1358 Tier 5: pack widgets emit nothing but the generic ready/close (every other event name is dropped
    // by the server before it gets here, and none of the allow-listed ones does anything for a widget).
    if (ev.ev !== 'probe.rejected') {
      for (const [key, w] of this.widgets) {
        if (w.id !== ev.popupId) continue;
        if (ev.ev === 'popup.closed') { this.widgets.delete(key); return; }
        if (ev.ev === 'popup.ready') { this.onWidgetReady?.(key); return; }
        if (ev.ev === 'popup.event' && ev.name === 'popup.close-request') { this.closeWidget(key); return; }
        return;
      }
    }
    // task-1359: the token-detail popup emits only close; the feeds popup may ask to open item i (an index into
    // OUR newest-first list: the mint is resolved here, the page never carries an address or a URL).
    if (this.tokenId && ev.ev !== 'probe.rejected' && ev.popupId === this.tokenId) {
      if (ev.ev === 'popup.closed') { this.tokenId = null; this.tokenHandle = null; return; }
      if (ev.ev === 'popup.event' && ev.name === 'popup.close-request') this.closeToken();
      return;
    }
    if (this.feedsId && ev.ev !== 'probe.rejected' && ev.popupId === this.feedsId) {
      if (ev.ev === 'popup.closed') { this.feedsId = null; this.feedsHandle = null; return; }
      if (ev.ev === 'popup.event') {
        if (ev.name === 'popup.close-request') { this.closeFeeds(); return; }
        if (ev.name === 'feed.selected') {
          const i = (ev.payload as { i?: unknown } | null)?.i;
          const mint = typeof i === 'number' && Number.isInteger(i) && i >= 0 ? this.feedsMints[i] ?? null : null;
          if (mint) this.onFeedSelected?.(mint); else this.onNote?.('feeds popup: that item names no coin');
        }
      }
      return;
    }
    // task-1356: the narrative-board popup's own events (close only; it emits nothing else)
    if (this.narrativeId && ev.ev !== 'probe.rejected' && ev.popupId === this.narrativeId) {
      if (ev.ev === 'popup.closed') { this.narrativeId = null; this.narrativeHandle = null; return; }
      if (ev.ev === 'popup.event' && ev.name === 'popup.close-request') { this.closeNarrative(); return; }
    }
    // task-1355: the plans popup's own events (close, and the one write it may ask for: plan.cancel). The id
    // was shape-checked by the server; we re-validate it here (defence in depth) and hand it to the TUI seam,
    // which re-checks it against the live plan list before cancelling. No arm/cap/sign event exists at all.
    if (this.plansId && ev.ev !== 'probe.rejected' && ev.popupId === this.plansId) {
      if (ev.ev === 'popup.closed') { this.plansId = null; this.plansHandle = null; return; }
      if (ev.ev === 'popup.event') {
        if (ev.name === 'popup.close-request') { this.closePlans(); return; }
        if (ev.name === 'plan.cancel') { const id = (ev.payload as { id?: unknown } | null)?.id; if (typeof id === 'string' && /^plan_[0-9a-z]+_[0-9a-z]+$/.test(id)) this.onPlanCancel?.(id); return; }
      }
      return;
    }
    // task-1340: the bubble-map popup's own events (close, holder click)
    if (this.bubblesId && ev.ev !== 'probe.rejected' && ev.popupId === this.bubblesId) {
      if (ev.ev === 'popup.closed') { this.bubblesId = null; this.bubblesHandle = null; return; }
      if (ev.ev === 'popup.event') {
        if (ev.name === 'popup.close-request') { this.closeBubbles(); return; }
        if (ev.name === 'holder.selected') { const a = (ev.payload as { address?: unknown } | null)?.address; if (typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) this.onHolderSelected?.(a); return; }
      }
      return;
    }
    if (ev.ev === 'popup.closed' && ev.popupId === this.chartId) { this.resetChart(); return; }
    if (ev.ev === 'popup.ready' && ev.popupId === this.chartId) { this.ready = true; return; }
    if (ev.ev !== 'popup.event' || ev.popupId !== this.chartId) return;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.name) {
      case 'chart.interval': case 'interval.changed': {
        const iv = p.interval as CandleInterval;
        if (!(CHART_INTERVALS as readonly string[]).includes(iv)) return; // defence in depth; the server already checked
        this.metrics.intervalRequests++;
        this.interval = iv; this.forceFull = true;
        this.onInterval?.(iv);
        if (this.lastView) this.push(this.lastView); // answered at once from the cache
        return;
      }
      case 'chart.indicator': {
        const id = p.id as ChartIndicator; const set = new Set(this.prefs.indicators);
        if (p.on === true) set.add(id); else set.delete(id);
        this.prefs = { ...this.prefs, indicators: [...set] };
        return;
      }
      case 'chart.style': this.prefs = { ...this.prefs, style: p.style as ChartPrefs['style'] }; return;
      case 'chart.scale': this.prefs = { ...this.prefs, scale: p.scale as ChartPrefs['scale'] }; return;
      case 'chart.painted': {
        const ms = Number(p.ms);
        if (p.kind === 'first' && this.metrics.openedAt !== null && this.metrics.openToFirstPaintMs === null) this.metrics.openToFirstPaintMs = this.now() - this.metrics.openedAt;
        else if (p.kind === 'data' && Number.isFinite(ms)) { this.metrics.dataToPaintMs.push(ms); if (this.metrics.dataToPaintMs.length > 200) this.metrics.dataToPaintMs.shift(); }
        return;
      }
      case 'popup.close-request': this.closeChart(); return;
      case 'popup.drag': // the user is moving the window: stop docking it back beside the terminal
        if (!this.undocked) { this.undocked = true; this.dock()?.stop(); }
        return;
      default: return;
    }
  }

  chartOpen(): boolean { return this.chartId !== null; }

  /** The popup's current timeframe (its own once it asked for one, else the terminal's). */
  chartInterval(view?: TokenView | null): CandleInterval | null { return this.interval ?? view?.interval ?? null; }

  async openChart(view: TokenView): Promise<{ native: boolean; reason: string; dock: string | null }> {
    if (this.chartId) { this.syncChart(view); return { native: this.manager().native, reason: this.manager().reason, dock: describeDock(this.placement) }; }
    const mgr = this.manager();
    this.metrics.openedAt = this.now(); this.metrics.openToFirstPaintMs = null; this.metrics.dockProbeMs = null;
    this.ready = false; this.forceFull = true; this.lastKey = null; this.lastLen = 0; this.undocked = false; this.placement = null;
    if (this.interval === null) this.interval = view.interval;
    // task-1325: dock beside the terminal — one probe (≤1.2 s; ~0.2 s measured) decides the window's rect.
    const dock = this.dock();
    if (dock) {
      const t = this.now();
      try { this.placement = await dock.place(1200); } catch { this.placement = null; }
      this.metrics.dockProbeMs = this.now() - t;
    }
    const geom = this.placement ? { ...this.placement.rect, ontop: this.placement.ontop, focus: false } : undefined;
    const vm = this.buildVM(view, true);
    this.lastView = view;
    const handle = await mgr.open({ kind: 'chart', title: view.symbol, data: vm, ...(geom ? { geom } : {}) });
    this.chartId = handle.id; this.chartHandle = handle; this.native = mgr.native;
    // Follow the terminal (move/resize) only for a real window that is actually docked to a known terminal.
    if (dock && mgr.native && this.placement && this.placement.mode !== 'screen-right' && this.config().dock.follow) {
      dock.follow((p) => { if (this.undocked || !this.chartHandle) return; this.placement = p; this.metrics.redocks++; (this.chartHandle as { setBounds?: (r: DockPlacement['rect']) => void }).setBounds?.(p.rect); });
    }
    return { native: mgr.native, reason: mgr.reason, dock: mgr.native ? describeDock(this.placement) : null };
  }

  /** Build the VM for the popup's interval; tracks the series identity so the next push can be a tail. */
  private buildVM(view: TokenView, full: boolean): ChartVM {
    const src = this.source;
    const iv = this.interval ?? view.interval;
    if (!src) return chartVMFromView(view, { interval: iv, prefs: this.prefs, now: this.now() });
    const held = src.positions?.held(view.mint) ?? null;
    const vm = chartVMFromView(view, {
      interval: iv,
      series: src.series(view.mint, iv),
      feed: src.feed(view.mint),
      livePrice: src.livePrice(view.mint),
      held,
      positionKind: held?.kind ?? src.positions?.kind ?? 'paper',
      solUsd: src.solUsd() ?? src.positions?.solUsd() ?? null,
      fills: held ? this.fillsFor(view.mint) : [],
      prefs: this.prefs,
      now: this.now(),
      image: src.imagePath?.(view) ?? null,
      priceMode: src.priceMode?.() ?? 'price',
    });
    const key = vm.seriesKey ?? null;
    const n = vm.candles.length;
    const canTail = !full && this.ready && key !== null && key === this.lastKey && this.lastLen > 0 && n >= this.lastLen && n <= this.lastLen + 1;
    this.lastKey = key; this.lastLen = n;
    if (canTail) { vm.mode = 'tail'; vm.candles = vm.candles.slice(-2); }
    return vm;
  }

  /** Ledger fills for the held coin, memoised 1 s (the loop pushes up to ~20×/s). */
  private fillsFor(mint: string): ChartFill[] {
    const now = this.now();
    if (this.fillsMemo && this.fillsMemo.mint === mint && now - this.fillsMemo.at < 1000) return this.fillsMemo.v;
    let v: ChartFill[] = [];
    try { v = currentPositionFills(this.source?.fills(mint) ?? []); } catch { v = []; }
    this.fillsMemo = { mint, at: now, v };
    return v;
  }

  private push(view: TokenView): void {
    if (!this.chartHandle) return;
    const full = this.forceFull || !this.ready;
    const vm = this.buildVM(view, full);
    if (vm.mode === 'tail') this.metrics.pushes.tail++; else { this.metrics.pushes.full++; if (this.ready) this.forceFull = false; }
    this.lastPushAt = this.now();
    this.chartHandle.setData(vm);
  }

  syncChart(view: TokenView): void {
    if (!this.chartId || !this.chartHandle) return;
    if (this.lastView && this.lastView.mint !== view.mint) this.forceFull = true; // the popup follows the open coin
    this.lastView = view;
    const wait = this.lastPushAt + this.syncMinMs - this.now();
    if (wait <= 0) { this.push(view); return; }
    if (this.pending) return; // a trailing push is already scheduled; it reads the newest view
    this.pending = setTimeout(() => { this.pending = null; if (this.lastView && this.chartHandle) this.push(this.lastView); }, wait);
    (this.pending as { unref?: () => void }).unref?.();
  }

  private resetChart(): void {
    this.chartId = null; this.chartHandle = null; this.ready = false;
    if (this.dockOpt !== 'auto') this.dockOpt?.stop(); else this.dockImpl?.stop();
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
  }

  closeChart(): void {
    const handle = this.chartHandle;
    // Clear our state first so we are consistent even if the underlying close throws.
    this.resetChart();
    if (!handle) return;
    // Closing must never affect the terminal: if the window shell already died (crash/kill), the close op
    // throws ("shell not running"). Swallow it — the popup is gone regardless — and surface it as a note so
    // the rejection can never reach the process-level fatal handler and take the whole TUI down.
    try { handle.close(); } catch (e) { this.onNote?.(`chart popup already gone (${(e as Error).message})`); }
  }

  // ---------------------------------------------------------------------------------------------- bubble map (task-1340)
  bubblesOpen(): boolean { return this.bubblesId !== null; }

  /** Open the bubble-map HUD for a coin (or push a fresh VM if already open). Read-only view model; no keys. */
  async openBubbles(vm: BubbleVM): Promise<{ native: boolean; reason: string }> {
    if (this.bubblesId) { this.syncBubbles(vm); return { native: this.manager().native, reason: this.manager().reason }; }
    const mgr = this.manager();
    const handle = await mgr.open({ kind: 'bubbles', title: `${vm.symbol} bubbles`, data: vm, geom: { w: 760, h: 620, focus: false } });
    this.bubblesId = handle.id; this.bubblesHandle = handle; this.native = mgr.native;
    return { native: mgr.native, reason: mgr.reason };
  }

  syncBubbles(vm: BubbleVM): void { this.bubblesHandle?.setData(vm); }

  closeBubbles(): void {
    const h = this.bubblesHandle;
    this.bubblesId = null; this.bubblesHandle = null;
    if (!h) return;
    try { h.close(); } catch (e) { this.onNote?.(`bubble popup already gone (${(e as Error).message})`); }
  }

  // ---------------------------------------------------------------------------------------------- narrative board (task-1356)
  narrativeOpen(): boolean { return this.narrativeId !== null; }

  /** Open the narrative-board HUD (or push a fresh VM if already open). Deterministic view model; no model, no keys. */
  async openNarrative(vm: NarrativeBoardVM): Promise<{ native: boolean; reason: string }> {
    if (this.narrativeId) { this.syncNarrative(vm); return { native: this.manager().native, reason: this.manager().reason }; }
    const mgr = this.manager();
    const handle = await mgr.open({ kind: 'narrative', title: 'narrative board', data: vm, geom: { w: 720, h: 560, focus: false } });
    this.narrativeId = handle.id; this.narrativeHandle = handle; this.native = mgr.native;
    return { native: mgr.native, reason: mgr.reason };
  }

  syncNarrative(vm: NarrativeBoardVM): void { this.narrativeHandle?.setData(vm); }

  closeNarrative(): void {
    const h = this.narrativeHandle;
    this.narrativeId = null; this.narrativeHandle = null;
    if (!h) return;
    try { h.close(); } catch (e) { this.onNote?.(`narrative popup already gone (${(e as Error).message})`); }
  }

  // ---------------------------------------------------------------------------------------------- order plans (task-1355)
  plansOpen(): boolean { return this.plansId !== null; }

  /** Open the order-plans HUD (or push a fresh VM if already open). Read-only view model; no keys, no signer. */
  async openPlans(vm: PlansVM): Promise<{ native: boolean; reason: string }> {
    if (this.plansId) { this.syncPlans(vm); return { native: this.manager().native, reason: this.manager().reason }; }
    const mgr = this.manager();
    const handle = await mgr.open({ kind: 'plans', title: 'order plans', data: vm, geom: { w: 640, h: 560, focus: false } });
    this.plansId = handle.id; this.plansHandle = handle; this.native = mgr.native;
    return { native: mgr.native, reason: mgr.reason };
  }

  syncPlans(vm: PlansVM): void { this.plansHandle?.setData(vm); }

  closePlans(): void {
    const h = this.plansHandle;
    this.plansId = null; this.plansHandle = null;
    if (!h) return;
    try { h.close(); } catch (e) { this.onNote?.(`plans popup already gone (${(e as Error).message})`); }
  }

  // ---------------------------------------------------------------------------------------------- token detail + feeds (task-1359)
  tokenOpen(): boolean { return this.tokenId !== null; }

  /** Open the token-detail HUD (or push a fresh VM if already open). Read-only; no keys, no trade path. */
  async openToken(vm: TokenDetailVM): Promise<{ native: boolean; reason: string }> {
    if (this.tokenId) { this.syncToken(vm); return { native: this.manager().native, reason: this.manager().reason }; }
    const mgr = this.manager();
    const handle = await mgr.open({ kind: 'token', title: `${vm.symbol} token`, data: vm, geom: { w: 420, h: 640, focus: false } });
    this.tokenId = handle.id; this.tokenHandle = handle; this.native = mgr.native;
    return { native: mgr.native, reason: mgr.reason };
  }

  syncToken(vm: TokenDetailVM): void { this.tokenHandle?.setData(vm); }

  closeToken(): void {
    const h = this.tokenHandle;
    this.tokenId = null; this.tokenHandle = null;
    if (!h) return;
    try { h.close(); } catch (e) { this.onNote?.(`token popup already gone (${(e as Error).message})`); }
  }

  feedsOpen(): boolean { return this.feedsId !== null; }

  /** Open the feeds HUD with the newest-first items and the mint behind each (kept here, never sent). */
  async openFeeds(vm: FeedVM, mints: readonly (string | null)[]): Promise<{ native: boolean; reason: string }> {
    if (this.feedsId) { this.syncFeeds(vm, mints); return { native: this.manager().native, reason: this.manager().reason }; }
    const mgr = this.manager();
    this.feedsMints = mints.slice();
    const handle = await mgr.open({ kind: 'feeds', title: 'feeds', data: vm, geom: { w: 560, h: 620, focus: false } });
    this.feedsId = handle.id; this.feedsHandle = handle; this.native = mgr.native;
    return { native: mgr.native, reason: mgr.reason };
  }

  syncFeeds(vm: FeedVM, mints: readonly (string | null)[]): void { if (!this.feedsHandle) return; this.feedsMints = mints.slice(); this.feedsHandle.setData(vm); }

  closeFeeds(): void {
    const h = this.feedsHandle;
    this.feedsId = null; this.feedsHandle = null; this.feedsMints = [];
    if (!h) return;
    try { h.close(); } catch (e) { this.onNote?.(`feeds popup already gone (${(e as Error).message})`); }
  }

  // ---------------------------------------------------------------------------------------------- pack widgets (task-1358 Tier 5)
  widgetOpen(key: string): boolean { return this.widgets.has(key); }
  openWidgets(): Array<{ key: string; topics: WidgetTopic[] }> { return [...this.widgets.entries()].map(([key, w]) => ({ key, topics: [...w.topics] })); }

  /** Open a pack widget page (consent + integrity were checked by the caller: widgets.ts). Already open → no-op. */
  async openWidget(page: WidgetPage): Promise<{ native: boolean; reason: string }> {
    const mgr = this.manager();
    if (this.widgets.has(page.key)) return { native: mgr.native, reason: mgr.reason };
    const handle = await mgr.open({ kind: 'widget', title: page.title, widget: page, geom: { w: 520, h: 420, focus: false } });
    this.widgets.set(page.key, { id: handle.id, handle, topics: [...page.topics] });
    this.native = mgr.native;
    return { native: mgr.native, reason: mgr.reason };
  }

  /** Push one topic's view model to an open widget; a topic the widget did not declare is not sent. */
  syncWidget(key: string, topic: WidgetTopic, payload: WidgetPayload): void {
    const w = this.widgets.get(key);
    if (!w || !w.topics.includes(topic)) return;
    w.handle.sendData?.(topic, payload);
  }

  closeWidget(key: string): void {
    const w = this.widgets.get(key);
    this.widgets.delete(key);
    if (!w) return;
    try { w.handle.close(); } catch (e) { this.onNote?.(`widget ${key} already gone (${(e as Error).message})`); }
  }

  shutdown(): void {
    const mgr = this.mgr; this.mgr = null; this.resetChart();
    this.widgets.clear();
    this.tokenId = null; this.tokenHandle = null;
    this.feedsId = null; this.feedsHandle = null; this.feedsMints = [];
    this.bubblesId = null; this.bubblesHandle = null;
    this.narrativeId = null; this.narrativeHandle = null;
    this.plansId = null; this.plansHandle = null;
    if (mgr) void mgr.shutdown().catch(() => {});
  }
}
