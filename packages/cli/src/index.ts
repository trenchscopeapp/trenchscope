// trenchscope — library surface of the CLI package (used by tests and tools).
export * from './state.ts';
export * from './fixtures.ts';
export {
  parseArgs, stateFromArgs, applyScreenerArgs, applyEffectArgs, applyAction, applyAnalystAction, applyFollowNav, applyKey, colorDepthFor, intensityFor, asciiRainFor, fpsFor, demoEvent, main, interactive, terminalGuard, describeError, buildScreenState,
  HELP, LIVE_REFRESH_MS, FPS_BY_INTENSITY, MAX_FPS, DEMO_KEYS,
  type CliArgs, type Effect, type Io, type GuardProcess, type TerminalGuard, type DemoEvent, type AnalystActionResult,
} from './main.ts';
export { AnalystSession, parseResults, parseFilterApplied, type AnalystOpts, type AnalystStatus, type AnalystProposal, type AnalystResult } from './analyst/session.ts';
export { resolveAnalystResults, type ResolvedResult } from './analyst/results.ts';
export { runAnalyst, buildArgv, turnPrompt, analystContextBlock, untrusted, ASSETS as ANALYST_ASSETS, MCP_BIN, type AnalystRequest, type AnalystHandlers, type AnalystHandle, type ActionEvent } from './analyst/backend.ts';
export { renderAnalystSession, type AnalystRenderOpts } from './screens/analyst-session.ts';
export * from './boot-state.ts';
export * from './doctor.ts';
export { renderOverlay, renderGotoPrompt, OVERLAY_HINTS, helpRows, type HelpRow } from './screens/overlay.ts';
export * from './audit.ts';
export { renderBoot } from './screens/boot.ts';
export { renderScreener, screenerColumns, spotlight, COLUMN_GATE } from './screens/screener.ts';
export { renderToken, analystPanel } from './screens/token.ts';
export { renderNewPairs } from './screens/newpairs.ts';
export { renderWatchlist } from './screens/watchlist.ts';
export { renderAnalyst, renderContextRail, renderCoinList } from './screens/analyst.ts';
export { renderTicket } from './screens/ticket.ts';
export { renderPositions } from './screens/positions.ts';
export * from './trade.ts';
export { TradeTicketLive, PositionsLive, LivePositions, CombinedPositions, POSITIONS_REFRESH_MS, type TradeTicketOptions, type LiveTradeDeps } from './live/trade.ts';
export { parseWalletCommand, WALLET_HELP, type WalletCommand } from './wallet-command.ts';
export * from './screener/filter.ts';
export * from './screener/sort.ts';
export * from './screener/presets.ts';
export * from './screener/view.ts';
export { fromFixture, fromSnapshot, deriveFlags, impliedSpark, cleanText, type ScreenerRow } from './screener/rows.ts';
export * from './feed.ts';
export * from './images-config.ts';
export { drawCoin, imagesOn, popupImagePath, type CoinBox } from './screens/coin.ts';
