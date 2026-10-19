// trenchscope CLI entry.
//
//   trenchscope                                         interactive, live keyless data (needs a TTY)
//   trenchscope --fixtures                              interactive demo on seeded fixture data
//   trenchscope --screen screener                       one-shot live frame to stdout
//   trenchscope --screen screener --fixtures            one-shot demo frame
//   trenchscope --screen screener --replay FILE         one-shot frame from a recording (no network)
//   trenchscope --screen screener --record FILE         live frame, and save the responses for --replay
//   trenchscope --screen token --mint MINT              one-shot live token detail (Helius holders when the key is configured)
//   trenchscope --screen newpairs --listen 30           one-shot: listen to PumpPortal for 30 s, then render
//   options: --filter QUERY --sort KEY[:asc|desc] --preset NAME --max-requests N --max-credits N --db PATH
//            --mint MINT --interval 1m|5m|15m|1h|4h|1d --listen SECONDS
//            --width N --height N --theme cyberspace|midnight|ember|paper --selected N --seed N --no-ai
//            --calm | --intensity off|normal|fever  --fps N  --frame N  --no-boot
//            --event newpair|pump|dump|rug  --ai thinking|streaming:N  --mood pump|dump|neutral  --activity 0..1  --t 0..1
//            --plain | --ansi | --html FILE [--fit WxH --font PX]  --color truecolor|256|none  --tz ZONE  --title TEXT
import { writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { writeExport, exportViewFor } from './export.ts';
import { openPnl, loadPnl, pnlKey } from './pnl-app.ts';
import { shareCard, runLocal } from './pnl-card.ts';
import { parseMintTarget, parseCoinTarget, resolveCoinTarget, isBareOpen, type CoinTarget } from './coin-target.ts';
import {
  THEMES, isThemeName, DEFAULT_THEME, THEME_NAMES, Flusher, ENTER_SCREEN, LEAVE_SCREEN, DEFAULT_KEYMAP, Keymap, nextTheme, parseKeys, keyId,
  detectColorDepth, parseColorDepth, blinkFrame, blinkFrames, stepVfx, pulse, isCalm, fxBusy, blendActivity,
  ImageLayer, queryTerminal, resolveProtocol, type ImageCaps,
  fireMoment, fireInflight, clearInflight, skipMoment, momentKindFor, playMoment, soundOn, breakpoint,
  type Canvas, type ColorDepth, type ScreenKey, type AppAction, type Key, type Intensity, type Mood, type PulseKind, type SettledTx, type Rect, type Theme,
  fmtUsd as fmtUsdTui,
} from '@dexterm/tui';
import { resolveRpcUrl, resolveTrackerKey, resolveShrineKey, redactSecrets, defaultDbPath, extraRpcUrls, wsUrlFor, SOLANA_PUBLIC_RPC_WS, parseHttpUrl, validateAnalystAction, ACTION_RATE, ACTION_TIER, configChangeForAction, ImageService, encodePng, SummaryLimiter, buildSummaryWindow, KolStore, Cache, PackError, normalizeHandle, terminalSafe, type CandleInterval, type FastLaneEndpoint, type RpcConfig, type Launchpad, type TrendRow, type AnalystAction } from '@dexterm/data';
import { Recorder, recorderEnabled, MaintenanceSchedule } from '@dexterm/recorder';
import { makeFixtureState, makeFeedState, syncFeed, renderFrame, isScreenKey, activityFor, SCREEN_NAMES, analystKey, syncAnalyst, pinNewpairsSelection, ANALYST_TAB_KEY, computeNarrativeView, newPlansUi, plansService, plansRows, newFollowsUi, copyService, copyAutoService, MIRROR_DEFAULT_CAP_USD, type AppState } from './state.ts';
import { mulberry32, tick, spawnPair, shock, type FixtureToken, type WatchRow, type Rng } from './fixtures.ts';
import type { ScreenerRow } from './screener/rows.ts';
import { createLiveFeed, createReplayFeed, type ScreenerFeed } from './feed.ts';
import { LiveContext, INTERVALS, WATCH_REFRESH_MS, POSITIONS_REFRESH_MS, popupBubbleVM, type NewPairRow, type WatchViewRow } from './live/index.ts';
import type { BubbleVM, NarrativeBoardVM, PlansVM, TokenDetailVM } from '@dexterm/popup';
import type { NarrativeBoard } from '@dexterm/packs';
import type { SpectatorNav } from '@dexterm/agents';
import { FOLLOW_NAV_ACTIONS } from '@dexterm/mcp';
import { McpFollowSession } from './mcp-follow.ts';
import { AgentPaperSwitch } from './agent-paper.ts';
import { TOKEN_REFRESH_MS, CandlePrefetcher } from './live/token.ts';
import { PRESETS, presetSpec, type PresetId } from './screener/presets.ts';
import { parseSortArg, SORT_KEYS, type SortDir } from './screener/sort.ts';
import { parseFilter } from './screener/filter.ts';
import {
  screenerView, setFilter, setSort, setPreset, stepPreset, clampSelection, openFilterEditor, openSortMenu, filterEditorKey, sortMenuKey,
} from './screener/view.ts';
import { readBootState, bootPlan, recordBoot, bootTrace, dextermHome } from './boot-state.ts';
import { socialOf, kolOf, trendingRows, kolRows, nextSocialFilter, feedsPopupModel, type KolRow } from './social/view.ts';
import { TokenPopups, tokenDetailVMFromView } from './popup.ts';
import { widgetPage, widgetEnabled, syncWidgetPopups } from './widgets.ts';
import { recordLarpVerdict } from './larp-record.ts';
import { rulesUiOf, rulesTick, rulesMove, beginRuleInput, saveRuleInput, dryRunNow, removeSelectedRule, toggleSelectedRule, dismissSelectedProposal, actOnSelectedProposal, RULE_INPUT_MAX } from './rules.ts';
import { buildNotifier, hasPushChannel } from './alerts/notifier.ts';
import { copyAlertToDelivery } from './alerts/format.ts';
import { readTelegramCreds, readDiscordCreds } from './alerts/creds.ts';
import { launchIntelCells, launchRetryable } from './live/intel.ts';
import { AnalystSession } from './analyst/session.ts';
import { analystCliOnPath, parseEngineChoice, resolveEngine, type AnalystEngine, type EngineChoice } from './analyst/codex.ts';
import type { AnalystDeps } from './analyst/backend.ts';
import { resolveAnalystResults, type ResolvedResult } from './analyst/results.ts';
import { parseScanCommand, SCAN_FLAGS, checkScanFlag, SCAN_HELP, type ScanCommand } from './scan/command.ts';
import { parseWalletCommand, WALLET_HELP } from './wallet-command.ts';
import { X_HELP } from './x-cmd.ts';
import { makeScanUi, MODE_LABEL, SCAN_ACTION_TYPES, SCAN_TICK_MS, SCAN_RECOMPUTE_MS } from './scan/ui.ts';
import { buildObservations, observeSig } from './scan/observe.ts';
import type { ScanConfig, ScanDecision, ScanEngine } from './scan/engine.ts';
import { cleanText } from './screener/rows.ts';
import { resolveImagesConfig } from './images-config.ts';
import { popupImagePath } from './screens/coin.ts';
import { VoiceController, selectStt, selectTts, SayTts, voiceStyleDefaults, type VoiceDecision, type VoiceScreenState } from '@dexterm/voice';
import { LivePlanExecutor, defaultPlansJournalPath } from '@dexterm/data/plans';
import type { PlanInput } from '@dexterm/data/plans';
import { isWalletAddress, shortAddr, buildMirror, leaderSoldSince, autoSizeCap, type MirrorMarket, type MirrorResult, type CopyAlert } from '@dexterm/data/copy';
import { FOLLOW_INPUT_MAX } from './screens/follows.ts';
import type { VoiceHud } from './voice-hud.ts';
import { isPriceMode, configPriceMode, togglePriceMode, priceModeOf, planLevels, type PriceMode } from './display.ts';
import { VERSION } from './version.ts';
import { initCustom, planWorkspace, planPopupOpens, findWorkspace, nextWorkspaceName, workspaceSlots, saveWorkspace, themeFor, themeByName, cycleTheme, themeNames, CHORD_TTL_MS, MAX_WORKSPACE_NAME, type WorkspacePlan } from './custom.ts';
import { DEFAULT_WORKSPACE, MORNING_HUD, applyAndJournal, policyCheck } from '@dexterm/custom';

/** A compact, firewalled view of one visible pool row for the analyst context (task-1313). */
interface VisibleRow { mint: string; symbol: string; priceUsd: number | null; chg1h: number | null; chg24h: number | null; liq: number | null; vol24: number | null }

/**
 * Context the `screen_state` MCP tool returns AND the per-turn context block is rendered from
 * (task-1313): what the user is looking at right now — selected/hovered coin, screen, the visible
 * pool rows, the watchlist, any open PAPER ticket/position — plus the action allow-list (`actions`)
 * that bounds what the analyst's UI actions may reference. Token-derived text stays raw here; the
 * context-block renderer wraps it as untrusted before a model sees it.
 */
/** Screens the analyst's `switch_screen` action may target (task-1413); the user-facing set. */
export const SWITCHABLE_SCREENS = ['screener', 'token', 'newpairs', 'watchlist', 'analyst', 'positions', 'trending', 'kol'] as const;

/**
 * A read-only snapshot of local UI state for the `app_state` MCP tool (task-1413): what the user sees.
 * NEVER includes a secret — alert channels report a boolean "configured", computed from creds presence,
 * never the token/webhook/key itself. `null` when there is no live config (one-shot fixture frames).
 */
export function appStateBlock(state: AppState): Record<string, unknown> | null {
  const ui = state.custom;
  if (!ui) return null;
  const cfg = ui.config;
  const home = ui.home;
  const ch = (cfg.alerts?.channels ?? {}) as Record<string, { enabled?: boolean } | undefined>;
  const alerts = {
    // toast is on unless explicitly disabled; the rest are off unless enabled. telegram/discord also need creds.
    toast: ch.toast?.enabled !== false,
    desktop: ch.desktop?.enabled === true,
    telegram: ch.telegram?.enabled === true && readTelegramCreds(home) !== null,
    discord: ch.discord?.enabled === true && readDiscordCreds(home) !== null,
  };
  return {
    theme: state.theme.name,
    priceMode: priceModeOf(state),
    intensity: state.vfx.intensity,
    calm: isCalm(state.vfx),
    voice: { name: cfg.voice?.name ?? null, rate: cfg.voice?.rate ?? null },
    scan: { on: state.scan?.engine.on ?? false },
    alerts, // booleans only — never a token, webhook or key
  };
}

/**
 * task-1443: the reduced screen snapshot a terminal following an EXTERNAL agent (`--spectate-mcp`) publishes for
 * that agent's `trenchscope mcp` server: what is on screen plus a VIEW-ONLY nav allow-list. Never the watchlist,
 * tickets, positions or app settings, and only the four follow nav action types (no watchlist add, no ticket).
 */
export function followSnapshot(state: AppState): Record<string, unknown> {
  const ss = buildScreenState(state);
  const a = ss.actions as Record<string, unknown>;
  return {
    screen: ss.screen, selected: ss.selected, selectedDetail: ss.selectedDetail, filter: ss.filter, sort: ss.sort,
    visible: ss.visible, visibleMints: ss.visibleMints,
    actions: { enabled: a.enabled, mints: a.mints, feeds: a.feeds, sortKeys: a.sortKeys, screens: a.screens, workspaces: [], themes: [], types: [...FOLLOW_NAV_ACTIONS] },
    now: ss.now,
  };
}

export function buildScreenState(state: AppState): Record<string, unknown> {
  const live = state.live;
  const sc = state.screener;
  // The screener and the Analyst-tab coin list both show the filtered/sorted screener view, so the
  // selection + visible rows must come from that same view (task-1313); other screens use the raw pool.
  const rows = state.screen === 'screener' || state.screen === 'analyst' ? screenerView(sc) : sc.rows;
  const toRow = (r: unknown): VisibleRow | null => {
    const x = r as { mint?: string; symbol?: string; price?: number | null; liq?: number | null; vol24?: number | null; chg?: { h1?: number | null; h24?: number | null } } | undefined;
    if (!x?.mint) return null;
    return { mint: x.mint, symbol: x.symbol ?? '', priceUsd: x.price ?? null, chg1h: x.chg?.h1 ?? null, chg24h: x.chg?.h24 ?? null, liq: x.liq ?? null, vol24: x.vol24 ?? null };
  };
  const visible = rows.slice(0, 12).map(toRow).filter((r): r is VisibleRow => r !== null);
  let selected: { mint: string; symbol: string } | null = null;
  if (state.screen === 'token' && live?.token?.view) selected = { mint: live.token.view.mint, symbol: live.token.view.symbol };
  else { const r = toRow(rows[state.selected || 0]); if (r) selected = { mint: r.mint, symbol: r.symbol }; }

  // Watchlist (live only): the saved entries' mint + symbol.
  const watchlist: Array<{ mint: string; symbol: string }> = [];
  if (live) for (const w of live.watch.list()) watchlist.push({ mint: w.entry.mint, symbol: w.entry.symbol });

  // Open PAPER ticket / position summary, if any.
  let ticket: { side: string; symbol: string; phase: string } | null = null;
  if (live?.ticket) { const t = live.ticket.ticket; ticket = { side: t.side, symbol: t.symbol, phase: t.phase }; }
  let positions: string | null = null;
  if (live?.positions) {
    const pv = live.positions.view();
    if (pv.rows.length) positions = pv.rows.map((p) => `${p.symbol}:${p.valueSol !== null ? p.valueSol.toFixed(2) + 'SOL' : '—'}${p.unrealizedPct !== null ? '(' + (p.unrealizedPct * 100).toFixed(0) + '%)' : ''}`).join(', ');
  }

  // Action allow-list: the only mints/feeds/sorts the analyst's UI actions may reference (task-1313).
  const mints = new Set<string>();
  for (const r of visible) mints.add(r.mint);
  for (const w of watchlist) mints.add(w.mint);
  if (selected) mints.add(selected.mint);
  if (live) for (const r of live.newpairs.list().slice(0, 12)) if (r.mint) mints.add(r.mint);
  const feeds = sc.presets.map((p) => p.id);

  return {
    screen: state.screen,
    selectedDetail: selectedDetail(state, rows as unknown[], selected),
    filter: sc.query ?? '',
    sort: `${sc.sort.key}:${sc.sort.dir}`,
    selected,
    visible,
    visibleMints: visible.map((r) => r.mint), // kept for back-compat with older skill text
    watchlist,
    ticket,
    positions,
    actions: {
      enabled: !!live, mints: [...mints], feeds, sortKeys: SORT_KEYS.map((k) => k.key),
      // task-1413: targets the new tiered actions may reference.
      screens: [...SWITCHABLE_SCREENS],
      workspaces: Object.keys(state.custom?.config.layout?.workspaces ?? {}),
      themes: themeNames(state.custom),
    },
    app: appStateBlock(state),
    now: Date.now(),
  };
}

/** One candle as the analyst sees it: [openTimeMs, o, h, l, c, volume]. */
type SnapCandle = [number, number, number, number, number, number];

/**
 * The live numbers of the SELECTED coin, built fresh on every analyst turn (2026-10-12): price, the
 * 5m/1h/6h/24h changes, mcap/liq/volume, the TOTAL holder count (Jupiter) and top-10 share, plus price
 * history (the token screen's candles when it is open on that coin, else the row's sparkline). Before
 * this the model got only the mint and had to fetch (or guess) price and history itself. Numbers only;
 * the symbol is wrapped as untrusted by the context-block renderer.
 */
function selectedDetail(state: AppState, rows: unknown[], selected: { mint: string; symbol: string } | null): Record<string, unknown> | null {
  if (!selected) return null;
  const tv = state.live?.token?.view;
  if (tv && tv.mint === selected.mint) {
    return {
      source: 'token-screen', mint: tv.mint, symbol: tv.symbol, priceUsd: tv.price, chg: tv.chg, mcap: tv.mcap, fdv: tv.fdv, liq: tv.liq, vol24: tv.vol24,
      holders: tv.holders, holdersChgPct24h: tv.holdersChgPct, top10Pct: tv.top10, ageMin: tv.ageMin, launchpad: tv.launchpad,
      interval: tv.interval, candles: tv.candles.slice(-48).map((k): SnapCandle => [k.t, k.o, k.h, k.l, k.c, k.v]),
      spark: null, asOf: tv.updatedAt ?? Date.now(),
    };
  }
  const r = rows.find((x) => (x as { mint?: string })?.mint === selected.mint) as {
    price?: number | null; chg?: Record<string, number | null>; mcap?: number | null; fdv?: number | null; liq?: number | null; vol24?: number | null;
    holders?: number | null; holdersChgPct?: number | null; top10?: number | null; ageMin?: number | null; launchpad?: string; spark?: number[]; fetchedAt?: number | null;
  } | undefined;
  if (!r) return null;
  return {
    source: 'screener-row', mint: selected.mint, symbol: selected.symbol, priceUsd: r.price ?? null, chg: r.chg ?? null, mcap: r.mcap ?? null, fdv: r.fdv ?? null,
    liq: r.liq ?? null, vol24: r.vol24 ?? null, holders: r.holders ?? null, holdersChgPct24h: r.holdersChgPct ?? null, top10Pct: r.top10 ?? null,
    ageMin: r.ageMin ?? null, launchpad: r.launchpad ?? null, interval: null, candles: null, spark: Array.isArray(r.spark) ? r.spark.slice(-30) : null,
    asOf: r.fetchedAt ?? Date.now(),
  };
}

export type DemoEvent = PulseKind;

export interface CliArgs {
  screen: ScreenKey | null;
  fixtures: boolean;
  replay: string | null;
  record: string | null;
  filter: string | null;
  sort: { key: string; dir: SortDir } | null;
  preset: PresetId | null;
  maxRequests: number;
  /** Helius credit cap for this run (0 = the data layer default). */
  maxCredits: number;
  db: string | null;
  /** Token to open on the token screen (live/replay). */
  mint: string | null;
  interval: CandleInterval;
  /** Seconds to listen to the PumpPortal stream in a one-shot `--screen newpairs` run. */
  listen: number;
  verbose: boolean;
  width: number | null;
  height: number | null;
  html: string | null;
  /** task-1401: where `--mint` came from (a dexscreener link is resolved pool → coin before the token opens). */
  mintVia?: CoinTarget['via'];
  /** task-1401: one-shot `--export [DIR]`: write the PNG + text report ('' = the default ~/.dexterm/exports). */
  export: string | null;
  theme: string;
  selected: number;
  seed: number;
  noAi: boolean;
  /** 0.1.5: `--analyst-engine auto|claude|codex` (null = DEXTERM_ANALYST_ENGINE / config / auto). */
  analystEngine: EngineChoice | null;
  title: string | null;
  plain: boolean;
  ansi: boolean;
  color: ColorDepth | null;
  tz: string | null;
  // ---- effects (task-1297)
  calm: boolean;
  /** trenchscope: --simple / --full pick the screener view; null = simple in the interactive app, full for one-shots. */
  simple: boolean | null;
  intensity: Intensity | null;
  fps: number | null;
  frame: number;
  /** Boot progress for `--screen boot`. */
  t: number;
  event: DemoEvent | null;
  ai: string | null;
  mood: Mood | null;
  activity: number | null;
  noBoot: boolean;
  fit: { width: number; height: number } | null;
  fontPx: number | null;
  asciiRain: boolean;
  /** task-1326: no coin images this run (also DEXTERM_IMAGES=0 / images.json). */
  noImages: boolean;
  /** task-1324: start AI scan mode on launch, and the `--scan-*` threshold/cap overrides. */
  scan: boolean;
  scanConfig: Partial<ScanConfig>;
  /** task-1329: `--no-recorder` switches the history recorder off for this run (DEXTERM_RECORDER=0 too). */
  noRecorder: boolean;
  /** task-1340: trade-moment sound cues on (muted by default; DEXTERM_SOUND=1 too). */
  sound: boolean;
  /** task-1328: argv forwarded ONCE to the signer process (caps flags); `live` false = paper only (--no-live / replay). */
  trade: string[];
  live: boolean;
  /** task-1358: the workspace to activate at launch (a built-in or ~/.dexterm/workspaces/<name>.json). */
  workspace: string | null;
  /** task-1366: `--price-mode price|mcap` for this run (overrides config.display.priceMode; not saved). */
  priceMode: PriceMode | null;
  /** task-1421: follow an agent driving over MCP — the terminal moves with it, and a read-only stream opens. */
  spectateMcp: boolean;
  /** task-1443: let the MCP agent PAPER-trade inside this armed mandate (needs --spectate-mcp). Paper only. */
  agentPaper: string | null;
  help: boolean;
  version: boolean;
  unknown: string[];
}

/** Refresh cadence for the live table (SPEC §3.4: table 10 s). */
export const LIVE_REFRESH_MS = 10_000;
/**
 * task-1355: the USD size of an order plan drafted BY VOICE. Voice never sets a size (SPEC §5.7, task-1339:
 * no spoken size reaches a ticket), so a spoken plan is always proposed at this fixed paper size and the
 * read-back says so; a different size is a new proposal from `trenchscope plan propose --size`. Equal to the
 * signer's default per-trade cap, so a voice draft can never exceed the smallest cap anyone armed.
 */
export const VOICE_PLAN_SIZE_USD = 5;
/** Warm-quote refresh cadence for the PAPER trade ticket (SPEC §6.1: a rolling quote). */
export const TICKET_QUOTE_MS = 5_000;
/** Frame cap per intensity (VISUAL-V2 §4). */
export const FPS_BY_INTENSITY: Record<Intensity, number> = { fever: 30, normal: 15, off: 30 };
export const MAX_FPS = 60;
/**
 * Idle ambient-rain redraw rate (task-1303). When no event animation is live and the market is quiet,
 * the loop renders the rain at this rate instead of the full frame cap — the look stays alive while
 * idle CPU drops. Events, keypresses and transitions snap back to the full cap.
 */
export const IDLE_FPS = 8;
/**
 * Idle throttle (task-1319 AC3 follow-up). The full look (frame cap, 30 fps in fever) is kept while the
 * user is active: every keypress opens a KEY_WAKE_S window of full-rate rendering. Once no key has been
 * pressed for KEY_WAKE_S and nothing event-driven is live (no glitch/shake/stutter, no screen blink, no
 * streaming answer), the loop redraws the ambient rain at IDLE_FPS instead. A data landing (feed refresh,
 * screener fill batch, live binding change) still paints the instant it lands — those draws bypass the
 * stride — but does NOT reopen the full-rate window: the screener's paced background fill lands a batch
 * every ~2.5 s, and even a 1 s wake per batch kept the loop at full rate ~40% of the time (measured 16.7%
 * idle CPU). The next key snaps straight back to the full rate — the throttle is a stride, not a sleep.
 */
export const KEY_WAKE_S = 5;
/** Min ms between fast-lane (on-chain push) redraws in normal/fever mode, bounding idle CPU (task-1312). */
export const FASTPRICE_MIN_MS = 120;

export interface FrameGate {
  calm: boolean;
  /** A screen blink is mid-flight. */
  transition: boolean;
  /** This frame is a 2 Hz data tick. */
  onTick: boolean;
  /** An analyst answer is thinking/streaming. */
  aiLive: boolean;
  /** Inside the post-keypress wake window (frame < wakeUntil). */
  awake: boolean;
  /** An event animation (glitch / shake / stutter) is live. */
  fxBusy: boolean;
  frame: number;
  /** Frame stride at the idle rate (full fps / IDLE_FPS). */
  idleEvery: number;
}

/**
 * Whether the loop paints this frame (pure; the loop and the regression test share it).
 *   - calm: nothing animates between data ticks → paint only on ticks, blinks, streaming AI or a wake.
 *   - normal/fever, awake or event-busy: paint every frame (the full look).
 *   - normal/fever, idle: paint every idleEvery-th frame (IDLE_FPS). The 2 Hz tick does not force an
 *     extra paint — the idle stride is already ≥ 2 Hz and the renderer reads the newest data at paint
 *     time, so nothing lands late by more than one idle frame (≤ 125 ms).
 */
export function shouldDrawFrame(g: FrameGate): boolean {
  if (g.transition || g.aiLive || g.awake) return true;
  if (g.calm) return g.onTick;
  if (g.fxBusy) return true;
  return g.frame % g.idleEvery === 0;
}

export const HELP = `trenchscope ${VERSION} (live: screener, token, new pairs, watchlist · analyst = your local claude CLI · mono look)

  trenchscope                                     interactive, live data (needs a TTY)
  trenchscope doctor                              check this machine is ready (Node, colour, claude, network, Helius key)
  trenchscope voice [status|download <model>]     voice engines on this machine; download whisper/piper models (asks first, checksum-verified)
  trenchscope update [--off|--on]                 check npm + GitHub for a newer version and print the upgrade command;
                                              --off/--on toggles the once-a-day startup notice (no telemetry)
  trenchscope recorder stats|label|prune|export   the history recorder's tables (no network; 'trenchscope recorder help')
  trenchscope kb list|show|new|edit|check|reset|path     your knowledge-base entries (~/.dexterm/kb/entries) over the bundled 17
  trenchscope skill list|show|new|edit|check|reset|path  your analyst skills (~/.dexterm/skills) over the bundled ones (read tools only)
  trenchscope narrative [--window 1h|24h] [--summary]  the narrative board over recorded history (no network, no model)
  trenchscope backtest [--subject heuristic|pack_verdicts] [--horizon SEC]  honest rug-model metrics over recorded outcomes (no network, no model)
  trenchscope wallet link|unlink|status|panic|resume  link a Phantom wallet via a local bridge (pubkey only); panic disables live trading, resume needs a TTY keypress
  trenchscope plan propose|list|arm|cancel|journal     conditional order plans (entry/ladder/take-profit/moon bag/stop); arming needs a physical keypress
  trenchscope mandate draft|list|arm|revoke            standing capped mandates (fast wallet); arming needs a physical keypress — voice/agents can never arm
  trenchscope follow add|remove|list|stats|trades|mirror|purge  copy trading tier 1: follow a wallet (your list, local labels), its decoded swaps + FIFO PnL + win rate/early-entry; 'mirror' previews a one-key MIRROR TICKET from the wallet's latest buy (inert; arm in the app)
  trenchscope mcp [install <client>|doctor]            read-only MCP server for your own agent; 'install' writes the config for claude-code|claude-desktop|cursor|codex|generic (asks first, idempotent, backs up); 'doctor' verifies the connection
  trenchscope alerts status|enable|disable|set-telegram|set-discord|test  where rule alerts are delivered (desktop / your Telegram / Discord; creds stay local, never logged)
  trenchscope watch [--interval S] [--once] [--replay FILE]  run your rules headless and push alerts when the terminal is closed (no signer, proposals only)
  trenchscope record run|install|uninstall|status  keep the history recorder fed with no TUI open, as a user-level launchd agent (no network beyond the data layer; 'trenchscope record help')
  trenchscope bot run|stats|config                 headless PAPER-trading bot over the live feed: simulated fills from live quotes, a journal, and a scoreboard vs a no-safety baseline (never signs or sends; 'trenchscope bot help')
  trenchscope larp-detected --out DIR [--db PATH]  build timestamped high-risk follow-up drafts/cards from recorder history; never posts
  trenchscope --fixtures                          interactive demo on seeded fixtures
  trenchscope --screen <name>                     one-shot frame to stdout (live)
  trenchscope --screen <name> --fixtures          one-shot frame from fixtures
  trenchscope --screen <name> --replay FILE       one-shot frame from a recording (no network)
  trenchscope --screen token --mint MINT          one-shot live token detail
  trenchscope --screen newpairs --listen 30       listen to PumpPortal for 30 s, then render
  screens: ${SCREEN_NAMES.join(' | ')}

  --filter QUERY            screener filter, e.g. "vol24 > 250K liq > 50K age < 30d launchpad:pump"
  --sort KEY[:asc|desc]     ${SORT_KEYS.map((k) => k.key).join(' | ')}
  --preset NAME             ${PRESETS.map((p) => p.id).join(' | ')}
  --record FILE             save every live response (and the PumpPortal session) to FILE (replay it with --replay)
  --spectate-mcp            follow an MCP agent's allowed navigation in this terminal; Ctrl+P pauses, Ctrl+K stops,
                            and any normal user keypress takes control (refused actions never move the UI)
  --agent-paper MANDATE_ID  (experimental, with --spectate-mcp) let that MCP agent PAPER-trade inside a mandate you
                            armed: simulated fills only, never signs or sends, never raises a cap; Ctrl+P / Ctrl+K /
                            any key also pause, stop or take over its paper trading
  --max-requests N          hard cap on live requests for this run (default: none)
  --max-credits N           hard cap on Helius credits for this run (default: 5000)
  --mint MINT|LINK          token to open on the token screen (a CA or a dexscreener / pump.fun / solscan / birdeye link)
  --interval IV             candle interval for the token screen: ${INTERVALS.join(' | ')} (default 1h)
  --listen SECONDS          one-shot new pairs: how long to listen to PumpPortal (default 20)
  --db PATH                 SQLite path for cache, watchlist, credit meter and history (default: ~/.local/share/dexterm/dexterm.db; ':memory:' for none)
  --no-recorder             do not record history this run (the recorder keeps token snapshots, feed membership and
                            outcome labels in the --db file for the rug model / backtests; DEXTERM_RECORDER=0 too)
  --verbose                 log every live request to stderr
  --width N --height N      frame size (default: terminal size, else 160×45)
  --theme NAME              ${THEME_NAMES.join(' | ')} or a user theme (default ${DEFAULT_THEME}; t cycles built-ins then user themes)
  --selected N              highlighted row / token index
  --seed N                  fixture PRNG seed (default 7)
  --no-ai                   hide the analyst panel on the token screen
  --analyst-engine E        auto | claude | codex: which of YOUR installed CLIs runs the analyst (default auto = claude
                            if installed, else codex; DEXTERM_ANALYST_ENGINE or config analyst.engine too; /engine in chat)

  --intensity LEVEL         off | normal | fever (default off; fever: rain, trails, glitch, blink, scanlines at 30 fps;
                            normal: 15 fps, sparser rain, no idle aberration; off = calm: neon theme, no motion)
  --simple / --full         the screener's simple split view or the full table (default: simple in the app, full for --screen; f toggles)
  --calm                    same as --intensity off (DEXTERM_CALM=1 too; NO_COLOR implies it)
  --fps N                   frame cap 1..${MAX_FPS} (default 30 fever / 15 normal); data still refreshes at 2 Hz
  --no-boot                 skip the boot sequence (first launch is the full glitch boot, later ones 1 s)
  --frame N                 effect frame index for one-shot renders (same frame = byte-identical output)
  --event KIND              one-shot demo event: newpair | pump | dump | rug (fixtures)
  --ai PHASE                analyst state for one-shot renders: thinking | streaming:N (chars revealed)
  --mood M --activity A     force the rain: mood pump | dump | neutral, activity 0..1
  --t 0..1                  boot progress for --screen boot
  --ascii-rain              hex-only rain glyphs (no half-width katakana; automatic when LANG is not UTF-8)
  --no-images               no coin images (also DEXTERM_IMAGES=0, or {"enabled": false} in ~/.dexterm/images.json);
                            real pixels in kitty / Ghostty / WezTerm / iTerm2 / sixel terminals, block art elsewhere
  --sound                   trade-moment sound cues (buy chirp, profit chime, loss thud, error buzz) after a CONFIRMED
                            result only; muted by default (also DEXTERM_SOUND=1); ~/.dexterm/sounds holds the WAVs
  --workspace NAME          start in a workspace: default | morning-hud | a file in ~/.dexterm/workspaces/ (task-1358);
                            in the app ctrl+w then w (list) · n/N (next/prev) · s (save as) · m (morning HUD) · o (popups) · d · 1-9
  --price-mode MODE         price | mcap: show USD price or MARKET CAP (price × supply) on the tables, token screen and both
                            charts for this run (default: config.json display.priceMode; \$ in the app toggles and saves it)
  trenchscope workspace list|show|remove|init         the workspace files (no network)
  trenchscope theme list|show|init|check              user themes in ~/.dexterm/themes (extends a built-in; contrast + hue guarded)
  trenchscope keymap [screen]                         the effective keys (defaults + config.keymap overrides, marked ·)
  trenchscope display [price|mcap]                    show or set the price display mode (market cap = price × supply)
  trenchscope rules list|add|remove|enable|disable|check|dry-run|fields
                            "when <cond> [for n ticks] then alert|ticket|ask|popup|tag|sound|watch" rules in config.json (task-1358);
                            parsed never eval'd; mandatory cooldown + max/h; rules only alert or PROPOSE (ctrl+r in the app)
  trenchscope pack list|verify|add|remove|export|lock|sign|trust|signers|keymap|widget
                            shareable packs (task-1358): workspaces + themes + rules + a keymap + popup widgets as plain files
                            with a sha256 pack.lock and an optional ssh-keygen signature; trust reviewed > signed > unsigned.
                            a pack never runs code: widgets install DISABLED (pack widget … --enable after reading the page),
                            unsigned rules load disabled, the keymap merges only with "pack keymap <name> --merge"

  AI SCAN MODE (off by default; observe + analyze only — it can never open a ticket, sign or trade):
${SCAN_HELP}

  LIVE TRADING (task-1328; devnet by default; a separate signer process holds the caps and signs via Phantom):
  --mainnet                 allow MAINNET swaps (real funds) within the caps; without it the signer refuses mainnet
  --max-usd N               per-trade USD cap (default $5; raising it needs --mainnet; hard ceiling $500)
  --daily-usd N             daily USD cap (default $20; raising it needs --mainnet; hard ceiling $2000)
  --max-sol-out N           SOL that may leave the wallet in one tx (default 1, ceiling 5)
  --max-slippage-bps N      slippage ceiling (default 500, ceiling 1000)
  --trade-rpc URL           the signer's RPC (default devnet; must be devnet unless --mainnet)
  --no-live                 paper only: never start the signer process
${WALLET_HELP}

  LOGIN WITH X (task-1357; your own X app, your limits, your bill; read scopes only, no scraping, trenchscope never posts):
${X_HELP}

  --plain                   monochrome text (snapshot surface)
  --ansi                    ANSI output even when stdout is not a TTY (24-bit unless --color / NO_COLOR)
  --html FILE               write a standalone HTML page (for screenshots); --fit WxH --font PX for video frames
  --export [DIR]            write the frame as a PNG + a text report with data ages (default ~/.dexterm/exports; local only)
  --color DEPTH             truecolor | 256 | none (default: detected; NO_COLOR honoured)
  --tz ZONE                 header clock zone (default America/New_York, the prototype's; 'local' = machine zone)
  --title TEXT              HTML page title
  -h, --help                this text
  --version                 print the version

  Keys: 1-4 screens · tab cycle · j/k move · ⏎ open · esc back · a analyst · v voice · t theme · c calm · p pause · q quit
        voice (JARVIS, macOS): v push-to-talk (press to talk, press to send) · m mute · , change voice · < / > slower/faster · esc stop speaking
                               voice asks the analyst or triggers safe actions (open/filter/watch/open a PAPER ticket);
                               a spoken "buy"/"sell" only OPENS a ticket — you still confirm it with a keypress
                               spoken replies talk in market cap and round numbers (never a raw per-token price); < / > set the rate (saved to config)
        screener: / filter · s sort · [ ] presets · r refresh · g/G top/bottom
        social (task-1330): T trending in the space · K KOL lists · token screen: s social panel · f filter · x hidden spam
        trenchscope kol list | create <name> | add <list> @handle | remove <list> @handle | mute @handle | unmute @handle | enable <list> | disable <list> | import <dir> | import-x
        Login with X (task-1357): trenchscope x login · then the SOCIAL panel + TRENDING read X with your own limits · KOL screen: X imports your X lists · o = only this handle
        token: B/S buy/sell ticket (PAPER; L on the ticket flips LIVE when a wallet is linked) · P positions · w watch
        token: M bubble map (holder graph: clusters by funder / same-slot buys / transfers; colour = rule) · bubble map: M popup · m treemap · z zoom · D deep scan
        demo events on --fixtures: n new pair (glitch) · u pump (gold rain) · d dump (red rain) · x rug flag
        AI scan: Z on/off · R resume scanning after a lock · esc (on the locked coin) cancel the analysis
        any key skips the boot sequence or a blink transition

  State: ~/.dexterm/state.json remembers launches (DEXTERM_HOME overrides the directory).
  DEXTERM_OFFLINE=1 refuses live data (tests and CI). Trading is PAPER by default — a simulated wallet
  priced from live Jupiter quotes. LIVE (L on a ticket, /wallet link first): a separate signer process
  quotes, builds, decodes, simulates and enforces the caps; Phantom signs in your browser; trenchscope never
  holds a key. The analyst, voice and scan mode can never open, confirm or sign a live trade.
  RPC: DEXTERM_RPC_URL, else ~/.dexterm/helius.key (Helius, metered with a credit meter), else the public RPC.
  Updates: at most once a day a live run asks npm + GitHub for the newest version (two anonymous GETs, no telemetry)
  and shows one toast if there is one; DEXTERM_NO_UPDATE_CHECK=1 or 'trenchscope update --off' turns that off.`;

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    screen: null, fixtures: false, replay: null, record: null, filter: null, sort: null, preset: null, maxRequests: 0, maxCredits: 0, db: null,
    mint: null, interval: '1h', listen: 20, verbose: false,
    width: null, height: null, html: null, export: null, theme: DEFAULT_THEME, selected: 0, seed: 7,
    noAi: false, analystEngine: null, title: null, plain: false, ansi: false, color: null, tz: null,
    calm: false, simple: null, intensity: null, fps: null, frame: 0, t: 1, event: null, ai: null, mood: null, activity: null, noBoot: false, fit: null, fontPx: null, asciiRain: false, noImages: false,
    scan: false, scanConfig: {},
    noRecorder: false,
    sound: false,
    trade: [], live: true,
    workspace: null, priceMode: null,
    spectateMcp: false, agentPaper: null,
    help: false, version: false, unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    const num = (): number => { i++; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${k} expects a number, got ${JSON.stringify(v)}`); return n; };
    const str = (): string => { i++; if (v === undefined) throw new Error(`${k} expects a value`); return v; };
    if (k === '--screen') { const s = str(); if (!isScreenKey(s)) throw new Error(`unknown screen ${s} (expected ${SCREEN_NAMES.join('|')})`); a.screen = s; }
    else if (k === '--fixtures') a.fixtures = true;
    else if (k === '--replay') a.replay = str();
    else if (k === '--record') a.record = str();
    else if (k === '--filter') {
      const q = str();
      const r = parseFilter(q);
      if (!r.ok) throw new Error(`bad --filter at column ${r.at}: ${r.error}`);
      a.filter = q;
    }
    else if (k === '--sort') a.sort = parseSortArg(str());
    else if (k === '--preset') { const p = presetSpec(str()); if (!p) throw new Error(`unknown preset ${v} (expected ${PRESETS.map((x) => x.id).join('|')})`); a.preset = p.id; }
    else if (k === '--max-requests') a.maxRequests = num();
    else if (k === '--max-credits') a.maxCredits = num();
    else if (k === '--mint') {
      // task-1401: a bare mint, or a dexscreener / pump.fun / solscan / birdeye link (a dexscreener pool is resolved to its coin at open)
      const m = str();
      const t = parseCoinTarget(m);
      if (!t || (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m.trim()) && t.via === 'address')) throw new Error(`--mint expects a base58 Solana address or a coin link, got ${JSON.stringify(m.slice(0, 20))}`);
      a.mint = t.address; a.mintVia = t.via;
    }
    else if (k === '--interval') { const iv = str(); if (!(INTERVALS as string[]).includes(iv)) throw new Error(`unknown interval ${iv} (expected ${INTERVALS.join('|')})`); a.interval = iv as CandleInterval; }
    else if (k === '--listen') a.listen = Math.max(0, Math.min(120, num()));
    else if (k === '--db') a.db = str();
    else if (k === '--verbose') a.verbose = true;
    else if (k === '--width') a.width = num();
    else if (k === '--height') a.height = num();
    else if (k === '--html') a.html = str();
    else if (k === '--export') a.export = argv[i + 1] && !argv[i + 1].startsWith('--') ? str() : '';
    else if (k === '--theme') a.theme = str();
    else if (k === '--selected') a.selected = num();
    else if (k === '--seed') a.seed = num();
    else if (k === '--title') a.title = str();
    else if (k === '--tz') a.tz = str();
    else if (k === '--color') { const s = str(); const d = parseColorDepth(s); if (!d) throw new Error(`unknown color depth ${s} (expected truecolor|256|none)`); a.color = d; }
    else if (k === '--no-ai') a.noAi = true;
    else if (k === '--analyst-engine') { const s = str(); const e = parseEngineChoice(s); if (!e) throw new Error(`unknown analyst engine ${s} (expected auto|claude|codex)`); a.analystEngine = e; }
    else if (k === '--calm') a.calm = true;
    else if (k === '--simple') a.simple = true;
    else if (k === '--full') a.simple = false;
    else if (k === '--intensity') { const s = str(); if (s !== 'off' && s !== 'normal' && s !== 'fever') throw new Error(`unknown intensity ${s} (expected off|normal|fever)`); a.intensity = s; }
    else if (k === '--fps') { const n = num(); if (n < 1 || n > MAX_FPS) throw new Error(`--fps expects 1..${MAX_FPS}`); a.fps = Math.round(n); }
    else if (k === '--frame') { const n = num(); if (n < 0) throw new Error('--frame expects a non-negative integer'); a.frame = Math.floor(n); }
    else if (k === '--t') { const n = num(); if (n < 0 || n > 1) throw new Error('--t expects 0..1'); a.t = n; }
    else if (k === '--event') { const s = str(); if (s !== 'newpair' && s !== 'pump' && s !== 'dump' && s !== 'rug') throw new Error(`unknown event ${s} (expected newpair|pump|dump|rug)`); a.event = s; }
    else if (k === '--ai') { const s = str(); if (!/^(thinking|streaming(:\d+)?)$/.test(s)) throw new Error(`bad --ai ${s} (expected thinking | streaming:N)`); a.ai = s; }
    else if (k === '--mood') { const s = str(); if (s !== 'pump' && s !== 'dump' && s !== 'neutral') throw new Error(`unknown mood ${s} (expected pump|dump|neutral)`); a.mood = s; }
    else if (k === '--activity') { const n = num(); if (n < 0 || n > 1) throw new Error('--activity expects 0..1'); a.activity = n; }
    else if (k === '--no-boot') a.noBoot = true;
    else if (k === '--fit') { const s = str(); const m = /^(\d+)x(\d+)$/.exec(s); if (!m) throw new Error(`--fit expects WxH, got ${s}`); a.fit = { width: Number(m[1]), height: Number(m[2]) }; }
    else if (k === '--font') { const n = num(); if (n < 4) throw new Error('--font expects a pixel size'); a.fontPx = n; }
    else if (k === '--ascii-rain') a.asciiRain = true;
    else if (k === '--no-images') a.noImages = true;
    else if (k === '--scan') a.scan = true;
    else if (k === '--no-recorder') a.noRecorder = true;
    else if (k === '--sound') a.sound = true;
    // task-1328 LIVE trading flags: forwarded verbatim to the signer process, which validates them
    // (over-ceiling values are refused there; without --mainnet the USD caps only go down).
    else if (k === '--mainnet') a.trade.push(k);
    else if (k === '--max-usd' || k === '--daily-usd' || k === '--max-sol-out' || k === '--max-slippage-bps') { a.trade.push(k, String(num())); }
    else if (k === '--trade-rpc') { a.trade.push('--rpc', str()); }
    else if (k === '--no-live') a.live = false;
    else if (k === '--price-mode') { const s = str(); if (!isPriceMode(s)) throw new Error(`--price-mode expects price|mcap, got ${JSON.stringify(s.slice(0, 20))}`); a.priceMode = s; }
    // task-1421: follow an agent driving over MCP (the running terminal moves with it; a read-only stream opens).
    else if (k === '--spectate-mcp') a.spectateMcp = true;
    // task-1443: agent PAPER trading inside a mandate the user armed (validated against the plans journal at start).
    else if (k === '--agent-paper') { const s = str(); if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error(`--agent-paper expects a mandate id (see \`trenchscope mandate list\`), got ${JSON.stringify(s.slice(0, 20))}`); a.agentPaper = s; }
    else if (k === '--workspace') { const s = str(); if (!/^[a-z][a-z0-9-]{0,39}(\/[a-z][a-z0-9-]{0,39})?$/.test(s)) throw new Error(`--workspace expects a name like morning-hud, got ${JSON.stringify(s.slice(0, 40))}`); a.workspace = s; }
    else if (Object.hasOwn(SCAN_FLAGS, k)) {
      const key = SCAN_FLAGS[k];
      const n = num();
      const bad = checkScanFlag(key, n);
      if (bad) throw new Error(`${k} ${bad}`);
      (a.scanConfig as Record<string, number>)[key] = n;
    }
    else if (k === '--plain') a.plain = true;
    else if (k === '--ansi') a.ansi = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--version') a.version = true;
    else a.unknown.push(k);
  }
  if (a.fixtures && a.replay) throw new Error('--fixtures and --replay are exclusive');
  if (a.record && (a.fixtures || a.replay)) throw new Error('--record needs live data (drop --fixtures / --replay)');
  if (a.mint && a.fixtures) throw new Error('--mint needs live data or a recording (drop --fixtures)');
  if (a.event && !a.fixtures) throw new Error('--event is a fixture demo event (add --fixtures)');
  if (a.scan && a.fixtures) throw new Error('--scan needs live data or a recording (drop --fixtures)');
  if (a.scan && a.screen) throw new Error('--scan is interactive (drop --screen)');
  if (a.agentPaper && !a.spectateMcp) throw new Error('--agent-paper needs --spectate-mcp (every agent paper trade must be visible in this terminal)');
  if (a.agentPaper && a.db === ':memory:') throw new Error('--agent-paper needs an on-disk --db (the agent books into the same paper wallet)');
  return a;
}

/**
 * Effects intensity for the run: --calm / DEXTERM_CALM=1 force off; --intensity or DEXTERM_INTENSITY pick a tier;
 * NO_COLOR defaults to off as the reduced-motion default (VISUAL-V2 §5; `--plain` pipes keep the effects so the
 * snapshot surface can prove them); otherwise off (calm is the default look).
 */
export function intensityFor(args: Pick<CliArgs, 'calm' | 'intensity'>, env: NodeJS.ProcessEnv, _depth: ColorDepth): Intensity {
  if (args.calm || env.DEXTERM_CALM === '1') return 'off';
  if (args.intensity) return args.intensity;
  const e = env.DEXTERM_INTENSITY;
  if (e === 'off' || e === 'normal' || e === 'fever') return e;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'off';
  return 'off'; // calm by default; --intensity normal|fever or `c` in the app turns the effects on
}

/** Hex-only rain when the locale is not UTF-8 (half-width katakana would be mojibake or double-width). */
export function asciiRainFor(args: Pick<CliArgs, 'asciiRain'>, env: NodeJS.ProcessEnv): boolean {
  if (args.asciiRain) return true;
  const loc = (env.LC_ALL || env.LC_CTYPE || env.LANG || '').toLowerCase();
  return loc !== '' && !/utf-?8/.test(loc);
}

/** `--theme`: a built-in, or (task-1358) a user theme from ~/.dexterm/themes resolved through the config; unknown or refused = error. */
function themeArg(name: string, env: NodeJS.ProcessEnv): Theme {
  if (isThemeName(name)) return THEMES[name];
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error(`unknown theme ${name} (expected ${THEME_NAMES.join('|')} or a user theme name)`);
  const ui = initCustom(env);
  const t = themeByName(ui, name);
  if (!t) throw new Error(ui.themeErrors.find((e) => e.includes(`theme ${name}:`)) ?? `unknown theme ${name} (have: ${themeNames(ui).join(' | ')})`);
  return t;
}

function stateOpts(args: CliArgs, depth: ColorDepth, env: NodeJS.ProcessEnv) {
  return {
    screen: args.screen ?? 'screener' as ScreenKey,
    theme: themeArg(args.theme, env),
    selected: args.selected,
    seed: args.seed,
    aiOpen: !args.noAi,
    // default: the prototype's zone (America/New_York); `--tz local` uses the machine zone
    timeZone: args.tz === null ? undefined : args.tz === 'local' ? null : args.tz,
    intensity: intensityFor(args, env, depth),
    frame: args.frame,
    asciiRain: asciiRainFor(args, env),
    colorDepth: depth,
  };
}

/** Fixture-mode state from the args (the D-01 path). */
export function stateFromArgs(args: CliArgs, env: NodeJS.ProcessEnv = process.env, depth: ColorDepth = 'truecolor'): AppState {
  const state = makeFixtureState(stateOpts(args, depth, env));
  applyScreenerArgs(state, args);
  return state;
}

/** Apply --filter / --sort / --preset to a state; errors were caught by parseArgs already. */
export function applyScreenerArgs(state: AppState, args: CliArgs): void {
  if (args.priceMode) state.priceMode = args.priceMode; // task-1366
  state.simple = args.simple ?? !args.screen; // the interactive app opens simple; one-shot renders stay on the full table
  const sc = state.screener;
  if (args.preset) {
    if (!setPreset(sc, args.preset) && sc.preset !== args.preset) {
      const v = sc.presets.find((p) => p.id === args.preset);
      throw new Error(`preset ${args.preset} is unavailable${v?.caption ? ` (${v.caption})` : ''}`);
    }
  }
  if (args.filter) { const err = setFilter(sc, args.filter); if (err) throw new Error(`bad --filter: ${err.error}`); }
  if (args.sort) setSort(sc, args.sort.key, args.sort.dir);
  // a feed state has no rows until the first refresh; main() clamps again after it lands
  if (sc.rows.length) state.selected = clampSelection(sc, state.selected);
}

/** Fire a fixture demo event: mutates the fixtures like the real thing would and pulses the effects. Returns the toast text. */
export function demoEvent(state: AppState, kind: DemoEvent, rnd: Rng): string {
  const v = state.vfx;
  const fx = state.fx;
  if (kind === 'newpair') {
    const p = spawnPair(fx, rnd);
    pulse(v, 'newpair');
    return `new pair $${p.symbol} · ${p.launchpad}`;
  }
  if (kind === 'rug') {
    const tk = state.token || fx.newPairs[state.selected || 0] || fx.newPairs[0];
    if (!tk.flags.includes('RUG' as never)) (tk.flags as string[]).unshift('RUG');
    pulse(v, 'rug');
    return `RUG FLAG · $${tk.symbol} dev sold 60%`;
  }
  const tk = state.token || fx.tokens[state.selected || 0] || fx.tokens[0];
  if (kind === 'pump') { shock(tk, 38, rnd); pulse(v, 'pump'); return `$${tk.symbol} ▲38% 5m · smart money in`; }
  shock(tk, -31, rnd); pulse(v, 'dump'); return `$${tk.symbol} ▼31% 5m · sell wall`;
}

/** Apply the one-shot effect flags (--event, --ai, --mood, --activity, --t) to a fresh state. */
export function applyEffectArgs(state: AppState, args: CliArgs): void {
  const v = state.vfx;
  if (args.event) demoEvent(state, args.event, mulberry32(args.seed + 1));
  if (args.ai) {
    const [phase, n] = args.ai.split(':');
    state.ai = { phase: phase === 'thinking' ? 'thinking' : 'streaming', cut: state.screen === 'analyst' ? 3 : 2, revealed: Number(n || 0), ticks: 0 };
  }
  if (args.mood) v.mood = args.mood;
  if (args.activity !== null) v.activity = args.activity;
  state.boot = { t: args.t };
}

export interface Io {
  stdout: NodeJS.WriteStream & { fd: 1 };
  stdin: NodeJS.ReadStream & { fd: 0 };
  stderr: NodeJS.WriteStream & { fd: 2 };
  env: NodeJS.ProcessEnv;
}

/** Color depth for the run: --color wins; --ansi means "I want colour on this pipe" = 24-bit unless NO_COLOR. */
export function colorDepthFor(args: Pick<CliArgs, 'color' | 'ansi'>, env: NodeJS.ProcessEnv, isTTY: boolean): ColorDepth {
  if (args.color) return args.color;
  if (args.ansi && !isTTY) return env.NO_COLOR !== undefined && env.NO_COLOR !== '' ? 'none' : 'truecolor';
  return detectColorDepth(env, isTTY);
}

/**
 * Fast-lane WebSocket endpoints for the live run (SPEC §3.9, task-1312): the resolved RPC (keyed Helius
 * when a key is configured, else the keyless public RPC) first, then the public RPC WS as the keyless
 * fallback. URLs may carry a key and are never logged. Returns [] when no streamable endpoint resolves.
 */
export function fastLaneEndpoints(rpc: RpcConfig): FastLaneEndpoint[] {
  const out: FastLaneEndpoint[] = [];
  const primaryWs = wsUrlFor(rpc.url);
  if (primaryWs) {
    const keyed = rpc.provider === 'helius' || rpc.provider === 'custom';
    out.push({ url: primaryWs, source: rpc.provider === 'helius' ? 'helius-ws' : 'solana-ws', keyed, label: rpc.provider === 'helius' ? 'Helius ws (free key)' : rpc.provider === 'custom' ? 'custom RPC ws' : 'public RPC ws' });
  }
  if (!out.some((e) => e.url === SOLANA_PUBLIC_RPC_WS)) out.push({ url: SOLANA_PUBLIC_RPC_WS, source: 'solana-ws', keyed: false, label: 'public RPC ws' });
  return out;
}

export async function main(argv: string[], io: Io = process as unknown as Io, proc: GuardProcess = process): Promise<number> {
  // `trenchscope mcp` → the read-only MCP server on stdio (SPEC §5.1; `claude mcp add trenchscope -- trenchscope mcp`),
  // plus `trenchscope mcp install <client>` (one-command setup) and `trenchscope mcp doctor` (verify the connection).
  if (argv[0] === 'mcp') {
    const { runMcp } = await import('./mcp-cmd.ts');
    return runMcp(argv.slice(1), io);
  }
  // `trenchscope agent <cmd>` → bring-your-own-agent registry + loopback bus (task-1345): add/list/rotate/
  // remove/tier/pause/resume/kick/audit/packs, `serve` (a standalone bus on fixtures) and `connect`.
  if (argv[0] === 'agent') {
    const { runAgent } = await import('./agent-cmd.ts');
    return runAgent(argv.slice(1), io);
  }
  // `trenchscope spectate --replay FILE | --info` → watch an agent drive trenchscope (task-1406, "watch the agent
  // cook"): replay a saved session, or show the live read-only, token-gated, loopback spectator stream.
  if (argv[0] === 'spectate') {
    const { runSpectate } = await import('./spectate-cmd.ts');
    return runSpectate(argv.slice(1), io);
  }
  // `trenchscope recorder <cmd>` → the history recorder's tables: stats, label, prune, export (task-1329). No network.
  if (argv[0] === 'recorder') {
    const { recorderCli } = await import('@dexterm/recorder');
    return recorderCli(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope narrative [--window 1h|24h] [--summary]` → the narrative board over recorded history (task-1356). No network, no model.
  if (argv[0] === 'narrative') {
    const { narrativeCommand } = await import('./narrative-cmd.ts');
    return narrativeCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope backtest [--subject heuristic|pack_verdicts] [--horizon SEC]` → honest rug-model metrics over recorded outcomes (task-1356). No network, no model.
  if (argv[0] === 'backtest') {
    const { backtestCommand } = await import('./backtest-cmd.ts');
    return backtestCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // Local-only marketing evidence pipeline (task-1433): drafts and cards for human review, never posts.
  if (argv[0] === 'larp-detected') {
    const { larpDetectedCommand } = await import('./larp-detected.ts');
    return larpDetectedCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope kol …` → KOL lists on the shared DB (task-1330): list/create/add/remove/mute/unmute/enable/disable/import.
  if (argv[0] === 'kol') return kolCommand(argv.slice(1), io);
  // `trenchscope x <status|set-client-id|login|logout>` → Login with X via OAuth2 PKCE on the loopback callback
  // (task-1357). Tokens stay in ~/.dexterm/x (0600), never printed; read scopes only.
  if (argv[0] === 'x') {
    const { runX } = await import('./x-cmd.ts');
    return runX(argv.slice(1), io as unknown as import('./x-cmd.ts').XIo);
  }
  // `trenchscope workspace list|show|remove|init` → the workspace files under ~/.dexterm/workspaces (task-1358). No network.
  if (argv[0] === 'workspace') {
    const { workspaceCommand } = await import('./workspace-cmd.ts');
    return workspaceCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope kb|skill list|show|new|edit|check|reset|path` → the user's KB / skill overlay under ~/.dexterm (task-1377).
  // No network, no model; bundled files are never edited, the MCP server / analyst / Jarvis pick changes up per call.
  if (argv[0] === 'kb' || argv[0] === 'skill') {
    const { kbSkillCommand } = await import('./kb-skill-cmd.ts');
    return kbSkillCommand(argv[0], argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env, isTTY: io.stdout.isTTY === true });
  }
  // `trenchscope help [topic]` → the app-help KB (task-1413): how the app works, with the exact key/command.
  // Backed by the same generated entries the analyst's `app_help` tool uses. No network, no model.
  if (argv[0] === 'help') {
    const { helpCommand } = await import('./help-cmd.ts');
    return helpCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr });
  }
  // `trenchscope theme list|show|init|check` → user themes under ~/.dexterm/themes (task-1358 Tier 2). No network.
  if (argv[0] === 'theme') {
    const { themeCommand } = await import('./theme-cmd.ts');
    return themeCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope display [price|mcap]` → show or set the price display mode (task-1366). No network; display only.
  if (argv[0] === 'display') {
    const { displayCommand } = await import('./display.ts');
    return displayCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope keymap [screen]` → the effective key bindings (defaults + config.keymap), overrides marked (task-1358 Tier 2).
  if (argv[0] === 'keymap') {
    const { keymapCommand } = await import('./theme-cmd.ts');
    return keymapCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope rules list|add|remove|enable|disable|check|dry-run|fields` → the rules engine's config (task-1358 Tier 3). No network, no model.
  if (argv[0] === 'rules') {
    const { rulesCommand } = await import('./rules-cmd.ts');
    return rulesCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope alerts status|enable|disable|levels|proposals|set-telegram|set-discord|test` → where rule alerts
  // are delivered (task-1398). Credentials live in ~/.dexterm/*.json (0600), never config.json/argv/logs.
  if (argv[0] === 'alerts') {
    const { alertsCommand } = await import('./alerts-cmd.ts');
    return alertsCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env, stdin: io.stdin as unknown as NodeJS.ReadStream });
  }
  // `trenchscope watch [--interval S] [--once|--ticks N] [--replay FILE]` → run the rules engine headless and
  // PUSH alerts to the enabled channels so they reach you when the terminal is closed (task-1398). No signer.
  if (argv[0] === 'watch') {
    const { watchCommand } = await import('./watch-cmd.ts');
    return watchCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope record [run|install|uninstall|status]` → the headless collector that keeps the history recorder
  // fed with no TUI open (task-1414), to be driven by a user-level launchd LaunchAgent. No signer, no trading;
  // requests honour the data layer limits / health gate / sweep budgets, and the Helius key is never printed.
  if (argv[0] === 'record') {
    const { recordCommand } = await import('./record-cmd.ts');
    return recordCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope bot run|stats|config` → the headless PAPER-trading bot. Paper only: its import graph never reaches the
  // signer / live executor / send path (test/bot-paper-guard.test.ts), and the bin shims route `bot` there before this
  // file (and so the app's trade modules) ever loads; this branch only serves in-process callers such as tests.
  if (argv[0] === 'bot') {
    const { botCommand } = await import('./bot-cmd.ts');
    return botCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope pack list|verify|add|remove|export|lock|sign|trust|signers|keymap|widget` → shareable packs (task-1358 Tier 4):
  // plain files + sha256 lock + optional ssh signature. No network, no model; a pack never runs code (widgets land
  // disabled, unsigned rules load disabled, a keymap merges only on the explicit command).
  if (argv[0] === 'pack') {
    const { packCommand } = await import('./pack-cmd.ts');
    return packCommand(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope wallet <link|unlink|status>` → link a Phantom wallet via the loopback bridge (keys never
  // enter dexterm; only the pubkey is stored), unlink it, or show the link + trade caps (task-1310 T1).
  if (argv[0] === 'wallet') {
    const { runWallet } = await import('./wallet-cmd.ts');
    return runWallet(argv.slice(1), io as unknown as import('./wallet-cmd.ts').WalletIo);
  }
  // `trenchscope plan …` / `trenchscope mandate …` → conditional order plans + standing mandates (task-1355).
  // Voice/agents can only PROPOSE; arming needs a physical keypress; caps/panic stay signer-side.
  if (argv[0] === 'plan') {
    const { runPlan } = await import('./plan-cmd.ts');
    return runPlan(argv.slice(1), io);
  }
  if (argv[0] === 'mandate') {
    const { runMandate } = await import('./plan-cmd.ts');
    return runMandate(argv.slice(1), io);
  }
  // `trenchscope follow …` → the copy-trading follow list (task-1360 Tier 1): local, self-directed, read-only.
  if (argv[0] === 'follow') {
    const { runFollow } = await import('./follow-cmd.ts');
    return runFollow(argv.slice(1), io);
  }
  // `trenchscope update [--off|--on]` → is there a newer version, and the exact upgrade command for this install (task-1397).
  // Two anonymous GETs (npm registry, GitHub releases); never upgrades anything itself.
  if (argv[0] === 'update') {
    const { updateCommand } = await import('./update.ts');
    return updateCommand(argv.slice(1), io);
  }
  // `trenchscope voice [status|download <model>]` → inspect the voice engines and download the optional
  // voice models (whisper base.en, Piper voice). Downloads ask first and are checksum-verified (task-1408).
  if (argv[0] === 'voice') {
    const { voiceCommand } = await import('./voice-cmd.ts');
    return voiceCommand(argv.slice(1), { stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, env: io.env });
  }
  // `trenchscope doctor` → a pre-flight that says whether trenchscope will run here and how to fix what won't (task-1305).
  if (argv[0] === 'doctor') {
    const { defaultDeps, runDoctor, renderDoctor } = await import('./doctor.ts');
    const rest = argv.slice(1);
    const deps = defaultDeps(io.env, io.stdout.isTTY === true);
    if (rest.includes('--offline')) deps.offline = true;
    const result = await runDoctor(deps);
    const color = rest.includes('--no-color') ? false
      : colorDepthFor({ color: null, ansi: false }, io.env, io.stdout.isTTY === true) !== 'none';
    io.stdout.write(renderDoctor(result, { color }) + '\n');
    return result.ok ? 0 : 1;
  }
  // `trenchscope popup --self-test` → open a chart popup on fixture data and report shell/hotkey/fps (task-1290).
  // Does NOT block on a live 60 fps display or a live hotkey press; it reports what it can measure headlessly
  // and labels what still needs a human at an unlocked Mac. `--browser` forces the OS-browser fallback path.
  if (argv[0] === 'popup') {
    const rest = argv.slice(1);
    if (!rest.includes('--self-test')) {
      io.stderr.write('trenchscope popup: the only subcommand is --self-test (open a chart popup on fixtures and report shell/hotkey/fps)\n');
      io.stderr.write('  trenchscope popup --self-test [--browser] [--seconds N] [--theme NAME]\n');
      return 2;
    }
    const { runSelfTest, renderSelfTest } = await import('@dexterm/popup');
    const si = rest.indexOf('--seconds');
    const seconds = si >= 0 ? Number(rest[si + 1]) : undefined;
    const ti = rest.indexOf('--theme');
    const themeName = (ti >= 0 ? rest[ti + 1] : DEFAULT_THEME) ?? DEFAULT_THEME;
    const theme = isThemeName(themeName) ? THEMES[themeName] : THEMES[DEFAULT_THEME];
    const { popupThemeFrom } = await import('./popup.ts');
    const color = colorDepthFor({ color: null, ansi: false }, io.env, io.stdout.isTTY === true) !== 'none';
    const result = await runSelfTest({ seconds: Number.isFinite(seconds) ? seconds : undefined, forceBrowser: rest.includes('--browser'), theme: popupThemeFrom(theme), env: io.env });
    io.stdout.write(renderSelfTest(result, color) + '\n');
    // Exit 0 even on the browser fallback / low fps: those are environment facts for the user, not a CLI failure.
    return 0;
  }
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr.write(`dexterm: ${(e as Error).message}\n`);
    return 2;
  }
  if (args.help) { io.stdout.write(HELP + '\n'); return 0; }
  if (args.version) { io.stdout.write(`${VERSION}\n`); return 0; }
  if (args.unknown.length) { io.stderr.write(`dexterm: unknown option ${args.unknown[0]}\n${HELP}\n`); return 2; }
  if (!args.screen && (!io.stdout.isTTY || !io.stdin.isTTY)) {
    io.stderr.write('dexterm: interactive mode needs a TTY; use --screen for one-shot output\n');
    return 1;
  }
  const live = !args.fixtures && !args.replay;
  if (live && io.env.DEXTERM_OFFLINE) {
    io.stderr.write('dexterm: DEXTERM_OFFLINE is set; use --fixtures or --replay FILE for offline data\n');
    return 2;
  }
  // HTML output is always rendered in truecolor (the page carries the colours itself)
  const depth = args.html ? 'truecolor' : colorDepthFor(args, io.env, io.stdout.isTTY === true);
  let state: AppState;
  let feed: ScreenerFeed | null = null;
  let ctx: LiveContext | null = null;
  try {
    if (args.fixtures) {
      state = stateFromArgs(args, io.env, depth);
    } else {
      // The DB persists the cache, the watchlist and the Helius credit meter across runs; ':memory:' opts out.
      const dbPath = args.db === null ? defaultDbPath(io.env) : args.db;
      const dbOpt = dbPath === ':memory:' ? undefined : dbPath;
      // task-1314: the analyst's MCP server (a child process) reads this to share the exact same cache
      // DB, so get_dossier sees the candles/holders/rugcheck the open token screen already warmed.
      process.env.DEXTERM_DB_PATH = dbPath;
      if (args.replay) {
        feed = createReplayFeed(args.replay);
        ctx = new LiveContext(feed.dl, { mode: 'replay', dbPath: dbOpt, replay: feed.replayStore ?? undefined, interval: args.interval, allowedSigners: join(dextermHome(io.env), 'allowed_signers') });
      } else {
        // The key never leaves resolveRpcUrl()/the data layer; only the provider name is ever printed.
        const rpc = resolveRpcUrl({ env: io.env });
        feed = createLiveFeed({
          dbPath: dbOpt, maxRequests: args.maxRequests, record: !!args.record, rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl, maxCredits: args.maxCredits || undefined,
          rpcPublicPool: true, rpcExtraUrls: extraRpcUrls(io.env), trackerKey: resolveTrackerKey({ env: io.env })?.key ?? null,
          shrineKey: resolveShrineKey({ env: io.env })?.key ?? null,
          onRequest: args.verbose ? (req, meta, o) => io.stderr.write(`  ${meta.source.padEnd(14)} ${String(o.status ?? 'ERR').padStart(3)} ${String(o.latencyMs).padStart(5)}ms ${redactSecrets(req.url).slice(0, 110)}\n`) : undefined,
        });
        ctx = new LiveContext(feed.dl, {
          mode: 'live', dbPath: dbOpt, rpc: { provider: rpc.provider, basis: rpc.basis }, record: args.record ? feed.recording ?? undefined : undefined, interval: args.interval, fastEndpoints: fastLaneEndpoints(rpc), onLog: args.verbose ? (l) => io.stderr.write(l) : undefined, allowedSigners: join(dextermHome(io.env), 'allowed_signers'),
          // task-1328: LIVE trading is available in a real live run (never replay/offline); the signer
          // process starts lazily on the first LIVE action with exactly these flags.
          ...(args.live && !io.env.DEXTERM_OFFLINE ? { trade: { signerArgv: args.trade } } : {}),
        });
        // task-1329: the history recorder listens to the data layer's normaliser (zero requests of its own)
        // and keeps snapshots / feed membership / outcome labels in the same --db file. Live mode only (a
        // replay must never write fixture-time rows into the user's history); ':memory:' has nothing to keep.
        if (dbOpt && recorderEnabled(io.env, args.noRecorder)) {
          const liveCtx = ctx;
          const recorder = new Recorder({
            path: dbOpt,
            focus: () => [...liveCtx.watch.store.list().map((w) => w.mint), ...(liveCtx.token ? [liveCtx.token.view.mint] : [])],
            onLog: args.verbose ? (l) => io.stderr.write(l) : undefined,
          });
          recorder.attach(feed.dl.store);
          ctx.recorder = recorder;
          // 0.1.5 dev history: PumpPortal / RugCheck creators of new pairs go into the creator index too.
          ctx.newpairs.onCreator = (mint, creator, source, createdAt) => { recorder.recordCreator(mint, creator, source, undefined, createdAt); };
        }
        if (args.verbose) io.stderr.write(`dexterm: rpc ${rpc.provider} (${rpc.basis}) · db ${dbPath} · recorder ${ctx.recorder ? 'on' : 'off'} · live trading ${args.live && !io.env.DEXTERM_OFFLINE ? 'available' : 'off'}\n`);
      }
      if (args.preset && !feed.setPreset(args.preset)) {
        const v = feed.presets().find((p) => p.id === args.preset);
        throw new Error(`preset ${args.preset} is unavailable${v?.caption ? ` (${v.caption})` : ''}`);
      }
      state = makeFeedState(feed, args.replay ? 'replay' : 'live', stateOpts(args, depth, io.env));
      state.live = ctx;
      // task-1330: the social feed matches headlines / cashtags against whatever the screener knows.
      ctx.boardSource = () => state.screener.rows.filter((r) => r.mint && !r.skeleton).map((r) => ({ mint: r.mint, symbol: r.symbol, name: r.name ?? undefined }));
      state.scanConfig = args.scanConfig; // task-1324: --scan-* overrides, applied when the scan is created
      // task-1326: coin images for live + replay runs. Replay / DEXTERM_OFFLINE answer from the disk cache only
      // (never the network). Off with --no-images, DEXTERM_IMAGES=0 or images.json; fixtures never have them.
      const imgCfg = resolveImagesConfig(io.env, args.noImages, { offline: !!args.replay || !!io.env.DEXTERM_OFFLINE });
      if (imgCfg.enabled) {
        const dataDir = dirname(dbPath === ':memory:' ? defaultDbPath(io.env) : dbPath);
        state.images = new ImageService({
          dir: join(dataDir, 'images'), offline: !!args.replay || !!io.env.DEXTERM_OFFLINE, thumbMax: imgCfg.thumbMax, maxDiskBytes: imgCfg.diskMb * 1024 * 1024,
          onRequest: args.verbose ? (r) => io.stderr.write(`  images         ${r.ok ? ' ok' : 'ERR'} ${String(r.ms).padStart(5)}ms ${r.source.padEnd(7)} ${r.ok ? '' : `${r.reason ?? ''} `}${r.url.slice(0, 100)}\n`) : undefined,
        });
        state.imageBlocks = imgCfg.blocks;
        // the environment's verdict now; the interactive loop refines it with a capability query
        state.imageProtocol = imgCfg.protocol === 'auto' ? resolveProtocol(io.env as never, null).protocol : imgCfg.protocol;
      }
      // task-1303: live-backed presets ("New"/"All") fold the PumpPortal new-pairs stream into the pool.
      const liveCtx = ctx;
      if (liveCtx) feed.extraMints = () => [...liveCtx.newpairs.rows.keys()];
      applyScreenerArgs(state, args);
      if (args.mint) {
        if (args.mintVia === 'dexscreener') args.mint = (await resolveCoinTarget({ address: args.mint, via: 'dexscreener', rest: '' }, ctx.dl)).mint;
        ctx.openToken({ mint: args.mint, symbol: args.mint.slice(0, 4) + '…', name: '', launchpad: 'unknown' });
        if (args.screen === null) state.screen = 'token';
      }
    }
  } catch (e) {
    ctx?.close();
    feed?.close();
    io.stderr.write(`dexterm: ${redactSecrets((e as Error).message)}\n`);
    return 2;
  }
  // task-1358: config.json + workspaces. Interactive runs always load them; a one-shot frame only when
  // --workspace asks (so the snapshot goldens never depend on a user's ~/.dexterm). A bad config keeps
  // the defaults and is reported, never fatal. A --workspace that does not exist IS fatal (a typo should not
  // silently render the default).
  if (!args.screen || args.workspace || !isThemeName(args.theme)) {
    state.custom = initCustom(io.env);
    state.rulesUi = rulesUiOf(state); // task-1358 Tier 3: the rules engine from config.rules (bad rules reported, good ones run)
    for (const e of state.custom.configErrors) io.stderr.write(`dexterm: config: ${e}\n`);
    // --theme <user theme> was resolved by stateOpts (unknown / refused = exit 2 above); config.theme.overrides
    // apply to a built-in theme here (user themes already carry them).
    if (isThemeName(args.theme) && state.custom.config.theme?.overrides && Object.keys(state.custom.config.theme.overrides).length) {
      const t = themeByName(state.custom, args.theme);
      if (t) state.theme = t;
    }
    for (const e of state.custom.themeErrors) io.stderr.write(`dexterm: ${e}\n`);
    state.priceMode = args.priceMode ?? configPriceMode(state.custom.config); // task-1366: --price-mode wins for the run
    if (args.workspace) {
      const r = switchWorkspace(state, args.workspace, []);
      if (!r.ok) { ctx?.close(); feed?.close(); io.stderr.write(`dexterm: ${r.reason}\n`); return 2; }
      if (args.screen) state.custom.pendingPopups = null; // a one-shot frame opens no windows
      else if (args.verbose) io.stderr.write(`dexterm: workspace ${args.workspace}${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}\n`);
    }
  }

  if (args.screen) {
    const live = ctx;
    if (feed && live) {
      // one-shot: the screen's own loaders first, then the screener feed (its rows seed the token/watch screens)
      if (args.screen === 'token') {
        if (!live.token) {
          await feed.refresh();
          syncFeed(state);
          const row = screenerView(state.screener)[clampSelection(state.screener, state.selected)];
          if (row) live.openToken(row);
        }
        if (live.token) await live.token.load();
      } else if (args.screen === 'newpairs') {
        const t0 = Date.now();
        await live.startFeed(0);
        if (live.mode === 'live' && args.listen > 0) {
          await new Promise<void>((resolve) => {
            const iv = setInterval(() => { if (Date.now() - t0 >= args.listen * 1000) { clearInterval(iv); resolve(); } }, 100);
          });
        }
        await live.newpairs.refresh(true);
        if (args.verbose) {
          const st = live.newpairs.status();
          io.stderr.write(`dexterm: pumpportal ${st.stream?.state ?? 'off'} · ${st.stream?.creates ?? 0} creates · event→row p50 ${st.latency.p50 ?? '-'}ms p95 ${st.latency.p95 ?? '-'}ms (n=${st.latency.n})\n`);
        }
      } else if (args.screen === 'watchlist') {
        await live.watch.refresh();
      } else if (args.screen === 'trending') {
        // task-1330: one paced venue cycle (5 keyless calls) + the RSS feeds, then the screener rows for symbols.
        await feed.refresh();
        syncFeed(state);
        await live.social.refreshVenues();
        await live.social.refreshNews();
        for (const [k, m] of Object.entries({ ...live.social.venueErrors, ...live.social.newsErrors })) io.stderr.write(`dexterm: social ${k}: ${m}\n`);
      } else if (args.screen === 'positions') {
        await feed.refresh();
        syncFeed(state);
        live.positions.setSolPrice(state.sol?.price);
        await live.positions.refresh();
      } else {
        await feed.refresh();
        syncFeed(state);
        state.selected = clampSelection(state.screener, state.selected);
      }
      const errs: Record<string, string> = { ...feed.errors, ...(args.screen === 'newpairs' ? live.newpairs.errors : args.screen === 'watchlist' ? live.watch.errors : {}) };
      if (args.screen === 'token' && live.token) for (const [panel, p] of Object.entries(live.token.view.panels)) if (p.state === 'error' || p.state === 'needs-key') errs[`token ${panel}`] = p.reason ?? p.state;
      for (const [src, msg] of Object.entries(errs)) io.stderr.write(`dexterm: ${src}: ${redactSecrets(msg.length > 160 ? msg.slice(0, 157) + '…' : msg)}\n`);
      if (args.verbose) io.stderr.write(`dexterm: ${feed.rows.length} rows, ${feed.requests} live requests${live.credits ? ` · ${live.credits.label()}` : ''}\n`);
    } else if (feed) {
      await feed.refresh();
      syncFeed(state);
      state.selected = clampSelection(state.screener, state.selected);
      for (const [src, msg] of Object.entries(feed.errors)) io.stderr.write(`dexterm: ${src}: ${msg.length > 160 ? msg.slice(0, 157) + '…' : msg}\n`);
      if (args.verbose) io.stderr.write(`dexterm: ${feed.rows.length} rows, ${feed.requests} live requests\n`);
    }
    applyEffectArgs(state, args);
    const w = args.width || io.stdout.columns || 160;
    const h = args.height || io.stdout.rows || 45;
    // task-1326: a one-shot frame is printed inline (no alternate screen), so it uses block art, and it waits
    // briefly for the visible coin images: the first render queues them, the service lands them, then we paint.
    if (state.images) {
      state.imageProtocol = 'blocks';
      renderFrame(state, w, h);
      await state.images.whenIdle(args.replay || io.env.DEXTERM_OFFLINE ? 1500 : 5000);
    }
    const c = renderFrame(state, w, h);
    ctx?.newpairs.markDrawn();
    if (args.export !== null) {
      // task-1401: `--export [DIR]` writes the same PNG + text report the `E` key does (default ~/.dexterm/exports).
      const now = Date.now();
      const r = writeExport(exportViewFor(state, w, h, now), { now, env: io.env, dir: args.export || undefined });
      io.stderr.write(`wrote ${r.png} (${r.bytes} bytes) and ${r.txt}\n`);
    } else if (args.html) {
      // task-1326: `--html … --color 256` renders through the xterm palette (a Terminal.app-faithful proof)
      writeFileSync(args.html, c.toHtml({ title: args.title || `trenchscope — ${args.screen} — ${state.theme.name}`, fit: args.fit, fontPx: args.fontPx ?? 15, depth: args.color ?? 'truecolor' }));
      io.stderr.write(`wrote ${args.html} (${w}×${h})\n`);
    } else if (args.plain || (!args.ansi && !io.stdout.isTTY && args.color === null)) {
      io.stdout.write(c.toPlain() + '\n');
    } else {
      io.stdout.write(c.toAnsi({ depth }) + '\n');
    }
    if (args.verbose && state.images) { const s = state.images.snapshot(); io.stderr.write(`dexterm: images ${s.ready} ready · ${s.missing} missing · ${s.pending} pending · ${s.fetched} fetched (${Math.round(s.bytesFetched / 1024)} KB) · ${s.diskHits} from disk\n`); }
    state.images?.close();
    ctx?.close();
    if (feed && args.record) { feed.save(args.record); io.stderr.write(`recorded ${feed.requests} live requests to ${args.record}\n`); }
    feed?.close();
    return 0;
  }
  // task-1397: live interactive runs only: the cached "new version" notice (no network) plus, at most once a day,
  // a background refresh that never blocks the start. Off with DEXTERM_NO_UPDATE_CHECK=1 / `trenchscope update --off`.
  const update = live ? (await import('./update.ts')).startupCheck(io.env) : null;
  if (update) {
    state.updateNotice = update.notice;
    void update.refresh?.then((n) => { if (n) state.updateNotice = n; });
  }
  try {
    return await interactive(state, io, depth, args, proc);
  } finally {
    update?.cancel();
  }
}

const SCREEN_ORDER: ScreenKey[] = ['screener', 'newpairs', 'watchlist', 'analyst'];

/** Rows PgUp/PgDn jump through the list (task-1303). */
export const PAGE_ROWS = 20;

/** Side effect the interactive loop performs after an action. */
export type Effect = 'quit' | 'refresh' | void;

/** The analyst starts thinking when its panel opens: spinner first, then the answer decrypts in (the loop advances it). */
function startAnalyst(state: AppState, cut: number): void {
  state.ai = { phase: 'thinking', cut, revealed: 0, ticks: 0 };
}

/**
 * Scroll a long analyst answer on the token chat screen; returns true when it consumed the key (QA
 * M12). On the Analyst tab (task-1313) the coin list owns the arrows instead — the chat scrolls with
 * PgUp/PgDn — so this only fires on the token screen.
 */
function chatScroll(state: AppState, delta: number): boolean {
  if (!(state.screen === 'token' && state.analyst)) return false;
  state.aiScroll = Math.max(0, (state.aiScroll ?? 0) + delta);
  return true;
}

/** Scroll the Analyst-tab chat transcript (PgUp/PgDn); returns true when it consumed the key (task-1313). */
function analystChatScroll(state: AppState, delta: number): boolean {
  if (!(state.screen === 'analyst' && state.analyst)) return false;
  state.aiScroll = Math.max(0, (state.aiScroll ?? 0) + delta);
  return true;
}

/** Apply one keymap action to the state. Exported so tests can drive it without a TTY. */
/** task-1340: j/k on the bubble screen move the holder selection (holders are ordered by share). */
function bubbleMove(state: AppState, dir: 1 | -1): boolean {
  if (state.screen !== 'bubbles' || !state.intelUi) return false;
  const ui = state.intelUi;
  const vm = state.live?.intel.entry(ui.mint)?.bubbles ?? null;
  if (!vm || !vm.holders.length) return true;
  const idxs = ui.focus ? vm.holders.map((h, i) => (h.cluster === ui.focus ? i : -1)).filter((i) => i >= 0) : vm.holders.map((_, i) => i);
  if (!idxs.length) return true;
  const cur = ui.selected == null ? -1 : idxs.indexOf(ui.selected);
  const next = cur < 0 ? (dir > 0 ? 0 : idxs.length - 1) : Math.max(0, Math.min(idxs.length - 1, cur + dir));
  ui.selected = idxs[next];
  return true;
}

// task-1355: j/k (and PgUp/PgDn/g/G) select a row on the PLANS screen. Returns true when it handled the
// move so the generic screener-row movement below does not also run. While the arm modal is up, movement
// is frozen (the loop captures those keys to drive the hold-to-confirm, never the list).
// task-1360 Tier 2: what the screen already knows about a mint, for the mirror checks (the live binding fills the
// gaps from the data layer). Fixture mints are synthetic: their decimals are the fixture convention (6).
function mirrorHint(state: AppState, live: LiveContext | null, mint: string, now: number): Partial<MirrorMarket> {
  const tv = live?.token?.view;
  if (tv && tv.mint === mint) return { symbol: tv.symbol, priceUsd: tv.price, priceAt: now, liqUsd: tv.liq, mcapUsd: tv.mcap, ageMs: tv.ageMin != null ? tv.ageMin * 60_000 : null };
  const sr = screenerView(state.screener).find((r) => r.mint === mint);
  if (sr) return { symbol: sr.symbol, priceUsd: sr.price, priceAt: now, liqUsd: sr.liq, mcapUsd: sr.mcap, ageMs: sr.ageMin != null ? sr.ageMin * 60_000 : null, ...(live ? {} : { decimals: 6 }) };
  const np = live?.newpairs.list().find((r) => r.mint === mint) as { symbol: string; price?: number | null; liq?: number | null; mcap?: number | null } | undefined;
  if (np) return { symbol: np.symbol, priceUsd: np.price ?? null, priceAt: now, liqUsd: np.liq ?? null, mcapUsd: np.mcap ?? null };
  return {};
}

/** The leader's standing in the token's wallet-intel scan, when one exists (null = not scanned: shown as unknown). */
function leaderIntelFor(live: LiveContext | null, mint: string, wallet: string): { inDevCluster: boolean; holdsPct: number | null } | null {
  const res = live?.intel.entry(mint)?.result;
  if (!res || res.state !== 'ok') return null;
  const a = res.analysis;
  const h = a.holders.find((x) => x.owner === wallet);
  const inDevCluster = a.clusters.some((c) => c.kind === 'dev-linked' && c.members.includes(wallet)) || !!h?.labels.some((l) => l.label === 'dev');
  return { inDevCluster, holdsPct: h ? h.pct : null };
}

// task-1360: j/k on the FOLLOWED WALLETS screen move the follow cursor (frozen while an address is being typed).
function followsMove(state: AppState, delta: number): boolean {
  if (state.screen !== 'follows' || !state.copyUi) return false;
  if (state.copyUi.input !== null || state.copyUi.mirror || state.copyUi.autoModal) return true;
  if (state.copyUi.detail) { state.copyUi.detail.scroll = Math.max(0, state.copyUi.detail.scroll + (delta > 0 ? 1 : -1)); return true; } // task-1399: j/k scroll the detail view
  const n = state.copy?.follows().length ?? 0;
  if (n <= 0) { state.copyUi.selected = 0; return true; }
  state.copyUi.selected = Math.max(0, Math.min(n - 1, state.copyUi.selected + delta));
  return true;
}

// task-1358 Tier 3: j/k on the RULES screen move the cursor of the active pane (frozen while a rule is being typed).
function rulesScreenMove(state: AppState, delta: number): boolean {
  if (state.screen !== 'rules' || !state.rulesUi) return false;
  rulesMove(state.rulesUi, delta);
  return true;
}

function plansMove(state: AppState, delta: number): boolean {
  if (state.screen !== 'plans' || !state.plansUi) return false;
  if (state.plansUi.arming || state.plansUi.riskModal || state.plansUi.liveModal) return true;
  const n = plansRows(state).length;
  if (n <= 0) { state.plansUi.selected = 0; return true; }
  state.plansUi.selected = Math.max(0, Math.min(n - 1, state.plansUi.selected + delta));
  return true;
}

export function applyAction(state: AppState, action: AppAction, stack: ScreenKey[]): Effect {
  const sc = state.screener;
  const live = state.live && sc.source !== 'fixtures' ? state.live : null;
  const rows = (): readonly unknown[] => state.screen === 'newpairs' ? (live ? live.newpairs.list() : state.fx.newPairs) : state.screen === 'watchlist' ? (live ? live.watch.list() : state.fx.watch)
    : state.screen === 'trending' ? trendingRows(state) : state.screen === 'kol' ? (kolOf(state) ? kolRows(kolOf(state)!) : []) : screenerView(sc);
  sc.notice = null;
  if (live) { live.notice = null; live.watch.notice = null; }
  /** The token the key refers to on the current screen (live rows only). */
  const pick = <T,>(xs: readonly T[]): T | undefined => xs[Math.max(0, Math.min(xs.length - 1, state.selected || 0))];
  const liveTarget = () => {
    if (!live) return null;
    if (state.screen === 'token') return live.token?.view ?? null;
    if (state.screen === 'newpairs') { const l = live.newpairs.list(); return (state.selectedMint ? l.find((x) => x.mint === state.selectedMint) : undefined) ?? pick(l) ?? null; }
    if (state.screen === 'watchlist') { const w = pick(live.watch.list()); return w ? (w.row ?? { mint: w.entry.mint, symbol: w.entry.symbol, name: w.entry.name, launchpad: w.entry.launchpad, price: null, liq: null }) : null; }
    if (state.screen === 'screener') { const r = pick(screenerView(sc)); return r && !r.fixture && !r.skeleton ? r : null; }
    // task-1330: a trending row is a mint + symbol (+ liq); the watchlist candidate needs nothing more.
    if (state.screen === 'trending') { const r = pick(trendingRows(state)); return r ? { mint: r.mint, symbol: r.symbol, name: r.symbol, launchpad: 'unknown' as Launchpad, price: null, liq: r.liq, mcap: null } : null; }
    return null;
  };
  switch (action) {
    case 'quit': return 'quit';
    case 'screen.screener': state.screen = 'screener'; state.selected = 0; break;
    case 'screen.newpairs': state.screen = 'newpairs'; state.selected = 0; break;
    case 'screen.watchlist': state.screen = 'watchlist'; state.selected = 0; break;
    case 'screen.analyst': if (state.screen !== 'analyst') stack.push(state.screen); state.screen = 'analyst'; break;
    case 'screen.next': {
      const cur = state.screen === 'token' ? 'screener' : state.screen;
      state.screen = SCREEN_ORDER[(SCREEN_ORDER.indexOf(cur) + 1) % SCREEN_ORDER.length];
      state.selected = 0;
      break;
    }
    // task-1313: on the Analyst tab the arrows move the coin-list selection beside the chat (which
    // updates the context injected next turn); PgUp/PgDn scroll the chat transcript. On the token
    // screen (QA M12) the movement keys scroll the answer. Keys reach here only when input is NOT focused.
    case 'move.down': if (plansMove(state, 1) || followsMove(state, 1) || rulesScreenMove(state, 1)) break; if (bubbleMove(state, 1)) break; if (chatScroll(state, 1)) break; state.selected = Math.min(rows().length - 1, (state.selected || 0) + 1); break;
    case 'move.up': if (plansMove(state, -1) || followsMove(state, -1) || rulesScreenMove(state, -1)) break; if (bubbleMove(state, -1)) break; if (chatScroll(state, -1)) break; state.selected = Math.max(0, (state.selected || 0) - 1); break;
    case 'move.pagedown': if (plansMove(state, PAGE_ROWS) || followsMove(state, PAGE_ROWS) || rulesScreenMove(state, PAGE_ROWS)) break; if (analystChatScroll(state, PAGE_ROWS)) break; if (chatScroll(state, PAGE_ROWS)) break; state.selected = Math.min(rows().length - 1, (state.selected || 0) + PAGE_ROWS); break;
    case 'move.pageup': if (plansMove(state, -PAGE_ROWS) || followsMove(state, -PAGE_ROWS) || rulesScreenMove(state, -PAGE_ROWS)) break; if (analystChatScroll(state, -PAGE_ROWS)) break; if (chatScroll(state, -PAGE_ROWS)) break; state.selected = Math.max(0, (state.selected || 0) - PAGE_ROWS); break;
    case 'move.top': if (plansMove(state, -1e9) || followsMove(state, -1e9)) break; if (chatScroll(state, -1e9)) break; state.selected = 0; break;
    case 'move.bottom': if (plansMove(state, 1e9) || followsMove(state, 1e9)) break; if (chatScroll(state, 1e9)) break; state.selected = Math.max(0, rows().length - 1); break;
    case 'open': {
      if (state.screen === 'token' || state.screen === 'analyst' || state.screen === 'kol') break;
      if (state.screen === 'trending') {
        // task-1330: ⏎ on the board opens the token (the same loader every list screen uses); fixtures stay a demo.
        const tr = rows()[state.selected || 0] as TrendRow | undefined;
        if (!tr) break;
        if (!live) { state.pendingToast = `token detail needs live mode (${tr.symbol} ${tr.mint.slice(0, 8)}…)`; break; }
        live.openToken(seedForMint(state, live, tr.mint, tr.symbol));
        stack.push(state.screen);
        state.screen = 'token';
        break;
      }
      const r = rows()[state.selected || 0];
      if (!r || (r as ScreenerRow).skeleton) break; // task-1323: placeholder rows open nothing
      if (live) {
        // live rows open the live token detail (task-1298); the loader runs in the background and redraws as panels land
        if (state.screen === 'watchlist') { const w = r as WatchViewRow; live.openToken(w.row ?? { mint: w.entry.mint, symbol: w.entry.symbol, name: w.entry.name, launchpad: w.entry.launchpad }); }
        else if (state.screen === 'newpairs') {
          // task-1311 (QA M8): open the coin the cursor is on by mint, not by a row index that a new
          // create may have shifted between the move and ⏎.
          const list = live.newpairs.list();
          const pinned = state.selectedMint ? list.find((x) => x.mint === state.selectedMint) : undefined;
          live.openToken(pinned ?? (r as NewPairRow));
        }
        else { const sr = r as ScreenerRow; if (sr.fixture) state.token = sr.fixture; else live.openToken(sr); }
      } else {
        const fr = r as FixtureToken | WatchRow | ScreenerRow;
        if ('token' in fr) state.token = fr.token;
        else if ('sources' in fr) {
          if (!fr.fixture) { sc.notice = `token detail needs live mode (${fr.symbol} ${fr.mint.slice(0, 8)}…)`; break; }
          state.token = fr.fixture;
        } else state.token = fr;
      }
      stack.push(state.screen);
      state.screen = 'token';
      // task-1311 (QA M5): opening a token shows its data instantly and is free — no `claude -p` runs
      // on ⏎. The analyst runs only on an explicit `a`, and each token keeps its own conversation
      // (the loop points state.analyst at the saved session for this mint). Fixtures keep the demo.
      if (!live) startAnalyst(state, 2);
      break;
    }
    case 'watch.add': {
      const r = liveTarget();
      if (!live) { sc.notice = 'the watchlist persists only in live mode (fixtures are a demo)'; break; }
      if (!r) break;
      if (live.watch.has(r.mint)) { live.watch.remove(r.mint); live.notice = live.watch.notice; }
      else { live.watch.add(LiveContext.candidate(r as ScreenerRow)); live.notice = live.watch.notice; }
      if (state.screen === 'screener') sc.notice = live.notice;
      break;
    }
    case 'watch.remove': {
      if (!live || state.screen !== 'watchlist') break;
      const w = pick(live.watch.list());
      if (w) live.watch.remove(w.entry.mint);
      state.selected = Math.max(0, Math.min(live.watch.list().length - 1, state.selected || 0));
      break;
    }
    case 'alert.propose': {
      const r = liveTarget();
      if (!live) { sc.notice = 'alerts need live mode'; break; }
      if (!r) break;
      live.watch.propose(LiveContext.candidate(r as ScreenerRow));
      live.notice = live.watch.notice;
      if (state.screen === 'screener') sc.notice = live.notice;
      break;
    }
    case 'alert.confirm':
    case 'alert.dismiss': {
      // task-1330: while the token SOCIAL panel is up, `x` shows/hides the spam + squat rows (no alert key is lost: the
      // panel is a mode the user opened with `s`; the alert verbs return the moment it closes).
      if (action === 'alert.dismiss' && state.screen === 'token' && state.tokenSocial) { state.socialShowSpam = !state.socialShowSpam; break; }
      if (!live) break;
      const r = liveTarget();
      if (action === 'alert.confirm') live.watch.confirm(r?.mint); else live.watch.dismiss(r?.mint);
      live.notice = live.watch.notice;
      if (state.screen === 'screener') sc.notice = live.notice;
      break;
    }
    case 'tf.1': case 'tf.2': case 'tf.3': case 'tf.4': case 'tf.5': case 'tf.6': {
      if (live && state.screen === 'token') live.setTimeframe(Number(action.slice(3)));
      break;
    }
    case 'back': {
      if (state.screen === 'follows' && state.copyUi?.mirror) { state.copyUi.mirror = null; state.copyUi.notice = 'mirror preview closed'; break; } // task-1360: esc closes the mirror preview first
      if (state.screen === 'follows' && state.copyUi?.detail) { state.copyUi.detail = null; break; } // task-1399: esc closes the wallet detail view before leaving the screen
      const prev = stack.pop(); if (prev) state.screen = prev; break;
    }
    case 'trade.buy':
    case 'trade.sell': {
      // task-1310 PAPER trading: open the ticket for the token on screen, pre-set to a side.
      if (!live) { sc.notice = 'paper trading needs live mode (quotes come from Jupiter)'; break; }
      const tv = state.screen === 'token' ? live.token?.view : null;
      if (!tv?.mint) { sc.notice = 'open a token first, then B/S to paper-trade'; break; }
      live.openTicket({ mint: tv.mint, symbol: tv.symbol, name: tv.name }, action === 'trade.buy' ? 'buy' : 'sell');
      stack.push(state.screen);
      state.screen = 'ticket';
      break;
    }
    case 'screen.positions': {
      // task-1310 PAPER positions. Reachable from anywhere; live binding marks the PnL.
      if (state.screen === 'ticket' || state.screen === 'token') stack.push(state.screen);
      else if (state.screen !== 'positions') stack.length = 0;
      state.screen = 'positions';
      if (live) { live.positions.setSolPrice(state.sol?.price); void live.positions.refresh(); }
      break;
    }
    case 'input.focus': {
      // task-1311 (QA B1/B2): focus the chat input on a chat screen so the next keystrokes type a
      // question. Keep the analyst panel visible on the token screen so there is somewhere to type.
      if (state.screen === 'token' || state.screen === 'analyst') { state.aiFocused = true; if (state.screen === 'token') state.aiOpen = true; }
      break;
    }
    case 'copy.ca': {
      // task-1311 (QA B5): copy the full mint to the OS clipboard (the loop runs pbcopy/xclip/clip).
      const row = pick(screenerView(sc)) as { mint?: string } | undefined;
      const mint = live?.token?.view.mint ?? state.token?.mint ?? row?.mint ?? null;
      if (mint) {
        state.pendingCopy = mint;
        const confirm = `copied contract address · ${mint.slice(0, 4)}…${mint.slice(-4)}`;
        if (live) live.notice = confirm; else sc.notice = confirm;
      } else { sc.notice = 'no contract address on this screen'; }
      break;
    }
    case 'open.web':
    case 'open.x':
    case 'open.tg':
    case 'open.links': {
      // task-1315 (LARP detector): open the coin's advertised website/socials in the OS browser, or
      // list them. Real hrefs come from the live token view (merged Jupiter + DexScreener); fixtures
      // carry only presence badges, so this needs live mode. The loop re-checks the scheme before
      // opening and shows the URL first — never open anything but a validated http/https link.
      // The transient notice is what unit tests read and some screens render; pendingToast is the durable
      // channel the token screen actually shows (see the loop drain), so the reply survives a feed redraw.
      const note = (m: string) => { if (live) live.notice = m; else sc.notice = m; state.pendingToast = m; };
      const links = live?.token?.view.socialLinks;
      if (!links) { note('open links needs live mode'); break; }
      const present: Array<[string, string]> = [];
      if (links.web) present.push(['web', links.web]);
      if (links.x) present.push(['X', links.x]);
      if (links.tg) present.push(['TG', links.tg]);
      if (action === 'open.links') {
        note(present.length ? present.map(([k, u]) => `${k} ${u}`).join('  ·  ') : 'no links advertised for this token');
        const items = links.all?.length ? links.all : present.map(([kind, url]) => ({ kind, url }));
        if (items.length) { state.linkMenu = { items, selected: 0 }; state.overlay = 'links'; }
        break;
      }
      const kind = action === 'open.web' ? 'web' : action === 'open.x' ? 'X' : 'TG';
      const url = action === 'open.web' ? links.web : action === 'open.x' ? links.x : links.tg;
      const safe = url ? parseHttpUrl(url) : null;
      if (!safe) { note(`no ${kind} link for this token`); break; }
      state.pendingOpen = safe.toString();
      note(`open ${safe.toString()}`);
      break;
    }
    // ---- task-1340 wallet intel: the BUBBLE MAP screen and its popup
    case 'intel.bubbles': {
      if (state.screen !== 'token') break;
      const tv = live?.token?.view;
      if (!live || !tv?.mint) { state.pendingToast = 'open a token in live mode first, then M for its bubble map'; break; }
      state.intelUi = { mint: tv.mint, symbol: tv.symbol, name: tv.name, selected: null, view: 'bubbles', focus: null, layout: null };
      void live.intel.scan({ mint: tv.mint, symbol: tv.symbol, name: tv.name, holderCount: tv.holders }).catch(() => {});
      stack.push(state.screen);
      state.screen = 'bubbles';
      break;
    }
    case 'popup.bubbles': {
      if (state.screen !== 'bubbles' || !state.intelUi) break;
      state.pendingPopup = 'bubbles'; // the loop owns the window host
      break;
    }
    case 'bubbles.view': { const ui = state.intelUi; if (ui) { ui.view = ui.view === 'treemap' ? 'bubbles' : 'treemap'; } break; }
    case 'bubbles.zoom': {
      const ui = state.intelUi;
      if (!ui) break;
      if (ui.focus) ui.focus = null;
      else {
        const vm = live?.intel.entry(ui.mint)?.bubbles ?? null;
        const h = vm && ui.selected != null ? vm.holders[ui.selected] : null;
        if (h?.cluster) ui.focus = h.cluster; else state.pendingToast = 'select a linked bubble (j/k) to zoom its cluster';
      }
      ui.layout = null;
      break;
    }
    case 'bubbles.deep': {
      const ui = state.intelUi;
      if (!ui || !live) break;
      void live.intel.scan({ mint: ui.mint, symbol: ui.symbol, name: ui.name }, { depth: 'deep', force: true }).catch(() => {});
      state.pendingToast = 'deep scan: funders for every top wallet + 300 launch txs (Helius credits)';
      break;
    }
    case 'popup.chart': {
      // task-1290: open/toggle the frameless live-chart HUD window for the open coin. The loop performs
      // the side effect (it owns the window host / browser fallback); applyAction only records the intent.
      if (state.screen !== 'token') break;
      const tv = live?.token?.view;
      if (!tv?.mint) { state.pendingToast = 'open a token first, then C for its chart popup'; break; }
      state.pendingPopup = 'chart';
      break;
    }
    case 'popup.token': {
      // task-1359: the TOKEN-DETAIL HUD for the open coin (identity, market, risk, snipers / bundled from the scan).
      if (state.screen !== 'token') break;
      if (!live?.token?.view?.mint) { state.pendingToast = 'open a token in live mode first, then I for its token popup'; break; }
      state.pendingPopup = 'token';
      break;
    }
    case 'popup.feeds': {
      // task-1359: the FEEDS HUD (the board's posts + official headlines, newest first). Works on the demo feed too.
      if (state.screen !== 'trending') break;
      state.pendingPopup = 'feeds';
      break;
    }
    case 'analyst.larp': {
      const tv = live?.token?.view;
      if (!tv?.mint) { state.pendingToast = 'product vetting needs a live token'; break; }
      if (state.analyst?.busy) { state.pendingToast = 'analyst busy; Esc to interrupt before vetting'; break; }
      state.aiOpen = true;
      state.pendingAnalyst = { skill: 'larp-check', mint: tv.mint, symbol: tv.symbol, target: 'token' };
      break;
    }
    case 'analyst.toggle': {
      if (state.screen === 'token') {
        // Fixtures keep the simple demo-panel toggle. Live (QA M5/B2): `a` runs the dossier on demand —
        // an existing conversation just toggles the panel, otherwise this is the one explicit, paid run.
        if (!live || state.analyst) { state.aiOpen = !state.aiOpen; break; }
        const tv = live.token?.view;
        if (tv?.mint) { state.aiOpen = true; state.pendingAnalyst = { skill: 'token-dossier', mint: tv.mint, symbol: tv.symbol, target: 'token' }; }
        break;
      }
      if (state.screen === 'analyst') {
        // On the analyst tab `a` focuses the input to type — it never launches a paid run behind your
        // back (QA B3). Start a scan from the screener instead.
        state.aiFocused = true;
        break;
      }
      // list screens: launch a real Claude run — rug-check the selected token, or scan the screener.
      const r = liveTarget();
      stack.push(state.screen);
      state.screen = 'analyst';
      if (live) {
        state.pendingAnalyst = r?.mint
          ? { skill: 'rug-check', mint: r.mint, symbol: r.symbol, target: 'analyst' }
          : { skill: 'trench-scan', target: 'analyst' };
      } else startAnalyst(state, 3);
      break;
    }
    // task-1324 AI SCAN MODE: Z toggles, R resumes after a lock. The reply surfaces as a durable toast.
    case 'scan.toggle': state.pendingToast = scanCommand(state, 'toggle', stack); break;
    case 'scan.resume': state.pendingToast = scanCommand(state, 'resume', stack); break;
    // task-1323: flip the token screen's lower-right panel between BUY/SELL FLOW (default) and the tape.
    case 'tape.toggle': if (state.screen === 'token') state.tokenTape = !state.tokenTape; break;
    // ---- task-1330 keyless social layer
    case 'screen.trending': {
      if (state.screen === 'trending') break;
      stack.push(state.screen);
      state.screen = 'trending';
      state.selected = 0;
      break;
    }
    case 'screen.narrative': {
      if (state.screen === 'narrative') break;
      stack.push(state.screen);
      state.screen = 'narrative';
      state.narrative = computeNarrativeView(state, state.narrative?.window ?? '1h');
      break;
    }
    case 'narrative.window': {
      if (state.screen !== 'narrative') break;
      const win = state.narrative?.window === '24h' ? '1h' : '24h';
      state.narrative = computeNarrativeView(state, win);
      break;
    }
    case 'narrative.popup': {
      if (state.screen !== 'narrative') break;
      state.pendingPopup = 'narrative';
      break;
    }
    // task-1355 order plans & standing mandates. Opening the screen lazily constructs the PlanService
    // (hash-chained journal at ~/.dexterm/plans.journal; recovered from disk if present). Arming is NOT
    // handled here — `plans.arm` only raises the hold-to-confirm modal; the interactive loop captures the
    // physical keypress and calls armPlanByKeypress, so nothing scripted/piped/voiced can ever arm.
    case 'screen.plans': {
      if (state.screen === 'plans') break;
      stack.push(state.screen);
      state.screen = 'plans';
      if (!state.plansUi) state.plansUi = newPlansUi();
      state.plansUi.notice = null;
      state.plansUi.arming = null;
      plansService(state); // construct + recover the journal if it has not been yet
      break;
    }
    case 'plans.tab': {
      if (state.screen !== 'plans' || !state.plansUi) break;
      state.plansUi.tab = state.plansUi.tab === 'plans' ? 'mandates' : 'plans';
      state.plansUi.selected = 0;
      state.plansUi.arming = null;
      break;
    }
    case 'plans.arm': {
      if (state.screen !== 'plans' || !state.plansUi) break;
      const svc = state.plansSvc; if (!svc) break;
      const ui = state.plansUi;
      if (ui.tab === 'plans') {
        const row = svc.listPlans()[ui.selected];
        if (!row) { ui.notice = 'no plan selected'; break; }
        if (row.status !== 'proposed') { ui.notice = `plan ${row.id} is ${row.status}, not armable`; break; }
        if (!row.mandateId) { ui.notice = 'plan has no mandate; propose it into an armed mandate first'; break; }
        ui.arming = { kind: 'plan', id: row.id, mandateId: row.mandateId, held: 0 };
      } else {
        const row = svc.listMandates()[ui.selected];
        if (!row) { ui.notice = 'no mandate selected'; break; }
        if (row.status === 'armed') { ui.notice = `mandate ${row.id} is already armed`; break; }
        ui.arming = { kind: 'mandate', id: row.id, held: 0 };
      }
      break;
    }
    case 'plans.cancel': {
      if (state.screen !== 'plans' || !state.plansUi || state.plansUi.tab !== 'plans') break;
      const svc = state.plansSvc; if (!svc) break;
      const row = svc.listPlans()[state.plansUi.selected];
      if (!row) { state.plansUi.notice = 'no plan selected'; break; }
      try { svc.cancelPlan(row.id, 'user-tui'); state.plansUi.notice = `cancelled ${row.id}`; }
      catch (e) { state.plansUi.notice = `cancel refused: ${describeError(e)}`; }
      break;
    }
    case 'plans.revoke': {
      if (state.screen !== 'plans' || !state.plansUi || state.plansUi.tab !== 'mandates') break;
      const svc = state.plansSvc; if (!svc) break;
      const row = svc.listMandates()[state.plansUi.selected];
      if (!row) { state.plansUi.notice = 'no mandate selected'; break; }
      try { svc.revokeMandate(row.id, 'user-tui'); state.plansUi.notice = `revoked ${row.id} (its plans released)`; }
      catch (e) { state.plansUi.notice = `revoke refused: ${describeError(e)}`; }
      break;
    }
    case 'plans.panic': {
      if (state.screen !== 'plans') break;
      const svc = state.plansSvc; if (!svc) break;
      try { svc.panic('panic key (TUI)'); if (state.plansUi) { state.plansUi.notice = '⚠ PANIC — all mandates revoked, plans cancelled'; state.plansUi.arming = null; } }
      catch (e) { if (state.plansUi) state.plansUi.notice = `panic error: ${describeError(e)}`; }
      break;
    }
    case 'plans.popup': {
      if (state.screen !== 'plans') break;
      state.pendingPopup = 'plans';
      break;
    }
    case 'plans.gate': {
      // Tier 4: raise the "less safe" hands-free opt-in modal. Like arm, this ONLY sets a modal flag — the
      // actual accept (keypress-only) / restore happens in the interactive key loop, so a pipe/agent that
      // drives applyAction can never turn the gate off. The engine still refuses any non-keypress gesture.
      if (state.screen !== 'plans') break;
      const svc = state.plansSvc; if (!svc) break;
      if (state.plansUi) { state.plansUi.arming = null; state.plansUi.riskModal = true; state.plansUi.notice = null; }
      break;
    }
    case 'plans.live': {
      // task-1363: raise the FIRE PATH modal (paper ⇄ live devnet fast wallet). Exactly like arm and gate this
      // ONLY sets a modal flag; the switch itself happens in the interactive key loop on a captured physical
      // keypress, and PlanService.useLive refuses any gesture but 'keypress' — so applyAction (a pipe, an
      // agent, the voice router) can never move fills off paper.
      if (state.screen !== 'plans') break;
      const svc = state.plansSvc; if (!svc) break;
      if (state.plansUi) { state.plansUi.arming = null; state.plansUi.riskModal = false; state.plansUi.liveModal = true; state.plansUi.notice = null; }
      break;
    }
    // task-1360 copy trading Tier 1: the FOLLOWED WALLETS screen. Opening it binds the follow store (+ the live
    // tracker when there is one). `follows.add` only opens the typed-address line (the loop captures the keys);
    // `follows.remove` unfollows the selected row. Nothing here trades, proposes or signs.
    case 'screen.follows': {
      if (state.screen === 'follows') break;
      stack.push(state.screen);
      state.screen = 'follows';
      if (!state.copyUi) state.copyUi = newFollowsUi();
      state.copyUi.notice = null;
      state.copyUi.input = null;
      copyService(state);
      break;
    }
    // task-1358 Tier 3: the RULES screen (ctrl+r). Opening it binds the engine built from config.rules. The verbs
    // edit the user's own rules (persisted through the config journal) and manage PROPOSAL cards. `rules.act`
    // only queues the PAPER ticket editor / an analyst question for the loop — nothing here arms, confirms or signs.
    case 'screen.rules': {
      if (state.screen === 'rules') break;
      stack.push(state.screen);
      state.screen = 'rules';
      const ui = rulesUiOf(state);
      ui.notice = null;
      ui.input = null;
      ui.editingId = null;
      break;
    }
    case 'rules.new': { if (state.screen !== 'rules') break; beginRuleInput(rulesUiOf(state), false); break; }
    case 'rules.edit': { if (state.screen !== 'rules') break; beginRuleInput(rulesUiOf(state), true); break; }
    case 'rules.act': {
      if (state.screen !== 'rules') break;
      const ui = rulesUiOf(state);
      if (ui.pane === 'proposals') ui.notice = actOnSelectedProposal(state);
      else beginRuleInput(ui, true);
      break;
    }
    case 'rules.toggle': { if (state.screen !== 'rules') break; const ui = rulesUiOf(state); ui.notice = toggleSelectedRule(state); break; }
    case 'rules.remove': { if (state.screen !== 'rules') break; const ui = rulesUiOf(state); ui.notice = removeSelectedRule(state); break; }
    case 'rules.tab': { if (state.screen !== 'rules') break; const ui = rulesUiOf(state); ui.pane = ui.pane === 'rules' ? 'proposals' : 'rules'; ui.notice = null; break; }
    case 'rules.dismiss': { if (state.screen !== 'rules') break; const ui = rulesUiOf(state); ui.notice = ui.pane === 'proposals' ? dismissSelectedProposal(state) : 'tab to the proposals pane first'; break; }
    case 'follows.add': {
      if (state.screen !== 'follows' || !state.copyUi) break;
      state.copyUi.input = '';
      state.copyUi.notice = null;
      break;
    }
    case 'follows.remove': {
      if (state.screen !== 'follows' || !state.copyUi) break;
      const svc = copyService(state);
      const rows = svc.follows();
      const row = rows[Math.max(0, Math.min(rows.length - 1, state.copyUi.selected))];
      if (!row) { state.copyUi.notice = 'no wallet selected'; break; }
      svc.store.remove(row.addr);
      state.copyUi.notice = `unfollowed ${shortAddr(row.addr)}${row.name ? ` (${row.name})` : ''} · its label is gone too`;
      state.copyUi.selected = Math.max(0, Math.min(svc.follows().length - 1, state.copyUi.selected));
      break;
    }
    // task-1360 Tier 2: the one-key MIRROR TICKET. First `m` previews the mirror of the selected wallet's latest BUY
    // (lag / drift / liquidity / age / leader-sold / leader-intel checks + the size from the user's own cap);
    // `m` again on an ok preview PROPOSES it: an inert order plan the O screen shows, armable only through the
    // plan engine's keypress / Phantom gate into an armed mandate. A refused or pending preview closes on `m`.
    case 'follows.mirror': {
      if (state.screen !== 'follows' || !state.copyUi) break;
      const ui = state.copyUi;
      const svc = copyService(state);
      if (ui.mirror && ui.mirror.result?.ok) {
        const r = ui.mirror.result;
        const psvc = plansService(state);
        try {
          const plan = psvc.propose(r.input, { supply: r.supply, by: 'copy', ref: r.ref });
          ui.mirror = null;
          applyAction(state, 'screen.plans', stack);
          if (state.plansUi) {
            state.plansUi.tab = 'plans';
            state.plansUi.selected = Math.max(0, psvc.listPlans().findIndex((p) => p.id === plan.id));
            state.plansUi.notice = `MIRROR PROPOSAL ${plan.id} (${fmtUsdTui(plan.sizeUsd)}) — inert until you hold a to arm it into an armed mandate`;
          }
        } catch (e) { ui.mirror = null; ui.notice = `mirror refused: ${describeError(e)}`; }
        break;
      }
      if (ui.mirror) { ui.mirror = null; ui.notice = 'mirror preview closed'; break; }
      const rows = svc.follows();
      const f = rows[Math.max(0, Math.min(rows.length - 1, ui.selected))];
      if (!f) { ui.notice = 'no wallet selected'; break; }
      const alert = svc.alerts(200).find((a) => a.wallet === f.addr && a.trade.side === 'buy');
      if (!alert) { ui.notice = `no buy alert from ${f.name ?? shortAddr(f.addr)} yet (alerts begin after the first poll; history is not news)`; break; }
      const now = svc.now();
      const hint = mirrorHint(state, live, alert.trade.mint, now);
      const leaderIntel = leaderIntelFor(live, alert.trade.mint, f.addr);
      const soldSince = leaderSoldSince(alert, svc.trades(f.addr));
      const mine = { alert, market: null as MirrorMarket | null, result: null as MirrorResult | null, pending: true };
      ui.mirror = mine;
      ui.notice = null;
      void svc.mirrorMarket(alert.trade.mint, hint).then((market) => {
        if (ui.mirror !== mine) return; // closed or replaced meanwhile
        mine.market = market;
        mine.result = buildMirror(alert, { now: svc.now(), capUsd: MIRROR_DEFAULT_CAP_USD, market, leaderSoldSince: soldSince, leaderIntel });
        mine.pending = false;
        state.live?.onChange('copy');
      }).catch((e) => { if (ui.mirror === mine) { ui.mirror = null; ui.notice = `mirror preview failed: ${describeError(e)}`; } });
      break;
    }
    // task-1360 Tier 3: AUTO-MIRROR. `A` on a wallet whose auto is ON turns it OFF at once (no gesture needed, always
    // safe: the copy mandate is revoked). Otherwise it drafts the default caps if none exist and ONLY raises the modal;
    // the enable itself is a physical keypress captured in the interactive loop and refused by the service without
    // the engine's less-safe popup — so applyAction (a pipe, an agent, the voice router) can never turn auto on.
    case 'follows.auto': {
      if (state.screen !== 'follows' || !state.copyUi) break;
      const ui = state.copyUi;
      const svc = copyService(state);
      const rows = svc.follows();
      const f = rows[Math.max(0, Math.min(rows.length - 1, ui.selected))];
      if (!f) { ui.notice = 'no wallet selected'; break; }
      const auto = copyAutoService(state);
      const pol = auto.policy(f.addr);
      if (pol?.enabled) { auto.disable(f.addr, 'user (A)'); ui.notice = `auto-mirror OFF for ${f.name ?? shortAddr(f.addr)} · its copy mandate is revoked`; ui.autoModal = null; break; }
      if (!pol) { try { auto.draft(f.addr, {}); } catch (e) { ui.notice = `auto caps: ${describeError(e)}`; break; } }
      ui.mirror = null;
      ui.autoModal = { wallet: f.addr };
      ui.notice = null;
      break;
    }
    case 'social.toggle': if (state.screen === 'token') state.tokenSocial = !state.tokenSocial; break;
    case 'social.kol': {
      if (state.screen === 'kol') break;
      stack.push(state.screen);
      state.screen = 'kol';
      state.selected = 0;
      state.kolSelected = 0;
      state.kolInput = null;
      state.kolNotice = null;
      break;
    }
    // task-1357: X imports the user's own X lists (live + logged in); o focuses the board/panel on one handle.
    case 'kol.importx': {
      if (state.screen !== 'kol') break;
      const x = live?.x ?? null;
      if (!live || !x) { state.kolNotice = 'importing X lists needs live mode and `trenchscope x login` (fixtures are a demo)'; break; }
      const xs = socialOf(state)?.status();
      if (xs && xs.xState === 'logged-out') { state.kolNotice = 'not logged in to X · run `trenchscope x login` first (your own X app, read scopes only)'; break; }
      if (state.kolImporting) { state.kolNotice = 'import already running'; break; }
      state.kolImporting = true; state.kolNotice = null;
      void x.importOwnLists().then((r) => {
        state.kolNotice = r.lists.length ? `imported ${r.lists.length} X list${r.lists.length === 1 ? '' : 's'}: ${r.lists.map((l) => `${l.name} (${l.handles})`).join(', ').slice(0, 120)}` : 'your X account owns no lists (create one on x.com, then X again)';
      }).catch((e) => { state.kolNotice = `X import failed: ${describeError(e)}`.slice(0, 160); }).finally(() => { state.kolImporting = false; socialOf(state)?.invalidate(); live.onChange('kol'); });
      break;
    }
    case 'kol.focus': {
      if (state.screen !== 'kol') break;
      const kol = kolOf(state);
      if (!kol) break;
      const row = kolRows(kol)[Math.max(0, state.selected || 0)];
      if (!row || row.kind !== 'handle') { state.kolNotice = state.socialAuthor ? `@${state.socialAuthor} filter cleared` : 'select a handle to focus on'; state.socialAuthor = null; socialOf(state)?.invalidate(); break; }
      state.socialAuthor = state.socialAuthor === row.handle ? null : row.handle;
      state.kolNotice = state.socialAuthor ? `board + token panel now show @${row.handle} only · o again or f clears` : `@${row.handle} filter cleared`;
      socialOf(state)?.invalidate();
      break;
    }
    case 'social.filter': {
      state.socialAuthor = null;
      if (state.screen === 'token' && !state.tokenSocial) break;
      state.socialFilter = nextSocialFilter(state.socialFilter);
      state.selected = 0;
      break;
    }
    case 'social.spam': state.socialShowSpam = !state.socialShowSpam; break;
    case 'social.sources': if (state.screen === 'trending') state.socialSources = !state.socialSources; break;
    case 'social.narrative': {
      if (state.screen !== 'trending') break;
      const n = socialOf(state)?.narratives().length ?? 0;
      state.socialNarrative = n === 0 ? 0 : ((state.socialNarrative ?? 0) + 1) % (n + 1);
      state.selected = 0;
      break;
    }
    case 'social.summary': {
      // One analyst chat turn over the FIREWALLED window (never the raw posts); rate-limited per board.
      if (state.screen !== 'trending') break;
      const feed = socialOf(state);
      if (!feed) break;
      if (!live) { state.pendingToast = 'the analyst summary needs live mode (fixtures are a demo)'; break; }
      if (state.analyst?.busy) { state.pendingToast = 'analyst busy; Esc to interrupt first'; break; }
      const lim = (state.socialSummaryLimiter ??= new SummaryLimiter());
      const now = Date.now();
      if (!lim.allow('board', now, 300_000)) { state.pendingToast = `board summary rate-limited · next in ${lim.wait('board', now, 300_000)}s`; break; }
      const rows = trendingRows(state).slice(0, 12);
      const posts = rows.flatMap((r) => feed.postsFor(r.mint, { includeInjection: true, includeSpam: true, includeHidden: true }));
      const win = buildSummaryWindow({ mint: null, symbol: null, posts, row: rows[0] ?? null, news: feed.newsItems(6), ages: feed.ages(), now, credibility: (p) => feed.credibilityOfPost(p) });
      const board = rows.map((r, i) => `${i + 1}. ${r.symbol} ${r.mint} vel ${r.velocity === null ? 'new' : r.velocity.toFixed(1) + '×'} cred ${r.credibility} kol ${r.kolCount} src ${r.sources.join(',')}`).join('\n');
      stack.push(state.screen);
      state.screen = 'analyst';
      state.pendingAnalyst = { skill: 'trench-scan', target: 'analyst', question: `Summarise what is trending in the space from this board and window. Board (rank, symbol, mint, local velocity × credibility):\n${board}\n${win.prompt}` };
      break;
    }
    case 'kol.toggle':
    case 'kol.mute':
    case 'kol.remove':
    case 'kol.add': {
      if (state.screen !== 'kol') break;
      const kol = kolOf(state);
      const feed = socialOf(state);
      if (!kol) break;
      const list = kolRows(kol);
      const row = list[Math.max(0, Math.min(list.length - 1, state.selected || 0))] as KolRow | undefined;
      if (!row) { state.kolNotice = 'no lists yet · trenchscope kol create <name>'; break; }
      if (action === 'kol.toggle') { kol.setEnabled(row.list.id, !row.list.enabled); state.kolNotice = `${row.list.name} ${row.list.enabled ? 'disabled' : 'enabled'} for the trending feed`; }
      else if (action === 'kol.mute') {
        if (row.kind !== 'handle') { state.kolNotice = 'select a handle to mute'; break; }
        if (kol.isMuted(row.handle)) { kol.unmute(row.handle); state.kolNotice = `@${row.handle} unmuted`; } else { kol.mute(row.handle); state.kolNotice = `@${row.handle} muted (never stored, never counted)`; }
      } else if (action === 'kol.remove') {
        if (row.kind !== 'handle') { state.kolNotice = 'select a handle to remove'; break; }
        if (row.list.source === 'pack') { state.kolNotice = 'packs are read-only · mute the handle instead (m)'; break; }
        kol.removeHandle(row.list.id, row.handle);
        state.kolNotice = `@${row.handle} removed from ${row.list.name}`;
      } else {
        if (row.list.source === 'pack') { state.kolNotice = 'packs are read-only · add handles to a manual list'; break; }
        state.kolInput = '';
      }
      feed?.invalidate();
      break;
    }
    case 'help.toggle': state.overlay = state.overlay === 'help' ? null : 'help'; break;
    // task-1388 GO-TO prompt: open the one-line "paste a contract address to open any coin" input. The loop
    // captures keys into it (applyKey) and ⏎ opens the token screen; nothing here loads or trades.
    case 'goto.open': state.goto = { input: '', notice: null }; break;
    // task-1401 EXPORT: the loop renders the current view calm and writes the PNG + report (local files only).
    case 'export.view': state.pendingExport = true; break;
    // task-1407 PNL CARD: the loop opens the preview (recorded fills only) and runs the share keys.
    case 'pnl.card': state.pendingPnl = true; break;
    case 'display.priceMode': state.pendingToast = togglePriceMode(state); break; // task-1366: display only, persisted
    case 'theme.next': state.theme = state.custom ? cycleTheme(state.custom, state.theme) : nextTheme(state.theme); break; // task-1358: user themes join the cycle
    // task-1358 workspaces. Every case is a UI action: navigate / re-theme / open read-only popups via the
    // loop (pendingPopups). Nothing here can open a ticket, confirm, arm or sign.
    case 'workspace.list': {
      if (!state.custom) { state.pendingToast = 'workspaces need a config (not loaded on this run)'; break; }
      state.custom.listCursor = Math.max(0, state.custom.workspaces.findIndex((w) => w.name === state.custom!.active));
      state.overlay = state.overlay === 'workspaces' ? null : 'workspaces';
      break;
    }
    case 'workspace.next':
    case 'workspace.prev': {
      if (!state.custom) { state.pendingToast = 'workspaces need a config (not loaded on this run)'; break; }
      const r = switchWorkspace(state, nextWorkspaceName(state.custom, action === 'workspace.next' ? 1 : -1), stack);
      if (r.ok && r.refresh) return 'refresh';
      break;
    }
    case 'workspace.morning':
    case 'workspace.default': {
      if (!state.custom) { state.pendingToast = 'workspaces need a config (not loaded on this run)'; break; }
      const r = switchWorkspace(state, action === 'workspace.morning' ? MORNING_HUD : DEFAULT_WORKSPACE, stack);
      if (r.ok && r.refresh) return 'refresh';
      break;
    }
    case 'workspace.popups': {
      if (!state.custom) { state.pendingToast = 'workspaces need a config (not loaded on this run)'; break; }
      const ws = findWorkspace(state.custom, state.custom.active);
      const popups = ws?.popups ?? [];
      if (!popups.length) { state.pendingToast = `workspace ${state.custom.active} has no popups`; break; }
      state.custom.pendingPopups = [...popups];
      break;
    }
    case 'workspace.save': {
      if (!state.custom) { state.pendingToast = 'workspaces need a config (not loaded on this run)'; break; }
      state.custom.nameInput = '';
      break;
    }
    case 'pause.toggle': state.paused = !state.paused; break;
    case 'filter.edit': if (state.screen === 'screener') openFilterEditor(sc); break;
    // task-1313 part E: one key clears the applied user filter (e.g. after the analyst set one), leaving
    // the preset's baked filter in place. A no-op note when there is nothing to clear.
    case 'filter.clear':
      if (state.screen === 'screener') {
        if (sc.query) { setFilter(sc, ''); sc.notice = 'filter cleared'; state.selected = clampSelection(sc, state.selected); }
        else sc.notice = 'no filter to clear';
      }
      break;
    case 'sort.menu': if (state.screen === 'screener' && !state.simple) openSortMenu(sc); break;
    case 'view.toggle': if (state.screen === 'screener') { state.simple = !state.simple; sc.mode = 'table'; } break;
    case 'preset.next':
    case 'preset.prev': {
      if (state.screen !== 'screener') break;
      if (!stepPreset(sc, action === 'preset.next' ? 1 : -1)) break;
      state.selected = 0;
      if (state.feed) { state.feed.setPreset(sc.preset); return 'refresh'; }
      break;
    }
    case 'refresh': {
      // task-1360: on the follows screen `r` polls the followed wallets now (Helius credits; unavailable keyless).
      if (state.screen === 'follows' && state.copyUi) {
        const svc = copyService(state);
        const st = svc.status();
        if (st.state === 'unavailable' || st.state === 'paused') { state.copyUi.notice = st.why ?? 'tracker unavailable'; break; }
        if (!svc.follows().length) { state.copyUi.notice = 'follow a wallet first (i)'; break; }
        state.copyUi.notice = 'polling…';
        const ui = state.copyUi;
        void svc.tracker.pollOnce().then((as) => { ui.notice = as.length ? `${as.length} new alert${as.length === 1 ? '' : 's'}` : 'polled · nothing new'; }).catch((e) => { ui.notice = `poll failed: ${describeError(e)}`; });
        break;
      }
      return state.feed ? 'refresh' : undefined;
    }
  }
  if (state.screen === 'screener') state.selected = clampSelection(sc, state.selected);
  else if (live && (state.screen === 'newpairs' || state.screen === 'watchlist')) state.selected = Math.max(0, Math.min(rows().length - 1, state.selected || 0));
  else if (state.screen === 'trending' || state.screen === 'kol') { state.selected = Math.max(0, Math.min(rows().length - 1, state.selected || 0)); if (state.screen === 'kol') state.kolSelected = state.selected; }
  // task-1311 (QA M8): remember which coin the cursor is on so the New pairs highlight follows the
  // mint across inserts (the loop remaps the index on every refresh via pinNewpairsSelection).
  if (live && state.screen === 'newpairs') {
    const row = rows()[state.selected || 0] as { mint?: string; symbol?: string; name?: string; holders?: number | null } | undefined;
    state.selectedMint = row?.mint ?? null;
    // task-1359: the row the cursor rests on gets a light wallet-intel scan (SNIPE / BUNDLE), Helius-keyed only
    if (live.mode === 'live' && row?.mint) live.intel?.scanSelectedLater?.({ mint: row.mint, symbol: row.symbol ?? '?', name: row.name ?? '', holderCount: row.holders ?? null });
  }
}

/** The scan's analyst-usage meter for the header / credit meter (task-1324). */
export function scanMeterOf(e: ScanEngine, now: number): { hour: number; hourCap: number; coin: number; coinCap: number; locked: boolean } {
  const u = e.usage(now, e.lock?.mint);
  return { hour: u.hour, hourCap: u.hourCap, coin: u.coin, coinCap: u.coinCap, locked: !!e.lock };
}

/**
 * Run one AI-scan command (task-1324) from the `Z`/`R` keys, `--scan` or `/scan …`. Returns the line
 * to show. `off` stops the scan from any state and interrupts the scan's in-flight analyst turn;
 * `resume` releases the locked coin (it gets its cooldown) and returns from its token screen. Live or
 * replay only — on fixtures there is nothing real to watch.
 */
export function scanCommand(state: AppState, cmd: ScanCommand, stack: ScreenKey[], now: number = Date.now()): string {
  const live = state.live && state.screener.source !== 'fixtures' ? state.live : null;
  if (!live) return 'AI scan needs live data (or --replay FILE)';
  const scan = (state.scan ??= makeScanUi(state.scanConfig));
  const e = scan.engine;
  const sym = (m: string) => `$${cleanText(m, 12)}`;
  const stopTurn = () => { if (scan.session?.busy) scan.session.interrupt(); scan.session = null; };
  const c = cmd === 'toggle' ? (e.on ? 'off' : 'on') : cmd;
  switch (c) {
    case 'status':
      return e.on ? `AI scan ${MODE_LABEL[e.mode]}${e.lock ? ' ' + sym(e.lock.symbol) : ''} · ${live.scanMeterLabel() ?? ''}` : 'AI scan is off · Z or /scan on';
    case 'on':
      if (!e.start(now)) return `AI scan is already on (${MODE_LABEL[e.mode]})`;
      live.scanMeter = scanMeterOf(e, now);
      return `AI scan ON · observe-only · warming up ${e.cfg.warmupS}s · locks at score ≥ ${e.cfg.minScore} · ai ≤ ${e.cfg.maxAiPerHour}/h · Z stop`;
    case 'off': {
      if (!e.on) return 'AI scan is already off';
      stopTurn();
      const was = e.lock?.symbol;
      e.stop(now);
      live.scanMeter = null;
      scan.returnTo = null;
      return `AI scan stopped${was ? ` (released ${sym(was)})` : ''}`;
    }
    case 'resume': {
      if (!e.on) return 'AI scan is off · Z to start it';
      if (e.mode === 'scanning') return 'AI scan is already scanning';
      const locked = e.lock;
      stopTurn();
      e.resume(now);
      live.scanMeter = scanMeterOf(e, now);
      // back from the coin the lock pulled up to where the user was, so the ticker is in view
      if (locked && state.screen === 'token' && live.token?.view.mint === locked.mint) state.screen = stack.pop() ?? scan.returnTo ?? 'screener';
      scan.returnTo = null;
      return `scan resumed · ${locked ? sym(locked.symbol) + ' cooling down ' + Math.round(e.cfg.coinCooldownS / 60) + 'm · ' : ''}watching for the next coin`;
    }
  }
  return '';
}

/**
 * The screen state a scan turn ships (task-1324): the normal context, with the LOCKED coin as the
 * selected coin (whatever the cursor is on) and the action-type allow-list emptied (observe-only).
 */
export function scanScreenState(state: AppState, mint: string, symbol: string): Record<string, unknown> {
  const ss = buildScreenState(state);
  const actions = (ss.actions ?? {}) as { mints?: string[] };
  return { ...ss, selected: { mint, symbol }, scan: true, actions: { ...actions, mints: [...new Set([...(actions.mints ?? []), mint])], types: [...SCAN_ACTION_TYPES] } };
}

/**
 * The scan session's UI-action boundary (task-1324). Structural, not a prompt: it validates against the
 * scan's empty action-type list and NEVER reaches the mutating switch in applyAnalystAction — so a
 * compromised or injected model that emits `open_ticket` (or anything) during a scan changes nothing.
 */
export function applyScanAnalystAction(state: AppState, raw: Record<string, unknown>): AnalystActionResult {
  const allow = buildScreenState(state).actions as { mints: string[]; feeds: string[]; sortKeys: string[] };
  const res = validateAnalystAction(raw, { ...allow, types: SCAN_ACTION_TYPES as never[] });
  return { ok: false, error: res.ok ? 'AI scan mode is observe-only' : res.error };
}

/**
 * The analyst engine for a run (0.1.5): `--analyst-engine`, then DEXTERM_ANALYST_ENGINE, then config
 * `analyst.engine`, then auto (claude when installed, else codex). Only the user picks it; models cannot.
 */
export function analystEngineFor(flag: string | null | undefined, env: NodeJS.ProcessEnv, configured: string | null | undefined, has: (bin: string) => boolean = (b) => analystCliOnPath(b, env)): AnalystEngine {
  const choice = parseEngineChoice(flag) ?? parseEngineChoice(env.DEXTERM_ANALYST_ENGINE) ?? parseEngineChoice(configured) ?? 'auto';
  return resolveEngine(choice, has);
}

/** `/engine [auto|claude|codex]` in the chat box (0.1.5). Null when the input is not this command. */
export function parseEngineCommand(q: string): { show: true } | { choice: EngineChoice } | { error: string } | null {
  const m = /^\/engine(?:\s+(\S+))?\s*$/i.exec(q.trim());
  if (!m) return null;
  if (!m[1]) return { show: true };
  const c = parseEngineChoice(m[1]);
  return c ? { choice: c } : { error: `unknown analyst engine "${m[1].slice(0, 16)}" (use /engine auto|claude|codex)` };
}

/**
 * Apply `/engine`: switch the CLI for NEW conversations this run (cached per-coin chats are dropped so the next
 * `a` starts on the chosen engine; a running turn finishes where it started). Returns the line to show.
 */
export function engineCommand(state: AppState, cmd: NonNullable<ReturnType<typeof parseEngineCommand>>, env: NodeJS.ProcessEnv, has: (bin: string) => boolean = (b) => analystCliOnPath(b, env)): string {
  const installed = (['claude', 'codex'] as const).filter((b) => has(b));
  const list = installed.length ? installed.join(' + ') : 'neither claude nor codex';
  if ('error' in cmd) return cmd.error;
  const cur = state.analystEngine ?? 'claude';
  if ('show' in cmd) return `analyst engine: ${cur} · installed: ${list} · /engine claude|codex|auto switches (config analyst.engine keeps it)`;
  const next = resolveEngine(cmd.choice, has);
  if (cmd.choice !== 'auto' && !has(next)) return `${next} is not installed (installed: ${list}); ${next === 'codex' ? 'npm i -g @openai/codex && codex login' : 'install Claude Code, then run claude once to log in'}`;
  if (next !== cur) {
    for (const [k, sess] of state.analystByMint ?? []) { if (!sess.busy) state.analystByMint!.delete(k); }
    if (state.analyst && !state.analyst.busy && state.analyst.engine !== next) state.analyst = null;
  }
  state.analystEngine = next;
  return `analyst engine: ${next} (your own ${next} CLI and login) for new conversations · set analyst.engine in config.json to keep it`;
}

/**
 * The ONE way a scan-driven analyst conversation is built (task-1324; the loop and the safety tests both
 * use it): the locked coin as the selected coin, `actionTypes: []` (observe-only at the validator, the
 * MCP server and the CLI's --disallowedTools), short reads only, and every UI action the model emits
 * routed to the non-mutating applyScanAnalystAction. `deps` injects a fake spawn in tests.
 */
export function createScanSession(state: AppState, mint: string, symbol: string, hooks: { onBlocked?: (type: string, error: string) => void; onChange?: () => void } = {}, deps: AnalystDeps = {}): AnalystSession {
  const ss = scanScreenState(state, mint, symbol);
  const onAction = (raw: Record<string, unknown>): void => {
    const r = applyScanAnalystAction(state, raw);
    const type = typeof raw.type === 'string' ? raw.type.replace(/[^a-z_]/gi, '').slice(0, 24) : '?';
    hooks.onBlocked?.(type, r.error ?? 'refused');
  };
  return new AnalystSession({ skill: 'token-dossier', mint, symbol, screenState: ss, onAction, actionTypes: SCAN_ACTION_TYPES, scan: true, ...(state.analystEngine === 'codex' ? { engine: 'codex' as const } : {}) }, hooks.onChange ?? (() => {}), deps);
}

/** The outcome of applying one analyst UI action: a human label to show, or a rejection reason. */
export interface AnalystActionResult { ok: boolean; label?: string; error?: string; refresh?: boolean; proposal?: AnalystConfigProposal }

/**
 * A tier-(b) persisted-config change the analyst requested (task-1413). It is NOT applied until the user
 * accepts it with a keypress; then `applyAnalystConfig` writes it through the journaled path as actor
 * `analyst` (so `ctrl+z` undoes it). Holds only the already-validated action + a one-line summary.
 */
export interface AnalystConfigProposal { action: AnalystAction; summary: string }

/**
 * Resolve a mint to an openable seed from what the app already knows (screener view → new pairs →
 * watchlist). Used by the analyst UI-action boundary and the part-F results-table jump; a mint the
 * app has never seen degrades to a stub so navigation never throws. `symbol` is a display fallback.
 */
function seedForMint(state: AppState, live: LiveContext, mint: string, symbol?: string): { mint: string; symbol: string; name: string; launchpad: Launchpad } {
  const sr = screenerView(state.screener).find((r) => r.mint === mint);
  if (sr) return { mint: sr.mint, symbol: sr.symbol, name: sr.name ?? '', launchpad: sr.launchpad ?? 'unknown' };
  const np = live.newpairs.list().find((r) => r.mint === mint);
  if (np) return { mint: np.mint, symbol: np.symbol, name: np.name, launchpad: np.launchpad };
  const w = live.watch.list().find((x) => x.entry.mint === mint);
  if (w) return { mint: w.entry.mint, symbol: w.entry.symbol, name: w.entry.name ?? '', launchpad: w.entry.launchpad ?? 'unknown' };
  return { mint, symbol: symbol || mint.slice(0, 4) + '…', name: '', launchpad: 'unknown' };
}

// task-1388 GO-TO prompt: the longest input we keep (a bare base58 mint is ≤ 44; the longest coin URL we
// accept is well under this), so a huge paste can never balloon the buffer.
const GOTO_INPUT_MAX = 120;

// task-1388's parser now lives in coin-target.ts (shared with the analyst chat, the filter line and --mint).
export { parseMintTarget };

/**
 * task-1401: open a pasted coin target (a CA, or a dexscreener / pump.fun / solscan / birdeye link) on the LIVE token
 * screen — the same read-only path `--screen token --mint` and the analyst's open_token use. A mint opens at once; a
 * dexscreener link is first resolved to its coin (its address is usually the pool) and opens when that answers.
 * `onOpened` runs after the open either way (the chat uses it to ask its question about the coin). Returns a notice
 * when it cannot open (fixtures mode), else null. Never trades, never signs.
 */
export function openCoinTarget(state: AppState, stack: ScreenKey[], t: CoinTarget, onOpened?: (mint: string) => void): string | null {
  const live = state.live && state.screener.source !== 'fixtures' ? state.live : null;
  if (!live) return 'opening a coin by address needs live mode (not --fixtures)';
  const open = (mint: string): void => {
    if (!(state.screen === 'token' && live.token?.view.mint === mint)) live.openToken(seedForMint(state, live, mint)); // already open: keep its loaded view
    if (state.screen !== 'token') { stack.push(state.screen); state.screen = 'token'; }
    onOpened?.(mint);
  };
  if (t.via !== 'dexscreener') { open(t.address); return null; }
  live.notice = 'resolving the dexscreener link…';
  void resolveCoinTarget(t, live.dl).then(({ mint, fromPair }) => {
    if (live.isClosed) return;
    live.notice = fromPair ? `dexscreener pool → coin ${mint.slice(0, 4)}…${mint.slice(-4)}` : null;
    open(mint);
    state.aiFocused = false;
    syncAnalyst(state);
    live.onChange('goto');
  });
  return null;
}

/**
 * task-1401: the analyst chat's ⏎. When the typed text names a coin (a CA or a coin link), open that coin's token
 * view and, if a question came with it ("is <CA> a rug?"), ask it about THAT coin; returns true when it handled
 * the input. Plain questions return false and go to the analyst as before.
 */
export function chatOpenCoin(state: AppState, stack: ScreenKey[], q: string, hooks: { ask: (question: string) => void; say: (msg: string, level: 'info' | 'warn', secs?: number) => void }): boolean {
  const ct = q ? parseCoinTarget(q) : null;
  if (!ct) return false;
  state.aiInput = '';
  const question = isBareOpen(ct.rest) ? '' : ct.rest;
  const notice = openCoinTarget(state, stack, ct, (mint) => {
    syncAnalyst(state);
    if (question) {
      state.aiOpen = true;
      try { hooks.ask(question); } catch (e) { state.screener.notice = `⚠ ask failed: ${describeError(e)}`; }
    } else { state.aiFocused = false; hooks.say(`opened ${mint.slice(0, 4)}…${mint.slice(-4)} from the chat`, 'info', 4); }
  });
  if (notice) hooks.say(notice, 'warn', 5);
  return true;
}

/**
 * task-1388: resolve the GO-TO prompt's input to a coin and open its live token screen (read-only — the same
 * path `--screen token --mint` and the analyst's open_token use: live.openToken(seedForMint(...)), which seeds
 * an unknown-launchpad stub when the mint is not already on a screen). Bad input keeps the prompt open with a
 * one-line notice and changes nothing; a good open closes the prompt and pushes the current screen on the stack.
 * task-1401: a dexscreener link is resolved pool → coin first (openCoinTarget).
 */
function openGotoTarget(state: AppState, stack: ScreenKey[]): void {
  const g = state.goto;
  if (!g) return;
  const raw = g.input.trim();
  if (!raw) { state.goto = null; return; } // ⏎ on an empty prompt just closes it
  const mint = parseMintTarget(raw);
  if (!mint) { g.notice = 'not a contract address or a dexscreener / pump.fun / solscan link'; return; }
  const t = parseCoinTarget(raw) ?? { address: mint, via: 'address' as const, rest: '' };
  const notice = openCoinTarget(state, stack, t);
  if (notice) { g.notice = notice; return; }
  state.goto = null;
}

/**
 * Apply one analyst-requested UI action to the state (task-1313). This is the trust boundary: every
 * action is RE-validated against the current screen's allow-list (never trust the channel), rate-
 * limited, and strictly non-financial. `open_ticket` only opens the PAPER ticket in its editing phase
 * — it never sizes, confirms, signs, or sends. Returns a label on success, else a rejection reason;
 * an injected instruction that names a mint not on screen is rejected here and changes nothing.
 */
export function applyAnalystAction(state: AppState, raw: Record<string, unknown>, stack: ScreenKey[]): AnalystActionResult {
  const live = state.live && state.screener.source !== 'fixtures' ? state.live : null;
  if (!live) return { ok: false, error: 'UI actions need live mode' };
  // Rate limit (defence in depth): a burst of actions cannot flood the UI.
  const now = Date.now();
  const times = (state.analystActionTimes ??= []);
  while (times.length && now - times[0] > ACTION_RATE.windowMs) times.shift();
  if (times.length >= ACTION_RATE.max) return { ok: false, error: 'analyst actions are rate-limited; try again shortly' };

  const sc = state.screener;
  const allow = buildScreenState(state).actions as Parameters<typeof validateAnalystAction>[1];
  const res = validateAnalystAction(raw, allow);
  if (!res.ok) return { ok: false, error: res.error };
  const action = res.action;

  // task-1413 tier (b): a persisted-config action is never applied by the model — return it as a PROPOSAL
  // the user accepts with a keypress (applyAnalystConfig then journals it as actor 'analyst').
  if (ACTION_TIER[action.type] === 'config') {
    times.push(now);
    return { ok: true, label: res.label, proposal: { action, summary: res.label } };
  }

  // Resolve a mint to a row object from what is on screen (allow-list guarantees it was visible).
  const findSeed = (mint: string) => seedForMint(state, live, mint);
  const toScreen = (next: ScreenKey): void => { if (state.screen !== next) { stack.push(state.screen); state.screen = next; } };

  switch (action.type) {
    case 'open_token': {
      live.openToken(findSeed(action.mint));
      toScreen('token');
      break;
    }
    case 'add_to_watchlist': {
      const seed = findSeed(action.mint);
      if (!live.watch.has(action.mint)) live.watch.add(LiveContext.candidate(seed as unknown as ScreenerRow));
      break;
    }
    case 'open_ticket': {
      const seed = findSeed(action.mint);
      // Opens the PAPER ticket in its editing phase only; the confirm gate still needs the user's keys.
      live.openTicket({ mint: seed.mint, symbol: seed.symbol, name: seed.name }, action.side);
      toScreen('ticket');
      break;
    }
    case 'switch_feed': {
      if (!setPreset(sc, action.feed as PresetId)) return { ok: false, error: `feed "${action.feed}" is unavailable` };
      toScreen('screener');
      state.selected = 0;
      times.push(now);
      if (state.feed) { state.feed.setPreset(sc.preset); return { ok: true, label: res.label, refresh: true }; }
      return { ok: true, label: res.label };
    }
    case 'show_in_screener': {
      toScreen('screener');
      if (action.preset && !setPreset(sc, action.preset as PresetId)) return { ok: false, error: `preset "${action.preset}" is unavailable` };
      if (action.preset && state.feed) state.feed.setPreset(sc.preset);
      if (action.filter) { const err = setFilter(sc, action.filter); if (err) return { ok: false, error: `bad filter: ${err.error}` }; }
      if (action.sort) setSort(sc, action.sort.key, action.sort.dir);
      if (action.highlight) { const i = screenerView(sc).findIndex((r) => r.mint === action.highlight); if (i >= 0) state.selected = i; }
      state.selected = clampSelection(sc, state.selected);
      if (action.preset) { times.push(now); return { ok: true, label: res.label, refresh: true }; }
      break;
    }
    // --- task-1413 view-only actions: applied immediately, shown as "analyst did X".
    case 'switch_screen': {
      toScreen(action.screen as ScreenKey);
      state.selected = 0;
      break;
    }
    case 'switch_workspace': {
      const r = switchWorkspace(state, action.name, stack);
      if (!r.ok) return { ok: false, error: r.reason };
      times.push(now);
      return { ok: true, label: res.label, refresh: r.refresh };
    }
    case 'chart_popup': {
      // Open the chart popup (the loop performs the open/close); needs a selected coin to chart.
      state.pendingPopup = action.open ? 'chart' : null;
      break;
    }
    case 'toggle_calm': {
      if (action.on) { if (!isCalm(state.vfx)) { state.vfx.intensity = 'off'; state.vfx.trail.clear(); } }
      else if (isCalm(state.vfx)) { const back: Intensity = 'fever'; state.vfx.intensity = back; state.vfx.baseline = 0.12; }
      break;
    }
    case 'set_scan': {
      scanCommand(state, action.on ? 'on' : 'off', stack);
      break;
    }
    case 'export_view': {
      state.pendingExport = true;
      break;
    }
  }
  times.push(now);
  return { ok: true, label: res.label };
}

/**
 * task-1421: move the REAL terminal to mirror an agent's navigation (follow mode, on the owner's own
 * machine). This is the same VIEW-ONLY navigation the analyst / go-to path uses — open a token, switch
 * screen/feed, set a filter, highlight a row, open the PAPER ticket editor. It never trades, sizes, confirms
 * or signs, and the key loop flips control to the user before any of it runs, so the human always wins the
 * screen. Unlike the analyst boundary it does not re-check the on-screen allow-list: the agent already made
 * the call on its own server and this only reflects where it went. A no-op when live navigation is off.
 */
export function applyFollowNav(state: AppState, nav: SpectatorNav, stack: ScreenKey[]): void {
  const sc = state.screener;
  const live = state.live && state.screener.source !== 'fixtures' ? state.live : null;
  const toScreen = (next: ScreenKey): void => { if (state.screen !== next) { stack.push(state.screen); state.screen = next; } };
  if (nav.mint && (!nav.screen || nav.screen === 'token')) {
    if (!live) return;
    try { live.openToken(seedForMint(state, live, nav.mint)); toScreen('token'); } catch { /* a stale mint never breaks follow */ }
    return;
  }
  if (nav.screen === 'ticket') {
    if (!live || !nav.mint) return;
    try { const seed = seedForMint(state, live, nav.mint); live.openTicket({ mint: seed.mint, symbol: seed.symbol, name: seed.name }, nav.side === 'sell' ? 'sell' : 'buy'); toScreen('ticket'); } catch { /* ignore */ }
    return;
  }
  if (nav.screen === 'watchlist') {
    if (live && nav.mint) { try { if (!live.watch.has(nav.mint)) live.watch.add(LiveContext.candidate(seedForMint(state, live, nav.mint) as unknown as ScreenerRow)); } catch { /* ignore */ } }
    toScreen('watchlist');
    return;
  }
  if (nav.feed || nav.filter || nav.highlight || nav.screen === 'screener') {
    toScreen('screener');
    if (nav.feed) { if (setPreset(sc, nav.feed as PresetId) && state.feed) state.feed.setPreset(sc.preset); }
    if (nav.filter) { try { setFilter(sc, nav.filter); } catch { /* an invalid agent filter is ignored */ } }
    if (nav.highlight) { const i = screenerView(sc).findIndex((r) => r.mint === nav.highlight); if (i >= 0) state.selected = i; }
    state.selected = clampSelection(sc, state.selected);
    return;
  }
  if (nav.screen && isScreenKey(nav.screen)) toScreen(nav.screen as ScreenKey);
}

/**
 * task-1413: apply an accepted tier-(b) config proposal through the journaled path as actor `analyst`
 * (so `ctrl+z` undoes it), creating the parent section when absent (exactly like the `$` / `,` handlers),
 * then reflect it in the live UI where cheap. Throws on a refusal (schema / policy); the caller toasts it.
 * Returns the one-line label for the confirmation toast.
 */
export function applyAnalystConfig(state: AppState, proposal: AnalystConfigProposal): string {
  const ui = state.custom;
  if (!ui) throw new Error('config changes need a loaded config (not available on this run)');
  const change = configChangeForAction(proposal.action);
  if (!change) throw new Error('not a persisted-config action');
  const parent = (ui.config as unknown as Record<string, unknown>)[change.section];
  const op = parent && typeof parent === 'object'
    ? { op: 'add' as const, path: change.path, value: change.value }
    : { op: 'add' as const, path: `/${change.section}`, value: { [change.key]: change.value } };
  // THE GATE (task-1413 r2): re-run the model-actor policy on the exact journal op BEFORE writing. The
  // analyst is not the user, so `DENIED_FOR_MODELS` applies — a config action can never reach a signer /
  // trading / keys / caps / mandates / wallet / alerts / VOICE path, even behind the keypress confirm.
  // CONFIG_ACTION_PATHS is already a closed non-denied allow-list; this is the server-side belt-and-braces.
  const denied = policyCheck([op], 'claude');
  if (denied.length) throw new Error(`refused: ${denied.map((e) => e.msg).join('; ')}`);
  const { config } = applyAndJournal(ui.home, [op], { actor: 'analyst', why: `analyst: ${proposal.summary}`, now: state.now.getTime() });
  ui.config = config;
  // Reflect the change in the running UI where it is cheap and local.
  switch (proposal.action.type) {
    case 'set_theme': { const t = themeByName(ui, proposal.action.name); if (t) state.theme = t; break; }
    case 'set_price_mode': state.priceMode = proposal.action.mode; break;
    case 'set_intensity': state.vfx.intensity = proposal.action.intensity; state.vfx.baseline = proposal.action.intensity === 'fever' ? 0.12 : 0; break;
    default: break;
  }
  return proposal.summary;
}

/**
 * Route one decoded key: the screener's filter editor and sort menu swallow keys while open,
 * everything else goes through the keymap. Exported for tests.
 */
/**
 * task-1358: activate a workspace by name — theme, effects intensity, screener preset/filter/sort, token
 * panel toggles, the start screen (via the same screen.* actions the keys use) and the HUD popups (handed to
 * the loop through `custom.pendingPopups`). Returns what happened; never throws into the key loop.
 */
export function switchWorkspace(state: AppState, name: string, stack: ScreenKey[]): { ok: true; plan: WorkspacePlan; warnings: string[]; refresh: boolean } | { ok: false; reason: string } {
  const ui = state.custom;
  if (!ui) return { ok: false, reason: 'workspaces need a config (not loaded on this run)' };
  const ws = findWorkspace(ui, name);
  if (!ws) {
    const bad = ui.workspaces.find((w) => w.name === name && w.error);
    return { ok: false, reason: bad ? `workspace ${name}: ${bad.error}` : `no workspace "${name}" (${workspaceSlots(ui).join(' · ')})` };
  }
  const plan = planWorkspace(ws, { themeKnown: (n) => themeByName(ui, n) !== null });
  let refresh = false;
  if (plan.theme) { const t = themeFor(plan.theme, ui); if (t) state.theme = t; }
  if (plan.priceMode) state.priceMode = plan.priceMode; // task-1366
  if (plan.intensity) {
    const v = state.vfx;
    v.intensity = plan.intensity;
    v.baseline = plan.intensity === 'fever' ? 0.12 : 0;
    if (plan.intensity === 'off') v.trail.clear();
  }
  const sc = state.screener;
  if (plan.screener.preset) {
    const ok = setPreset(sc, plan.screener.preset as PresetId);
    if (ok && state.feed) { state.feed.setPreset(sc.preset); refresh = true; }
    else if (!ok) plan.warnings.push(`preset ${plan.screener.preset} is unavailable here`);
  }
  if (plan.screener.filter !== null) { const err = setFilter(sc, plan.screener.filter); if (err) plan.warnings.push(`filter: ${err.error}`); }
  if (plan.screener.sort) setSort(sc, plan.screener.sort.key, plan.screener.sort.dir);
  if (plan.token.tape !== undefined) state.tokenTape = plan.token.tape;
  if (plan.token.social !== undefined) state.tokenSocial = plan.token.social;
  if (plan.token.analyst !== undefined) state.aiOpen = plan.token.analyst;
  state.selected = clampSelection(sc, state.selected);
  ui.active = ws.name;
  ui.layoutCache = undefined;
  ui.chord = null;
  if (plan.start) applyAction(state, plan.start, stack);
  else if (plan.startScreen === 'token') { if (!(state.live?.token || state.token)) plan.warnings.push('no token open for the token screen'); else if (state.screen !== 'token') { stack.push(state.screen); state.screen = 'token'; } }
  ui.pendingPopups = plan.popups.length ? [...plan.popups] : null;
  ui.notice = `workspace ${ws.name}${plan.popups.length ? ` · ${plan.popups.length} popup${plan.popups.length > 1 ? 's' : ''}` : ''}${plan.warnings.length ? ` · ${plan.warnings.join('; ')}` : ''}`;
  state.pendingToast = ui.notice;
  return { ok: true, plan, warnings: plan.warnings, refresh };
}

export function applyKey(state: AppState, key: Key, stack: ScreenKey[]): Effect {
  const sc = state.screener;
  // task-1388 GO-TO prompt: while the "open any coin" input is open it captures EVERY key (so a base58 char
  // like v / m / c never toggles voice or calm, and q / 1-4 never quit or navigate out from under a half-typed
  // address). A 44-char paste arrives as 44 printable `char` keys (parseKeys has no bracketed-paste state), so
  // each is appended here and the whole mint lands. esc cancels, ⏎ opens the coin, bad input shows a notice.
  if (state.goto) {
    const g = state.goto;
    if (key.name === 'esc') { state.goto = null; return; }
    if (key.name === 'enter') { openGotoTarget(state, stack); return; }
    if (key.name === 'backspace') { g.input = g.input.slice(0, -1); g.notice = null; return; }
    if (key.ctrl && key.ch === 'u') { g.input = ''; g.notice = null; return; }
    // printable, non-control, non-space (a mint or URL never contains a space): append up to the cap.
    if (key.name === 'char' && key.ch && !key.ctrl && !key.alt && g.input.length < GOTO_INPUT_MAX && !/[\u0000-\u001f\u007f]/.test(key.ch)) { g.input += key.ch; g.notice = null; }
    return;
  }
  // task-1358: typing a workspace name after ctrl+w s captures every key until ⏎ / esc (lowercase letters,
  // digits and dashes only, so a name can never carry a path or a shell fragment).
  const ui = state.custom;
  if (ui && ui.nameInput !== null) {
    if (key.name === 'esc') { ui.nameInput = null; return; }
    if (key.name === 'enter') {
      const name = ui.nameInput;
      ui.nameInput = null;
      try {
        const popups: Array<'chart' | 'bubbles' | 'narrative' | 'plans'> = [];
        const p = state.popups;
        if (p?.chartOpen()) popups.push('chart');
        if (p?.bubblesOpen?.()) popups.push('bubbles');
        if (p?.narrativeOpen?.()) popups.push('narrative');
        if (p?.plansOpen?.()) popups.push('plans');
        const widgets = (p?.openWidgets?.() ?? []).map((w) => w.key); // task-1358 Tier 5: open pack widgets are saved by ref
        const entry = saveWorkspace(ui, {
          name, screen: state.screen, theme: state.theme.name, intensity: state.vfx.intensity, priceMode: state.priceMode ?? 'price',
          screener: { preset: sc.preset, filter: sc.query ?? null, sort: `${sc.sort.key}:${sc.sort.dir}` },
          token: { tape: !!state.tokenTape, social: !!state.tokenSocial, analyst: state.aiOpen !== false },
          popups, widgets,
        });
        ui.active = entry.name;
        ui.layoutCache = undefined;
        state.pendingToast = `saved workspace ${entry.name} → ${entry.path}`;
      } catch (e) { state.pendingToast = `not saved: ${describeError(e)}`; }
      return;
    }
    if (key.name === 'backspace') { ui.nameInput = ui.nameInput.slice(0, -1); return; }
    if (key.name === 'char' && key.ch && !key.ctrl && !key.alt && /^[a-z0-9-]$/.test(key.ch) && ui.nameInput.length < MAX_WORKSPACE_NAME) ui.nameInput += key.ch;
    return;
  }
  // task-1330: typing a handle on the KOL screen captures every key until ⏎ / esc (so q and 1-4 never leak).
  // task-1360: typing a wallet address on the FOLLOWED WALLETS screen captures every key until ⏎ / esc.
  // task-1358 Tier 3: typing a rule on the RULES screen captures every key until ⏎ / esc. Every keystroke re-runs the
  // dry-run ("would match N rows right now"); ⏎ parses + saves (never eval'd), a refusal is the notice.
  if (state.screen === 'rules' && state.rulesUi && state.rulesUi.input !== null) {
    const ui = state.rulesUi;
    const cur: string = state.rulesUi.input;
    if (key.name === 'esc') { ui.input = null; ui.editingId = null; ui.dry = null; return; }
    if (key.name === 'enter') { ui.notice = saveRuleInput(state); return; }
    if (key.name === 'backspace') { ui.input = cur.slice(0, -1); dryRunNow(state); return; }
    if (key.name === 'space' && cur.length < RULE_INPUT_MAX) { ui.input = cur + ' '; dryRunNow(state); return; }
    if (key.name === 'char' && key.ch && !key.ctrl && !key.alt && cur.length < RULE_INPUT_MAX && !/[\u0000-\u001f\u007f]/.test(key.ch)) { ui.input = cur + key.ch; dryRunNow(state); }
    return;
  }
  if (state.screen === 'follows' && state.copyUi && state.copyUi.input !== null) {
    const ui = state.copyUi;
    const cur: string = state.copyUi.input;
    if (key.name === 'esc') { ui.input = null; return; }
    if (key.name === 'enter') {
      const typed = cur.trim();
      ui.input = null;
      const [addr, ...rest] = typed.split(/\s+/);
      if (!addr) return;
      if (!isWalletAddress(addr)) { ui.notice = 'not a base58 wallet address'; return; }
      const svc = copyService(state);
      const r = svc.store.add(addr, rest.length ? rest.join(' ') : undefined);
      ui.notice = r.ok ? `following ${shortAddr(r.follow.addr)}${r.follow.name ? ` as "${r.follow.name}"` : ''} · first poll backfills history (no alerts for the past)` : `not followed: ${r.reason}`;
      if (r.ok) { ui.selected = Math.max(0, svc.follows().length - 1); if (svc.status().state !== 'unavailable') void svc.tracker.pollOnce().catch(() => {}); }
      return;
    }
    if (key.name === 'backspace') { ui.input = cur.slice(0, -1); return; }
    if (key.name === 'space' && cur.length < FOLLOW_INPUT_MAX) { ui.input = cur + ' '; return; }
    if (key.name === 'char' && key.ch && !key.ctrl && !key.alt && cur.length < FOLLOW_INPUT_MAX) ui.input = cur + key.ch;
    return;
  }
  // task-1399: on the follows screen (not typing, no modal), enter opens/closes the selected wallet's DETAIL view.
  if (state.screen === 'follows' && state.copyUi && state.copyUi.input === null && !state.copyUi.mirror && !state.copyUi.autoModal && key.name === 'enter') {
    const ui = state.copyUi;
    if (ui.detail) { ui.detail = null; return; }
    const svc = state.copy;
    const rows = svc?.follows() ?? [];
    const f = rows[Math.max(0, Math.min(rows.length - 1, ui.selected))];
    if (f) ui.detail = { wallet: f.addr, scroll: 0 };
    else ui.notice = 'follow a wallet first (i)';
    return;
  }
  if (state.screen === 'kol' && state.kolInput !== null && state.kolInput !== undefined) {
    const kol = kolOf(state);
    if (key.name === 'esc') { state.kolInput = null; return; }
    if (key.name === 'enter') {
      const typed = state.kolInput;
      state.kolInput = null;
      if (!kol) return;
      const list = kolRows(kol)[Math.max(0, state.selected || 0)]?.list;
      if (!list) return;
      const r = kol.addHandle(list.id, typed);
      state.kolNotice = r.ok ? `@${normalizeHandle(typed)} added to ${list.name}` : `not added: ${r.reason}`;
      socialOf(state)?.invalidate();
      return;
    }
    if (key.name === 'backspace') { state.kolInput = state.kolInput.slice(0, -1); return; }
    if (key.name === 'char' && key.ch && !key.ctrl && !key.alt && state.kolInput.length < 16) state.kolInput += key.ch;
    return;
  }
  if (state.screen === 'screener' && sc.mode === 'filter') {
    // task-1324: `/scan on|off|stop|resume|status` typed on the screener's `/` line is a command, not a
    // filter (no filter field is called scan); the editor closes and the previous filter stays applied.
    if (key.name === 'enter') {
      const cmd = parseScanCommand(sc.edit.text);
      if (cmd) {
        sc.mode = 'table';
        sc.edit.text = sc.query ?? '';
        sc.edit.error = null;
        state.pendingToast = typeof cmd === 'object' ? cmd.error : scanCommand(state, cmd, stack);
        return;
      }
      // task-1401: a pasted CA or coin link on the `/` line opens that coin (no filter field is a 32-44 char base58
      // run); the editor closes and the previous filter stays applied.
      const ct = parseCoinTarget(sc.edit.text);
      if (ct && isBareOpen(ct.rest)) {
        sc.mode = 'table';
        sc.edit.text = sc.query ?? '';
        sc.edit.error = null;
        const notice = openCoinTarget(state, stack, ct);
        if (notice) state.pendingToast = notice;
        return;
      }
      // task-1328: `/wallet …` is a command too (the loop performs it: link opens a browser, probe opens a ticket).
      const wc = parseWalletCommand(sc.edit.text);
      if (wc) {
        sc.mode = 'table';
        sc.edit.text = sc.query ?? '';
        sc.edit.error = null;
        if (typeof wc === 'object') state.pendingToast = wc.error; else state.pendingWallet = wc;
        return;
      }
    }
    const r = filterEditorKey(sc, key);
    if (r === 'applied') state.selected = clampSelection(sc, state.selected);
    return;
  }
  if (state.screen === 'screener' && sc.mode === 'sort') {
    sortMenuKey(sc, key);
    return;
  }
  // task-1358 chords: `ctrl+w` arms a 1.5 s prefix; the next key completes it ("ctrl+w s"), a digit picks a
  // workspace slot, anything else drops the prefix and is NOT replayed (a half-typed chord never fires a verb).
  const id = keyId(key);
  if (ui && ui.chord) {
    const prefix = ui.chord;
    const fresh = state.now.getTime() - ui.chordAt <= CHORD_TTL_MS;
    ui.chord = null;
    if (fresh) {
      if (key.name === 'char' && key.ch && /^[1-9]$/.test(key.ch) && prefix === 'ctrl+w') {
        const slot = workspaceSlots(ui)[Number(key.ch) - 1];
        if (!slot) { state.pendingToast = `no workspace in slot ${key.ch}`; return; }
        const r = switchWorkspace(state, slot, stack);
        if (!r.ok) state.pendingToast = r.reason;
        return r.ok && r.refresh ? 'refresh' : undefined;
      }
      const chordAction = keymapOf(state).resolveId(`${prefix} ${id}`, state.screen);
      if (chordAction !== undefined) return applyAction(state, chordAction, stack);
      state.pendingToast = `${prefix} ${id}: no such chord (w list · n/N · s save · m morning · o popups · d default · 1-9)`;
      return;
    }
    // stale prefix: fall through and treat this key normally
  }
  if (ui && keymapOf(state).isPrefix(id)) { ui.chord = id; ui.chordAt = state.now.getTime(); return; }
  const action = keymapOf(state).resolve(key, state.screen);
  return action === undefined ? undefined : applyAction(state, action, stack);
}

/** The keymap in force: the defaults layered with config.keymap when a config was loaded (task-1358 Tier 2). */
export function keymapOf(state: AppState): Keymap<AppAction> { return state.custom?.keymap ?? DEFAULT_KEYMAP; }

/** Fixture-only demo event keys (VISUAL-V2 demo): n new pair · u pump · d dump · x rug. */
export const DEMO_KEYS: Record<string, DemoEvent> = { n: 'newpair', u: 'pump', d: 'dump', x: 'rug' };

/** The slice of `process` the terminal guard hooks; injectable so tests can drive it with an emitter. */
export type GuardProcess = Pick<NodeJS.Process, 'on' | 'off' | 'exit'>;

export interface TerminalGuard {
  /** Cooked mode, cursor shown, main screen back. Idempotent; never throws. */
  restore(): void;
  /** True once restore() has run. */
  readonly restored: boolean;
  /** Hook exit / uncaughtException / unhandledRejection / SIGTERM / SIGHUP so the terminal is always restored. */
  install(): void;
  uninstall(): void;
}

/**
 * Copy text to the OS clipboard via the platform tool (task-1311, QA B5): pbcopy (macOS), clip
 * (Windows), xclip/xsel (Linux). Best-effort and silent — if no tool is present the on-screen CA
 * line is the fallback. The value is a public mint; it is never written to any log.
 */
export function copyToClipboard(text: string): void {
  const cmds = process.platform === 'darwin' ? [['pbcopy']]
    : process.platform === 'win32' ? [['clip']]
      : [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input'], ['wl-copy']];
  const run = (i: number): void => {
    if (i >= cmds.length) return;
    try {
      const p = spawn(cmds[i][0], cmds[i].slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => run(i + 1)); // tool missing: try the next one
      p.stdin.on('error', () => {});
      p.stdin.end(text);
    } catch { run(i + 1); }
  };
  run(0);
}

/**
 * Open a URL in the OS browser (task-1315): `open` (macOS) or `xdg-open` (Linux).
 * No command shell fallback. The URL is re-parsed here and only http/https is
 * ever launched, so a `file://`, `javascript:` or any other scheme can never reach the shell. The URL
 * is passed as a single argument (no shell interpolation). Returns false (no launch) when it is unsafe.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const u = parseHttpUrl(url); // http/https only, length-capped
  if (!u || (platform !== 'darwin' && platform !== 'linux')) return false;
  const href = u.toString();
  const cmd = platform === 'darwin' ? ['open', href] : ['xdg-open', href];
  try {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore' });
    p.on('error', () => {}); // tool missing: silent, the on-screen URL is the fallback
    p.unref?.();
    return true;
  } catch { return false; }
}

/** One-line description of a thrown value for the status area and stderr. */
export function describeError(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = e && typeof e.name === 'string' ? e.name : 'Error';
  const msg = e && typeof e.message === 'string' ? e.message : String(err);
  return `${name}: ${msg}`.replace(/\s+/g, ' ').trim();
}

/**
 * Terminal restore that runs exactly once however the interactive loop ends: a clean quit, an
 * unexpected exception, a rejected promise, SIGTERM/SIGHUP, or any other exit. Without this an
 * uncaught error left the terminal in the alternate screen with raw input (task-1279 verification).
 * `onFatal` runs after the restore for the error paths; the guard then exits with code 1.
 */
export function terminalGuard(io: Pick<Io, 'stdout' | 'stdin' | 'stderr'>, onFatal: (err: unknown) => void = () => {}, proc: GuardProcess = process, hooks: { /** task-1326: bytes to write before leaving the alternate screen (kitty image cleanup). */ beforeLeave?: () => string; /** task-1443: cleanup to run on SIGTERM/SIGHUP before the exit (never throws out). */ onSignal?: () => void } = {}): TerminalGuard {
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { if (io.stdin.isTTY) io.stdin.setRawMode(false); } catch { /* stdin already gone */ }
    try { io.stdin.pause(); } catch { /* ignore */ }
    try { const pre = hooks.beforeLeave?.() ?? ''; if (pre) io.stdout.write(pre); } catch { /* ignore */ }
    try { io.stdout.write(LEAVE_SCREEN); } catch { /* stdout already gone */ }
  };
  const fatal = (err: unknown) => {
    restore();
    try { io.stderr.write(`dexterm: fatal: ${describeError(err)}\n`); } catch { /* ignore */ }
    try { onFatal(err); } catch { /* ignore */ }
    proc.exit(1);
  };
  const onExit = () => restore();
  const onSignal = (sig: 'SIGTERM' | 'SIGHUP') => {
    restore();
    try { hooks.onSignal?.(); } catch { /* cleanup is best-effort; the exit still happens */ }
    proc.exit(sig === 'SIGTERM' ? 143 : 129);
  };
  const onTerm = () => onSignal('SIGTERM');
  const onHup = () => onSignal('SIGHUP');
  let installed = false;
  return {
    get restored() { return restored; },
    restore,
    install() {
      if (installed) return;
      installed = true;
      proc.on('exit', onExit);
      proc.on('uncaughtException', fatal);
      proc.on('unhandledRejection', fatal);
      proc.on('SIGTERM', onTerm);
      proc.on('SIGHUP', onHup);
    },
    uninstall() {
      if (!installed) return;
      installed = false;
      proc.off('exit', onExit);
      proc.off('uncaughtException', fatal);
      proc.off('unhandledRejection', fatal);
      proc.off('SIGTERM', onTerm);
      proc.off('SIGHUP', onHup);
    },
  };
}

/** Frame cap for the loop: --fps wins, else the intensity's cap (calm keeps the 30 Hz timer but only draws on data ticks). */
export function fpsFor(args: Pick<CliArgs, 'fps'>, intensity: Intensity): number {
  return Math.max(1, Math.min(MAX_FPS, args.fps ?? FPS_BY_INTENSITY[intensity]));
}

/** DEC 2026 synchronized output around blink / shake frames so the terminal never shows a half-drawn transition. */
const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';

export function interactive(state: AppState, io: Io, depth: ColorDepth, args: CliArgs, proc: GuardProcess = process): Promise<number> {
  // 0.1.5: the analyst engine for new conversations (the user's own claude or codex CLI; never a shipped key).
  state.analystEngine ??= analystEngineFor(args.analystEngine, io.env, state.custom?.config.analyst?.engine);
  const out = io.stdout;
  const inp = io.stdin;
  const rnd = mulberry32(99);
  const stack: ScreenKey[] = [];
  const flusher = new Flusher({ depth });
  const feed = state.feed ?? null;
  const live = state.live ?? null;
  // task-1323: hover prefetch — the screener row the cursor rests on gets its candles warmed (idle
  // priority on the GeckoTerminal bucket, debounced, soft-capped) so ⏎ paints the chart instantly.
  const prefetcher = live && live.mode === 'live' ? new CandlePrefetcher(live.dl, { interval: () => live.token?.view.interval ?? args.interval }) : null;
  const hoverPrefetch = (): void => {
    if (!prefetcher) return;
    if (state.screen !== 'screener') { prefetcher.hover(null); return; }
    const r = screenerView(state.screener)[state.selected || 0];
    prefetcher.hover(r && !r.skeleton && !r.fixture && r.mint ? { mint: r.mint, pair: r.pair } : null);
  };
  const v = state.vfx;
  // task-1326: the coin-image service (live/replay) and, once the terminal answered the capability query, the
  // pixel layer that paints real images over the recorded slots after every flush (null = block art in cells).
  const images = state.images ?? null;
  let layer: ImageLayer | null = null;
  let imageCaps: ImageCaps | null = null;
  const applyCaps = (caps: ImageCaps): void => {
    imageCaps = caps;
    state.imageProtocol = caps.protocol;
    layer = caps.protocol !== 'blocks'
      ? new ImageLayer(caps.protocol, { cellPx: caps.cellPx, bg: () => state.theme.bg, encodePng: (img) => { const b = encodePng(img); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); } })
      : null;
  };
  // The interactive clock runs live; it keeps whatever zone stateOpts chose.
  state.now = new Date();
  state.sound = { on: soundOn(args.sound, io.env) }; // task-1340: cues only after a settled result; muted unless asked
  const fps = fpsFor(args, v.intensity);
  const tickEvery = Math.max(1, Math.round(fps / 2)); // data tick at 2 Hz regardless of the frame cap
  const size = (): [number, number] => [out.columns || 160, out.rows || 45];

  // ---- boot (first launch: full glitch boot; later launches: 1 s). Calm skips it.
  // First launch gets the welcome card (task-1305); read it before the boot records this launch.
  const firstLaunch = readBootState(io.env).boots === 0;
  const plan = args.noBoot || isCalm(v) ? null : bootPlan(readBootState(io.env));
  let bootFrames = plan ? Math.max(1, Math.round(plan.seconds * fps)) : 0;
  let bootHold = plan ? Math.round(plan.holdSeconds * fps) : 0;
  // the screen the run starts on (screener, or the token screen when --mint named one); the boot returns to it
  const homeScreen: ScreenKey = state.screen === 'boot' ? 'screener' : state.screen;
  if (plan) { state.screen = 'boot'; state.boot = { t: 0 }; }
  else if (firstLaunch) { state.overlay = 'welcome'; recordBoot(io.env); } // no boot screen: still welcome once, and count the launch
  // task-1323: DEXTERM_TRACE=<file> records first-frame / first-rows milestones for the boot measurements.
  const trace = bootTrace(io.env);
  const traceFirstPaint = (): void => {
    if (!trace) return;
    trace.mark('first-frame', state.screen);
    if (state.screen !== 'screener') return;
    const view = screenerView(state.screener);
    if (view.length === 0) return;
    if (view[0].skeleton) { trace.mark('first-skeleton', `${view.length}`); return; }
    trace.mark('first-rows', `${view.length} preset=${state.screener.preset}${feed?.fromSnapshot ? ' cached' : ''}`);
    if (feed?.fellBack) trace.mark('fallback', `${feed.fellBack.from}->${feed.preset} ${feed.fellBack.reason}`);
    if (feed && feed.firstFreshAt !== null && !feed.fromSnapshot) trace.mark('first-fresh-rows', `${view.length} preset=${state.screener.preset}`);
  };
  let lastIntensity: Intensity = v.intensity === 'off' ? 'fever' : v.intensity;
  let moodHoldUntil = 0;
  let prevCanvas: Canvas | null = null;
  let transition: { from: Canvas | null; to: Canvas; i: number; n: number } | null = null;
  // A render failure must not kill the loop either: say so on the home row once, retry on the next tick.
  let renderBroken = false;

  const frameCanvas = (): Canvas => {
    const [w, h] = size();
    if (transition) {
      if (transition.to.w !== w || transition.to.h !== h) transition = null;
      else {
        const tt = transition.i / (transition.n - 1);
        const c = blinkFrame(transition.from, transition.to, Math.min(1, tt), v);
        transition.i += 1;
        if (transition.i >= transition.n) transition = null;
        return c;
      }
    }
    const c = renderFrame(state, w, h);
    prevCanvas = c;
    return c;
  };
  const draw = () => {
    if (v.stutter > 0 && !transition) return; // datamosh stutter: hold the last frame
    const sync = transition !== null || v.shake > 0;
    try {
      const c = frameCanvas();
      const r = flusher.flush(c, (s) => out.write(sync ? SYNC_ON + s + SYNC_OFF : s));
      // task-1326: real pixels over the frame's image slots (kitty keeps placements across text redraws; iTerm2 /
      // sixel re-emit on the rows the flusher rewrote). Nothing here waits on a fetch.
      if (layer) { const seq = layer.sync({ slots: c.images, changed: r.full ? 'all' : r.changed, screen: state.screen }); if (seq) out.write(seq); }
      renderBroken = false;
      if (trace) traceFirstPaint();
    } catch (e) {
      flusher.invalidate();
      if (!renderBroken) { renderBroken = true; try { out.write(`\x1b[H\x1b[2K dexterm: render error: ${describeError(e)}`); } catch { /* ignore */ } }
    }
  };
  /** Screen changed: blink from the last drawn frame to a fresh render of the target (skipped in calm mode). */
  const startTransition = () => {
    blendActivity(v, activityFor(state), v.frame >= moodHoldUntil);
    if (isCalm(v) || !prevCanvas) return;
    const [w, h] = size();
    transition = { from: prevCanvas, to: renderFrame(state, w, h), i: 0, n: blinkFrames(fps) };
  };
  const endBoot = () => {
    if (state.screen !== 'boot') return;
    bootFrames = 0; bootHold = 0;
    state.boot = { t: 1 };
    recordBoot(io.env);
    state.screen = homeScreen;
    startTransition();
    if (firstLaunch) state.overlay = 'welcome'; // one-time welcome once the boot clears to the home screen
  };
  const say = (text: string, level: 'up' | 'down' | 'warn' | 'ai' | 'info', secs = 3) => { v.toast = { text, level, until: v.frame + Math.round(secs * fps) }; };
  // task-1358: a config / theme / keymap problem is said once at start (the defaults are in use); `trenchscope doctor` repeats it.
  { const probs = [...(state.custom?.configErrors ?? []), ...(state.custom?.themeErrors ?? [])]; if (probs.length) say(`⚠ ${probs[0]}${probs.length > 1 ? ` (+${probs.length - 1} more)` : ''}`, 'warn', 8); }
  // ---- task-1340 bubble-map popup view model (text only; built from the live scan for the coin on the bubble screen)
  const bubbleVMNow = (): BubbleVM | null => {
    const ui = state.intelUi;
    if (!ui || !live) return null;
    const img = live.token?.view.mint === ui.mint ? popupImagePath(state, live.token.view.image) : null;
    return popupBubbleVM(live.intel.entry(ui.mint), { mint: ui.mint, symbol: ui.symbol, name: ui.name }, ui.selected, img);
  };
  const syncBubblesPopup = (): void => { if (state.popups?.bubblesOpen?.()) { const vm = bubbleVMNow(); if (vm) state.popups.syncBubbles?.(vm); } };

  // task-1356: build the narrative-board popup VM from the current board (deterministic; no model).
  const narrativeVMNow = (): NarrativeBoardVM | null => {
    const board: NarrativeBoard | null = state.narrative?.board ?? null;
    if (!board) return null;
    let rank = 0;
    const rows = board.narratives.filter((n) => n.tokens > 0).map((n) => {
      if (n.score != null) rank++;
      const r = n.runners[0] ?? null;
      return {
        narrative: n.narrative, rank: n.score == null ? null : rank, score: n.score, tokens: n.tokens,
        new_1h: n.new_1h, new_24h: n.new_24h, vol: board.window === '24h' ? n.vol_h24 : n.vol_h1,
        pace: n.pace_mature ?? n.pace, med_chg: board.window === '24h' ? n.med_chg_h24 : n.med_chg_h1,
        runner: r ? { symbol: r.symbol, chg: r.chg_h1, mcap: r.mcap } : null,
      };
    });
    return {
      title: 'narrative board', window: board.window, tokens_total: board.meta.tokens_total,
      unclassified_pct: Math.round(100 * board.meta.unclassified_share), copycats: board.meta.copycat_tokens,
      data_age: board.meta.data_age_label, lexicon_version: board.meta.lexicon_version, rows,
      limits: `model output: none (deterministic lexicon v${board.meta.lexicon_version}). Name-based: X/Telegram-only narratives are missed; ${board.meta.copycat_tokens} copycat symbols.`,
    };
  };
  const syncNarrativePopup = (): void => { if (state.popups?.narrativeOpen?.()) { const vm = narrativeVMNow(); if (vm) state.popups.syncNarrative?.(vm); } };

  // task-1355: build the order-plans popup VM from the live PlanService. The popup is a READ-ONLY HUD of the
  // signer trust domain: it is handed view rows only — never a key, a signature, a mandate secret or any arm
  // capability. The untrusted coin `symbol` is firewalled with terminalSafe before it crosses to the page.
  // `mode` is the PAPER/LIVE banner (paper is default; live is devnet-only until the maintainers say otherwise) and
  // `journal` is the append-only chain's integrity line from verifyJournal() — the audit log is the truth.
  const plansVMNow = (): PlansVM | null => {
    const svc = state.plansSvc;
    if (!svc) return null;
    const v = svc.verifyJournal();
    const journal = v.ok ? `journal verified · ${v.count} events` : `journal BROKEN at seq ${v.atSeq} (${v.why})`;
    const paper = svc.executor.kind === 'paper'; // fail-safe: anything not provably paper shows the LIVE banner
    const handsFree = svc.riskStatus().active;
    return {
      title: 'order plans & mandates',
      mode: paper ? 'PAPER' : 'LIVE (devnet)',
      handsFree,
      now: Date.now(),
      plans: svc.listPlans().map((p) => ({
        id: p.id, symbol: terminalSafe(p.symbol), side: p.side, sizeUsd: p.sizeUsd, status: p.status,
        tier: p.tier, mandateId: p.mandateId, paused: p.paused, readBack: terminalSafe(p.readBack),
        levels: ((plan) => (plan ? planLevels(plan, priceModeOf(state)) : undefined))(svc.engine.plan(p.id)), // task-1366: mc + price
      })),
      mandates: svc.listMandates().map((m) => ({
        id: m.id, status: m.status, wallet: m.wallet, totalUsd: m.totalUsd, perTradeUsd: m.perTradeUsd,
        perCoinUsd: m.perCoinUsd, maxTier: m.maxTier, reservedUsd: m.reservedUsd, spentUsd: m.spentUsd,
        realizedUsd: m.realizedUsd, lossUsd: m.lossUsd, expiresAt: m.expiresAt,
      })),
      journal,
      updatedAt: Date.now(),
    };
  };
  // ---- task-1359 token-detail + feeds popups (read-only HUDs)
  const tokenVMNow = (): TokenDetailVM | null => {
    const tv = live?.token?.view;
    if (!tv) return null;
    const c = launchIntelCells(live?.intel, tv.mint, 'M bubble map');
    return tokenDetailVMFromView(tv, { snipers: c.snipers.text, bundle: c.bundle.text, snipersLevel: c.snipers.level, bundleLevel: c.bundle.level });
  };
  const syncTokenPopup = (): void => { if (state.popups?.tokenOpen?.()) { const vm = tokenVMNow(); if (vm) state.popups.syncToken?.(vm); } };
  const syncFeedsPopup = (): void => { if (state.popups?.feedsOpen?.()) { const m = feedsPopupModel(state); state.popups.syncFeeds?.(m.vm, m.mints); } };
  const syncPlansPopup = (): void => { if (state.popups?.plansOpen?.()) { const vm = plansVMNow(); if (vm) state.popups.syncPlans?.(vm); } };
  // task-1363: feed the plan engine the prices the terminal already has (screener rows, watchlist rows, the
  // open token) so armed plans actually fire — paper or, after the L keypress, live through the signer. The
  // engine re-confirms every trigger and the signer re-checks every fill; this only supplies ticks. Never from
  // fixture data (a demo must not fill a real plan), and only once the service exists (a journal on disk or
  // the O screen opened).
  const plansTick = (): void => {
    const svc = state.plansSvc;
    if (!svc || state.screener.source === 'fixtures') return;
    const now = Date.now();
    const seen = new Set<string>();
    const push = (mint: string | null | undefined, price: number | null | undefined, mcap: number | null | undefined): void => {
      if (!mint || !(typeof price === 'number' && price > 0) || !(typeof mcap === 'number' && mcap > 0) || seen.has(mint)) return;
      seen.add(mint);
      try { svc.tick({ mint, priceUsd: price, supply: mcap / price, ts: now, source: 'board' }); }
      catch (e) { if (state.plansUi) state.plansUi.notice = `plan engine: ${describeError(e)}`; }
    };
    for (const r of screenerView(state.screener)) if (!r.fixture && !r.skeleton) push(r.mint, r.price, r.mcap);
    if (live) for (const w of live.watch.list()) if (w.row) push(w.entry.mint, w.row.price, w.row.mcap);
    if (live?.token?.view) push(live.token.view.mint, live.token.view.price, live.token.view.mcap);
    if (seen.size) syncPlansPopup();
  };
  // An armed plan recovered from the journal must be monitored from launch, not from the first visit to O.
  if (!state.plansSvc && existsSync(defaultPlansJournalPath(io.env))) { try { plansService(state, io.env); } catch (e) { state.screener.notice = `⚠ plans journal: ${describeError(e)}`; } }

  return new Promise<number>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let lastRefresh = 0;
    let done = false;
    // task-1421: the MCP follow session (set below when `--spectate-mcp` is on). Declared here so the quit /
    // terminal-guard teardown closures can stop it.
    let followSession: McpFollowSession | null = null;
    // task-1443: `--agent-paper <mandate-id>` (with --spectate-mcp) lets that agent PAPER-trade inside the mandate.
    const agentPaper = args.spectateMcp && args.agentPaper ? new AgentPaperSwitch({ env: io.env, mandateId: args.agentPaper, db: args.db ?? defaultDbPath(io.env) }) : null;
    // Idle economy (task-1303, retuned for task-1319 AC3): between events the ambient rain redraws at
    // IDLE_FPS instead of the full frame cap, cutting idle CPU. A keypress opens a KEY_WAKE_S full-rate
    // window (`wakeUntil`) so input and transitions stay smooth; data landings paint at once on their own
    // (draw() below) without a window. `idleEvery` is the frame stride at the idle rate. (The earlier gate also demanded
    // `activity < 0.15` before throttling, which live data never satisfies — activityFor clamps at 0.15 —
    // so the default look never actually idled: 30 fps and ~22% CPU with nobody typing.)
    const idleEvery = Math.max(1, Math.round(fps / IDLE_FPS));
    let wakeUntil = 0;
    const wake = (secs: number) => { wakeUntil = Math.max(wakeUntil, v.frame + Math.round(secs * fps)); };
    // ---- task-1340 trade moments. The ONLY producer is live.onSettled, which the ticket binding calls once per
    // settled outcome (paper fill, confirmed live fill, refusal, failure) — never for a quote, a plan or an unknown send.
    // The ticket itself is shielded (screens/ticket.ts), so the effects play around it, never over it.
    let tradesThisRun = 0;
    const ticketOrigin = (): Rect => { const [tw, th] = size(); const bw = Math.min(breakpoint(tw) === 'compact' ? tw - 2 : 78, tw - 2); return { x: 1, y: 4, w: bw, h: Math.max(1, th - 5) }; };
    if (live) live.onSettled = (tx: SettledTx) => {
      try {
        const first = tx.status === 'confirmed' && tradesThisRun === 0;
        const m = fireMoment(v, tx, { origin: ticketOrigin(), fps, milestone: first ? 'first' : null });
        if (tx.status === 'confirmed') tradesThisRun += 1;
        playMoment(m ? m.kind : momentKindFor(tx), m ? m.milestone : null, state.sound); // sound follows the result, calm or not
        wake(5);
      } catch (e) { say(`trade moment failed: ${describeError(e)}`, 'warn'); }
    };
    const teardown = () => { done = true; prefetcher?.close(); if (timer) clearInterval(timer); void followSession?.stop(); agentPaper?.stop(); state.analyst?.cancel(); if (state.analystByMint) for (const s of state.analystByMint.values()) s.cancel(); state.popups?.shutdown(); voice?.disable(); images?.close(); live?.close(); feed?.close(); };
    // task-1443: SIGTERM/SIGHUP (a closed terminal window) runs the same teardown as a fatal error, so the agent-paper
    // rendezvous, the spectator rendezvous and the --record file never outlive the terminal that owns them.
    const guard = terminalGuard(io, teardown, proc, { beforeLeave: () => layer?.teardown() ?? '', onSignal: teardown });
    let lastTokenRefresh = 0;
    let lastWatchRefresh = 0;
    let lastPositionsRefresh = 0;
    let lastTicketQuote = 0;
    // task-1361: first maintenance RECORDER_FIRST_TICK_MS after launch (after the first paint, inside even a short
    // run), then every RECORDER_TICK_MS. The old `lastTick = launch` rule needed a 60 s process: no real run had one.
    const recorderSchedule = new MaintenanceSchedule(Date.now());
    const NARRATIVE_REFRESH_MS = 5000; // task-1356: recompute the narrative board at most every 5 s while it is on screen
    const refresh = () => {
      if (!feed) return;
      // task-1330: `r` on the trending board re-runs the paced venue cycle + RSS (the limiter paces; no retries).
      if (live && state.screen === 'trending') { void live.social.refreshVenues(); void live.social.refreshNews(); }
      // live screens refresh their own bindings; the screener feed refreshes on its own screen and for the watch/token seeds
      if (live && state.screen === 'token' && live.token) {
        lastTokenRefresh = Date.now();
        void live.token.load();
        // task-1367: a scan whose launch window did not land (Helius paused / call failed) is retried by `r`
        const tv = live.token.view;
        if (launchRetryable(live.intel, tv.mint)) void live.intel.scan({ mint: tv.mint, symbol: tv.symbol, name: tv.name, holderCount: tv.holders }, { force: true }).catch(() => {});
      }
      if (live && state.screen === 'watchlist') { lastWatchRefresh = Date.now(); void live.watch.refresh(); }
      if (live && state.screen === 'newpairs') { void live.newpairs.refresh(true); }
      if (live && state.screen === 'bubbles' && state.intelUi) { const ui = state.intelUi; void live.intel.scan({ mint: ui.mint, symbol: ui.symbol, name: ui.name }, { force: true }).catch(() => {}); }
      if (feed.refreshing) return;
      lastRefresh = Date.now();
      feed.refresh()
        .then(() => { if (done) return; syncFeed(state); live?.setSolPrice(state.sol?.price); plansTick(); if (state.screen === 'screener') state.selected = clampSelection(state.screener, state.selected); })
        .catch((e: unknown) => { if (!done) state.screener.notice = `⚠ refresh failed: ${describeError(e)}`; })
        .then(() => { if (!done) draw(); });
    };
    // Live bindings redraw as soon as something lands (one frame per macrotask at most).
    let drawPending = false;
    let lastFastDraw = 0;
    // task-1399: a followed wallet's buy/sell also PUSHES through the alerts engine (desktop / Telegram / Discord)
    // when the user enabled a push channel. Forward-declared; the real impl is set once the Notifier exists below.
    // Read-only, like a rule alert — nothing here trades, arms or signs.
    let pushCopyAlert: (a: CopyAlert) => void = () => {};
    if (live) {
      // task-1360: poll the followed wallets for the whole run (live only; replay never spends credits) and toast
      // every new buy/sell a followed wallet made. Information only: no path from an alert to a trade exists here.
      if (live.mode === 'live') live.copy.start();
      live.onChange = (reason: string) => {
        if (reason === 'copy') {
          const as = live.copy.takeAlerts();
          if (as.length && !done) {
            const a = as[as.length - 1];
            const who = a.name ?? shortAddr(a.wallet);
            say(`${who} ${a.trade.side === 'buy' ? 'BOUGHT' : 'SOLD'} ${shortAddr(a.trade.mint)}${a.trade.usd !== null ? ` ≈ $${a.trade.usd.toFixed(0)}` : ''}${a.lagMs !== null ? ` · lag ${Math.round(a.lagMs / 1000)}s` : ''}${as.length > 1 ? ` (+${as.length - 1} more · U)` : ' (U)'}`, a.trade.side === 'buy' ? 'up' : 'down', 6);
            for (const ca of as) pushCopyAlert(ca); // task-1399: push each one out through the alerts engine too
          }
        }
        if (done || drawPending) return;
        // Idle economy (task-1312): a fast-lane price push never forces a draw in calm mode (the 2 Hz
        // data tick picks up the latest price). In normal/fever it redraws, but no faster than
        // FASTPRICE_MIN_MS so a burst of ticks cannot spin the render loop — the renderer always reads
        // the newest price at draw time, so capping the cadence drops no data (SPEC §3.9.3).
        if (reason === 'fastprice') {
          if (isCalm(v) || Date.now() - lastFastDraw < FASTPRICE_MIN_MS) return;
        }
        // task-1340: a send in flight shows the neutral scanning sweep (never a verdict); it clears when the ticket settles.
        if (reason === 'ticket') {
          const ph = live.ticket?.ticket.phase;
          if (ph === 'filling' || ph === 'signing') { if (v.moment?.kind !== 'inflight') fireInflight(v, live.ticket?.ticket.symbol ?? '', ticketOrigin()); }
          else clearInflight(v);
        }
        drawPending = true;
        setImmediate(() => { drawPending = false; if (!done) { if (reason === 'fastprice') lastFastDraw = Date.now(); pinNewpairsSelection(state); draw(); live.newpairs.markDrawn(); if (state.popups?.chartOpen() && live.token) state.popups.syncChart(live.token.view); if (reason === 'intel' || reason === 'token') { syncBubblesPopup(); syncTokenPopup(); } if (reason.startsWith('social')) syncFeedsPopup(); syncWidgets(); } });
      };
    }
    // The screener pool fills progressively (task-1303): copy the rows in and paint as each batch lands.
    if (feed) {
      // Enrich what the user can see first: the current filtered/sorted view's leading rows (the
      // table never shows more than ~a screenful). The paced background fill handles the long tail.
      feed.visibleMints = () => {
        const [, h] = size();
        const n = Math.max(30, h - 6); // roughly one screenful of rows (kept small so the fast path is cheap)
        return screenerView(state.screener).slice(0, n).map((r) => (r as { mint?: string }).mint).filter((m): m is string => !!m);
      };
      feed.onProgress = () => {
        if (done || drawPending || state.screen !== 'screener') return;
        drawPending = true;
        setImmediate(() => {
          drawPending = false;
          if (done) return;
          syncFeed(state);
          state.selected = clampSelection(state.screener, state.selected);
          draw();
          hoverPrefetch();
        });
      };
    }
    const startPushIfNeeded = () => {
      // Start the PumpPortal push on the new-pairs screen, and on the screener when a live-backed
      // preset ("New"/"All") wants the fresh mints folded into its pool (task-1303).
      const wantsStream = state.screen === 'newpairs'
        || (state.screen === 'screener' && !!presetSpec(state.screener.preset)?.live);
      if (live && wantsStream && !live.feedStarted && !state.paused) {
        void live.startFeed(1).catch((e: unknown) => { live.notice = `⚠ stream: ${describeError(e)}`; });
        void live.newpairs.refresh(true);
      }
      // The on-chain fast lane prices the open token + watchlist and must run in every preset and on
      // the token screen — not only the live-stream presets (task-1319: --preset trending and --mint
      // got no LIVE price because startFeed only fired for trench/new/all). Start it as soon as there
      // is something to price, independent of the push stream's gate.
      if (live && !live.fastLaneRunning && !state.paused && (live.token || live.watch.list().length > 0)) {
        live.startFastLane();
      }
    };
    // Every conversation this run spawned (per-token + the analyst tab), so quit can stop them all.
    const cancelAllAnalysts = () => {
      state.analyst?.cancel();
      if (state.analystByMint) for (const s of state.analystByMint.values()) s.cancel();
    };
    const scheduleDraw = () => {
      if (done || drawPending) return;
      drawPending = true;
      setImmediate(() => { drawPending = false; if (!done) draw(); });
    };
    // task-1326: an image landing (decoded, or found missing) repaints at most once per macrotask.
    if (images) images.onChange = () => scheduleDraw();
    // task-1421: `--spectate-mcp` → follow an agent driving over MCP. The rendezvous lets a `trenchscope mcp`
    // server the external client spawned emit here; we tail it, move the terminal for navigation calls, and
    // the owner's controls (ctrl+p pause/resume · ctrl+k stop · any key = take over) are handled in onInput.
    // A read-only, loopback, token-gated stream opens too (`trenchscope spectate --info`). Off (and zero-cost)
    // unless the flag is set; nothing it folds can arm, sign, confirm, send or raise a cap.
    if (args.spectateMcp) {
      followSession = new McpFollowSession({
        env: io.env,
        stream: true,
        onNav: (nav) => {
          const before = state.screen;
          try { applyFollowNav(state, nav, stack); } catch { /* a stale mint never breaks follow */ }
          if (state.screen !== before) { try { startTransition(); } catch { transition = null; } }
          scheduleDraw();
        },
        onStatus: (line) => { say(line, 'ai', 4); scheduleDraw(); },
        onEvent: () => scheduleDraw(),
        onControl: agentPaper ? (st) => agentPaper!.control(st) : undefined,
        snapshot: () => followSnapshot(state),
      });
      void followSession.start();
      say('following agents over MCP · ctrl+p pause · ctrl+k stop · any key takes over', 'ai', 6);
      if (agentPaper) say(agentPaper.start(), 'ai', 8);
    }
    // Launch a real Claude analyst session when a key asked for one (applyAction cannot spawn). A
    // `question` means start it as a chat turn, not a paid structured skill run (task-1311, QA B3).
    const beginAnalyst = () => {
      const p = state.pendingAnalyst;
      if (!p) return;
      state.pendingAnalyst = null;
      // Replace only this screen's own conversation; other tokens' chats stay warm in the map (QA M5).
      const key = analystKey(state) ?? (p.target === 'analyst' ? ANALYST_TAB_KEY : p.mint ?? ANALYST_TAB_KEY);
      state.analystByMint?.get(key)?.cancel();
      state.ai = null; // a live session drives its own render, not the demo animation
      state.aiInput = ''; // a fresh session starts with an empty chat input
      state.aiScroll = 0; state.aiRevealAll = false; // a new answer decrypts in from the top (QA M12)
      // A UI action the analyst requests arrives here (task-1313): apply it at the trust boundary,
      // note "analyst did X" for the UI, and redraw. Rejected actions (injection / rate limit) are silent.
      const onAction = (raw: Record<string, unknown>): void => {
        const before = state.screen;
        const r = applyAnalystAction(state, raw, stack);
        if (!r.ok || !r.label) return;
        // task-1413 tier (b): a persisted-config request is a PROPOSAL — show it and wait for the user's key.
        if (r.proposal) {
          // The proposal expires with its 8s toast (task-1413 defect c): a 'y' typed after it fades never
          // persists a stale change. `now` is the frame clock so it stays deterministic under replay.
          state.analystConfigProposal = { ...r.proposal, expiresAt: state.now.getTime() + 8000 };
          say(`analyst suggests: ${r.proposal.summary} — press y to accept, any other key to dismiss`, 'ai', 8);
          scheduleDraw();
          return;
        }
        const log = (state.analystActions ??= []);
        log.push(r.label);
        if (log.length > 6) log.shift();
        say(`analyst ${r.label}`, 'ai', 4);
        if (r.refresh) refresh();
        if (state.screen !== before) { state.aiFocused = false; syncAnalyst(state); try { startTransition(); } catch { transition = null; } }
        scheduleDraw();
      };
      try {
        // task-1315: cache a settled larp-check verdict per mint so the screener column / token badge
        // can show it (only ever for a mint we actually computed). Wrap the redraw hook to harvest it.
        // task-1359: each settled assessment is also written once to the recorder (pack larp-check) for the LARP eval.
        let recordedAssessment: object | null = null;
        const onChange = () => {
          if (p.mint && session.status === 'done' && session.productAssessment) {
            const at = Date.now();
            state.larpByMint?.set(p.mint, { ...session.productAssessment, at });
            if (recordedAssessment !== session.productAssessment) {
              recordedAssessment = session.productAssessment;
              recordLarpVerdict(state.live?.recorder?.database, { mint: p.mint, verdict: session.productAssessment.verdict, confidence: session.productAssessment.confidence, t: at, skill: p.skill, model: p.model ?? null });
            }
          }
          maybeSpeakVoiceAnswer(session); // task-1282: speak a voice-initiated answer when it settles
          scheduleDraw();
        };
        const session = new AnalystSession({ skill: p.skill, mint: p.mint, symbol: p.symbol, screenState: buildScreenState(state), model: p.model, onAction, ...(state.analystEngine === 'codex' ? { engine: 'codex' as const } : {}) }, onChange);
        if (p.question) session.ask(p.question, buildScreenState(state)); else session.start();
        state.analyst = session;
        state.analystByMint?.set(key, session);
      } catch (e) {
        state.screener.notice = `⚠ analyst failed to start: ${describeError(e)}`;
      }
    };
    // Send a chat question (task-1311): a follow-up on the warm session if one exists, else start a
    // new session with this question as its first turn — always a chat turn, never a paid dossier.
    const sendChat = (q: string) => {
      state.aiScroll = 0; state.aiRevealAll = false; // the reply decrypts in from the top (QA M12)
      if (state.analyst) { state.analyst.ask(q, buildScreenState(state)); return; }
      const tv = live?.token?.view;
      const target: ScreenKey = state.screen === 'token' ? 'token' : 'analyst';
      state.pendingAnalyst = state.screen === 'token' && live && tv?.mint
        ? { skill: 'token-dossier', mint: tv.mint, symbol: tv.symbol, target, question: q }
        : { skill: 'trench-scan', target, question: q };
    };
    // ---- task-1324 AI SCAN MODE. The scan tick reads only data already in memory / the SQLite cache
    // (observe.ts); the engine decides; these helpers perform the decision. Never draws on its own: the
    // 2 Hz data tick paints whatever changed, so calm mode stays at its idle cost.
    const scanSay = (m: string, lvl: 'ai' | 'warn' | 'info' = 'ai', secs = 5) => { say(m, lvl, secs); };
    /** A scan-session UI action: always refused (observe-only) and surfaced so the user sees it. */
    const onScanBlocked = (type: string, error: string): void => {
      const scan = state.scan;
      if (scan) { scan.blocked.push(type); if (scan.blocked.length > 6) scan.blocked.shift(); }
      scanSay(`AI scan blocked analyst action "${type}" · observe-only (${error})`, 'warn', 5);
      scheduleDraw();
    };
    const startScanSession = (mint: string, symbol: string, question: string, display: string): void => {
      const scan = state.scan;
      if (!scan) return;
      state.analystByMint?.get(mint)?.cancel();
      const session = createScanSession(state, mint, symbol, { onBlocked: onScanBlocked, onChange: () => scheduleDraw() });
      session.ask(question, scanScreenState(state, mint, symbol), display);
      state.analystByMint?.set(mint, session);
      scan.session = session;
    };
    const scanAct = (d: ScanDecision): void => {
      const scan = state.scan;
      if (!scan || !live) return;
      if (d.kind === 'lock') {
        // PULL IT UP: open the coin's token screen (the same loader ⏎ uses) and start the analyst on it.
        const before = state.screen;
        if (state.screen !== 'token') { stack.push(state.screen); scan.returnTo = state.screen; }
        live.openToken(seedForMint(state, live, d.mint, d.symbol));
        state.screen = 'token';
        state.aiOpen = true;
        state.aiFocused = false;
        state.aiScroll = 0; state.aiRevealAll = false;
        startScanSession(d.mint, d.symbol, d.question, `AI scan · score ${d.score} · ${d.hits.map((h) => h.id).join(' + ')} → short read`);
        syncAnalyst(state);
        live.syncFastSet();
        scanSay(`AI scan LOCKED $${cleanText(d.symbol, 12)} · score ${d.score} · ${d.hits.map((h) => h.id).join(' + ')}`, 'ai', 5);
        if (state.screen !== before) { try { startTransition(); } catch { transition = null; } }
        return;
      }
      const sess = scan.session;
      if (!sess) return;
      sess.ask(d.question, scanScreenState(state, d.mint, d.symbol), `AI scan refresh · ${d.moved.join(' · ')}`);
      if (state.analyst === sess) { state.aiScroll = 0; state.aiRevealAll = false; }
      scanSay(`AI scan: $${cleanText(d.symbol, 12)} moved (${d.moved.join(', ')}) · refreshing the read`, 'ai', 4);
    };
    const scanTick = (): void => {
      const scan = state.scan;
      if (!scan || !scan.engine.on || !live) return;
      const now = Date.now();
      if (now - scan.lastTickAt < SCAN_TICK_MS) return;
      scan.lastTickAt = now;
      const e = scan.engine;
      const src = { rows: state.screener.rows, token: live.token?.view ?? null, larp: state.larpByMint };
      const sig = observeSig(src);
      if (sig !== scan.sig || now - scan.lastComputeAt >= SCAN_RECOMPUTE_MS) {
        scan.sig = sig;
        scan.lastComputeAt = now;
        e.observe(buildObservations({ ...src, cacheGet: (ns, k) => live.dl.cache.get(ns, k), livePrice: (m) => live.livePrice(m), now, minLiqUsd: e.cfg.minLiqUsd }), now);
      }
      // Never yank the user out of something they are doing: a lock waits while a ticket, an overlay,
      // the filter/sort editor or a half-typed question has the keys.
      const holdLock = state.screen === 'ticket' || !!state.overlay || state.screener.mode !== 'table' || (state.aiFocused === true && !!state.aiInput);
      const d = e.tick(now, { analystBusy: scan.session?.busy ?? false, holdLock });
      live.scanMeter = scanMeterOf(e, now);
      if (d) scanAct(d);
    };
    /** Esc on the locked coin: cancel the analysis (the analyst's own interrupt), keep the coin, no hop. */
    const cancelScanAnalysis = (): void => {
      const scan = state.scan;
      if (!scan) return;
      if (scan.session?.busy) scan.session.interrupt();
      scan.engine.cancelAnalysis(Date.now());
      if (live) live.scanMeter = scanMeterOf(scan.engine, Date.now());
      scanSay(`analysis cancelled · scan holds $${cleanText(scan.engine.lock?.symbol ?? '', 12)} · R resume scan · Z stop`, 'ai', 5);
    };
    // task-1290: lazily create the popup-window controller for this run. onNote surfaces the browser-fallback
    // reason / errors as a toast. Live mode only (the chart needs the live candle series). Closing a popup
    // never touches the terminal; quit tears the controller down.
    // task-1325: the chart popup has its OWN timeframe. Its 1–6 requests are answered from the open token's
    // in-memory candle cache (TokenLive.cachedSeries: 1m/1h bases + local derivations) — no fetch, and the
    // terminal's timeframe is untouched. Position = the task-1323 PositionSource (paper ledger today); fills
    // come from the same ledger. All of it is local and read-only.
    const ensurePopups = (): TokenPopups => {
      if (!state.popups) {
        state.popups = new TokenPopups({
          theme: state.theme, env: io.env,
          onNote: (m) => { say(m, 'info', 5); scheduleDraw(); },
          dock: 'auto', // task-1325: dock the window beside this terminal (macOS + native shell)
          // task-1326: the popup header's coin image is served from the terminal's local cache, never hot-linked.
          ...(images ? { imageProvider: (key: string) => images.pngFor(key) } : {}),
          // task-1340: a click in the bubble popup selects the same holder in the terminal (validated address only)
          onHolderSelected: (address: string) => {
            const ui = state.intelUi;
            const vm = ui && live ? live.intel.entry(ui.mint)?.bubbles ?? null : null;
            if (!ui || !vm) return;
            const i = vm.holders.findIndex((h) => h.owner === address);
            if (i >= 0) { ui.selected = i; if (!done) { draw(); syncBubblesPopup(); } }
          },
          // task-1359: ⏎ on a feeds item opens that coin here (the mint was resolved terminal-side from OUR list).
          onFeedSelected: (mint: string) => {
            if (!live) { say('the feeds popup opens coins in live mode only', 'info', 4); return; }
            live.openToken(seedForMint(state, live, mint));
            if (state.screen !== 'token') { stack.push(state.screen); state.screen = 'token'; }
            if (!done) draw();
          },
          // task-1358 Tier 5: a pack widget page connected → push its first view models (public topics only).
          onWidgetReady: (key: string) => { if (!done) syncWidgetPopups(state, widgetDeps, { force: true, only: key }); },
          // task-1355: the plans popup may ask to cancel a plan. We re-validate the id against the live plan
          // list (defence in depth; the server + popup already shape-checked it) and only then cancel — the
          // popup can NEVER arm, raise a cap, widen/arm a mandate, resume a paused plan, or sign.
          onPlanCancel: (id: string) => {
            const svc = state.plansSvc; if (!svc) return;
            if (!svc.listPlans().some((p) => p.id === id)) { say(`plans popup: unknown plan ${id} (ignored)`, 'warn', 5); return; }
            try { svc.cancelPlan(id, 'user-popup'); if (state.plansUi) state.plansUi.notice = `cancelled ${id} (from popup)`; say(`cancelled ${id}`, 'info', 4); }
            catch (e) { say(`plans popup cancel refused: ${describeError(e)}`, 'warn', 5); }
            if (!done) { draw(); syncPlansPopup(); }
          },
          source: live ? {
            series: (mint, iv) => (live.token && live.token.mint === mint ? live.token.cachedSeries(iv) : null),
            livePrice: (mint) => (live.badgeFor(mint) === 'LIVE' ? live.livePrice(mint) : null),
            feed: (mint) => (live.badgeFor(mint) === 'LIVE' ? 'LIVE' : 'POLL'),
            positions: live.positionSource,
            fills: (mint) => [...(live.livePositions?.records(200, mint) ?? []), ...live.wallet.trades(500).filter((t) => t.mint === mint)],
            solUsd: () => state.sol?.price ?? live.positions.solUsd(),
            imagePath: (v) => popupImagePath(state, v.image),
            priceMode: () => priceModeOf(state), // task-1366
          } : null,
        });
      }
      return state.popups as TokenPopups;
    };
    const togglePopupChart = async (): Promise<void> => {
      const tv = live?.token?.view;
      if (!tv) { say('open a token first, then C for its chart popup', 'info'); return; }
      const popups = ensurePopups();
      if (popups.chartOpen()) { popups.closeChart(); say('chart popup closed', 'info'); draw(); return; }
      try {
        const { native, reason, dock } = await popups.openChart(tv);
        say(native ? `chart popup opened · $${tv.symbol}${dock ? ` · ${dock}` : ''}` : `chart opened in browser (${reason})`, 'info', 5);
      } catch (e) {
        say(`chart popup failed: ${describeError(e)}`, 'warn', 5);
      }
      if (!done) draw();
    };
    const togglePopupBubbles = async (): Promise<void> => {
      const vm = bubbleVMNow();
      if (!vm) { say('open a token, then M for its bubble map', 'info'); return; }
      const popups = ensurePopups();
      if (popups.bubblesOpen()) { popups.closeBubbles(); say('bubble map popup closed', 'info'); draw(); return; }
      try {
        const { native, reason } = await popups.openBubbles(vm);
        say(native ? `bubble map popup opened · $${vm.symbol}` : `bubble map opened in browser (${reason})`, 'info', 5);
      } catch (e) {
        say(`bubble map popup failed: ${describeError(e)}`, 'warn', 5);
      }
      if (!done) draw();
    };

    const togglePopupToken = async (): Promise<void> => {
      const vm = tokenVMNow();
      if (!vm) { say('open a token first, then I for its token popup', 'info'); return; }
      const popups = ensurePopups();
      if (popups.tokenOpen?.()) { popups.closeToken?.(); say('token popup closed', 'info'); draw(); return; }
      try {
        const res = await popups.openToken?.(vm);
        say(res?.native ? `token popup opened · $${vm.symbol}` : `token detail opened in browser (${res?.reason ?? 'fallback'})`, 'info', 5);
      } catch (e) {
        say(`token popup failed: ${describeError(e)}`, 'warn', 5);
      }
      if (!done) draw();
    };
    const togglePopupFeeds = async (): Promise<void> => {
      const popups = ensurePopups();
      if (popups.feedsOpen?.()) { popups.closeFeeds?.(); say('feeds popup closed', 'info'); draw(); return; }
      try {
        const m = feedsPopupModel(state);
        const res = await popups.openFeeds?.(m.vm, m.mints);
        say(res?.native ? `feeds popup opened · ${m.vm.items.length} items` : `feeds opened in browser (${res?.reason ?? 'fallback'})`, 'info', 5);
      } catch (e) {
        say(`feeds popup failed: ${describeError(e)}`, 'warn', 5);
      }
      if (!done) draw();
    };

    const togglePopupNarrative = async (): Promise<void> => {
      if (!narrativeVMNow()) { say('open the narrative board (N) first', 'info'); return; }
      const popups = ensurePopups();
      if (popups.narrativeOpen?.()) { popups.closeNarrative?.(); say('narrative popup closed', 'info'); draw(); return; }
      try {
        const vm = narrativeVMNow();
        const res = vm ? await popups.openNarrative?.(vm) : null;
        say(res?.native ? 'narrative popup opened' : `narrative board opened in browser (${res?.reason ?? 'fallback'})`, 'info', 5);
      } catch (e) {
        say(`narrative popup failed: ${describeError(e)}`, 'warn', 5);
      }
      if (!done) draw();
    };

    // task-1358 Tier 5: pack widgets. The page is read from the ENABLED, re-hashed pack at open time (widgets.ts);
    // the popup host serves it under a hash-only CSP (r2: no nonce) + the widget SDK; the sync path pushes only the topics the
    // widget declared, built from public view models. A workspace lists a widget; only `trenchscope pack widget …
    // --enable` makes it openable.
    const widgetDeps = { token: tokenVMNow, narrative: narrativeVMNow };
    const openWidgetPopup = async (ref: string): Promise<void> => {
      const r = widgetPage(state.custom, ref);
      if (!r.ok) { say(`widget: ${r.reason}`, 'warn', 6); return; }
      const popups = ensurePopups();
      if (popups.widgetOpen?.(r.page.key)) { popups.closeWidget?.(r.page.key); say(`widget ${r.page.key} closed`, 'info'); draw(); return; }
      try {
        const res = await popups.openWidget?.(r.page);
        say(res?.native ? `widget ${r.page.key} opened · topics ${r.page.topics.join(', ')}` : `widget ${r.page.key} opened in browser (${res?.reason ?? 'fallback'})`, 'info', 5);
      } catch (e) { say(`widget ${r.page.key} failed: ${describeError(e)}`, 'warn', 5); }
      if (!done) draw();
    };
    const syncWidgets = (): void => { if (state.popups?.openWidgets?.().length) syncWidgetPopups(state, widgetDeps); };

    const togglePopupPlans = async (): Promise<void> => {
      if (!plansVMNow()) { say('open order plans (O) first', 'info'); return; }
      const popups = ensurePopups();
      if (popups.plansOpen?.()) { popups.closePlans?.(); say('plans popup closed', 'info'); draw(); return; }
      try {
        const vm = plansVMNow();
        const res = vm ? await popups.openPlans?.(vm) : null;
        say(res?.native ? 'plans popup opened · read-only, cancel only' : `order plans opened in browser (${res?.reason ?? 'fallback'})`, 'info', 5);
      } catch (e) {
        say(`plans popup failed: ${describeError(e)}`, 'warn', 5);
      }
      if (!done) draw();
    };

    // task-1358: open a workspace's popups (the same read-only windows the keys open). The narrative board
    // and the plans service are prepared first so their popups have a view model; chart/bubbles need an open
    // token and are skipped with a note otherwise. Popups that have no workspace binding yet say so.
    const openWorkspacePopups = async (specs: readonly import('@dexterm/custom').PopupSpec[]): Promise<void> => {
      if (!live) { say('workspace popups need live or replay mode', 'info', 4); return; }
      const p = state.popups;
      const plan = planPopupOpens(specs, {
        chartOpen: p?.chartOpen() ?? false, bubblesOpen: p?.bubblesOpen?.() ?? false, narrativeOpen: p?.narrativeOpen?.() ?? false, plansOpen: p?.plansOpen?.() ?? false,
        tokenOpen: p?.tokenOpen?.() ?? false, feedsOpen: p?.feedsOpen?.() ?? false,
        hasToken: !!live.token?.view,
        widgetEnabled: (ref) => widgetEnabled(state.custom, ref),
        widgetOpen: (ref) => { const r = widgetPage(state.custom, ref); return r.ok ? p?.widgetOpen?.(r.page.key) ?? false : false; },
      });
      for (const kind of plan.open) {
        if (done) return;
        try {
          if (kind === 'narrative') { if (!state.narrative) state.narrative = computeNarrativeView(state, '24h'); await togglePopupNarrative(); }
          else if (kind === 'plans') { plansService(state, io.env); if (!state.plansUi) state.plansUi = newPlansUi(); await togglePopupPlans(); }
          else if (kind === 'chart') await togglePopupChart();
          else if (kind === 'token') await togglePopupToken();
          else if (kind === 'feeds') await togglePopupFeeds();
          else if (kind === 'bubbles') { if (bubbleVMNow()) await togglePopupBubbles(); }
        } catch (e) { say(`${kind} popup failed: ${describeError(e)}`, 'warn', 5); }
      }
      for (const ref of plan.widgets) { if (done) return; await openWidgetPopup(ref); }
      if (plan.skipped.length) say(`skipped ${plan.skipped.map((s) => `${s.kind} (${s.why})`).join(', ')}`, 'info', 5);
      scheduleDraw();
    };
    // task-1398: PUSH delivery while the TUI is open. Built only when the user enabled a push channel
    // (desktop/telegram/discord); otherwise null and there is no behaviour change. The in-app toast is
    // still state.pendingToast, so the Notifier's toast sink is a no-op here (routing may still include it,
    // harmlessly). Delivery is fire-and-forget: a slow channel never blocks the frame.
    const alertNotifier = state.custom && hasPushChannel(state.custom.config.alerts)
      ? buildNotifier(state.custom.home, state.custom.config.alerts, { toastSink: () => {} })
      : null;
    // task-1399: now the Notifier exists, a followed wallet's buy/sell can be pushed. Fire-and-forget; a slow
    // channel never blocks the loop; routing's `levels` filter lets the user scope (a buy is `up`, a sell `down`).
    if (alertNotifier) pushCopyAlert = (ca: CopyAlert): void => { void alertNotifier.deliver(copyAlertToDelivery(ca)).catch(() => { /* never crash the loop on a channel failure */ }); };
    const drainDeliveries = (): void => {
      const ui = state.rulesUi;
      if (!ui || !ui.pendingDeliveries.length) return;
      const ds = ui.pendingDeliveries;
      ui.pendingDeliveries = [];
      if (!alertNotifier) return;
      for (const d of ds) void alertNotifier.deliver(d).catch(() => { /* never crash the loop on a channel failure */ });
    };
    // task-1358 Tier 3: perform what the rules engine / an accepted proposal queued. A ticket proposal opens the
    // PAPER ticket in its editing phase (the user sizes + confirms there; signer caps apply) — never a live ticket,
    // never a confirm. An ask proposal is a question to the analyst. Popups are the same read-only windows the keys
    // open; chart/token/bubbles need the fired coin to be the open token. Sounds are the terminal bell, when on.
    const drainRulesPending = (): void => {
      const ui = state.rulesUi;
      if (!ui) return;
      const p = ui.pending;
      if (p.ticket) {
        const tk = p.ticket; p.ticket = null;
        if (!live) say(`ticket proposal for ${tk.symbol} needs live or replay mode (the PAPER ticket)`, 'info', 5);
        else {
          try {
            const s = seedForMint(state, live, tk.mint, tk.symbol);
            live.openTicket({ mint: s.mint, symbol: s.symbol, name: s.name }, tk.side, 'paper');
            if (state.screen !== 'ticket') stack.push(state.screen);
            state.screen = 'ticket';
            say(`PAPER ticket for ${tk.symbol}: a rule proposed ${tk.side} ${tk.size} ${tk.unit} — size and confirm it yourself`, 'info', 6);
          } catch (e) { say(`ticket editor failed: ${describeError(e)}`, 'warn', 5); }
        }
        scheduleDraw();
      }
      if (p.ask) {
        const q = p.ask; p.ask = null;
        try { sendChat(q); } catch (e) { say(`ask failed: ${describeError(e)}`, 'warn', 5); }
        scheduleDraw();
      }
      if (p.popups.length) {
        const items = p.popups.splice(0, p.popups.length);
        for (const it of items) {
          if (it.kind === 'narrative' || it.kind === 'plans' || it.kind === 'feeds') void openWorkspacePopups([{ kind: it.kind } as import('@dexterm/custom').PopupSpec]);
          else if (live?.token?.view?.mint === it.mint) void openWorkspacePopups([{ kind: it.kind, mint: 'selected' } as import('@dexterm/custom').PopupSpec]);
          else say(`rule ${it.rule}: ${it.kind} popup for ${it.symbol} skipped (open the coin first)`, 'info', 5);
        }
      }
      if (p.bells > 0) { p.bells = 0; if (state.sound?.on) out.write('\x07'); }
    };

    // ===== JARVIS voice mode (task-1282) =====
    // The controller lives in the loop because its decisions drive the same safe paths the keys use
    // (sendChat, the screen switches, the PAPER ticket). It can ONLY ask the analyst or trigger those
    // safe actions; the open-ticket path opens the ticket in its editing phase and never confirms it.
    let voice: VoiceController | null = null;
    let voiceInitStarted = false;
    const spokenTurns = new Set<number>();
    const toHud = (): VoiceHud => {
      const s = voice!.status();
      return { enabled: s.enabled, mode: s.mode, muted: s.muted, voice: s.voice, transcript: s.lastTranscript, say: s.lastSay, message: s.starting ? 'opening the mic…' : s.message };
    };
    /**
     * The coin a spoken pronoun ("it", "this one") refers to: ONLY the row actually highlighted on the
     * current screen (token, screener/analyst view, new pairs by pinned mint, watchlist, trending). An
     * empty list or any other screen is null, so voice asks instead of acting on a coin the user cannot
     * see (task-1339, re-verify N4: "buy it" on an empty watchlist used to open a ticket for a screener row).
     */
    const voiceSelected = (): { mint: string; symbol: string } | null => {
      if (!live) return null;
      const pick = <T,>(xs: readonly T[]): T | undefined => xs.length ? xs[Math.max(0, Math.min(xs.length - 1, state.selected || 0))] : undefined;
      switch (state.screen) {
        case 'token': return live.token?.view ? { mint: live.token.view.mint, symbol: live.token.view.symbol } : null;
        case 'screener': case 'analyst': { const r = pick(screenerView(state.screener)); return r?.mint && !r.fixture && !r.skeleton ? { mint: r.mint, symbol: r.symbol ?? '' } : null; }
        case 'newpairs': { const l = live.newpairs.list(); const r = (state.selectedMint ? l.find((x) => x.mint === state.selectedMint) : undefined) ?? pick(l); return r?.mint ? { mint: r.mint, symbol: r.symbol ?? '' } : null; }
        case 'watchlist': { const w = pick(live.watch.list()); return w ? { mint: w.entry.mint, symbol: w.entry.symbol } : null; }
        case 'trending': { const r = pick(trendingRows(state)); return r ? { mint: r.mint, symbol: r.symbol } : null; }
        default: return null;
      }
    };
    const voiceScreenState = (): VoiceScreenState => {
      // Symbols the router may treat as known tickers: everything the app can resolve (screener view,
      // new pairs, watchlist) — the app still resolves and clarifies; this only helps the router tell a
      // ticker from a stray word.
      const syms = new Set<string>();
      for (const r of screenerView(state.screener)) if (r.symbol) syms.add(r.symbol);
      if (live) { for (const r of live.newpairs.list()) if (r.symbol) syms.add(r.symbol); for (const w of live.watch.list()) syms.add(w.entry.symbol); }
      return { screen: state.screen, selected: voiceSelected(), visibleSymbols: [...syms] };
    };
    const SCREEN_ACTION: Record<string, AppAction> = {
      screener: 'screen.screener', newpairs: 'screen.newpairs', watchlist: 'screen.watchlist', analyst: 'screen.analyst', positions: 'screen.positions',
    };
    // Resolve a voice-requested token against what is actually on screen — the screener view, the new
    // pairs feed, and the watchlist — plus the selected row for "this one"/"it". The router never
    // guesses a mint; this is where a spoken symbol/name becomes a concrete token. If the symbol matches
    // more than one distinct mint (a copycat / fake ticker), that is AMBIGUOUS: we ask rather than
    // silently pick one (task-1282 rework D1). An unknown symbol is 'none' → ask; we never fall back to
    // the selected coin for a named ticker.
    type VoiceTokenResolution = { kind: 'ok'; mint: string } | { kind: 'none' } | { kind: 'ambiguous'; count: number };
    const resolveVoiceToken = (target: string): VoiceTokenResolution => {
      if (target === '__selected__') { const sel = voiceSelected(); return sel ? { kind: 'ok', mint: sel.mint } : { kind: 'none' }; }
      if (!live) return { kind: 'none' };
      const sym = target.toUpperCase();
      const candidates: Array<{ mint?: string; symbol?: string }> = [
        ...screenerView(state.screener),
        ...live.newpairs.list(),
        ...live.watch.list().map((w) => w.entry),
      ];
      const mints = new Set(candidates.filter((r) => (r.symbol ?? '').toUpperCase() === sym && r.mint).map((r) => r.mint as string));
      if (mints.size === 0) return { kind: 'none' };
      if (mints.size > 1) return { kind: 'ambiguous', count: mints.size };
      return { kind: 'ok', mint: [...mints][0] };
    };
    // Thin mint-or-null helper for the non-trade paths (open-token / watchlist): an ambiguous or unknown
    // symbol yields null, so the caller asks rather than acting on a guess.
    const resolveVoiceMint = (target: string): string | null => { const r = resolveVoiceToken(target); return r.kind === 'ok' ? r.mint : null; };
    // task-1355: the price + market cap the app currently shows for a mint (token view, else the screener
    // row, else the new-pairs row). A spoken market-cap target is read back against supply = mcap / price;
    // when the screen has neither we ASK rather than invent a supply.
    const voiceMarket = (mint: string): { price: number | null; mcap: number | null } => {
      const tv = live?.token?.view;
      if (tv && tv.mint === mint) return { price: tv.price, mcap: tv.mcap };
      const sr = screenerView(state.screener).find((r) => r.mint === mint);
      if (sr) return { price: sr.price, mcap: sr.mcap };
      const np = live?.newpairs.list().find((r) => r.mint === mint) as { price?: number | null; mcap?: number | null } | undefined;
      if (np) return { price: np.price ?? null, mcap: np.mcap ?? null };
      return { price: null, mcap: null };
    };
    // task-1411: a short instruction appended to a VOICE analyst question so the answer is built for the
    // ear, not the screen — market cap not a per-token price, round numbers, short.
    const VOICE_ANALYST_SPEECH_HINT =
      'Answer out loud for text-to-speech: talk about price as market cap, never a raw per-token price; '
      + 'round big numbers like "340 thousand" or "1.2 million"; no long addresses; keep it to two or three short sentences.';
    // A spoken pronoun that points at the highlighted row ("this one", "this coin", "it").
    const VOICE_SELECTION_PRONOUN = /\b(?:this (?:one|coin|token)|that (?:one|coin|token)|this|it)\b/i;
    // A friendly, complete spoken ack for each navigable screen (the router's `say` is the terse key).
    const NAV_ACK: Record<string, string> = {
      screener: 'the screener', newpairs: 'new pairs', watchlist: 'your watchlist', analyst: 'the analyst', positions: 'your positions',
    };
    /**
     * Run a VOICE-originated analyst question (task-1411). Fixes the screener silence: "what do you think
     * of THIS ONE" aimed at a highlighted screener row used to start a context-free `trench-scan` with no
     * mint, so the analyst never learned which coin "this one" was and answered with a short, useless
     * fragment (the tester heard nothing useful). We now attach the SELECTED coin as a token-dossier target —
     * exactly the context a token screen already gives — so it answers for real. The question also carries
     * a short "answer for speech" instruction (market cap, round numbers, short).
     */
    const askVoiceAnalyst = (question: string): void => {
      const q = question.trim().slice(0, 400);
      const instructed = `${q}\n\n${VOICE_ANALYST_SPEECH_HINT}`;
      // A warm session: follow up on it so the model keeps context (the screen is already analyst/token).
      if (state.analyst) { state.analyst.ask(instructed, buildScreenState(state)); return; }
      const tv = live?.token?.view;
      const sel = voiceSelected();
      if (state.screen === 'token' && live && tv?.mint) {
        state.pendingAnalyst = { skill: 'token-dossier', mint: tv.mint, symbol: tv.symbol, target: 'token', question: instructed };
      } else if (live && sel && VOICE_SELECTION_PRONOUN.test(q)) {
        // the screener/analyst/watchlist/new-pairs highlighted coin IS "this one" (task-1411)
        state.pendingAnalyst = { skill: 'token-dossier', mint: sel.mint, symbol: sel.symbol, target: 'analyst', question: instructed };
      } else {
        state.pendingAnalyst = { skill: 'trench-scan', target: 'analyst', question: instructed };
      }
      if (state.pendingAnalyst) beginAnalyst();
    };
    /**
     * Perform a voice decision. Returns `false` when the app spoke its own reply (an ask / clarify), so
     * the controller does not read the decision's `say` line over it (task-1339, re-verify N1: the
     * copycat warning used to be cut off by "opening a buy ticket for X" although no ticket opened).
     */
    const handleVoiceDecision = (d: VoiceDecision): boolean => {
      const before = state.screen;
      let answered = false;
      const ask = (line: string): void => { answered = true; voice?.speak(line); };
      try {
        switch (d.kind) {
          case 'navigate': { const a = SCREEN_ACTION[d.screen]; if (a) applyAction(state, a, stack); ask(NAV_ACK[d.screen] ?? d.say); break; }
          case 'open-token': {
            const mint = resolveVoiceMint(d.target);
            if (mint && live) { live.openToken(seedForMint(state, live, mint)); if (state.screen !== 'token') stack.push(state.screen); state.screen = 'token'; }
            else ask(live ? (d.target === '__selected__' ? 'Nothing is highlighted here — pick a row first.' : "I don't see that token on screen — open the screener first.") : 'Opening a token needs live mode.');
            break;
          }
          case 'filter': {
            if (state.screen !== 'screener') { stack.push(state.screen); state.screen = 'screener'; }
            const err = setFilter(state.screener, d.expr);
            if (err) ask('I could not set that filter.'); else state.selected = clampSelection(state.screener, state.selected);
            break;
          }
          case 'watchlist': {
            const mint = resolveVoiceMint(d.target);
            if (mint && live) { if (!live.watch.has(mint)) live.watch.add(LiveContext.candidate(seedForMint(state, live, mint) as unknown as ScreenerRow)); }
            else ask(live ? (d.target === '__selected__' ? 'Nothing is highlighted here — pick a row first.' : "I don't see that token to watch.") : 'The watchlist needs live mode.');
            break;
          }
          case 'open-ticket': {
            // SAFE: open the PAPER ticket in its editing phase only — explicitly 'paper', never 'live'. The
            // keypress gate still stands; voice never confirms, signs, flips LIVE, or touches the caps. This
            // is the single trade-shaped path and it stops here. Resolve the SPOKEN coin (never the selected
            // one unless it was a pronoun); ask on unknown or ambiguous (copycat ticker) rather than opening
            // the wrong token (task-1282 rework D1).
            const res = resolveVoiceToken(d.target);
            if (res.kind === 'ok' && live) { const s = seedForMint(state, live, res.mint); live.openTicket({ mint: s.mint, symbol: s.symbol, name: s.name }, d.side, 'paper'); if (state.screen !== 'ticket') stack.push(state.screen); state.screen = 'ticket'; }
            else if (res.kind === 'ambiguous') ask(`I see ${res.count} tokens called ${d.target}. Open the exact one first, then say ${d.side}.`);
            else if (d.target === '__selected__') ask(live ? `${d.side === 'buy' ? 'Buy' : 'Sell'} what? Nothing is highlighted here — name the ticker or pick a row first.` : 'Paper trading needs live mode.');
            else ask(live ? `I don't see a token called ${d.target} — open it first, then say ${d.side}.` : 'Paper trading needs live mode.');
            break;
          }
          case 'propose-plan': {
            // task-1355 (verify fix): a spoken "buy this if it dips to 300k, sell half at 600k, leave a moon
            // bag" becomes a PROPOSED order plan in the PlanService — inert data. Nothing on this path arms,
            // confirms, signs or touches a cap: arming is the hold-to-arm gesture on the O screen (or
            // `trenchscope plan arm` on a TTY), and the decision carries no field that could ask for it. The size
            // is never spoken (VOICE_PLAN_SIZE_USD, paper); the coin is the SPOKEN ticker or the highlighted
            // row for a pronoun, resolved exactly like a ticket (ambiguous / unknown → ask, never a guess).
            const res = resolveVoiceToken(d.target);
            if (res.kind === 'ambiguous') { ask(`I see ${res.count} tokens called ${d.target}. Open the exact one first, then say the plan.`); break; }
            if (!live) { ask('Order plans need live mode.'); break; }
            if (res.kind !== 'ok') { ask(d.target === '__selected__' ? 'A plan for what? Nothing is highlighted here — name the ticker or pick a row first.' : `I don't see a token called ${d.target} — open it first, then say the plan.`); break; }
            const s = seedForMint(state, live, res.mint);
            const mkt = voiceMarket(res.mint);
            const supply = mkt.price && mkt.mcap && mkt.price > 0 && mkt.mcap > 0 ? mkt.mcap / mkt.price : null;
            if (!supply) { ask(`I don't have a market cap for ${s.symbol} yet — open its token screen, then say the plan again.`); break; }
            const input: PlanInput = {
              mint: s.mint, symbol: s.symbol, decimals: 6, side: d.side, sizeUsd: VOICE_PLAN_SIZE_USD,
              entry: d.entry ? { kind: 'mc-below', value: d.entry.mcUsd } : { kind: 'immediate' },
              exits: d.exits.map((x) => ({ at: { kind: 'mc-above', value: x.mcUsd }, fraction: x.fraction })),
              stop: d.stopMcUsd != null ? { kind: 'mc-below', value: d.stopMcUsd } : null,
            };
            const svc = plansService(state);
            let planId: string;
            try { planId = svc.propose(input, { supply, by: 'voice', ref: 'voice:propose-plan' }).id; }
            catch (e) { ask(`I couldn't draft that plan: ${describeError(e)}.`); break; }
            // Surface the card: open the plans screen on the new row so the review + hold-to-arm is one key away.
            applyAction(state, 'screen.plans', stack);
            if (state.plansUi) {
              state.plansUi.tab = 'plans';
              state.plansUi.selected = Math.max(0, svc.listPlans().findIndex((p) => p.id === planId));
              state.plansUi.notice = `drafted ${planId} from voice — PROPOSAL only, not armed; hold a to arm`;
            }
            ask(`Drafted an order plan for ${s.symbol}, sized at ${VOICE_PLAN_SIZE_USD} dollars paper: ${svc.readBack(planId)}. It is a proposal only — I can't arm it; hold A on the plans screen to arm.`);
            break;
          }
          case 'popup': {
            // task-1339: a popup PANEL through the popup host (read-only; the window never sees keys).
            const open = state.popups?.chartOpen() ?? false;
            if (!live?.token?.view) ask('Open a token first, then say "show the chart".');
            else if (d.open === open) ask(d.open ? 'The chart popup is already open.' : 'No chart popup is open.');
            else void togglePopupChart();
            break;
          }
          case 'analyst': {
            // Route the question to the analyst, surface the chat, and let the answer be spoken when it lands.
            // Capped like typed chat (400 chars): a runaway transcript never becomes a 200 KB argv (N7).
            // task-1411: askVoiceAnalyst attaches the highlighted coin as context so a screener "this one"
            // question is answered for real, and appends the "answer for speech" instruction.
            if (state.screen !== 'token' && state.screen !== 'analyst') { stack.push(state.screen); state.screen = 'analyst'; }
            syncAnalyst(state);
            askVoiceAnalyst(d.question);
            break;
          }
          case 'workspace': {
            // task-1358: a workspace switch is navigation + theme + read-only popups — the same path as ctrl+w.
            const r = switchWorkspace(state, d.name, stack);
            if (!r.ok) ask(state.custom ? `I don't have a workspace called ${d.name}. ${workspaceSlots(state.custom).length ? `You have ${workspaceSlots(state.custom).join(', ')}.` : ''}` : 'Workspaces are not loaded on this run.');
            else if (r.refresh) refresh();
            break;
          }
          case 'clarify': case 'ignore': break; // the controller already speaks a clarify; ignore is a no-op
        }
      } catch (e) { state.screener.notice = `⚠ voice action failed: ${describeError(e)}`; }
      if (state.screen !== before) { state.aiFocused = false; syncAnalyst(state); try { startTransition(); } catch { transition = null; } }
      scheduleDraw();
      return !answered;
    };
    // Speak the analyst's answer when a voice-initiated turn settles (first ~2 sentences only).
    const maybeSpeakVoiceAnswer = (session: AnalystSession): void => {
      if (!voice || voice.status().mode !== 'thinking' || session.busy) return;
      // Settled = not busy AND a terminal status, keyed on the turn's start time — NOT on doneAt: the
      // error paths never set doneAt, so an analyst error (claude missing / not logged in / exit 1) left
      // voice wedged in 'thinking' until restart (task-1339, re-verify N2).
      if (session.status !== 'done' && session.status !== 'error' && session.status !== 'interrupted') return;
      const turn = session.startedAt;
      if (spokenTurns.has(turn)) return;
      spokenTurns.add(turn);
      if (session.status === 'done') voice.speakAnswer({ verdict: session.verdict, summary: session.summary, text: session.text });
      // error / interrupted: return voice to idle with a clear spoken + visible error, never stuck in
      // 'thinking' (task-1282 rework D3).
      else voice.abortTurn(session.status === 'error' ? "Sorry — the analyst hit an error. Try again." : "Okay, stopped.");
    };
    // task-1393: persist the `,` voice choice to config.voice.name (actor 'user', journaled → undo works).
    // Best-effort: a persistence failure keeps the voice for this run and never breaks the UI.
    const persistVoiceChoice = (voiceName: string): void => {
      const ui = state.custom;
      if (!ui) return;
      try {
        const op = ui.config.voice
          ? { op: 'add' as const, path: '/voice/name', value: voiceName }
          : { op: 'add' as const, path: '/voice', value: { name: voiceName } };
        const { config } = applyAndJournal(ui.home, [op], { actor: 'user', why: `, voice ${voiceName}`, now: state.now.getTime() });
        ui.config = config;
      } catch { /* keep the voice for this run; nothing to surface */ }
    };
    // task-1411: persist the < / > speaking-rate nudge to config.voice.rate (actor 'user', journaled →
    // undo works). Best-effort: a failure keeps the rate for this run and never breaks the UI.
    const persistVoiceRate = (rate: number): void => {
      const ui = state.custom;
      if (!ui) return;
      try {
        const op = ui.config.voice
          ? { op: 'add' as const, path: '/voice/rate', value: rate }
          : { op: 'add' as const, path: '/voice', value: { rate } };
        const { config } = applyAndJournal(ui.home, [op], { actor: 'user', why: `voice rate ${rate}`, now: state.now.getTime() });
        ui.config = config;
      } catch { /* keep the rate for this run; nothing to surface */ }
    };
    const initVoice = async (): Promise<void> => {
      if (voiceInitStarted) return;
      voiceInitStarted = true;
      state.voice = { enabled: true, mode: 'idle', muted: false, voice: null, transcript: null, say: null, message: 'preparing voice…' };
      scheduleDraw();
      // task-1393: the user's saved voice/rate (if any). A missing/banned name is resolved to a safe
      // deep British male by selectTts — it never falls back to the machine's system voice.
      const cfgVoice = state.custom?.config.voice;
      let stt = null, tts = null;
      try { [stt, tts] = await Promise.all([selectStt(), selectTts(undefined, cfgVoice?.name ?? null)]); } catch { /* both null → degrade to text */ }
      if (done) return;
      // Seed the controller with the ENGINE's resolved voice so its cycle/status start on the British male,
      // not on voices[0] (which could be a novelty voice like "Albert").
      const resolvedVoice = tts instanceof SayTts ? tts.voiceName : undefined;
      const style = voiceStyleDefaults(resolvedVoice); // the picked voice's own rate/pitch, unless the user saved theirs
      voice = new VoiceController({
        stt, tts, voice: resolvedVoice, rate: cfgVoice?.rate ?? style?.rate, pitch: cfgVoice?.pitch ?? style?.pitch, getScreenState: voiceScreenState,
        onState: () => { if (!done && voice) { state.voice = toHud(); scheduleDraw(); } },
        onDecision: handleVoiceDecision,
        onVoiceChange: persistVoiceChoice,
        onRateChange: persistVoiceRate,
      });
      voice.enable();
      await voice.toggleTalk(); // the first `v` press both enables and starts listening
    };

    const quit = () => {
      done = true;
      prefetcher?.close();
      if (timer) clearInterval(timer);
      void followSession?.stop();
      agentPaper?.stop();
      guard.restore();
      guard.uninstall();
      cancelAllAnalysts();
      state.popups?.shutdown();
      images?.close();
      voice?.disable(); // closes the mic and stops any speech (task-1282)
      live?.close();
      if (feed && args.record) { try { feed.save(args.record); io.stderr.write(`recorded ${feed.requests} live requests to ${args.record}\n`); } catch (e) { io.stderr.write(`dexterm: ${(e as Error).message}\n`); } }
      feed?.close();
      resolve(0);
    };
    guard.install();
    out.write(ENTER_SCREEN);
    inp.setRawMode(true);
    inp.resume();
    inp.setEncoding('utf8');
    const onInput = (chunk: string): void => {
      if (done) return;
      for (const key of parseKeys(chunk)) {
        wake(KEY_WAKE_S);                               // full-rate rendering for KEY_WAKE_S after input
        if (v.moment && v.moment.kind !== 'inflight') skipMoment(v); // task-1340: any key skips a trade moment
        // task-1311 (QA M12): any key reveals a finished answer in full — the decrypt never hides it.
        if ((state.screen === 'analyst' || state.screen === 'token') && state.analyst) state.aiRevealAll = true;
        if (transition) transition = null;              // any key skips the blink
        if (state.screen === 'boot') {                  // any key skips the boot; the key still does its job
          try { endBoot(); } catch (e) { state.screener.notice = `⚠ boot failed: ${describeError(e)}`; }
          // First launch: the boot clears to the welcome card, so this key only reveals it (next key dismisses).
          if (state.overlay === 'welcome') { draw(); continue; }
        }
        // Ctrl-C always quits cleanly (terminal restored by the guard), whatever is focused.
        if (key.ctrl && key.ch === 'c') { quit(); return; }
        // task-1421 follow-mode controls (only while following an MCP agent). ctrl+p pauses / resumes the
        // terminal mirroring; ctrl+k stops following (removes the rendezvous so the server stops emitting);
        // ANY other key while the agent is driving hands control to the user — the human and the agent never
        // fight over the screen. The control keys are consumed; the take-over key still does its own job.
        if (followSession) {
          if (key.ctrl && key.ch === 'k') { followSession.kill(); draw(); continue; }
          if (key.ctrl && key.ch === 'p') { if (followSession.isPaused) followSession.resume(); else followSession.pause(); draw(); continue; }
          if (followSession.controlState === 'agent') followSession.userKey(); // take over, then fall through
        }
        // task-1413: a pending analyst config PROPOSAL owns the next key. `y` accepts and journals it as
        // actor 'analyst' (ctrl+z undoes); any other key dismisses it. A stray key never persists a change.
        // Two guards (defect c): the proposal does NOT steal a key while a TEXT INPUT is open — the GO-TO
        // prompt or a focused analyst chat line — so a 'y' being typed goes into the field, not the accept;
        // and an EXPIRED proposal (its 8s toast has faded) is silently dropped, never accepted by a late 'y'.
        if (state.analystConfigProposal) {
          const inputOpen = !!state.goto || (state.aiFocused === true);
          const expired = state.now.getTime() >= state.analystConfigProposal.expiresAt;
          if (expired) {
            state.analystConfigProposal = null; // let the key fall through to its normal handler below
          } else if (!inputOpen) {
            const prop = state.analystConfigProposal;
            state.analystConfigProposal = null;
            if (key.ch === 'y' || key.ch === 'Y') {
              try { say(`analyst ${applyAnalystConfig(state, prop)} · ctrl+z undoes`, 'ai', 5); }
              catch (e) { say(`change refused: ${describeError(e)}`, 'warn', 4); }
            } else { say('dismissed the analyst change', 'ai', 3); }
            draw();
            continue;
          }
        }
        // task-1388 GO-TO prompt: while the "open any coin" input is open it owns the keyboard. Route the key
        // straight to applyKey (which does the capture / open) and skip the voice, calm, demo and keymap
        // handlers below — otherwise a base58 char like v / m / c would toggle voice or calm instead of typing.
        if (state.goto) {
          const before = state.screen;
          try { applyKey(state, key, stack); }
          catch (e) { state.goto = null; state.screener.notice = `⚠ go-to failed: ${describeError(e)}`; }
          if (state.screen !== before) {
            state.aiFocused = false;
            syncAnalyst(state);
            try { startTransition(); } catch (e) { transition = null; state.screener.notice = `⚠ transition failed: ${describeError(e)}`; }
          }
          draw();
          continue;
        }
        // task-1282 rework (D2): the mic is live ONLY while listening. It must never stay live once the
        // keyboard moves elsewhere. ANY key other than the voice controls (v/m/,) stops the capture
        // immediately, and esc always cancels it — even on the ticket, chat, filter or overlay screens
        // where the voice keys below are suppressed, so the mic can never be left open where v/esc do
        // not reach it. The 15 s hard cap in the controller is the final backstop.
        // `micEngaged` also covers the window while the mic is still OPENING (listen() in flight), so a key
        // pressed before the engine came up closes the session the moment it arrives (task-1339, N3/N8).
        if (voice?.micEngaged) {
          const isVoiceCtl = key.name === 'char' && !key.ctrl && !key.alt && (key.ch === 'v' || key.ch === 'm' || key.ch === ',' || key.ch === '<' || key.ch === '>');
          if (key.name === 'esc') { voice.cancelListen(); draw(); continue; }
          if (!isVoiceCtl) voice.cancelListen(); // fall through so the key still does its normal job
        }
        // JARVIS voice keys (task-1282). `v` push-to-talk (auto-enables voice on first use); `m` mute;
        // `,` change voice; esc stops a reply or cancels listening. Suppressed while a modal, the chat
        // input, the filter/sort editor or the PAPER ticket owns the keyboard, so they never collide
        // with typing or the trade confirm gate.
        const voiceKeysOk = !state.overlay && !state.aiFocused
          && !(state.screen === 'screener' && state.screener.mode !== 'table')
          && state.screen !== 'ticket';
        if (voiceKeysOk) {
          const vmode = voice?.status().mode;
          if (key.name === 'esc' && voice && (vmode === 'listening' || vmode === 'speaking')) { voice.interrupt(); draw(); continue; }
          if (key.name === 'char' && !key.ctrl && !key.alt) {
            if (key.ch === 'v') { if (!voice) void initVoice(); else void voice.toggleTalk(); draw(); continue; }
            if (voice?.isEnabled && key.ch === 'm') { voice.toggleMute(); draw(); continue; }
            if (voice?.isEnabled && key.ch === ',') { voice.cycleVoice(); draw(); continue; }
            if (voice?.isEnabled && key.ch === '<') { voice.nudgeRate(-1); draw(); continue; } // slower (task-1411)
            if (voice?.isEnabled && key.ch === '>') { voice.nudgeRate(1); draw(); continue; }  // faster (task-1411)
          }
        }
        // A modal overlay (welcome/help) is open: any key dismisses it; `?` switches welcome→help (task-1305).
        if (state.overlay === 'links' && state.linkMenu) {
          const menu = state.linkMenu;
          if (key.name === 'esc' || (key.name === 'char' && key.ch === 'q')) state.overlay = null;
          else if (key.name === 'down' || (key.name === 'char' && key.ch === 'j')) menu.selected = Math.min(menu.items.length - 1, menu.selected + 1);
          else if (key.name === 'up' || (key.name === 'char' && key.ch === 'k')) menu.selected = Math.max(0, menu.selected - 1);
          else if (key.name === 'enter') { state.pendingOpen = menu.items[menu.selected]?.url ?? null; state.overlay = null; }
          draw(); continue;
        }
        // task-1407: the PnL card preview owns the keys while open (share / save / toggles / other coin / esc).
        if (state.overlay === 'pnl' && state.pnl) {
          const ui = state.pnl;
          const eff = pnlKey(ui, key);
          if (eff.kind === 'close') { state.overlay = null; state.pnl = null; }
          else if (eff.kind === 'reload') { ui.stats = null; ui.error = null; void loadPnl(state).then(() => { if (!done) draw(); }); }
          else if (eff.kind === 'share' && ui.stats) {
            ui.busy = true; ui.notice = null;
            void shareCard(ui.stats, { ...ui.opts }, eff.action, { platform: process.platform, env: io.env, run: runLocal, openUrl: (u) => openInBrowser(u), copyText: copyToClipboard })
              .then((r) => { ui.notice = r.message; say(r.message, 'info', 10); })
              .catch((e) => { ui.notice = `card failed: ${describeError(e)}`; })
              .finally(() => { ui.busy = false; if (!done) draw(); });
          }
          draw(); continue;
        }
        // task-1358: the WORKSPACES card — a digit picks a slot, j/k move, ⏎ activates, esc/q/ctrl+w w close.
        if (state.overlay === 'workspaces' && state.custom) {
          const ui = state.custom;
          const slots = workspaceSlots(ui);
          const pick = (name: string | undefined): void => {
            state.overlay = null;
            if (!name) { say('no workspace in that slot', 'warn'); return; }
            const before = state.screen;
            const r = switchWorkspace(state, name, stack);
            if (!r.ok) say(r.reason, 'warn', 5);
            else if (r.refresh) refresh();
            if (state.screen !== before) { state.aiFocused = false; syncAnalyst(state); try { startTransition(); } catch { transition = null; } }
          };
          if (key.name === 'esc' || (key.name === 'char' && (key.ch === 'q' || (key.ch === 'w' && key.ctrl)))) state.overlay = null;
          else if (key.name === 'down' || (key.name === 'char' && key.ch === 'j')) ui.listCursor = Math.min(ui.workspaces.length - 1, ui.listCursor + 1);
          else if (key.name === 'up' || (key.name === 'char' && key.ch === 'k')) ui.listCursor = Math.max(0, ui.listCursor - 1);
          else if (key.name === 'char' && key.ch && /^[1-9]$/.test(key.ch) && !key.ctrl) pick(slots[Number(key.ch) - 1]);
          else if (key.name === 'enter') { const w = ui.workspaces[ui.listCursor]; pick(w && !w.error ? w.name : undefined); }
          draw(); continue;
        }
        if (state.overlay) {
          // `?` turns the welcome card into the help card instead of dismissing it.
          if (key.name === 'char' && key.ch === '?' && state.overlay !== 'help') {
            state.overlay = 'help';
            draw();
            continue;
          }
          const wasWelcome = state.overlay === 'welcome';
          state.overlay = null;
          // task-1311 (QA DEFECT 2): a screen-switch digit (1-4) pressed on the welcome card dismisses
          // it AND navigates in the same keypress, so the user lands where they aimed (e.g. the Analyst
          // tab's guarded input) instead of being dropped on the screener, where the next letters would
          // fire hotkeys — `a` there launches a real paid rug-check run. Any other key just dismisses.
          if (!(wasWelcome && key.name === 'char' && (key.ch === '1' || key.ch === '2' || key.ch === '3' || key.ch === '4'))) {
            draw();
            continue;
          }
          // fall through: the dismissed welcome's digit still resolves to its screen switch below
        }
        // task-1324: Esc while the scan is LOCKED cancels the scan's analysis (not the scan): on the locked
        // coin's token screen, or anywhere but the ticket while the scan's turn is running. A second Esc
        // then navigates as usual. On the screener table, Esc while SCANNING stops the scan.
        const scanE = state.scan?.engine;
        if (key.name === 'esc' && !state.aiFocused && scanE?.mode === 'locked' && live
          && ((state.screen === 'token' && live.token?.view.mint === scanE.lock?.mint) || (state.screen !== 'ticket' && state.scan?.session?.busy))) {
          cancelScanAnalysis();
          draw();
          continue;
        }
        if (key.name === 'esc' && scanE?.mode === 'scanning' && state.screen === 'screener' && state.screener.mode === 'table' && !state.analyst?.busy) {
          scanSay(scanCommand(state, 'off', stack), 'info', 4);
          draw();
          continue;
        }
        // Esc interrupts a running analyst from any screen and never navigates mid-run (task-1303).
        if (key.name === 'esc' && state.analyst?.busy) {
          try { state.analyst.interrupt(); } catch (e) { state.screener.notice = `⚠ interrupt failed: ${describeError(e)}`; }
          draw();
          continue;
        }
        // During an in-flight confirm (`filling`), a slow or 429-paused quote must never trap the
        // user (task-1310 MAJOR fix): esc cancels the bounded quote, and q/P/1-4 are NOT swallowed —
        // they fall through to the keymap. Nothing here can confirm, so letting keys through is safe.
        if (state.screen === 'ticket' && live?.ticket && live.ticket.ticket.phase === 'filling') {
          if (key.name === 'esc') { try { live.ticket.cancel(); } catch (e) { state.screener.notice = `⚠ cancel failed: ${describeError(e)}`; } draw(); continue; }
          // else: fall through to the keymap (quit/navigation remain responsive while filling)
        }
        // task-1328 LIVE: while the signer builds the plan, esc cancels; while Phantom has the plan
        // (signing) no key does anything — the signer finishes or times out, and nothing here can
        // confirm, so navigation keys still fall through to the keymap.
        if (state.screen === 'ticket' && live?.ticket && live.ticket.ticket.phase === 'planning') {
          if (key.name === 'esc') { live.ticket.cancelPlan(); draw(); continue; }
          // task-1368: while Jupiter is rate limiting the signer the ticket waits and retries by itself; r retries now.
          if (key.name === 'char' && (key.ch === 'r' || key.ch === 'R') && !key.ctrl && !key.alt) { live.ticket.retryPlan(); draw(); continue; }
        }
        if (state.screen === 'ticket' && live?.ticket && live.ticket.ticket.phase === 'signing') {
          if (key.name === 'esc') { state.pendingToast = 'waiting for Phantom — approve or reject it in the browser'; draw(); continue; }
        }
        // PAPER trade ticket (task-1310): the ticket captures every key (digits/y/esc/tab/…) so the
        // confirm gate can never be satisfied by a stray key, and `q`/`1`-`4` cannot quit or navigate
        // out from under a half-typed order. `filling` is handled above so the user is never trapped.
        const ticketActive = state.screen === 'ticket' && live?.ticket && live.ticket.ticket.phase !== 'filled' && live.ticket.ticket.phase !== 'error' && live.ticket.ticket.phase !== 'refused' && live.ticket.ticket.phase !== 'filling' && live.ticket.ticket.phase !== 'planning' && live.ticket.ticket.phase !== 'signing';
        if (ticketActive && live?.ticket) {
          let eff: ReturnType<typeof live.ticket.key>;
          try { eff = live.ticket.key({ name: key.name, ch: key.ch, ctrl: key.ctrl, alt: key.alt }); }
          catch (e) { state.screener.notice = `⚠ ticket key failed: ${describeError(e)}`; draw(); continue; }
          if (eff === 'close') { const prev = stack.pop(); state.screen = prev ?? 'token'; startTransition(); }
          else if (eff === 'confirm') { void live.ticket.confirm().then(() => { if (!done) { if (state.screen === 'positions') return; void live.positions.refresh(); draw(); } }); }
          draw();
          continue;
        }
        // task-1355 ARM MODAL (hold-to-confirm): while the plans screen's arm prompt is up, this block
        // captures EVERY key so the signer gesture can only be satisfied by a real physical keypress at
        // the keyboard — enter/y confirms (arms via armPlanByKeypress / armMandateByKeypress, which run
        // the signer-side challenge→proof→arm), esc cancels, nothing else leaks to the keymap. A piped or
        // scripted stdin never reaches here (the loop only runs on a TTY), and voice/agents have no path
        // to set `arming`, so there is no way to arm except a person pressing the key. The engine still
        // re-checks caps/tier/reservation on arm and the signer re-checks on every fill.
        // task-1360 Tier 3 AUTO-MIRROR modal: the same captured-keypress discipline as arming. enter/y ENABLES
        // auto for the wallet (the service drafts + arms the copy mandate on this very gesture and refuses unless the
        // less-safe popup is active, so no pipe/agent/voice path exists); esc cancels; every other key is swallowed.
        if (state.screen === 'follows' && state.copyUi?.autoModal) {
          const ui = state.copyUi;
          const wallet: string = state.copyUi.autoModal.wallet;
          if (key.name === 'esc') { ui.autoModal = null; ui.notice = 'auto-mirror left OFF'; draw(); continue; }
          const confirmKey = key.name === 'enter' || (key.name === 'char' && !key.ctrl && !key.alt && (key.ch === 'y' || key.ch === 'Y'));
          if (confirmKey) {
            ui.autoModal = null;
            try {
              const p = copyAutoService(state).enable(wallet, { gesture: 'keypress' });
              ui.notice = `auto-mirror ON for ${shortAddr(wallet)} · ≤ $${autoSizeCap(p).toFixed(2)} per mirror (¼ of $${Math.min(p.perTradeUsd, p.dailyUsd)}, hands-free tier) · $${p.dailyUsd}/day · A again turns it off`;
            } catch (e) { ui.notice = `auto-mirror refused: ${describeError(e)}`; }
            draw();
            continue;
          }
          draw();
          continue;
        }
        if (state.screen === 'plans' && state.plansUi?.arming) {
          const a = state.plansUi.arming;
          const ui = state.plansUi;
          if (key.name === 'esc') { ui.arming = null; ui.notice = 'arming cancelled'; draw(); continue; }
          const confirmKey = key.name === 'enter' || (key.name === 'char' && !key.ctrl && !key.alt && (key.ch === 'y' || key.ch === 'Y'));
          if (confirmKey) {
            const svc = state.plansSvc;
            ui.arming = null;
            if (!svc) { ui.notice = 'no plan service'; draw(); continue; }
            try {
              if (a.kind === 'plan') { svc.armPlanByKeypress(a.id, a.mandateId); ui.notice = `armed ${a.id} (signer re-checks caps on every fill)`; }
              else { svc.armMandateByKeypress(a.id, 'keypress'); ui.notice = `armed mandate ${a.id}`; }
            } catch (e) { ui.notice = `arm refused: ${describeError(e)}`; }
            draw();
            continue;
          }
          // any other key is swallowed so a stray keystroke can neither arm nor navigate out mid-confirm
          draw();
          continue;
        }
        // task-1355 Tier 4 — the "LESS SAFE" hands-free opt-in modal. Same captured-keypress discipline as
        // arm: enter/y accepts (if the gate is on) or restores it (if already hands-free); esc cancels;
        // every other key is swallowed. Accepting turns OFF the keypress gate via acceptRisk({gesture:
        // 'keypress'}) — which the engine takes ONLY from a real keypress, journals, and auto-expires in 24h;
        // restoreGate() puts it back. There is no path here for a pipe/agent (TTY-only loop, no way to raise
        // the modal except a person pressing G), and signer caps/allow-lists/panic are unaffected either way.
        // task-1363 — the FIRE PATH modal: paper ⇄ LIVE (devnet, the capped fast wallet). Same captured-keypress
        // discipline as arm/gate: enter/y switches, esc cancels, every other key is swallowed. Going LIVE needs
        // the run's signer process (never started in replay/offline/--no-live), the signer on DEVNET with a fast
        // wallet loaded (checked by LivePlanExecutor.ready), and no armed/filled plans; PlanService.useLive
        // takes ONLY a keypress gesture and journals the switch. Nothing here signs: fills still go through the
        // signer's own policy, simulation and caps, and the fast wallet never signs for the main wallet.
        if (state.screen === 'plans' && state.plansUi?.liveModal) {
          const ui = state.plansUi;
          if (key.name === 'esc') { ui.liveModal = false; ui.notice = 'fire path unchanged'; draw(); continue; }
          const confirmKey = key.name === 'enter' || (key.name === 'char' && !key.ctrl && !key.alt && (key.ch === 'y' || key.ch === 'Y'));
          if (confirmKey) {
            const svc = state.plansSvc;
            ui.liveModal = false;
            if (!svc) { ui.notice = 'no plan service'; draw(); continue; }
            if (svc.mode() === 'live') {
              try { svc.usePaper(); ui.notice = 'fire path: PAPER — fills are simulated again'; }
              catch (e) { ui.notice = `switch refused: ${describeError(e)}`; }
              draw(); continue;
            }
            const port = live?.ensureSigner() ?? null;
            if (!port) { ui.notice = 'LIVE fills need the signer process: start trenchscope live (not replay/offline/--no-live)'; draw(); continue; }
            if (svc.engine.openPlans().length) { ui.notice = `switch refused: cancel or finish ${svc.engine.openPlans().length} open plan(s) first`; draw(); continue; }
            const ex = new LivePlanExecutor({ signer: port, clock: { now: () => Date.now(), sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) } as never, solUsd: () => state.sol?.price ?? live?.positions.solUsd() ?? null, onChange: () => { if (!done) { plansTick(); draw(); } }, log: (l) => args.verbose && io.stderr.write(`  plans-live    ${l}\n`) });
            ui.notice = 'checking the signer and the fast wallet…';
            void ex.ready().then((r) => {
              if (done) return;
              if (!r.ok) { ui.notice = `LIVE refused: ${r.why}`; draw(); return; }
              try { svc.useLive(ex, { gesture: 'keypress' }); ui.notice = `fire path: ${ex.describe(r.fastWallet)} · balance ${r.balanceLamports === null ? '?' : (Number(r.balanceLamports) / 1e9).toFixed(4)} SOL · L again for paper`; }
              catch (e) { ui.notice = `switch refused: ${describeError(e)}`; }
              draw();
            });
            draw();
            continue;
          }
          draw();
          continue;
        }
        if (state.screen === 'plans' && state.plansUi?.riskModal) {
          const ui = state.plansUi;
          if (key.name === 'esc') { ui.riskModal = false; ui.notice = 'left the gate as it was'; draw(); continue; }
          const confirmKey = key.name === 'enter' || (key.name === 'char' && !key.ctrl && !key.alt && (key.ch === 'y' || key.ch === 'Y'));
          if (confirmKey) {
            const svc = state.plansSvc;
            ui.riskModal = false;
            if (!svc) { ui.notice = 'no plan service'; draw(); continue; }
            try {
              if (svc.riskStatus().active) { svc.restoreGate(); ui.notice = 'keypress gate restored — hands-free off'; }
              else { svc.acceptRisk({ gesture: 'keypress' }); ui.notice = 'hands-free ON for 24h — signer caps still apply (G to restore)'; }
            } catch (e) { ui.notice = `gate change refused: ${describeError(e)}`; }
            draw();
            continue;
          }
          draw();
          continue;
        }
        // Chat input (task-1311, QA B1/B2/B3): the token and analyst screens capture keystrokes into
        // the chat box ONLY while it is focused (focus explicitly with `i` or Enter). While focused,
        // printable keys type — never the keymap — so `q`/`1`-`4`/`a` cannot quit, switch screens, or
        // fire a paid run from under a half-typed question. Esc clears a non-empty box, else blurs;
        // once blurred the number keys and `q` work again, so the analyst tab is never a trap.
        const onChat = state.screen === 'analyst' || state.screen === 'token';
        if (onChat && state.aiFocused) {
          if (key.name === 'enter') {
            const q = (state.aiInput ?? '').trim();
            // task-1328: `/wallet …` in the chat input is a command, never sent to claude.
            const wc0 = q.startsWith('/') ? parseWalletCommand(q) : null;
            if (wc0) {
              state.aiInput = '';
              if (typeof wc0 === 'object') say(wc0.error, 'warn', 5); else state.pendingWallet = wc0;
              draw();
              continue;
            }
            // 0.1.5: `/engine [auto|claude|codex]` switches the analyst CLI for new conversations; never sent to a model.
            const en0 = q.startsWith('/') ? parseEngineCommand(q) : null;
            if (en0) {
              state.aiInput = '';
              say(engineCommand(state, en0, io.env), typeof en0 === 'object' && 'error' in en0 ? 'warn' : 'info', 6);
              draw();
              continue;
            }
            // task-1324: `/scan …` in the chat input is a command, never sent to claude.
            const sc0 = q.startsWith('/') ? parseScanCommand(q) : null;
            if (sc0) {
              state.aiInput = '';
              const before = state.screen;
              scanSay(typeof sc0 === 'object' ? sc0.error : scanCommand(state, sc0, stack), 'info', 5);
              if (state.screen !== before) { state.aiFocused = false; syncAnalyst(state); try { startTransition(); } catch { transition = null; } }
              draw();
              continue;
            }
            // task-1401: a CA or a dexscreener / pump.fun / solscan / birdeye link in the chat opens that coin's token
            // view (read-only, the go-to path); any question typed with it is then asked about THAT coin.
            const before = state.screen;
            if (chatOpenCoin(state, stack, q, { ask: sendChat, say })) {
              if (state.screen !== before) { try { startTransition(); } catch { transition = null; } }
              draw();
              continue;
            }
            if (q) { state.aiInput = ''; try { sendChat(q); } catch (e) { state.screener.notice = `⚠ ask failed: ${describeError(e)}`; } }
            draw();
            continue;
          }
          if (key.name === 'esc') {
            if (state.aiInput) state.aiInput = ''; else state.aiFocused = false;
            draw();
            continue;
          }
          if (key.name === 'backspace') { state.aiInput = (state.aiInput ?? '').slice(0, -1); draw(); continue; }
          if (key.ctrl && key.ch === 'u') { state.aiInput = ''; draw(); continue; }
          if (key.ctrl && key.ch === 'w') { state.aiInput = (state.aiInput ?? '').replace(/\s*\S+\s*$/, ''); draw(); continue; }
          if ((key.name === 'char' || key.name === 'space') && key.ch && !key.ctrl && !key.alt) {
            if ((state.aiInput ?? '').length < 400) state.aiInput = (state.aiInput ?? '') + key.ch;
            draw();
            continue;
          }
          // tab / arrows fall through to the keymap (e.g. tab leaves to the next screen)
        }
        // task-1313 part F: a list-of-coins answer renders as a navigable table in the chat. While the
        // chat input is blurred and the current turn produced results, ↑↓ drive the table cursor, ⏎
        // jumps to the selected coin's token screen, `o` opens its PAPER ticket (edit phase only, never
        // confirms), and esc returns to the chat with the list + scroll intact. The numbers come from
        // live data; here we only navigate by the mint, which the app already knows (open_token path).
        if (state.screen === 'analyst' && !state.aiFocused && live && state.analyst?.hasResults) {
          const rows = resolveAnalystResults(state, state.analyst.results);
          if (rows.length) {
            const activate = (): boolean => { if (!state.aiResultsActive) { state.aiResultsActive = true; return true; } return false; };
            if (key.name === 'up') { activate(); state.analyst.moveResults(-1); draw(); continue; }
            if (key.name === 'down') { activate(); state.analyst.moveResults(1); draw(); continue; }
            if (state.aiResultsActive) {
              const pick = (): ResolvedResult | null => rows[Math.max(0, Math.min(rows.length - 1, state.analyst!.resultsCursor))] ?? null;
              if (key.name === 'esc') { state.aiResultsActive = false; draw(); continue; }
              if (key.name === 'enter') {
                const r = pick();
                if (r) { live.openToken(seedForMint(state, live, r.mint, r.symbol)); stack.push(state.screen); state.screen = 'token'; state.aiResultsActive = false; state.aiFocused = false; syncAnalyst(state); try { startTransition(); } catch { transition = null; } }
                draw();
                continue;
              }
              if (key.name === 'char' && key.ch === 'o' && !key.ctrl && !key.alt) {
                const r = pick();
                if (r) { const s = seedForMint(state, live, r.mint, r.symbol); live.openTicket({ mint: s.mint, symbol: s.symbol, name: s.name }, 'buy'); stack.push(state.screen); state.screen = 'ticket'; state.aiResultsActive = false; state.aiFocused = false; try { startTransition(); } catch { transition = null; } }
                draw();
                continue;
              }
            }
          }
        }
        // Not focused yet on a chat screen: Enter focuses the input, the same as `i` (task-1311, B1).
        if (onChat && !state.aiFocused && key.name === 'enter') {
          state.aiFocused = true;
          if (state.screen === 'token') state.aiOpen = true;
          draw();
          continue;
        }
        const sc = state.screener;
        const editing = state.screen === 'screener' && sc.mode !== 'table';
        const plain = key.name === 'char' && !key.ctrl && !key.alt && key.ch !== undefined;
        if (!editing && plain && key.ch === 'c') {
          // calm toggle: off ↔ the last active tier
          if (isCalm(v)) { v.intensity = lastIntensity; v.baseline = lastIntensity === 'fever' ? 0.12 : 0; }
          else { lastIntensity = v.intensity; v.intensity = 'off'; v.trail.clear(); }
          flusher.invalidate();
          continue;
        }
        if (!editing && plain && sc.source === 'fixtures' && Object.hasOwn(DEMO_KEYS, key.ch as string)) {
          const kind = DEMO_KEYS[key.ch as string];
          try {
            const text = demoEvent(state, kind, rnd);
            say(text, kind === 'pump' ? 'up' : kind === 'dump' || kind === 'rug' ? 'down' : 'info', kind === 'rug' ? 4 : 3);
            moodHoldUntil = v.frame + fps * 8;
          } catch (e) {
            sc.notice = `⚠ demo event ${kind} failed: ${describeError(e)}`;
          }
          continue;
        }
        const before = state.screen;
        let fx: Effect;
        try {
          fx = applyKey(state, key, stack);
        } catch (e) {
          // No key may take the TUI down: surface the error in the status area and keep going.
          if (sc.mode !== 'table') sc.mode = 'table';
          sc.notice = `⚠ key ${JSON.stringify(key.raw)} failed: ${describeError(e)}`;
          continue;
        }
        if (fx === 'quit') { quit(); return; }
        if (fx === 'refresh') refresh();
        if (state.screen !== before) {
          // task-1311: leaving a chat screen blurs the input; entering one restores that screen's own
          // conversation (per-token, or the analyst tab) rather than a stale pointer to another token.
          state.aiFocused = false;
          syncAnalyst(state);
          try { startTransition(); } catch (e) { transition = null; sc.notice = `⚠ transition failed: ${describeError(e)}`; }
        }
      }
      startPushIfNeeded();
      hoverPrefetch();
      live?.syncFastSet(); // a watch add/remove or token open changes the fast set (cheap no-op otherwise)
      if (state.pendingAnalyst) beginAnalyst();
      if (state.pendingPopup) { const which = state.pendingPopup; state.pendingPopup = null; void (which === 'bubbles' ? togglePopupBubbles() : which === 'narrative' ? togglePopupNarrative() : which === 'plans' ? togglePopupPlans() : which === 'token' ? togglePopupToken() : which === 'feeds' ? togglePopupFeeds() : togglePopupChart()).catch((e) => { say(`${which} popup failed: ${describeError(e)}`, 'warn', 5); }); }
      // task-1358: a workspace's HUD popups, opened one after another (never toggled closed if already open).
      if (state.custom?.pendingPopups) { const specs = state.custom.pendingPopups; state.custom.pendingPopups = null; void openWorkspacePopups(specs); }
      // task-1358 Tier 3: an accepted rule proposal (paper ticket editor / analyst question) and rule popups/bells.
      drainRulesPending();
      if (state.screen === 'bubbles') syncBubblesPopup(); // selection / view changes reach the popup
      if (state.screen === 'narrative') syncNarrativePopup(); // board recompute reaches the popup
      if (state.screen === 'plans') syncPlansPopup(); // arm / cancel / tick status changes reach the popup
      syncWidgets(); // task-1358 Tier 5: open pack widgets follow the terminal (throttled per widget + topic)
      // task-1328: `/wallet …` — performed here because link opens a browser and probe opens a LIVE ticket.
      if (state.pendingWallet) {
        const wc = state.pendingWallet; state.pendingWallet = null;
        if (!live) say('wallet commands need live mode', 'warn', 5);
        else {
          if (wc === 'link') say('opening your browser to link a wallet (sign-a-message only; no transaction)…', 'info', 8);
          void live.walletCommand(wc).then((line) => {
            if (done) return;
            if (wc === 'probe' && live.ticket && live.ticket.ticket.mode === 'live') { if (state.screen !== 'ticket') { stack.push(state.screen); state.screen = 'ticket'; } }
            say(line, wc === 'panic' ? 'warn' : 'info', 8);
            scheduleDraw();
          }).catch((e) => { say(`wallet ${wc} failed: ${describeError(e)}`, 'warn', 6); scheduleDraw(); });
        }
      }
      if (state.pendingCopy) {
        const m = state.pendingCopy; state.pendingCopy = null;
        copyToClipboard(m);
        say(`copied CA  ${m.slice(0, 4)}…${m.slice(-4)}`, 'info');
      }
      if (state.pendingExport) {
        // task-1401: one key → PNG + text report of the current view in ~/.dexterm/exports. Nothing is uploaded.
        state.pendingExport = false;
        try {
          const [ew, eh] = size();
          const now = Date.now();
          const r = writeExport(exportViewFor(state, ew, eh, now), { now, env: io.env });
          say(`exported PNG + report → ${r.png.replace(homedir(), '~')} · local only, nothing uploaded`, 'info', 8);
        } catch (e) { say(`export failed: ${describeError(e)}`, 'warn', 6); }
      }
      if (state.pendingPnl) {
        // task-1407: open the PnL card preview for this screen (recorded fills only), then build the card.
        state.pendingPnl = false;
        const why = openPnl(state);
        if (why) say(why, 'warn', 6);
        else void loadPnl(state).then(() => { if (!done) draw(); });
      }
      if (state.pendingToast) {
        // task-1315: surface the link list / "no link" reply as a durable toast. Drained BEFORE
        // pendingOpen so that on a successful open the "opened <url>" toast overwrites the "open <url>" one.
        const m = state.pendingToast; state.pendingToast = null;
        say(m, 'info', 5);
      }
      if (state.pendingOpen) {
        const url = state.pendingOpen; state.pendingOpen = null;
        say(`open ${url}`, 'info', 5);
        draw(); // render the destination before invoking any external application
        setImmediate(() => {
          if (done) return;
          say(openInBrowser(url) ? `browser requested: ${url}` : `cannot open ${url}`, 'info');
          draw();
        });
      }
      if (live && state.screen === 'watchlist' && Date.now() - lastWatchRefresh >= WATCH_REFRESH_MS) { lastWatchRefresh = Date.now(); void live.watch.refresh(); }
      draw();
    };
    // task-1326: before the key handler owns stdin, ask the terminal which image protocol it speaks (kitty
    // query + cell size + DA1; ≤150 ms, replies parsed off the input; any early keypress is replayed). Skipped
    // when images are off or the protocol is pinned by DEXTERM_IMAGES / images.json.
    const attachInput = (leftover: string): void => { inp.on('data', onInput); if (leftover && !done) onInput(leftover); };
    const imgCfg = images ? resolveImagesConfig(io.env, args.noImages) : null;
    if (images && imgCfg && imgCfg.protocol === 'auto' && out.isTTY && inp.isTTY) {
      void queryTerminal({ write: (s) => out.write(s), onData: (cb) => { inp.on('data', cb); return () => inp.off('data', cb); } }, 150).then(({ facts, leftover }) => {
        if (done) return;
        applyCaps(resolveProtocol(io.env as never, facts));
        attachInput(leftover);
        flusher.invalidate();
        draw();
      });
    } else {
      if (images) applyCaps(resolveProtocol({ ...io.env, DEXTERM_IMAGES: imgCfg && imgCfg.protocol !== 'auto' ? imgCfg.protocol : io.env.DEXTERM_IMAGES } as never, null));
      attachInput('');
    }
    void imageCaps;
    out.on('resize', () => { flusher.invalidate(); transition = null; prevCanvas = null; draw(); });
    timer = setInterval(() => {
      stepVfx(v);
      state.now = new Date();
      // task-1358: a ctrl+w prefix expires after CHORD_TTL_MS (the badge on row 1 disappears with it)
      if (state.custom?.chord && Date.now() - state.custom.chordAt > CHORD_TTL_MS) { state.custom.chord = null; flusher.invalidate(); }
      try {
        if (state.screen === 'boot' && bootFrames) {
          state.boot.t = Math.min(1, v.frame / bootFrames);
          if (v.frame >= bootFrames + bootHold) endBoot();
        }
        if (v.frame % tickEvery === 0) {
          // task-1397: the "new version available" toast, once, after the boot and never over the welcome card.
          if (state.updateNotice && state.screen !== 'boot' && !state.overlay) { say(state.updateNotice, 'info', 8); state.updateNotice = null; }
          if (feed) {
            if (!state.paused && Date.now() - lastRefresh >= LIVE_REFRESH_MS) refresh();
            // live screens keep their own cadence (task-1298): token / watchlist every 10 s, new pairs recompute ages/rows at the 2 Hz tick
            if (live && !state.paused) {
              // task-1330: the social feed's own cadence (venues 60 s, RSS 10 min); it never creates timers itself.
              live.social.tick(Date.now());
              if (state.screen === 'token' && live.token && Date.now() - lastTokenRefresh >= TOKEN_REFRESH_MS) { lastTokenRefresh = Date.now(); void live.token.load(); }
              // task-1404: keep the open token's credit-metered holder/rug intel LIVE (slow cadence, budget-gated inside).
              if (state.screen === 'token' && live.token) live.refreshOpenIntel(Date.now());
              if (state.screen === 'watchlist' && Date.now() - lastWatchRefresh >= WATCH_REFRESH_MS) { lastWatchRefresh = Date.now(); void live.watch.refresh(); }
              if (state.screen === 'newpairs' || live.feedStarted) void live.newpairs.refresh();
              if (state.screen === 'newpairs') pinNewpairsSelection(state); // QA M8: keep the highlight on the picked mint
              // task-1310: mark PAPER positions at the live cadence; keep the ticket quote warm while editing.
              if (state.screen === 'positions' && Date.now() - lastPositionsRefresh >= POSITIONS_REFRESH_MS) { lastPositionsRefresh = Date.now(); live.positions.setSolPrice(state.sol?.price); void live.positions.refresh(); }
              if (state.screen === 'ticket' && live.ticket && live.ticket.ticket.phase === 'editing' && Date.now() - lastTicketQuote >= TICKET_QUOTE_MS) { lastTicketQuote = Date.now(); live.ticket.refreshQuote(); }
              // task-1324: AI scan tick (self-throttled to SCAN_TICK_MS; no requests, no draws of its own).
              if (state.scan?.engine.on) { try { scanTick(); } catch (e) { state.screener.notice = `⚠ scan tick failed: ${describeError(e)}`; } }
              // task-1358 Tier 3: rules engine tick (self-throttled, pure; outputs are toasts, the log, PROPOSAL cards, pending UI).
              if (state.rulesUi) { try { if (rulesTick(state, Date.now())) flusher.invalidate(); drainRulesPending(); drainDeliveries(); } catch (e) { state.screener.notice = `⚠ rules tick failed: ${describeError(e)}`; } }
              // task-1329: recorder maintenance (outcome sweeps at low limiter priority, labels, retention). It never
              // throws and never draws; the sweep is the only request path and it is budgeted inside maintain().
              if (live.recorder && recorderSchedule.due(Date.now())) void live.recorder.maintain(live.dl);
              // task-1356: keep the narrative board fresh while it is on screen (cheap, a few ms over cached rows).
              if (state.screen === 'narrative' && Date.now() - (state.narrative?.computedAt ?? 0) >= NARRATIVE_REFRESH_MS) {
                try { state.narrative = computeNarrativeView(state, state.narrative?.window ?? '1h'); } catch { /* keep the last board */ }
              }
            }
            state.refreshedAgo = feed.refreshedAgo();
          } else if (!state.paused) {
            tick(state.fx, rnd);
            state.screener.rows.forEach((r) => { if (r.fixture) Object.assign(r, { price: r.fixture.price, mcap: r.fixture.mcap, vol24: r.fixture.vol24, buys: r.fixture.buys, sells: r.fixture.sells, spark: r.fixture.spark }); });
            state.refreshedAgo = `${Math.floor(rnd() * 4) + 1}s`;
            // task-1358 Tier 3: rules run on the drifting fixture rows too (demo / fixtures mode).
            if (state.rulesUi) { try { if (rulesTick(state, Date.now())) flusher.invalidate(); drainRulesPending(); drainDeliveries(); } catch (e) { state.screener.notice = `⚠ rules tick failed: ${describeError(e)}`; } }
          }
          // market → rain: EMA on activity every tick, mood from the data every 4 s unless an event holds it
          blendActivity(v, activityFor(state), v.frame % (tickEvery * 8) === 0 && v.frame >= moodHoldUntil);
        }
        if (state.ai && state.ai.phase === 'thinking') {
          state.ai.ticks += 1;
          if (state.ai.ticks > fps * 1.6) { state.ai.phase = 'streaming'; state.ai.revealed = 0; }
        } else if (state.ai && state.ai.phase === 'streaming') {
          state.ai.revealed += Math.max(1, Math.round(90 / fps)); // ≈ 90 chars/s however fast we draw
          if (state.ai.revealed > 1400) state.ai = null;
        }
        if (v.toast && v.frame > v.toast.until) v.toast = null;
      } catch (e) {
        state.screener.notice = `⚠ tick failed: ${describeError(e)}`;
      }
      // Idle economy (task-1303 / task-1319 AC3): see shouldDrawFrame. Calm paints only on data ticks;
      // the full look paints every frame while the key wake window is open or an event animation is
      // live, and strides down to IDLE_FPS once the user has been idle for KEY_WAKE_S.
      if (!shouldDrawFrame({
        calm: isCalm(v),
        transition: transition !== null,
        onTick: v.frame % tickEvery === 0,
        aiLive: !!(state.ai && state.ai.phase !== 'done'),
        awake: v.frame < wakeUntil,
        fxBusy: fxBusy(v),
        frame: v.frame,
        idleEvery,
      })) return;
      draw();
    }, Math.round(1000 / fps));
    if (feed) refresh();
    startPushIfNeeded();
    // task-1324: --scan starts AI scan mode with the run (the same path as the Z key).
    if (args.scan) scanSay(scanCommand(state, 'on', stack), 'ai', 5);
    draw();
  });
}

/**
 * `trenchscope kol …` (task-1330): manage KOL lists on the shared SQLite DB (same --db as the app). Packs are
 * hash-locked directories (`pack.json` + `pack.lock`, optional `pack.lock.sig` verified against
 * ~/.dexterm/allowed_signers); a tampered pack is refused, never imported as "unsigned".
 */
export async function kolCommand(rest: string[], io: Io): Promise<number> {
  const dbi = rest.indexOf('--db');
  const dbPath = dbi >= 0 ? rest[dbi + 1] : defaultDbPath(io.env);
  const args = rest.filter((_, i) => i !== dbi && i !== dbi + 1);
  const cache = new Cache({ path: dbPath === ':memory:' ? undefined : dbPath });
  const kol = new KolStore({ cache, allowedSigners: join(dextermHome(io.env), 'allowed_signers') });
  const usage = 'usage: trenchscope kol list | create <name> | add <list> @handle | remove <list> @handle | mute @handle | unmute @handle | enable <list> | disable <list> | import <dir> | import-x  [--db PATH]';
  const findList = (name: string) => kol.all().find((l) => l.id === name || l.name === name || l.id === `manual:${name}` || l.name.startsWith(`${name}@`));
  try {
    const [cmd, a, b] = args;
    switch (cmd) {
      case undefined:
      case 'list': {
        const lists = kol.all();
        if (!lists.length) { io.stdout.write('no KOL lists · ' + usage + '\n'); return 0; }
        for (const l of lists) {
          io.stdout.write(`${l.enabled ? '◉' : '◌'} ${l.id}  ${l.name}  ${l.source}  ${l.tier}  ${l.handles.length} handles${l.wallets.length ? ` · ${l.wallets.length} wallets` : ''}${l.signed ? ` · ${l.signed.verified ? 'signed ✓' : 'unsigned'} · ${l.signed.publisher}` : ''}\n`);
          for (const h of l.handles) io.stdout.write(`    @${h}${kol.isMuted(h) ? '  (muted)' : ''}\n`);
        }
        const muted = kol.muted();
        if (muted.length) io.stdout.write(`muted: ${muted.map((h) => '@' + h).join(' ')}\n`);
        return 0;
      }
      case 'create': { if (!a) { io.stderr.write(usage + '\n'); return 2; } const l = kol.create(a); io.stdout.write(`created ${l.id}\n`); return 0; }
      case 'add':
      case 'remove': {
        if (!a || !b) { io.stderr.write(usage + '\n'); return 2; }
        const l = findList(a);
        if (!l) { io.stderr.write(`no such list: ${a}\n`); return 1; }
        if (cmd === 'add') { const r = kol.addHandle(l.id, b); if (!r.ok) { io.stderr.write(`not added: ${r.reason}\n`); return 1; } io.stdout.write(`added @${normalizeHandle(b)} to ${l.name}\n`); return 0; }
        io.stdout.write(kol.removeHandle(l.id, b) ? `removed @${normalizeHandle(b)} from ${l.name}\n` : `@${normalizeHandle(b)} was not in ${l.name}\n`);
        return 0;
      }
      case 'mute': { if (!a) { io.stderr.write(usage + '\n'); return 2; } kol.mute(a); io.stdout.write(`muted @${normalizeHandle(a)}\n`); return 0; }
      case 'unmute': { if (!a) { io.stderr.write(usage + '\n'); return 2; } kol.unmute(a); io.stdout.write(`unmuted @${normalizeHandle(a)}\n`); return 0; }
      case 'enable':
      case 'disable': {
        if (!a) { io.stderr.write(usage + '\n'); return 2; }
        const l = findList(a);
        if (!l) { io.stderr.write(`no such list: ${a}\n`); return 1; }
        kol.setEnabled(l.id, cmd === 'enable');
        io.stdout.write(`${l.name} ${cmd}d\n`);
        return 0;
      }
      // task-1357: the user's OWN X lists (list.read on their login) become `own-x-list` lists: handles only, never posts.
      case 'import-x': {
        const { importOwnXLists } = await import('./x-cmd.ts');
        const r = await importOwnXLists({ cache, env: io.env });
        if (!r.ok) { io.stderr.write(`trenchscope kol import-x: ${r.error}\n`); return 1; }
        if (!r.lists.length) { io.stdout.write('your X account owns no lists (create one on x.com first)\n'); return 0; }
        for (const l of r.lists) io.stdout.write(`imported ${l.id}  ${l.name}  ${l.handles} handles (own-x-list, kol-a)\n`);
        return 0;
      }
      case 'import': {
        if (!a) { io.stderr.write(usage + '\n'); return 2; }
        try {
          const l = kol.importPack(a);
          io.stdout.write(`imported ${l.name} (${l.handles.length} handles, ${l.signed?.verified ? 'signature verified' : 'unsigned'}, tier ${l.tier})\n`);
          return 0;
        } catch (e) {
          io.stderr.write(`refused: ${e instanceof PackError ? e.message : describeError(e)}\n`);
          return 1;
        }
      }
      default: io.stderr.write(usage + '\n'); return 2;
    }
  } finally {
    cache.close();
  }
}
