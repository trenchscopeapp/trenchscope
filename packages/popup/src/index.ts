// @dexterm/popup — loopback popup host: a frameless HUD-window layer (wry) with a graceful OS-browser
// fallback, driven by a loopback-only server and a typed protocol (task-1290). The terminal is the hub;
// heavy views (chart, token detail, feeds) open as chromeless always-on-top windows over the same data.
export * from './protocol.ts';
export { createPopupServer, POPUP_EVENTS, IMAGE_ROUTE_RE, IMAGE_ROUTE_PREFIX, type PopupServer, type PopupServerOptions } from './server.ts';
export { auditWidgetHtml, inlineHashes, normalizeWidgetHtml, cspHash, WIDGET_INLINE_MAX } from './widget-html.ts';
export { createPopupHost, ShellPopupHost, BrowserPopupHost, openInBrowser, shellBinaryPath, displayAvailable, nativeShellAvailable, type HostDecision, type HostOptions } from './host.ts';
export { createPopupManager, assertLoopbackUrl, type PopupManager, type PopupManagerOptions, type PopupHandle } from './open.ts';
export { loopbackUrlProblem, isLoopbackUrl } from './loopback.ts';
export { loadConfig, normalizeConfig, configPath, dexHome, DEFAULT_CONFIG, DEFAULT_HOTKEY, DEFAULT_HOTKEY_CLOSE, DEFAULT_DOCK, DEFAULT_RAIN, type PopupConfig, type DockConfig } from './config.ts';
export { detectTerminal, controllingTty, dockScript, parseDockProbe, dockRect, TerminalDock, type TerminalKind, type DockRect, type DockScreen, type DockProbe, type DockPlacement } from './dock.ts';
export { runSelfTest, renderSelfTest, fixtureChartVM, fixtureRosterVM, type SelfTestResult, type SelfTestOptions } from './selftest.ts';
