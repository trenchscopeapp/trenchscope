// trenchscope popup protocol v1 (task-1290). Types only; the runtime lives in server.ts (TUI side),
// src/pages/*.js (popup side) and shell/wry (window side). Three layers, three channels:
//
//   TUI  ──stdin JSON lines──▶  SHELL (window process: wry)  ──stdout JSON lines──▶  TUI
//   TUI  ◀──── WebSocket (loopback, ticket → one-time token) ────▶  POPUP PAGE (served by the TUI's server)
//
// Invariants (security model, carried over from the spike doc §5):
//   * popups never receive keys, signer state, mandates or trade capability; they receive VIEW MODELS and theme tokens;
//   * popups can only send UI events from `PopupToTui`; anything else is dropped and reported as `popup.dropped`;
//   * the popup URL carries a single-use 30 s ticket and travels TUI → shell over stdin (never argv, never a log);
//   * every untrusted string in a view model is rendered via textContent / fillText, never markup; CSP blocks the rest.
//
// This file ports and narrows research/popup-host/popup-protocol.ts to the three in-app popups.

// ------------------------------------------------------------------ theme tokens (subset the popups use)
export interface ThemeTokens {
  bg: string;
  panel: string;
  panelAlt?: string;
  border: string;
  borderFocus: string;
  text: string;
  muted: string;
  dim: string;
  accent: string;
  up: string;
  down: string;
  warn: string;
  ai: string;
  pump?: string;
  dbc?: string;
  rain: [string, string, string, string];
  rainPump: [string, string, string, string];
  rainDump: [string, string, string, string];
  scan?: string;
  glow?: string;
}

/** Rain/animation tuning the TUI sends to a popup in `hello` (task-1290: rain cadence is user-configurable). */
export interface PopupRainConfig {
  /** Rain drawn at all. */
  enabled: boolean;
  /** Fall-speed multiplier (1 = the spike default cadence that was approved). */
  speedScale: number;
  /** Column activity 0..1 (also nudged live by market activity via `update`). */
  density: number;
}

/** The in-app popup kinds (SPEC §8.5 / task-1290 scope; task-1340 adds the bubble map; task-1345 the agent roster; task-1358 pack widgets; task-1406 the spectator view). */
export type PopupKind = 'chart' | 'token' | 'feeds' | 'bubbles' | 'roster' | 'narrative' | 'plans' | 'widget' | 'spectator';

// ------------------------------------------------------------------ pack widgets (task-1358 Tier 5)
/**
 * The topics a pack widget may subscribe to. Each is a PUBLIC view model the terminal already shows: nothing in
 * them names a key, a signer, a cap, a mandate or the gate, and a widget can only receive — the only messages a
 * widget page may send are the generic ready/perf/log + close/focus/drag events every popup has.
 */
export const WIDGET_TOPICS = ['rows', 'token', 'narrative', 'positions', 'alerts', 'theme'] as const;
export type WidgetTopic = typeof WIDGET_TOPICS[number];
/** One screener row as a widget sees it (the public columns; no provenance internals, no pair/source ids). */
export interface WidgetRowVM {
  symbol: string; name: string; mint: string; launchpad: string;
  price: number | null; mcap: number | null; liq: number | null;
  vol5m: number | null; vol1h: number | null; vol24: number | null;
  chg: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  ageMin: number | null; holders: number | null; org: number | null; top10: number | null;
  flags: string[]; verified: boolean;
}
export interface WidgetRowsVM { feed: string; rows: WidgetRowVM[]; updatedAt: number }
export interface WidgetPositionVM { symbol: string; mint: string; side: 'long' | 'short'; tokens: number; valueSol: number | null; unrealizedSol: number | null; unrealizedPct: number | null; book: 'paper' | 'live' }
export interface WidgetPositionsVM { rows: WidgetPositionVM[]; updatedAt: number }
export interface WidgetAlertVM { at: number; level: string; kind: string; text: string; symbol: string | null }
export interface WidgetAlertsVM { items: WidgetAlertVM[]; updatedAt: number }
export type WidgetPayload = WidgetRowsVM | TokenDetailVM | NarrativeBoardVM | WidgetPositionsVM | WidgetAlertsVM | ThemeTokens;
/** A widget page to serve: the pack's html (size-capped by the TUI before it gets here), under the popup host's own CSP + SDK. */
export interface WidgetPage { key: string; title: string; topics: WidgetTopic[]; html: string }
/** Hard cap on a widget page (the pack layer caps files at 512 KB; the server refuses anything larger at ticket time). */
export const WIDGET_HTML_MAX = 512_000;

/** One OHLCV bar (mirrors @dexterm/data Candle; duplicated so the page bundle has no package import). */
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

// ------------------------------------------------------------------ chart v2 (task-1325): TradingView Lightweight Charts page
/** The six chart timeframes, same order and keys (1–6) as the terminal. 1s is deliberately absent (see README). */
export const CHART_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type ChartInterval = typeof CHART_INTERVALS[number];
/** Indicator / overlay ids the chart page may toggle. Anything else is dropped by the server. */
export const CHART_INDICATORS = ['ema9', 'ema21', 'vwap', 'volma', 'volume', 'tape'] as const;
export type ChartIndicator = typeof CHART_INDICATORS[number];
export const CHART_STYLES = ['candles', 'line', 'area'] as const;
export type ChartStyle = typeof CHART_STYLES[number];
/** Price-scale mode: auto (normal, autoscaled), logarithmic, percent (from the first visible bar). */
export const CHART_SCALES = ['auto', 'log', 'percent'] as const;
export type ChartScale = typeof CHART_SCALES[number];

/** Chart preferences the TUI remembers for the run (re-applied when the popup is reopened). */
export interface ChartPrefs {
  style: ChartStyle;
  scale: ChartScale;
  indicators: ChartIndicator[];
}

/** One trade from the terminal's existing tape (GeckoTerminal, ≤60, newest first). No wallet: markers need none. */
export interface TapeTrade { t: number; side: 'buy' | 'sell'; usd: number; price: number }

/** A fill on this coin from the position source's ledger (paper today), for chart markers. Read-only display. */
export interface ChartFill { t: number; side: 'buy' | 'sell'; priceUsd: number | null; sol: number; tokens: number }

/** One labelled cell of the popup's position row, formatted TUI-side so it reads exactly like the terminal row. */
export interface PositionCell { label: string; value: string; tone: 'up' | 'down' | 'text' | 'muted' | 'warn' }

/** The held position as the chart draws it (task-1323 PositionSource → positionRow). Absent / null = not held. */
export interface ChartPosition {
  kind: 'paper' | 'live';
  side: 'long' | 'short';
  symbol: string;
  tokens: number;
  /** "1.23M WIF" — the size part of the entry-line label. */
  sizeLabel: string;
  /** USD per token; null when SOL/USD is unknown (the entry line is then not drawn and the row says why). */
  avgEntryUsd: number | null;
  priceUsd: number | null;
  /** Fraction of cost (0.28 = +28 %). */
  unrealizedPct: number | null;
  stopUsd: number | null;
  targetUsd: number | null;
  /** Same caption the terminal row shows ("paper ledger · SOL $142.10"). */
  caption: string;
  /** SIDE · SIZE · VALUE · AVG ENTRY · PRICE · UNREALIZED (+ REALIZED / STOP / TARGET only when set). */
  cells: PositionCell[];
  /** Fills of the CURRENT position (since it was last flat), oldest first. */
  fills: ChartFill[];
}

/** Chart popup view model: the open token's candles + header stats, from the live data layer. */
export interface ChartVM {
  symbol: string;
  name: string;
  mint: string;
  interval: string;
  price: number | null;
  chg: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  liq: number | null;
  vol24: number | null;
  mcap: number | null;
  candles: Bar[];
  /** t of the open (still-forming) bar, or null. */
  openBarT: number | null;
  updatedAt: number | null;
  // ---- task-1325 additive fields (all optional; a v1 page ignores them)
  /** 'full' (default): `candles` is the whole series. 'tail': `candles` holds only the last ≤2 bars of the
   *  series named by `seriesKey`, to merge into what the page already has (live tick). */
  mode?: 'full' | 'tail';
  /** Identity of the candle series (`mint|interval|firstBarT`); a tail only applies to the same key. */
  seriesKey?: string;
  /** True when the requested interval has nothing cached yet (the page says "warming", never a fake chart). */
  cold?: boolean;
  /** Candle panel status from the terminal ("ok"/"stale"/"loading"/"error") and a printable reason. */
  source?: { state: string; stale: boolean; reason: string | null };
  /** The terminal's price feed for this coin: the fast-lane stream (LIVE) or the polled price (POLL). */
  feed?: 'LIVE' | 'POLL';
  /** The price the terminal header shows right now (fast-lane push when LIVE, else polled). */
  livePrice?: number | null;
  /** The terminal's trade tape (for buy/sell markers). */
  trades?: TapeTrade[];
  /** The held position, or null when flat / never held. */
  position?: ChartPosition | null;
  prefs?: ChartPrefs;
  /** TUI wall clock when this VM was built (for the page's setData → repaint latency measurement). */
  sentAt?: number;
  /**
   * task-1326: the coin image as a SAME-ORIGIN path on the popup server (`/img/<key>.png`, our own cached
   * re-encoded PNG), or null when the terminal has no image for the coin yet. Never a third-party URL.
   */
  image?: string | null;
  /**
   * task-1366: the terminal's price display mode. 'mcap' with a `supply` makes the Y axis, crosshair legend and header
   * read MARKET CAP (price × supply, K/M/B) — the bars stay in USD price, so levels and fills keep their meaning.
   * `supply` is mcap / price at the LATEST tick (current supply: history is scaled by it, and the page says so);
   * null in mcap mode = the supply is unknown and the page shows prices with a visible note.
   */
  priceMode?: 'price' | 'mcap';
  supply?: number | null;
}

/** Token-detail popup view model: the identity + market + risk subset of the live TokenView. */
export interface TokenDetailVM {
  symbol: string;
  name: string;
  mint: string;
  launchpad: string;
  price: number | null;
  chg: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  mcap: number | null;
  fdv: number | null;
  liq: number | null;
  vol24: number | null;
  holders: number | null;
  top10: number | null;
  dev: number | null;
  lpLocked: number | null;
  mintAuth: boolean | null;
  freezeAuth: boolean | null;
  rugScore: number | null;
  risks: Array<{ name: string; level: string }>;
  flags: string[];
  holdersSample: string | null;
  updatedAt: number | null;
  /**
   * task-1359: snipers / bundled supply from the wallet-intel scan (text + level as the terminal prints them; a
   * reason such as `needs Helius key` when the launch window was not read). Absent on older terminals.
   */
  intel?: { snipers: string; bundle: string; snipersLevel: 'ok' | 'warn' | 'bad' | 'na'; bundleLevel: 'ok' | 'warn' | 'bad' | 'na' } | null;
}

/** Feeds popup view model (stub: a scrolling list of untrusted items the TUI feeds it). */
export interface FeedVM {
  title: string;
  items: Array<{ t: number; source: string; text: string; kind?: string }>;
}

// ------------------------------------------------------------------ bubble map (task-1340, wallet intel W5)
/** One holder bubble: share, rule-derived kind, its labels WITH rule text (shown on hover), funder, cluster. */
export interface BubbleHolderVM {
  owner: string;
  pct: number;
  /** Colour = rule: dev | dev-linked | bundle | funder | transfer | sniper | pool | cex | whale | plain. */
  kind: string;
  labels: Array<{ label: string; rule: string; confidence: string }>;
  funder: { address: string; label: string | null; blockTime: number | null } | null;
  walletFirstSeen: number | null;
  cluster: string | null;
  /**
   * task-1367: POOL / CURVE / VAULT / LOCK / CEX / BURN / DEV / LINKED / UNLABELLED with the on-chain reason (and,
   * for a lock / vault, the escrow + program; the unlock schedule only when decoded). Absent on older terminals.
   */
  cls?: { tag: string; reason: string; lock: { escrow: string; program: string; unlock: string | null; note: string } | null } | null;
}

export interface BubbleClusterVM { name: string; kind: string; members: string[]; pct: number; evidence: Array<{ a: string; b: string; rule: string; linked: boolean }> }

/** Sample-captioned insights (every people-metric prints its sample; nulls = not measured). */
export interface BubbleInsightsVM {
  top10Raw: number | null;
  top10Adjusted: number | null;
  excludedCount: number;
  /** task-1367: top-10 without POOL/CURVE/VAULT/LOCK/BURN owners (the red flag reads it), how many were dropped. */
  top10ExPool?: number | null;
  exPoolDropped?: number;
  /** task-1367: the largest counted owner above 30 % (the main risk), or null. */
  bigHolder?: { owner: string; pct: number; tag: string } | null;
  snipers: { count: number; launchSharePct: number } | null;
  bundlePct: number | null;
  cohorts: number | null;
  devPct: number | null;
  devUpperBoundPct: number | null;
  freshPct: number | null;
  freshMeasuredPct: number | null;
  sample: string;
}

/** Bubble-map popup view model. `state` 'unavailable' carries the reason and the fix; the page draws nothing fake. */
export interface BubbleVM {
  symbol: string;
  name: string;
  mint: string;
  state: 'loading' | 'ok' | 'unavailable';
  reason: string | null;
  fix: string | null;
  depth: 'light' | 'deep' | null;
  /** Honest degradation note (keyless: funders + launch window missing). */
  degraded: string | null;
  holders: BubbleHolderVM[];
  clusters: BubbleClusterVM[];
  insights: BubbleInsightsVM | null;
  /** The terminal's selected holder index (null = none); the popup mirrors it and reports its own clicks. */
  selected: number | null;
  via: string | null;
  updatedAt: number | null;
  image?: string | null;
}

// ------------------------------------------------------------------ agent roster (task-1345): the bring-your-own-agent
// control surface — connected agents with tier, activity, reads/proposals, rate usage, and the audit log,
// with per-agent pause and kick. The popup only ever sends `roster.pause` / `roster.kick` UI events (by
// agent name); it never sees a token and can never arm, sign or change a cap.
export interface RosterAgentVM {
  id: string;
  name: string;
  tier: 'observe' | 'annotate' | 'propose';
  sessions: number;
  client: string;
  lastActivity: number;
  topics: string[];
  reads: number;
  readsLimit: number;
  proposals: number;
  proposalsLimit: number;
  refused: number;
  paused: boolean;
  floodPausedUntil: number | null;
}
export interface RosterAuditVM { t: number; agent: string; kind: string; tool: string; ok: boolean; detail: string }
export interface RosterVM {
  now: number;
  busPort: number;
  agents: RosterAgentVM[];
  audit: RosterAuditVM[];
}

// ------------------------------------------------------------------ narrative board (task-1356, AI-SUITE-DESIGN §7)
/** One narrative row in the HUD popup. All numbers come from the deterministic board; no model. */
export interface NarrativeRowVM {
  narrative: string;
  rank: number | null;
  score: number | null;
  tokens: number;
  new_1h: number;
  new_24h: number;
  vol: number;
  pace: number | null;
  med_chg: number | null;
  /** The top runner (liquidity >= $10K), symbol is firewalled display text. */
  runner: { symbol: string; chg: number | null; mcap: number } | null;
}
/** Narrative-board popup view model. Deterministic (model_output: false). */
export interface NarrativeBoardVM {
  title: string;
  window: '1h' | '24h';
  tokens_total: number;
  unclassified_pct: number;
  copycats: number;
  data_age: string;
  lexicon_version: string;
  rows: NarrativeRowVM[];
  limits: string;
}

// ------------------------------------------------------------------ order plans & standing mandates (task-1355)
// The read-only HUD for the signer trust domain. It mirrors the terminal's PLANS screen: the conditional
// order plans and the standing mandates, their status and ledgers. The popup NEVER sees a key, a signature,
// a mandate secret or trade capability, and it can NEVER arm, raise a cap or widen a mandate: the only UI
// event it may send is `plan.cancel` (cancel a plan by id), which the TUI re-validates against its own list
// before acting. Arming stays a physical keypress at the terminal. Every untrusted string (symbol) is
// firewalled TUI-side and rendered via textContent on the page.
export interface PlanRowVM {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  sizeUsd: number;
  status: string;
  tier: string | null;
  mandateId: string | null;
  paused: boolean;
  readBack: string;
  /** task-1366: entry · TP · stop with BOTH market cap and price (order follows the terminal's price mode). Optional. */
  levels?: string;
}
export interface MandateRowVM {
  id: string;
  status: string;
  wallet: string;
  totalUsd: number;
  perTradeUsd: number;
  perCoinUsd: number;
  maxTier: string;
  reservedUsd: number;
  spentUsd: number;
  realizedUsd: number;
  lossUsd: number;
  expiresAt: number;
}
/** Order-plans popup view model. Paper by default; read-only but for the `plan.cancel` event. */
export interface PlansVM {
  title: string;
  /** PAPER / LIVE (devnet) banner text, formatted TUI-side. */
  mode: string;
  now: number;
  plans: PlanRowVM[];
  mandates: MandateRowVM[];
  /** Journal integrity ("verified · N events" or a reason); the audit log is the source of truth. */
  journal: string;
  /** The hands-free gate (Tier 4). true = the keypress gate is off (less safe); changing it is a TTY keypress. */
  handsFree: boolean;
  updatedAt: number | null;
}

// ------------------------------------------------------------------ spectator (task-1406, "watch the agent cook")
// The read-only live view of an agent driving dexterm. The popup renders the REDACTED spectator view model
// (wallet addresses/keys already masked TUI-side): the screen the agent moved to, the connected agents with
// an 'agent' badge and status, and an activity feed with timing and data ages. The ONLY messages this page
// may send are spectator.pause / resume / takeover / kill by agent name; it can never arm, sign or raise a
// cap, and it never sees a key, a signer, a mandate or a trade capability (like the roster popup).
export interface SpectatorScreenVM { screen: string; selectedMint: string | null; feed: string | null; filter: string | null; highlight: string | null }
export interface SpectatorAgentVM { name: string; tier: string | null; status: 'active' | 'paused' | 'killed'; lastAt: number }
export interface SpectatorActivityVM {
  seq: number; t: number; phase: string; agent: string; tier: string | null;
  tool: string | null; summary: string; ms: number | null; dataAgeSec: number | null; ok: boolean; refusal: string | null;
}
export interface SpectatorPopupVM {
  title: string;
  now: number;
  /** Whether the stream was redacted (always true for a shared view; false only in local follow mode). */
  redacted: boolean;
  /** Who is driving: the agent, or the user after a take-over. */
  control: 'agent' | 'user';
  screen: SpectatorScreenVM;
  agents: SpectatorAgentVM[];
  activity: SpectatorActivityVM[];
}

export type PopupVM = ChartVM | TokenDetailVM | FeedVM | BubbleVM | RosterVM | NarrativeBoardVM | PlansVM | SpectatorPopupVM;

// ------------------------------------------------------------------ TUI → POPUP (over the WebSocket)
export type TuiToPopup =
  | { type: 'hello'; protocol: 'dexterm-popup/1'; popup: { id: string; kind: PopupKind; params: Record<string, unknown> }; theme: ThemeTokens; rain: PopupRainConfig }
  | { type: 'theme'; tokens: Partial<ThemeTokens> }
  | { type: 'data'; topic: PopupKind; payload: PopupVM }
  // task-1358: a pack widget receives per-topic view models (never keys, never trade state)
  | { type: 'data'; topic: WidgetTopic; payload: WidgetPayload }
  | { type: 'update'; patch: { activity?: number; mood?: 'rain' | 'rainPump' | 'rainDump'; rain?: boolean } }
  | { type: 'pause'; on: boolean }
  | { type: 'focus' }
  | { type: 'close' };

// ------------------------------------------------------------------ POPUP → TUI (allow-listed; see POPUP_EVENTS in server.ts)
export type PopupToTui =
  | { type: 'ready'; page: string; t: number }
  | { type: 'perf'; fps: number; frameMs: number; p95Ms: number; long: number; dpr: number; w: number; h: number; pwned: 'undefined' | string }
  | { type: 'log'; msg: string }
  | { type: 'event'; name: 'bar.hovered'; payload: { i: number } }
  | { type: 'event'; name: 'interval.changed'; payload: { interval: ChartInterval } }
  // task-1325 chart v2 requests. The server validates every payload against the closed sets above and
  // drops anything else as `popup.dropped` (reason 'bad-payload') without echoing the payload.
  | { type: 'event'; name: 'chart.interval'; payload: { interval: ChartInterval } }
  | { type: 'event'; name: 'chart.indicator'; payload: { id: ChartIndicator; on: boolean } }
  | { type: 'event'; name: 'chart.style'; payload: { style: ChartStyle } }
  | { type: 'event'; name: 'chart.scale'; payload: { scale: ChartScale } }
  | { type: 'event'; name: 'chart.painted'; payload: { kind: 'first' | 'data'; ms: number; sentAt: number } }
  | { type: 'event'; name: 'holder.selected'; payload: { address: string } }
  | { type: 'event'; name: 'feed.selected'; payload: { i: number } }
  // task-1355: the plans popup may ask the TUI to cancel a plan by id. The TUI re-validates the id against
  // its own live plan list before acting. This is the ONLY write the popup can make — it can never arm,
  // raise a cap, widen or arm a mandate, resume a paused plan, or sign; those have no event at all.
  | { type: 'event'; name: 'plan.cancel'; payload: { id: string } }
  // task-1406 spectator: pause / resume / take over / kill an agent by name. The TUI maps these to the
  // bus's user-side controls and re-validates the name; the page can never arm, sign, raise a cap or sign.
  | { type: 'event'; name: 'spectator.pause' | 'spectator.resume' | 'spectator.takeover' | 'spectator.kill'; payload: { agent: string } }
  | { type: 'event'; name: 'popup.close-request' | 'popup.focus' | 'popup.drag'; payload: Record<string, never> };
// Deliberately absent: anything that names a trade, a ticket, a mandate, a signer or a key. The TUI maps UI
// events to its own actions and never executes a popup-provided command.

// ------------------------------------------------------------------ TUI → SHELL (stdin JSON lines) and SHELL → TUI (stdout)
export type ShellOp =
  /** `port` pins the window's navigation to http://127.0.0.1:<port> in the shell (task-1290 follow-up). */
  | { op: 'open'; id: string; url: string; port?: number; x?: number; y?: number; w?: number; h?: number; ontop?: boolean; focus?: boolean }
  | { op: 'close' | 'show' | 'hide' | 'focus' | 'drag'; id: string }
  | { op: 'ontop' | 'clickthrough'; id: string; on: boolean }
  | { op: 'move'; id: string; x: number; y: number }
  /** task-1325: dock / follow the terminal (logical points, top-left origin of the main display). */
  | { op: 'bounds'; id: string; x: number; y: number; w: number; h: number }
  | { op: 'snapshot'; id: string; path: string }
  | { op: 'quit' };

export type ShellEvent =
  | { ev: 'shell.ready'; shell: 'wry'; t_ms: number; hotkey_registered: boolean; hotkey: string; hotkey_close_registered?: boolean; hotkey_close?: string; /** task-1358 r4: the loopback sink proxy the shell routes every WebView connection through (`127.0.0.1:<port>`), or null */ sink_proxy?: string | null }
  | { ev: 'window.created'; id: string; t_ms: number; create_ms: number }
  | { ev: 'window.closed'; id: string }
  | { ev: 'hotkey'; accel: string; action?: 'toggle' | 'close'; t_ms: number }
  | { ev: 'ipc'; id: string; msg: { type: 'drag' | 'close-request' } | unknown }
  | { ev: 'snapshot'; id: string; path: string }
  | { ev: 'error'; msg: string };

// ------------------------------------------------------------------ server-side events the TUI consumes (createPopupServer onEvent)
export type ServerEvent =
  | { ev: 'popup.ready'; popupId: string; kind: PopupKind; openToReadyMs: number; page: string }
  | { ev: 'popup.event'; popupId: string; name: string; payload: unknown }
  | { ev: 'popup.perf'; popupId: string; fps: number; frameMs: number; p95Ms: number; long: number; dpr: number; w: number; h: number; pwned: string }
  | { ev: 'popup.log'; popupId: string; msg: string }
  | { ev: 'popup.dropped'; popupId: string; reason: 'bad-json' | 'not-allowed' | 'bad-payload'; type?: string }
  | { ev: 'popup.closed'; popupId: string }
  | { ev: 'probe.rejected'; reason: ProbeReason; method: string; path: string; remote: string; host: string; origin: string }
  /** task-1358 r4: the native shell's sink proxy refused a connection to anything but the popup server (e.g. a widget page's runtime `<link rel=preconnect>` to a host:port of its choosing). */
  | { ev: 'proxy.refused'; method: string; target: string; remote: string };

export type ProbeReason =
  | 'remote-not-loopback' | 'bad-host' | 'bad-origin' | 'bad-ticket' | 'bad-ws-token'
  | 'bad-ws-handshake' | 'unknown-route' | 'bad-json'
  /** task-1358 r3: the widget-frame route refused (spent/unknown frame token, or not an iframe fetch from our origin). */
  | 'bad-frame';

/**
 * PopupHost interface: what the TUI (and later Jarvis, and the trading lane's wallet bridge) calls.
 * The shell technology (wry) is a swap behind it; when no shell or display is available the
 * implementation falls back to the OS browser (see host.ts).
 */
export interface PopupHost {
  /** Whether this host drives a native frameless shell (true) or falls back to the OS browser (false). */
  readonly native: boolean;
  start(): Promise<{ hotkeyRegistered: boolean; spawnToReadyMs: number; /** task-1358 r4: the sink proxy the shell confirmed, or null */ sinkProxy?: string | null } | null>;
  open(id: string, url: string, geom?: { x?: number; y?: number; w?: number; h?: number; ontop?: boolean; focus?: boolean }): void;
  close(id: string): void;
  show(id: string): void;
  hide(id: string): void;
  focus(id: string): void;
  alwaysOnTop(id: string, on: boolean): void;
  clickThrough(id: string, on: boolean): void;
  move(id: string, x: number, y: number): void;
  /** task-1325: position + size in one op (docking beside the terminal). No-op under the browser fallback. */
  setBounds?(id: string, r: { x: number; y: number; w: number; h: number }): void;
  quit(): void;
}

/** The small, lane-reusable facade (scope item 3). */
export interface OpenPopupRequest {
  kind: PopupKind;
  /** A route under the popup server (e.g. `chart`), OR a fully-formed loopback URL for a custom page. */
  route?: PopupKind;
  url?: string;
  title?: string;
  /** Initial view model pushed to the page as soon as it connects. */
  data?: PopupVM;
  /** task-1358: for `kind: 'widget'` — the pack page to serve (the server wraps it in its own CSP + the widget SDK). */
  widget?: WidgetPage;
  geom?: { x?: number; y?: number; w?: number; h?: number; ontop?: boolean; focus?: boolean };
}

export const PROTOCOL_VERSION = 'dexterm-popup/1' as const;
