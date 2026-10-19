// trenchscope popup host — the small, lane-reusable facade (task-1290 scope item 3).
//
//   const mgr = createPopupManager({ theme, onEvent });
//   const h = await mgr.open({ kind: 'chart', title: 'WIF', data: chartVm });   // opens a frameless HUD window
//   mgr.setData(h.id, nextChartVm);                                             // the popup follows the open coin
//   h.close();                                                                  // closing never touches the TUI
//
// The same `open({ kind, url|route, title })` is what Jarvis will call ("show me the bubble map for X") and
// what the trading lane's wallet bridge can call to render its loopback page in a chromeless window instead
// of the default browser — pass `url` for a custom loopback page, or `route` for one of the built-in kinds.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { createPopupServer, type PopupServer } from './server.ts';
import { createPopupHost } from './host.ts';
import { createSinkProxy, type SinkProxy } from './sinkproxy.ts';
import type { PopupHost, OpenPopupRequest, ThemeTokens, PopupRainConfig, PopupVM, ServerEvent, WidgetTopic, WidgetPayload } from './protocol.ts';
import { DEFAULT_HOTKEY, DEFAULT_RAIN } from './config.ts';

export interface PopupHandle {
  readonly id: string;
  readonly kind: string;
  /** True when this opened in a native frameless window, false when it fell back to the OS browser. */
  readonly native: boolean;
  /** Replace the popup's view model (no-op for a custom `url` page the server does not own). */
  setData(data: PopupVM): void;
  /** task-1358: push one topic's view model to a pack widget (no-op for other kinds). */
  sendData?(topic: WidgetTopic, payload: WidgetPayload): void;
  close(): void;
  show(): void;
  hide(): void;
  focus(): void;
  alwaysOnTop(on: boolean): void;
  /** task-1325: move + resize (docking). No-op under the browser fallback. Optional so older fakes still type-check. */
  setBounds?(r: { x: number; y: number; w: number; h: number }): void;
}

export interface PopupManagerOptions {
  theme?: ThemeTokens;
  rain?: PopupRainConfig;
  hotkey?: string;
  /** task-1325: global chord that closes every popup. */
  hotkeyClose?: string;
  /** Events from any popup (ready/perf/event/log/dropped/closed/probe.rejected). */
  onEvent?: (ev: ServerEvent) => void;
  /** A human-readable note when the host falls back to the browser, or the shell fails to start. */
  onWarn?: (msg: string) => void;
  forceBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** task-1326: coin images for popup headers, from the TUI's local cache (see PopupServerOptions.imageProvider). */
  imageProvider?: (key: string) => Uint8Array | null;
}

export interface PopupManager {
  /** Open a popup. Starts the server + window host on first use. */
  open(req: OpenPopupRequest): Promise<PopupHandle>;
  setData(id: string, data: PopupVM): void;
  close(id: string): void;
  /** True once started and a native shell is driving windows; false under the browser fallback. */
  readonly native: boolean;
  /** Why the current host was chosen (e.g. "wry shell", "no display available"). */
  readonly reason: string;
  /** Whether a global hotkey was registered by the shell (false under the browser fallback). */
  readonly hotkeyRegistered: boolean;
  readonly port: number | null;
  /**
   * task-1358 r4: pack widgets open ONLY in the native shell, and only once the shell has confirmed it routes every
   * WebView connection through the host's loopback sink proxy (see sinkproxy.ts). Under the browser fallback a widget
   * page would run in an engine the host does not control (the r3 verifier showed WebKit opening a TCP connection
   * for a runtime `<link rel=preconnect>`, which no CSP directive covers), so `open({ kind: 'widget' })` refuses there.
   */
  readonly widgetsAllowed?: boolean;
  /** Why widgets are (not) allowed right now, for the toast. */
  readonly widgetReason?: string;
  /** The sink proxy's port once started under the native shell (tests / evidence), else null. */
  readonly sinkProxyPort?: number | null;
  /** The sink proxy's counters (connections tunnelled to the popup server / refused), else null. */
  readonly sinkProxyStats?: { forwarded: number; refused: number } | null;
  shutdown(): Promise<void>;
}

/** macOS major (Darwin kernel major − 9): WKWebsiteDataStore.proxyConfigurations needs macOS 14 = Darwin 23. */
const darwinMajor = (): number => Number(os.release().split('.')[0]) || 0;

// A custom popup URL may only point at our own loopback server origin (http://127.0.0.1:<server-port>/…).
// This enforces the ROADMAP "no remote content" rule in code, not just in the doc comment: https, any
// other host, any other port, userinfo and non-http schemes are all rejected before a window or browser
// tab opens. The rule itself lives in ./loopback.ts (shared with the browser fallback); re-exported here.
import { assertLoopbackUrl } from './loopback.ts';
export { assertLoopbackUrl, loopbackUrlProblem } from './loopback.ts';

export function createPopupManager(opts: PopupManagerOptions = {}): PopupManager {
  const emitter = new EventEmitter();
  if (opts.onEvent) emitter.on('event', opts.onEvent);
  let server: PopupServer | null = null;
  let host: PopupHost | null = null;
  let native = false;
  let reason = 'not started';
  let hotkeyRegistered = false;
  let hostDead = false;
  let startPromise: Promise<void> | null = null;
  const openIds = new Set<string>();
  // task-1358 r4: the sink proxy + the widget gate (see PopupManager.widgetsAllowed)
  let sinkProxy: SinkProxy | null = null;
  let widgetsOk = false;
  let widgetReason = 'popups not started';

  const warn = (m: string): void => { opts.onWarn?.(m); };
  const noWidgets = (why: string): void => { widgetsOk = false; widgetReason = why; };

  /** Swap a crashed native shell for the browser fallback so the next open() degrades instead of throwing. */
  async function switchToBrowser(why: string): Promise<void> {
    hostDead = false; native = false; hotkeyRegistered = false;
    reason = `${why}; using browser`;
    noWidgets(`browser fallback (${reason})`);
    const fb = createPopupHost({ forceBrowser: true, env: opts.env, platform: opts.platform, port: server?.port });
    host = fb.host;
    await host.start();
    warn(`popups open in your browser: ${reason}`);
  }

  async function ensureStarted(): Promise<void> {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      server = await createPopupServer({
        theme: opts.theme,
        rain: opts.rain ?? { ...DEFAULT_RAIN },
        onEvent: (ev) => emitter.emit('event', ev),
        ...(opts.imageProvider ? { imageProvider: opts.imageProvider } : {}),
      });
      const hostOpts = { hotkey: opts.hotkey ?? DEFAULT_HOTKEY, hotkeyClose: opts.hotkeyClose, forceBrowser: opts.forceBrowser, env: opts.env, platform: opts.platform, port: server.port };
      let decision = createPopupHost(hostOpts);
      if (decision.native) {
        // r4: the shell gets a loopback sink proxy that tunnels to the popup server and nowhere else; every
        // connection a WebView makes — page loads, the socket, a runtime <link rel=preconnect> — goes through it.
        const srvPort = server.port;
        sinkProxy = await createSinkProxy({ targetPort: srvPort, onRefused: (r) => emitter.emit('event', { ev: 'proxy.refused', ...r }) });
        decision = createPopupHost({ ...hostOpts, proxyPort: sinkProxy.port });
      }
      host = decision.host; native = decision.native; reason = decision.reason;
      if (!native) { warn(`popups open in your browser: ${reason}`); noWidgets(`browser fallback (${reason})`); }
      else {
        // If the native window shell dies (crash/kill), mark it dead so the next open() re-starts via the
        // browser fallback instead of letting a later close/open throw "shell not running" into the TUI.
        const nativeHost = host as unknown as { once?: (ev: string, cb: () => void) => void };
        nativeHost.once?.('exit', () => { hostDead = true; noWidgets('the popup shell exited'); });
      }
      try {
        const info = await host.start();
        if (info) hotkeyRegistered = info.hotkeyRegistered;
        if (native) {
          const confirmed = info?.sinkProxy ?? null;
          if ((opts.platform ?? process.platform) === 'darwin' && darwinMajor() < 23) noWidgets('the sink proxy needs macOS 14 or newer');
          else if (!sinkProxy || confirmed !== sinkProxy.address) noWidgets(`the popup shell did not confirm the sink proxy (${confirmed ?? 'none'})`);
          else { widgetsOk = true; widgetReason = `native shell behind the sink proxy ${sinkProxy.address}`; }
        }
      } catch (err) {
        // The shell was present but would not start (missing libs, no GUI session, crash): degrade to the
        // browser so a popup still opens, and tell the user why.
        reason = `shell failed to start (${(err as Error).message}); using browser`;
        native = false; hotkeyRegistered = false;
        noWidgets(`browser fallback (${reason})`);
        warn(`popups open in your browser: ${reason}`);
        const fb = createPopupHost({ forceBrowser: true, env: opts.env, platform: opts.platform, port: server.port });
        host = fb.host;
        await host.start();
      }
    })();
    return startPromise;
  }

  function handleFor(id: string, kind: string): PopupHandle {
    return {
      id, kind, native,
      setData: (data) => server?.setData(id, data),
      sendData: (topic, payload) => server?.sendData(id, topic, payload),
      close: () => { server?.closePopup(id); host?.close(id); openIds.delete(id); },
      show: () => host?.show(id),
      hide: () => host?.hide(id),
      focus: () => host?.focus(id),
      alwaysOnTop: (on) => host?.alwaysOnTop(id, on),
      setBounds: (r) => { if (native && !hostDead) host?.setBounds?.(id, r); },
    };
  }

  return {
    async open(req) {
      await ensureStarted();
      if (hostDead) await switchToBrowser('popup window shell exited');
      if (!server || !host) throw new Error('popup host failed to start');
      const id = `p_${randomBytes(6).toString('hex')}`;
      const kind = req.route ?? req.kind;
      // r4: a pack widget never opens in an engine the host does not route through its sink proxy
      if ((kind === 'widget' || req.widget) && !widgetsOk) throw new Error(`pack widgets open only in the native popup shell behind its sink proxy — ${widgetReason}`);
      // A custom loopback URL (e.g. the wallet bridge's own page) is pinned to our own loopback origin —
      // never a remote page; a built-in kind gets a single-use ticket URL from our server with the initial
      // view model attached. assertLoopbackUrl throws on https/other-host/other-port before anything opens.
      const url = req.url !== undefined
        ? assertLoopbackUrl(req.url, server.port)
        : server.issueTicket(kind, id, { ...(req.data ? { data: req.data } : {}), ...(req.widget ? { widget: req.widget } : {}), ...(native ? {} : { fallback: reason }) });
      host.open(id, url, req.geom);
      openIds.add(id);
      return handleFor(id, kind);
    },
    setData: (id, data) => server?.setData(id, data),
    close: (id) => { server?.closePopup(id); host?.close(id); openIds.delete(id); },
    get native() { return native; },
    get reason() { return reason; },
    get hotkeyRegistered() { return hotkeyRegistered; },
    get port() { return server?.port ?? null; },
    get widgetsAllowed() { return widgetsOk; },
    get widgetReason() { return widgetReason; },
    get sinkProxyPort() { return sinkProxy?.port ?? null; },
    get sinkProxyStats() { return sinkProxy ? { forwarded: sinkProxy.forwarded, refused: sinkProxy.refused } : null; },
    async shutdown() {
      try { host?.quit(); } catch { /* ignore */ }
      if (sinkProxy) { await sinkProxy.close(); sinkProxy = null; }
      noWidgets('popups shut down');
      if (server) await server.close();
      server = null; host = null; startPromise = null; openIds.clear();
    },
  };
}
