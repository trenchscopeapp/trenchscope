// trenchscope — app state consumed by the screens. Screens are pure render(canvas, state) functions;
// renderFrame() draws the screen, the toast, then runs the effects post-pass (VISUAL-V2 §3).
import {
  Canvas, THEMES, DEFAULT_THEME, applyFx, toast, makeVfx, setSources, marketActivity, candleActivity, isCalm,
  type Theme, type ScreenKey, type HeaderModel, type Vfx, type Intensity, type Activity, type ColorDepth,
} from '@dexterm/tui';
import { makeFixtures, type Fixtures, type FixtureToken, type TranscriptLine } from './fixtures.ts';
import type { AnalystSession, AnalystOpts } from './analyst/session.ts';
import type { AnalystEngine } from './analyst/codex.ts';
import type { DevHistoryBook } from './live/dev-history.ts';
import { fromFixture } from './screener/rows.ts';
import { makeScreenerState, screenerView, type ScreenerState } from './screener/view.ts';
import type { ScreenerFeed } from './feed.ts';
import type { LiveContext } from './live/index.ts';
import type { FlowTracker } from './live/flow.ts';
import { renderScreener } from './screens/screener.ts';
import { renderToken } from './screens/token.ts';
import { renderNewPairs } from './screens/newpairs.ts';
import { renderWatchlist } from './screens/watchlist.ts';
import { renderAnalyst } from './screens/analyst.ts';
import { renderBoot } from './screens/boot.ts';
import { renderOverlay, renderGotoPrompt } from './screens/overlay.ts';
import { renderTicket } from './screens/ticket.ts';
import { renderPositions } from './screens/positions.ts';
import { renderTrending } from './screens/trending.ts';
import { renderKol } from './screens/kol.ts';
import { renderBubbles, type IntelUi } from './screens/bubbles.ts';
import { renderNarrative } from './screens/narrative.ts';
import { renderPlans } from './screens/plans.ts';
import { renderFollows } from './screens/follows.ts';
import { renderRules } from './screens/rules.ts';
import type { RulesUi } from './rules.ts';
import type { PnlUi } from './pnl-app.ts';
import { CopyLive } from './live/copy.ts';
import { CopyAuto, defaultCopyJournalPath, leaderSoldSince, type CopyAlert, type MirrorMarket, type MirrorResult } from '@dexterm/data/copy';
import { computeBoard, loadDefaultLexicon, recentNarrativeRows, type NarrativeBoard, type NarrativeRow } from '@dexterm/packs';
import type { ScreenerRow } from './screener/rows.ts';
import type { SoundState } from '@dexterm/tui';
import type { SocialFeed, KolStore, SummaryLimiter } from '@dexterm/data';
import { PlanService, defaultPlansJournalPath, type PlanRow, type MandateRow } from '@dexterm/data/plans';
import type { SocialFilter } from './social/view.ts';
import { openTicket, type TicketView, type PositionsView } from './trade.ts';
import type { PopupController } from './popup.ts';
import { computeFill, type SwapQuote, type ImageService } from '@dexterm/data';
import type { ImageProtocol, BlockMode } from '@dexterm/tui';
import { renderScanTicker, scanIndicator, type ScanUi } from './scan/ui.ts';
import type { ScanConfig } from './scan/engine.ts';
import { renderVoiceHud, type VoiceHud } from './voice-hud.ts';
import { workspaceBadge, type CustomUi } from './custom.ts';
import type { PriceMode } from './display.ts';

/** The analyst's streaming state: a Claude-Code-style spinner, then the answer decrypts in. */
export interface AiState {
  phase: 'thinking' | 'streaming' | 'done';
  /** Transcript lines before this index are settled; from here on they stream. */
  cut: number;
  /** Characters revealed so far across the streaming lines. */
  revealed: number;
  /** Frames spent thinking. */
  ticks: number;
}

export interface AppState {
  /** trenchscope: the screener draws the simple split view instead of the full table (interactive default). */
  simple?: boolean;
  /** Seeded demo data. The screener reads `screener.rows` instead; the other screens still read this until D-05/D-10/D-11. */
  fx: Fixtures;
  screen: ScreenKey;
  theme: Theme;
  selected: number;
  token: FixtureToken | null;
  aiOpen: boolean;
  paused: boolean;
  now: Date;
  /** IANA zone for the header clock. Fixtures pin America/New_York so renders match everywhere. */
  timeZone?: string;
  refreshedAgo: string;
  feedLabel?: string;
  /** Live SOL quote from the feed (null until a source supplies one; the fixture value is never shown live). */
  sol?: { price: number; chg24: number } | null;
  /** The screener's rows, filter, sort, presets and editor state (D-03). */
  screener: ScreenerState;
  /** The data-store feed behind the screener in live/replay mode; absent on fixtures. */
  feed?: ScreenerFeed;
  /** Live bindings for the token / new pairs / watchlist screens (task-1298); absent on fixtures. */
  live?: LiveContext;
  transcript?: TranscriptLine[];
  aiInput?: string;
  /**
   * Chat-input focus (task-1311, QA B1/B2/B3). On the token and analyst screens the input only
   * captures keystrokes while focused; focus is explicit (`i` or Enter). When false, `q` quits and
   * `1`–`4` switch screens as everywhere else, so the analyst tab is never a trap.
   */
  aiFocused?: boolean;
  /**
   * One Claude conversation per token, keyed by mint, plus the Analyst-tab chat under
   * `ANALYST_TAB_KEY` (task-1311, QA M5). Moving between tokens restores that token's chat instead
   * of cancelling it; `state.analyst` points at the session for whatever is on screen.
   */
  analystByMint?: Map<string, AnalystSession>;
  /**
   * 0.1.5: which of the user's own CLIs runs NEW analyst conversations (`claude` or `codex`), resolved at start
   * from `--analyst-engine` / DEXTERM_ANALYST_ENGINE / config `analyst.engine` / auto, switchable with `/engine`.
   * Absent = claude (one-shot renders, fixtures and tests).
   */
  analystEngine?: AnalystEngine;
  /** 0.1.5 dev history: the per-mint cache over the recorder DB (created on first use in live mode). */
  devBook?: DevHistoryBook;
  /**
   * Cached LARP-detector verdict per mint (task-1315), set when a `larp-check` analyst turn settles.
   * The screener column and token-screen badge are drawn ONLY for a mint present here — never a guess.
   */
  larpByMint?: Map<string, { verdict: string; confidence: number | null; at: number }>;
  /** A contract address the loop should copy to the OS clipboard and confirm (task-1311, QA B5). */
  pendingCopy?: string | null;
  /** task-1401: `E` asked for an export of the current view; the loop renders + writes it (local files only). */
  pendingExport?: boolean;
  /** task-1407: `H` asked for a PnL card of this screen's coin(s); the loop opens the preview (state.pnl). */
  pendingPnl?: boolean;
  /** task-1407: the PnL card preview (overlay 'pnl'); null when closed. */
  pnl?: PnlUi | null;
  /**
   * A website/social URL the loop should open in the OS browser (task-1315, LARP detector). Set by the
   * token screen's W/X/T keys; the loop re-validates the scheme (http/https only) before launching
   * `open`/`xdg-open`, and never opens anything else.
   */
  pendingOpen?: string | null;
  /**
   * A short status message the loop should surface as a durable toast (task-1315). The W/X/T/L keys set
   * both the transient per-action notice (which some screens render) and this, so the link list and the
   * "no link"/"needs live mode" replies stay visible on the token screen (which renders the toast, not
   * the notice) instead of being wiped by the next feed redraw.
   */
  pendingToast?: string | null;
  /** task-1397: "trenchscope X is available" — shown once as a toast after the boot (update.ts startupCheck); null = none. */
  updateNotice?: string | null;
  /**
   * The mint the cursor is on, on the New pairs screen (task-1311, QA M8). New creates insert at the
   * top of the list, so a row index drifts to a different coin; the highlight (and ⏎) follow this mint
   * instead, remapped to its current index on every refresh.
   */
  selectedMint?: string | null;
  /** Scroll offset (wrapped lines) into a long analyst answer (task-1311, QA M12); j/k and PgUp/Dn move it. */
  aiScroll?: number;
  /** Reveal a finished analyst answer in full, skipping the decrypt animation (task-1311, QA M12): set on any key. */
  aiRevealAll?: boolean;
  /**
   * The list-of-coins results table (task-1313 part F) has the keyboard focus: ↑↓ move its cursor,
   * ⏎ jumps to the selected coin's token screen, `o` opens its PAPER ticket, esc returns to the chat.
   * Only meaningful when the current analyst turn produced results and the input is blurred.
   */
  aiResultsActive?: boolean;
  /** Effects state: rain, glitch, mood, toast (task-1297). */
  vfx: Vfx;
  /** Boot sequence progress 0..1 (only read by the boot screen). */
  boot: { t: number };
  /** Analyst streaming state; null = every transcript line is settled. */
  ai: AiState | null;
  /** Live Claude analyst session (task-1302); null = no real analyst running. Set only in live/replay mode. */
  analyst?: AnalystSession | null;
  /** A request for the interactive loop to launch an analyst session (set by applyAction, which cannot spawn). */
  pendingAnalyst?: PendingAnalyst | null;
  /** Recent "analyst did X" UI-action notes, newest last (task-1313); shown beside the chat. */
  analystActions?: string[];
  /** Timestamps of applied analyst UI actions, for rate limiting (task-1313). */
  analystActionTimes?: number[];
  /** A pending tier-(b) config change the analyst proposed (task-1413); the user accepts it with a keypress.
   *  `expiresAt` is an epoch-ms deadline (matches the 8s toast) after which the proposal is treated as gone,
   *  so a stale 'y' typed minutes later never persists a change. */
  analystConfigProposal?: { action: import('@dexterm/data').AnalystAction; summary: string; expiresAt: number } | null;
  /** Colour depth of the run (the boot screen prints it). */
  colorDepth: ColorDepth;
  /** Active modal overlay drawn on top of the screen (task-1305): the first-run welcome or the `?` help card. */
  overlay?: 'welcome' | 'help' | 'links' | 'workspaces' | 'pnl' | null;
  linkMenu?: { items: Array<{ kind: string; url: string }>; selected: number };
  /** PAPER trade ticket view (task-1310); set while the ticket screen is open, else null. */
  ticket?: TicketView | null;
  /** PAPER positions view (task-1310); set while the positions screen is open, else null. */
  positions?: PositionsView | null;
  /**
   * A request for the interactive loop to open/toggle a popup window (task-1290). applyAction cannot spawn
   * the window host, so it sets this and the loop performs the side effect. 'chart' = the live chart HUD.
   */
  pendingPopup?: 'chart' | 'bubbles' | 'narrative' | 'plans' | 'token' | 'feeds' | null;
  /** A `/wallet …` command for the loop to perform (task-1328): link opens a browser; probe opens a LIVE ticket. */
  pendingWallet?: 'status' | 'link' | 'unlink' | 'panic' | 'probe' | null;
  /**
   * The popup-window controller for this run (task-1290); created lazily on the first popup open. Only ever
   * set in live/replay interactive mode. Closing a popup never touches the terminal; quit tears it down.
   */
  popups?: PopupController | null;
  /**
   * Token screen (task-1323): show the raw trade TAPE in the lower-right panel instead of the default
   * BUY/SELL FLOW panel. Off by default; `F` toggles it and it stays as set for the rest of the run.
   */
  tokenTape?: boolean;
  /** Per-mint ring of DexScreener buy/sell samples behind the flow panel's trend arrows (task-1323). */
  tokenFlow?: FlowTracker;
  /**
   * AI SCAN MODE (task-1324): the scan engine + its UI state, created on the first `Z` / `--scan` /
   * `/scan on` (live/replay only). Absent or `engine.mode === 'off'` = the scan is not running.
   */
  scan?: ScanUi | null;
  /** Threshold/cap overrides from the `--scan-*` flags, applied when the scan is first created. */
  scanConfig?: Partial<ScanConfig>;
  /**
   * task-1326 coin images: the service (fetch → decode → cache) for live/replay runs; absent on fixtures
   * and when images are off (`--no-images`, DEXTERM_IMAGES=0, images.json). Screens ask it synchronously.
   */
  images?: ImageService | null;
  /** How this run paints images: a pixel protocol (kitty/iterm/sixel) after the flush, or block art in cells. */
  imageProtocol?: ImageProtocol;
  /** Block-art mode for the token-header hero (list icons always use quadrants). */
  imageBlocks?: BlockMode;
  // ---- task-1330 keyless social layer (TRENDING screen T, token SOCIAL panel s, KOL lists K)
  /** The social feed on fixtures (demo, created lazily by socialOf()); live/replay runs read `live.social`. `null` = none. */
  social?: SocialFeed | null;
  /** The KOL store on fixtures (demo); live/replay runs read `live.kol`. */
  kol?: KolStore | null;
  /** Token screen: SOCIAL panel + AI SUMMARY in place of ON-CHAIN / HOLDERS (`s`). */
  tokenSocial?: boolean;
  /** Source filter for the board and the token panel (`f` cycles all · kol · x · chain · news · own). */
  socialFilter?: SocialFilter;
  /** Show the rows hidden by the spam / squat rules (`x`). */
  socialShowSpam?: boolean;
  /** Trending: SOURCES panel instead of NARRATIVES (`s`). */
  socialSources?: boolean;
  /** Trending: 0 = whole board, n = only the n-th narrative's tokens (`n` cycles). */
  socialNarrative?: number;
  /** Cached analyst summaries per mint (text + when), filled by the loop when a summary turn settles. */
  socialSummaries?: Map<string, { text: string; at: number }>;
  /** One summary per token per 2 min / board per 5 min. */
  socialSummaryLimiter?: SummaryLimiter;
  /** KOL screen: cursor over the flattened list/handle rows, the handle being typed (null = not typing), a reply line. */
  kolSelected?: number;
  kolInput?: string | null;
  kolNotice?: string | null;
  /** task-1357 per-KOL filter: only this handle's posts on the board / token panel (`o` on the KOL screen; `f` clears). */
  socialAuthor?: string | null;
  /** task-1357: an X-list import in flight (the KOL screen shows it; one at a time). */
  kolImporting?: boolean;
  // ---- task-1356 AI suite: narrative board screen
  /** The narrative board (recomputed on entry / tick from the recorder or the visible rows); set when the screen opens. */
  narrative?: NarrativeView | null;
  // ---- task-1355 order plans + standing mandates screen (key O)
  /**
   * The plan engine + hash-chained journal (recovered from ~/.dexterm/plans.journal on first open). It is the
   * SIGNER trust domain: the screen can only read rows, cancel/revoke (no gesture needed), panic, or arm
   * through the keypress hold gate. Created lazily so fixtures/replay never touch the on-disk journal unless
   * the screen is opened. Held on AppState (not LiveContext) so it also works in fixtures/demo.
   */
  plansSvc?: PlanService | null;
  /** The plans screen's UI state (plans|mandates tab, cursor, and the hold-to-arm modal); set when the screen opens. */
  plansUi?: PlansUi | null;
  // ---- task-1360 copy trading: the FOLLOWED WALLETS screen (key U)
  /** The follow store + tracker for this run (live: the context's; fixtures: a store-only binding). Created on first open. */
  copy?: CopyLive | null;
  /** The follows screen's UI state (cursor, the address being typed, a reply line); set when the screen opens. */
  copyUi?: FollowsUi | null;
  // ---- task-1358 Tier 3 rules engine: the RULES screen (ctrl+r)
  /** The rules engine + screen state (rules, proposals, log, the rule being typed). Created when config loads or the screen opens. */
  rulesUi?: RulesUi | null;
  /** task-1358 Tier 5: last push time per open pack widget + topic (`<key>|<topic>` → ms); the sync path throttles on it. */
  widgetSync?: Map<string, number>;
  // ---- task-1340 wallet intel + trade moments
  /** The BUBBLE MAP screen's UI state (which coin, selection, bubbles ⇄ treemap, zoom); set when the screen opens. */
  intelUi?: IntelUi | null;
  /** Sound cues for trade moments (`--sound` / DEXTERM_SOUND=1); muted by default. */
  sound?: SoundState;
  /**
   * Voice-mode HUD snapshot (task-1282, JARVIS). Present only once voice mode has been enabled; the
   * VoiceController pushes its status here and the always-on indicator on row 1 renders from it.
   */
  voice?: VoiceHud | null;
  /**
   * task-1358 customization: config.json + workspaces (active name, the ctrl+w chord, the save-as input, popups
   * the loop must open). Absent on one-shot fixture frames so the snapshot goldens never read a user's config.
   */
  custom?: CustomUi | null;
  /**
   * task-1366: price display mode — 'price' (USD per token, the default) or 'mcap' (market cap = price × supply, history
   * scaled by the CURRENT supply). Set from config.display.priceMode / --price-mode / a workspace; `$` toggles + saves.
   * Display only: nothing that trades reads it.
   */
  priceMode?: PriceMode;
  /**
   * task-1388 GO-TO prompt: the one-line "paste a contract address to open any coin" input, opened with `g`
   * on the screener / new pairs / watchlist / token screens. `null` = closed. While open the interactive loop
   * captures every key into it (so a base58 char like v/m/c never toggles voice or calm). Read-only navigation:
   * ⏎ opens the coin's live token screen, esc cancels, bad input sets `notice` and changes nothing.
   */
  goto?: GotoPrompt | null;
}

/** task-1388: the GO-TO prompt's state (the text being typed + a one-line notice for bad input). */
export interface GotoPrompt {
  input: string;
  notice: string | null;
}

/** Launch request raised by a key, fulfilled by the interactive loop (which can spawn `claude`). */
export interface PendingAnalyst {
  skill: AnalystOpts['skill'];
  mint?: string;
  symbol?: string;
  model?: string;
  /** The screen the session belongs to; the loop focuses it. */
  target: ScreenKey;
  /**
   * A free-text question (task-1311): when set, the loop starts the session with this chat turn
   * instead of the structured skill run, so a typed question never triggers a paid dossier (QA B3).
   */
  question?: string;
}

/** Map key for the Analyst-tab's own conversation (not tied to a single token). */
export const ANALYST_TAB_KEY = '__analyst_tab__';

/**
 * The conversation key for whatever is on screen: the token's mint on the token screen, the shared
 * Analyst-tab key on the analyst screen, else null (no chat surface). Drives `state.analystByMint`.
 */
export function analystKey(s: AppState): string | null {
  if (s.screen === 'token') return s.live?.token?.view.mint ?? s.token?.mint ?? null;
  if (s.screen === 'analyst') return ANALYST_TAB_KEY;
  return null;
}

/** Point `state.analyst` at the saved conversation for the current screen (task-1311, QA M5). */
export function syncAnalyst(s: AppState): void {
  const k = analystKey(s);
  if (!k || !s.analystByMint) return;
  s.analyst = s.analystByMint.get(k) ?? null;
}

/**
 * Keep the New pairs highlight on the coin the cursor picked, not on a row index (task-1311, QA M8):
 * remap `state.selected` to the current position of `state.selectedMint`. Called after the list
 * changes. When the pinned mint has scrolled off, the selection is clamped in place.
 */
export function pinNewpairsSelection(s: AppState): void {
  const live = s.live;
  if (!live || s.screen !== 'newpairs' || !s.selectedMint) return;
  const list = live.newpairs.list();
  const i = list.findIndex((r) => r.mint === s.selectedMint);
  if (i >= 0) s.selected = i;
  else if (list.length) s.selected = Math.max(0, Math.min(list.length - 1, s.selected || 0));
}

// ---- task-1356 narrative board view -------------------------------------------------------------
export interface NarrativeView {
  board: NarrativeBoard | null;
  window: '1h' | '24h';
  computedAt: number;
  /** 'recorded' = from the history recorder; 'screen' = from the visible rows; 'none' = nothing to cluster. */
  source: 'recorded' | 'screen' | 'none';
  selected: number;
  error?: string | null;
}

/** Map the screener's visible rows to narrative rows (the fallback source when there is no recorder DB). */
export function narrativeRowsFromScreener(rows: readonly ScreenerRow[]): NarrativeRow[] {
  return rows.filter((r) => r.mint && !r.skeleton).map((r) => ({
    mint: r.mint, symbol: r.symbol, name: r.name,
    vol_h1: r.vol1h, vol_h24: r.vol24, chg_h1: r.chg.h1, chg_h24: r.chg.h24,
    holder_count: r.holders, liquidity_usd: r.liq, mcap: r.mcap,
    age_sec: r.ageMin == null ? null : Math.round(r.ageMin * 60), feeds: [], t: r.fetchedAt,
  }));
}

/**
 * Recompute the narrative board for the current state: from the history recorder when its DB is reachable
 * (the design's recorded-history source), else from the visible screener rows so the board is always
 * populated in fixtures / replay / live-without-recorder.
 */
export function computeNarrativeView(state: AppState, window: '1h' | '24h', now = Date.now()): NarrativeView {
  const lex = loadDefaultLexicon();
  try {
    const db = state.live?.recorder?.database ?? null;
    if (db) {
      const rows = recentNarrativeRows(db, { now });
      if (rows.length) return { board: computeBoard(rows, lex, { window, now }), window, computedAt: now, source: 'recorded', selected: 0 };
    }
    const rows = narrativeRowsFromScreener(state.screener.rows);
    if (rows.length) return { board: computeBoard(rows, lex, { window, now }), window, computedAt: now, source: 'screen', selected: 0 };
    return { board: null, window, computedAt: now, source: 'none', selected: 0 };
  } catch (e) {
    return { board: null, window, computedAt: now, source: 'none', selected: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- task-1355 order plans + mandates view ------------------------------------------------------
/**
 * The plans screen's UI state. `arming` is the hold-to-confirm MODAL: while it is set the interactive
 * loop routes every key to the arm gate (so a stray key can never arm), exactly like the paper ticket.
 * Arming a plan needs a mandate to arm it INTO; `arming.mandateId` is the selected armed mandate.
 */
export interface PlansUi {
  /** which list the cursor is on */
  tab: 'plans' | 'mandates';
  /** cursor within the active list */
  selected: number;
  /** transient one-liner (refusal reason, confirmation); cleared on the next key */
  notice: string | null;
  /** the hold-to-arm modal, or null when not arming */
  arming: { kind: 'plan'; id: string; mandateId: string; held: number } | { kind: 'mandate'; id: string; held: number } | null;
  /** the "less safe" hands-free opt-in modal (Tier 4): accepted by a physical keypress only, or null */
  riskModal: boolean;
  /** task-1363: the FIRE PATH modal (paper ⇄ live devnet fast wallet): switched by a captured physical keypress only */
  liveModal: boolean;
}

export function newPlansUi(): PlansUi { return { tab: 'plans', selected: 0, notice: null, arming: null, riskModal: false, liveModal: false }; }

/**
 * task-1363: how old a board price may be and still fire a plan. The terminal feeds the plan engine from its
 * screener/watchlist refresh (about every 10 s) and the token screen, so the engine's 3 s default would never
 * see two consecutive fresh ticks; 15 s keeps the two-tick debounce meaningful at that cadence.
 */
export const PLANS_TICK_MAX_AGE_MS = 15_000;

/**
 * The plan service for this run, created on first open and recovered from its journal. Held on AppState so
 * the screen works in fixtures/replay/live alike; a test can inject one via `state.plansSvc`.
 */
export function plansService(state: AppState, env: NodeJS.ProcessEnv = process.env): PlanService {
  if (!state.plansSvc) state.plansSvc = new PlanService({ journalPath: defaultPlansJournalPath(env), priceMaxAgeMs: PLANS_TICK_MAX_AGE_MS });
  return state.plansSvc;
}

/** The rows the plans screen shows for the active tab (plans or mandates). */
export function plansRows(state: AppState): readonly (PlanRow | MandateRow)[] {
  const svc = state.plansSvc;
  if (!svc) return [];
  return state.plansUi?.tab === 'mandates' ? svc.listMandates() : svc.listPlans();
}

// ---- task-1360 copy trading: followed wallets view ----------------------------------------------
/** The follows screen's UI state. `input` is the address (+ optional label) being typed; null = not typing. */
export interface FollowsUi {
  selected: number;
  input: string | null;
  notice: string | null;
  /**
   * Tier 2: the MIRROR TICKET preview for one buy alert. `pending` while price / liquidity / decimals resolve;
   * `result` is the mirror build (sized proposal or refusal with every check). Pressing m again on an ok result
   * PROPOSES the plan (inert); esc closes. Nothing in this object can arm.
   */
  mirror: { alert: CopyAlert; market: MirrorMarket | null; result: MirrorResult | null; pending: boolean } | null;
  /**
   * Tier 3: the AUTO-MIRROR modal for one wallet. Like the arm modal it is only a flag: the ENABLE is a physical
   * keypress captured in the interactive loop (never applyAction, so a pipe/agent cannot), and it needs the plan
   * engine's less-safe popup already accepted. Turning auto OFF needs no gesture and happens on `A` directly.
   */
  autoModal: { wallet: string } | null;
  /**
   * task-1399: the per-wallet DETAIL view (one followed wallet's own recent trades + positions + metrics, each
   * labelled with its source and data age). `enter` opens it for the selected wallet, `esc` closes. Read-only:
   * nothing on it trades, arms or signs. `scroll` is the trades/positions scroll offset.
   */
  detail: { wallet: string; scroll: number } | null;
}

export function newFollowsUi(): FollowsUi { return { selected: 0, input: null, notice: null, mirror: null, autoModal: null, detail: null }; }

/**
 * Tier 3: the auto-mirror service for this run, attached to the copy binding on first use. It sits on the plan
 * service (the signer trust domain) and the copy binding's market resolver; its journal is ~/.dexterm/copy.journal.
 * Auto is OFF after every start; enabling is a keypress on the follows screen.
 */
export function copyAutoService(state: AppState, env: NodeJS.ProcessEnv = process.env): CopyAuto {
  const copy = copyService(state, env);
  if (!copy.auto) {
    const plans = plansService(state, env);
    const live = state.live ?? null;
    copy.auto = new CopyAuto({
      plans, journalPath: defaultCopyJournalPath(env),
      market: (mint) => copy.mirrorMarket(mint, {}),
      trades: (wallet) => copy.trades(wallet),
      isFollowed: (wallet) => copy.store.has(wallet),
      leaderIntel: (mint, wallet) => {
        const res = live?.intel.entry(mint)?.result;
        if (!res || res.state !== 'ok') return null;
        const h = res.analysis.holders.find((x) => x.owner === wallet);
        return { inDevCluster: res.analysis.clusters.some((c) => c.kind === 'dev-linked' && c.members.includes(wallet)) || !!h?.labels.some((l) => l.label === 'dev'), holdsPct: h ? h.pct : null };
      },
    });
  }
  return copy.auto;
}
export { leaderSoldSince };

/** The user's own cap for ONE mirror ticket (USD). The mandate's per-trade cap still applies at arming. */
export const MIRROR_DEFAULT_CAP_USD = 20;

/**
 * The copy-trading binding for this run: the live context's (polling Helius history) when there is one, else a
 * store-only binding whose tracker says "unavailable" (fixtures / one-shot). A test injects `state.copy`.
 */
export function copyService(state: AppState, env: NodeJS.ProcessEnv = process.env): CopyLive {
  if (!state.copy) state.copy = state.live?.copy ?? new CopyLive(null, { env });
  return state.copy;
}

export type ScreenRenderer = (c: Canvas, s: AppState) => void;

export const RENDERERS: Record<ScreenKey, ScreenRenderer> = {
  screener: renderScreener,
  token: renderToken,
  newpairs: renderNewPairs,
  watchlist: renderWatchlist,
  analyst: renderAnalyst,
  boot: renderBoot,
  ticket: renderTicket,
  positions: renderPositions,
  trending: renderTrending,
  kol: renderKol,
  bubbles: renderBubbles,
  narrative: renderNarrative,
  plans: renderPlans,
  follows: renderFollows,
  rules: renderRules,
};

export const SCREEN_NAMES = Object.keys(RENDERERS) as ScreenKey[];

export function isScreenKey(s: string): s is ScreenKey {
  return (SCREEN_NAMES as string[]).includes(s);
}

/** Screens that render fixtures while the app runs on real data (the analyst until the Claude lane; any live screen without its binding). */
export function isDemoScreen(s: AppState): boolean {
  if (s.screener.source === 'fixtures') return false;
  if (s.screen === 'screener') return false;
  if (s.screen === 'token') return !s.live?.token;
  if (s.screen === 'newpairs' || s.screen === 'watchlist') return !s.live;
  // PAPER trade screens carry their own banner; the header shows a PAPER status, not "demo data".
  if (s.screen === 'ticket' || s.screen === 'positions') return false;
  // task-1330: the social screens read real keyless venues/news in live mode (fixtures mode is demo like the rest).
  if (s.screen === 'trending' || s.screen === 'kol') return false;
  // task-1340: the bubble map reads the live scan (its own screen says loading / unavailable when it has nothing)
  if (s.screen === 'bubbles') return false;
  // task-1360: the follows screen shows the user's own list + the tracker's real state (unavailable when keyless).
  if (s.screen === 'follows') return false;
  // analyst screen: a live Claude session (even mid-run or failed) is real output, not demo data
  return !s.analyst;
}

/** The header's view of the state. Screens still on fixtures say so when the app runs on real data. */
export function headerModel(s: AppState): HeaderModel {
  const demo = isDemoScreen(s);
  let status = s.screener.headerStatus;
  let feedLabel = s.feedLabel;
  if (s.live && !demo) {
    if (s.screen === 'newpairs') { const st = s.live.newpairs.status(); status = st.headerStatus ?? status; feedLabel = st.caption; }
    else if (s.screen === 'watchlist') { status = s.live.watch.status().headerStatus ?? status; feedLabel = 'dexscreener · jup · sqlite watchlist'; }
    else if (s.screen === 'token') feedLabel = `${s.live.rpc.provider === 'helius' ? 'helius · ' : ''}gecko · rugcheck · goplus · dexscreener · jup`;
    status = s.live.creditsStatus() ?? status;
  }
  if (s.screen === 'ticket' || s.screen === 'positions') { status = '◈ PAPER · simulation'; feedLabel = 'jupiter keyless quote · paper wallet'; }
  if (s.screen === 'trending' && s.live) feedLabel = 'jupiter · gecko · boosts · coingecko · rss · keyless';
  if (s.screen === 'kol') feedLabel = 'kol lists · sqlite';
  // task-1355: the plans screen is the signer trust domain; it is paper by default and says so.
  // task-1363: once the fire path is LIVE (devnet fast wallet, keypress opt-in) the header says so; anything not
  // provably paper renders LIVE (fail-safe).
  if (s.screen === 'plans') {
    const paper = s.plansSvc ? s.plansSvc.mode() === 'paper' : true;
    status = paper ? '◈ PAPER · plans journal' : '◉ LIVE · DEVNET · fast wallet';
    feedLabel = paper ? 'order plans · standing mandates · hash-chained journal' : 'order plans · signer process · fast wallet · devnet';
  }
  // task-1360: the follows screen reads public history for the user's own list; it never trades.
  if (s.screen === 'follows') feedLabel = `${s.live?.rpc.provider === 'helius' ? 'helius history · ' : ''}your follow list (local) · alerts`;
  // task-1358: the rules screen evaluates the screener rows locally; rules only alert or PROPOSE.
  if (s.screen === 'rules') feedLabel = 'rules · config.json · alerts + proposals only · nothing arms';
  if (s.screen === 'bubbles') feedLabel = `${s.live?.rpc.provider === 'helius' ? 'helius history · ' : ''}rpc holders · rules · sqlite`;
  // task-1328: a LIVE ticket says so in the header, with the SIGNER's network (never a UI flag).
  if (s.screen === 'ticket' && s.live?.ticket?.ticket.mode === 'live') {
    const net = s.live.ticket.view().live?.signer?.network ?? null;
    status = net === 'mainnet' ? '⚠ LIVE · MAINNET · real funds' : net === 'devnet' ? '◉ LIVE · DEVNET' : '◉ LIVE · signer unreachable';
    feedLabel = 'signer process · jupiter · phantom';
  }
  // task-1324: while AI scan mode is on the header ALWAYS says so (state + the scan's analyst meter +
  // any Helius credit warning), on every screen — the running indicator wins over every other status.
  let scanStatus: string | null = null;
  if (s.scan?.engine.on) scanStatus = s.live?.meterStatus(scanIndicator(s.scan)) ?? scanIndicator(s.scan);
  return {
    screen: s.screen, paused: s.paused,
    // live mode never shows the fixture SOL quote; it shows the real one when the feed carried it, else nothing
    sol: s.screener.source === 'fixtures' ? s.fx.sol : (s.sol ?? null),
    now: s.now, timeZone: s.timeZone, feedLabel,
    status: scanStatus ?? (demo ? '◌ demo data' : status),
    calm: isCalm(s.vfx),
  };
}

/** Wrapped SOL mint: when it is among the enriched rows the header can quote it for free. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface FixtureStateOpts {
  screen?: ScreenKey;
  theme?: Theme;
  selected?: number;
  seed?: number;
  aiOpen?: boolean;
  /** Default 'America/New_York' (the zone the prototype screenshots were taken in). */
  timeZone?: string | null;
  /** Effects intensity; default off (calm). `calm` is shorthand for 'off'. */
  intensity?: Intensity;
  calm?: boolean;
  /** Effect frame index for one-shot renders (deterministic). */
  frame?: number;
  /** Hex-only rain glyphs (no katakana). */
  asciiRain?: boolean;
  colorDepth?: ColorDepth;
}

/** The prototype's frozen clock: 2026-10-05 23:04:11 UTC (19:04:11 in New York). */
export const FIXTURE_NOW = new Date(Date.UTC(2026, 9, 5, 23, 4, 11));

export function makeFixtureState(opts: FixtureStateOpts = {}): AppState {
  const seed = opts.seed ?? 7;
  const fx = makeFixtures(seed);
  const screen = opts.screen ?? 'screener';
  const selected = opts.selected ?? 0;
  const vfx = makeVfx({ seed, intensity: opts.intensity, calm: opts.calm, ascii: opts.asciiRain });
  vfx.frame = opts.frame ?? 0;
  const state: AppState = {
    fx,
    screen,
    theme: opts.theme ?? THEMES[DEFAULT_THEME],
    selected,
    token: screen === 'token' ? fx.tokens[selected] ?? fx.tokens[0] : null,
    aiOpen: opts.aiOpen ?? true,
    paused: false,
    now: new Date(FIXTURE_NOW.getTime()),
    timeZone: opts.timeZone === null ? undefined : (opts.timeZone ?? 'America/New_York'),
    refreshedAgo: '2s',
    screener: makeScreenerState('fixtures', fx.tokens.map(fromFixture)),
    vfx,
    boot: { t: 1 },
    ai: null,
    analystByMint: new Map(),
    larpByMint: new Map(),
    colorDepth: opts.colorDepth ?? 'truecolor',
  };
  refreshVfx(state);
  if (screen === 'ticket' || screen === 'positions') seedDemoTrade(state);
  return state;
}

/**
 * Seed a demo PAPER ticket / positions view for one-shot fixture frames (`--screen ticket/positions
 * --fixtures`) so the screens render without a live binding. The real data comes from the live
 * bindings (live/trade.ts); this is only the fixtures/evidence path.
 */
export function seedDemoTrade(state: AppState): void {
  const mint = 'FTREEabc1111111111111111111111111111111111x';
  const decimals = 6;
  if (state.screen === 'ticket') {
    const ticket = openTicket({ mint, symbol: 'FTREE', decimals, side: 'buy' });
    ticket.sizeInput = '0.5';
    const quote: SwapQuote = {
      inputMint: SOL_MINT, outputMint: mint, inAmount: 500_000_000n, outAmount: 1_250_000_000n,
      otherAmountThreshold: 1_243_750_000n, mode: 'ExactIn', slippageBps: 50, priceImpactPct: 0.42,
      route: ['Meteora', 'Whirlpool'], platformFeeBps: null, platformFeeAmount: null, usdValue: 75,
      contextSlot: 1, source: 'jupiter-swap', fetchedAt: FIXTURE_NOW.getTime(),
    };
    const order = { mint, symbol: 'FTREE', side: 'buy' as const, decimals, amountRaw: 500_000_000n, slippageBps: 50 };
    state.ticket = {
      ticket, balanceSol: 10, positionTokens: 0, positionValueSol: null, quote,
      preview: computeFill(order, quote, FIXTURE_NOW.getTime()), quoteAgeMs: 2000, loading: false, error: null, receipt: null, rateLimited: false,
    };
  } else {
    state.positions = {
      balanceSol: 8.5, startSol: 10, equitySol: 10.42, totalUnrealizedSol: 0.42, totalRealizedSol: 0.12, totalPct: 0.042,
      solPriceUsd: 150,
      rows: [{ mint, symbol: 'FTREE', tokens: 1250, costSol: 1.5, avgEntrySol: 0.0012, priceSol: 0.00154, valueSol: 1.92, unrealizedSol: 0.42, unrealizedPct: 0.28, realizedSol: 0.12 }],
      history: [
        { id: 2, t: FIXTURE_NOW.getTime() - 30_000, mint, symbol: 'FTREE', side: 'sell', decimals, solDelta: 300_000_000n, tokenDelta: -200_000_000n, grossLamports: 300_005_000n, feeLamports: 5_000n, priceSol: 0.0015, priceUsd: 0.225, priceImpactPct: 0.3, slippageBps: 50, route: ['Meteora'], realizedLamports: 60_000_000n, paper: true },
        { id: 1, t: FIXTURE_NOW.getTime() - 120_000, mint, symbol: 'FTREE', side: 'buy', decimals, solDelta: -1_500_005_000n, tokenDelta: 1_250_000_000n, grossLamports: 1_500_000_000n, feeLamports: 5_000n, priceSol: 0.0012, priceUsd: 0.18, priceImpactPct: 0.42, slippageBps: 50, route: ['Meteora', 'Whirlpool'], realizedLamports: 0n, paper: true },
      ],
      loading: false,
    };
  }
}

/**
 * State over a data-store feed (live or replayed recording). The fixtures still back the screens
 * that have not been ported (token detail D-05, new pairs D-10, watchlist D-11); the header marks
 * them as demo data. Call syncFeed() after every refresh.
 */
export function makeFeedState(feed: ScreenerFeed, source: 'live' | 'replay', opts: FixtureStateOpts = {}): AppState {
  const state = makeFixtureState(opts);
  state.feed = feed;
  state.screener = makeScreenerState(source, [], { presets: feed.presets(), gates: feed.gates() });
  state.screener.preset = feed.preset;
  syncFeed(state);
  return state;
}

/** Copy the feed's rows, gates, health status and clock into the state, then rebuild the rain sources and activity. */
export function syncFeed(state: AppState): void {
  const feed = state.feed;
  if (!feed) return;
  const sc = state.screener;
  sc.rows = feed.rows;
  sc.gates = feed.gates();
  sc.presets = feed.presets();
  sc.preset = feed.preset;
  sc.pool = feed.pool;
  sc.slowing = feed.slowing;
  const st = feed.status();
  sc.headerStatus = st.headerStatus;
  sc.errors = st.errors;
  state.feedLabel = st.feedLabel;
  const sol = feed.rows.find((r) => r.mint === SOL_MINT);
  if (sol && sol.price !== null) state.sol = { price: sol.price, chg24: sol.chg.h24 ?? 0 };
  state.refreshedAgo = feed.refreshedAgo();
  state.now = new Date(feed.now());
  refreshVfx(state);
}

/** Rain columns are the user's own data: watchlist + screener tickers, mint prefixes, trade address tails (VISUAL-V2 §7). */
export function rainSources(state: AppState): string[] {
  const s: string[] = [];
  const fx = state.fx;
  for (const w of fx.watch) s.push(w.token.symbol);
  const live = state.screener.source !== 'fixtures' ? state.screener.rows : [];
  if (live.length) {
    for (const r of live.slice(0, 16)) s.push(r.symbol.toUpperCase());
    for (const r of live.slice(0, 10)) s.push(r.mint.slice(0, 10).toUpperCase());
  } else {
    for (const t of fx.tokens.slice(0, 12)) s.push(t.symbol);
    for (const t of fx.tokens.slice(0, 8)) s.push(t.mint.slice(0, 10).toUpperCase());
  }
  for (const t of fx.tokens.slice(0, 4)) for (const tr of t.trades.slice(0, 3)) s.push(tr.addr.slice(-8).toUpperCase());
  return s;
}

/**
 * Market activity for the rain (VISUAL-V2 §3, §7): on the token screen the selected token's own
 * candles drive colour and speed; elsewhere the cross-section of the rows on screen does (live
 * rows when the feed has them, fixtures otherwise), with volume velocity when the source reports it.
 */
export function activityFor(state: AppState): Activity {
  if (state.screen === 'token') {
    const tk = state.token || state.fx.tokens[state.selected || 0];
    if (tk) return candleActivity(tk.candles, tk.chg.m5);
  }
  const live = state.screener.source !== 'fixtures' ? state.screener.rows : [];
  if (live.length) {
    const rows = state.screen === 'screener' ? screenerView(state.screener) : live;
    const use = rows.length ? rows : live;
    return marketActivity(
      use.map((r) => r.chg.m5),
      use.map((r) => (r.vol5m !== null && r.vol24 !== null && r.vol24 > 0 ? (r.vol5m * 288) / r.vol24 : null)),
    );
  }
  const all = [...state.fx.tokens, ...state.fx.newPairs];
  return marketActivity(all.map((t) => t.chg.m5));
}

/** Rebuild rain sources and set activity/mood directly from the data (one-shot renders and feed syncs). */
export function refreshVfx(state: AppState): void {
  setSources(state.vfx, rainSources(state));
  const act = activityFor(state);
  state.vfx.activity = act.activity;
  state.vfx.mood = act.mood;
}

/** Render one frame of the current screen into a fresh canvas: screen → toast → effects. */
export function renderFrame(state: AppState, w: number, h: number): Canvas {
  const c = new Canvas(w, h, state.theme);
  c.fill(0, 0, w, h, ' ', { bg: state.theme.bg });
  c.imageMode = state.images && state.imageProtocol && state.imageProtocol !== 'blocks' ? 'pixels' : 'cells';
  (RENDERERS[state.screen] || renderScreener)(c, state);
  // task-1324: the SCANNING ticker on row 1 (the blank band under the header) of every list screen; the
  // live token screen draws its own WHY IT TRIGGERED strip there (token-live.ts).
  if (state.scan?.engine.on && state.screen !== 'boot' && state.screen !== 'token') renderScanTicker(c, state.scan, state.live?.scanMeterLabel() ?? '');
  if (state.screen !== 'boot') toast(c, state.vfx.toast);
  applyFx(c, state.vfx, { scan: state.screen !== 'boot' });
  // The voice indicator (task-1282) draws after the effects so the mic-live badge is always crisp and
  // unmistakable. Suppressed on the boot screen, where row 1 is part of the boot art.
  if (state.voice?.enabled && state.screen !== 'boot') renderVoiceHud(c, state.voice, state.theme);
  // task-1358: the workspace badge (non-default name, a pending ctrl+w chord, the save-as input) on the band
  // under the header, right-aligned, drawn after the effects so it is always legible. Nothing on `default`.
  const badge = state.screen !== 'boot' ? workspaceBadge(state.custom, state.now.getTime()) : null;
  if (badge) {
    const t = state.theme;
    const text = badge.text.slice(0, Math.max(0, w - 2));
    const x = Math.max(0, w - text.length - 1);
    c.noRain(x, 1, text.length, 1);
    c.text(x, 1, text, badge.kind === 'input' ? { fg: t.text, bg: t.accentSoft, b: true } : badge.kind === 'chord' ? { fg: t.warn, bg: t.warnSoft, b: true } : { fg: t.accent, bg: t.headBg, b: true });
  }
  // Overlays (task-1305) draw last, over the effects, so the welcome/help card is always crisp.
  if (state.overlay) renderOverlay(c, state);
  // task-1388: the GO-TO prompt draws on top of everything (but is mutually exclusive with an overlay).
  if (state.goto) renderGotoPrompt(c, state);
  return c;
}
