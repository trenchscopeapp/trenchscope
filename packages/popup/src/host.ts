// trenchscope popup host — the window layer behind the PopupHost interface (task-1290).
//
// Two implementations, chosen at runtime:
//   * ShellPopupHost  — spawns the frameless wry shell (shell/wry) and speaks the stdio control protocol.
//                       Opens chromeless, transparent, always-on-top HUD windows. native = true.
//   * BrowserPopupHost — graceful fallback when the shell binary or a display is unavailable: opens the
//                       same loopback URL in the OS default browser (`open` / `xdg-open`). native = false.
//
// The popup URL (which carries a single-use ticket) is handed to the shell over STDIN, never argv, so `ps`
// from another local user cannot read it. The browser fallback necessarily passes it as an argument — that
// tradeoff is documented in the README threat notes; the ticket is single-use and loopback-only.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PopupHost, ShellEvent, ShellOp } from './protocol.ts';
import { DEFAULT_HOTKEY, DEFAULT_HOTKEY_CLOSE } from './config.ts';
import { isLoopbackUrl } from './loopback.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The built wry shell binary. `DEXTERM_POPUP_SHELL` overrides (e.g. a packaged location). */
export function shellBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEXTERM_POPUP_SHELL && env.DEXTERM_POPUP_SHELL.trim()) return env.DEXTERM_POPUP_SHELL;
  return path.join(here, '..', 'shell', 'wry', 'target', 'release', 'dexterm-shell-wry');
}

/** Whether a GUI display is reachable (a frameless window can be created). Browser fallback otherwise. */
export function displayAvailable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return true;              // macOS GUI session (a locked screen still has a display)
  if (platform === 'win32') return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);        // X11 / Wayland on Linux; empty in a headless/CI box
}

/** Whether `createPopupHost` would pick the native shell (binary present + display), without starting anything. */
export function nativeShellAvailable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return existsSync(shellBinaryPath(env)) && displayAvailable(env, platform);
}

export interface HostDecision {
  host: PopupHost;
  native: boolean;
  /** Human-readable reason for the choice, surfaced by the TUI/self-test. */
  reason: string;
}

export interface HostOptions {
  hotkey?: string;
  /** task-1325: the global chord that closes every popup. */
  hotkeyClose?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Force the browser fallback regardless of shell/display (tests, `--self-test --browser`, user preference). */
  forceBrowser?: boolean;
  /** The popup server's port: the browser fallback refuses to launch any other loopback origin when set. */
  port?: number;
  /** task-1358 r4: the loopback sink proxy's port; the shell routes every WebView connection through it. */
  proxyPort?: number;
}

/**
 * Decide and construct the host without starting it. The shell is chosen only when its binary exists AND a
 * display is available AND the browser was not forced; otherwise the browser fallback is returned with a
 * reason the caller can show the user ("wry shell not built", "no display", ...).
 */
export function createPopupHost(opts: HostOptions = {}): HostDecision {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (opts.forceBrowser) return { host: new BrowserPopupHost(platform, opts.port), native: false, reason: 'browser requested' };
  const bin = shellBinaryPath(env);
  if (!existsSync(bin)) return { host: new BrowserPopupHost(platform, opts.port), native: false, reason: `wry shell not built (${bin}); run \`npm run build:shell\` in @dexterm/popup` };
  if (!displayAvailable(env, platform)) return { host: new BrowserPopupHost(platform, opts.port), native: false, reason: 'no display available' };
  return { host: new ShellPopupHost({ bin, hotkey: opts.hotkey ?? DEFAULT_HOTKEY, hotkeyClose: opts.hotkeyClose ?? DEFAULT_HOTKEY_CLOSE, env, ...(opts.proxyPort ? { proxyPort: opts.proxyPort } : {}) }), native: true, reason: 'wry shell' };
}

// ------------------------------------------------------------------ shell host
export interface ShellHostDeps { bin: string; hotkey: string; env: NodeJS.ProcessEnv; hotkeyClose?: string; /** task-1358 r4 */ proxyPort?: number }

export class ShellPopupHost extends EventEmitter implements PopupHost {
  readonly native = true;
  private proc: ChildProcess | null = null;
  private spawnedAt = 0;
  private readonly bin: string;
  private readonly hotkey: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hotkeyClose: string;
  private readonly proxyPort: number | undefined;
  /** Set from shell.ready (task-1325). */
  hotkeyCloseRegistered = false;
  /** task-1358 r4: the sink proxy the shell confirmed in shell.ready (`127.0.0.1:<port>`), or null. */
  sinkProxy: string | null = null;
  constructor(deps: ShellHostDeps) { super(); this.bin = deps.bin; this.hotkey = deps.hotkey; this.env = deps.env; this.hotkeyClose = deps.hotkeyClose ?? DEFAULT_HOTKEY_CLOSE; this.proxyPort = deps.proxyPort; }

  async start(): Promise<{ hotkeyRegistered: boolean; spawnToReadyMs: number; sinkProxy: string | null }> {
    if (this.proc) return { hotkeyRegistered: false, spawnToReadyMs: 0, sinkProxy: this.sinkProxy };
    this.spawnedAt = performance.now();
    // The hotkey chord (and, r4, the sink proxy address) reach the shell via the environment, never a
    // shell-interpolated command line.
    const env = { ...this.env, DEXTERM_POPUP_HOTKEY: this.hotkey, DEXTERM_POPUP_HOTKEY_CLOSE: this.hotkeyClose, ...(this.proxyPort ? { DEXTERM_POPUP_PROXY: `127.0.0.1:${this.proxyPort}` } : {}) };
    this.proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let buf = '';
    this.proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev: ShellEvent;
        try { ev = JSON.parse(line); } catch { this.emit('stderr', line); continue; }
        this.emit('shell', ev);
        if (ev.ev) this.emit(ev.ev, ev);
      }
    });
    this.proc.stderr!.on('data', (d: Buffer) => this.emit('stderr', d.toString().trimEnd()));
    this.proc.on('exit', (code, sig) => { this.proc = null; this.emit('exit', { code, sig }); });
    this.proc.on('error', (err) => this.emit('error', err));
    const ready = await this.waitFor('shell.ready', 20_000) as ShellEvent & { ev: 'shell.ready' };
    this.hotkeyCloseRegistered = !!ready.hotkey_close_registered;
    this.sinkProxy = typeof ready.sink_proxy === 'string' ? ready.sink_proxy : null;
    return { hotkeyRegistered: !!ready.hotkey_registered, spawnToReadyMs: +(performance.now() - this.spawnedAt).toFixed(1), sinkProxy: this.sinkProxy };
  }

  private sendOp(op: ShellOp): void { if (!this.proc) throw new Error('shell not running'); this.proc.stdin!.write(JSON.stringify(op) + '\n'); }
  open(id: string, url: string, geom: { x?: number; y?: number; w?: number; h?: number; ontop?: boolean; focus?: boolean } = {}): void {
    // The URL reaching here is already pinned to our server origin (assertLoopbackUrl / a server ticket).
    // The shell pins every later navigation of this window to the same origin; `port` tells it which.
    let port: number | undefined;
    try { const u = new URL(url); port = Number(u.port || '80'); } catch { port = undefined; }
    this.sendOp({ op: 'open', id, url, port, x: geom.x ?? 80, y: geom.y ?? 80, w: geom.w ?? 960, h: geom.h ?? 640, ontop: geom.ontop ?? true, focus: geom.focus ?? false });
  }
  close(id: string): void { this.sendOp({ op: 'close', id }); }
  show(id: string): void { this.sendOp({ op: 'show', id }); }
  hide(id: string): void { this.sendOp({ op: 'hide', id }); }
  focus(id: string): void { this.sendOp({ op: 'focus', id }); }
  alwaysOnTop(id: string, on: boolean): void { this.sendOp({ op: 'ontop', id, on }); }
  clickThrough(id: string, on: boolean): void { this.sendOp({ op: 'clickthrough', id, on }); }
  move(id: string, x: number, y: number): void { this.sendOp({ op: 'move', id, x, y }); }
  setBounds(id: string, r: { x: number; y: number; w: number; h: number }): void { this.sendOp({ op: 'bounds', id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }); }
  snapshot(id: string, file: string): void { this.sendOp({ op: 'snapshot', id, path: file }); }
  quit(): void {
    if (!this.proc) return;
    try { this.sendOp({ op: 'quit' }); } catch { /* already gone */ }
    const p = this.proc;
    setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref();
  }
  get pid(): number | undefined { return this.proc?.pid; }

  waitFor(ev: string, timeoutMs = 10_000, pred: (e: unknown) => boolean = () => true): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, timeoutMs);
      const h = (e: unknown): void => { if (!pred(e)) return; clearTimeout(t); this.off(ev, h); resolve(e); };
      this.on(ev, h);
    });
  }
}

// ------------------------------------------------------------------ browser fallback host
/**
 * Opens popups as plain tabs/windows in the OS default browser. Everything else is a no-op: a browser tab
 * cannot be made always-on-top / click-through / frameless, and closing it is the user's job. The loopback
 * URL and its single-use ticket are identical to the shell path, so the security model is unchanged.
 */
export class BrowserPopupHost extends EventEmitter implements PopupHost {
  readonly native = false;
  private readonly platform: NodeJS.Platform;
  private readonly port: number | undefined;
  private readonly opened = new Set<string>();
  /** `port`: when known, only http://127.0.0.1:<port> URLs are ever launched (the manager passes the server's). */
  constructor(platform: NodeJS.Platform = process.platform, port?: number) { super(); this.platform = platform; this.port = port; }
  start(): Promise<null> { return Promise.resolve(null); }
  open(id: string, url: string): void {
    if (!openInBrowser(url, this.platform, this.port)) { this.emit('error', new Error(`refused to open ${url} in a browser on ${this.platform} (not our loopback origin, or no launcher)`)); return; }
    this.opened.add(id);
    this.emit('window.created', { ev: 'window.created', id, t_ms: 0, create_ms: 0 });
  }
  close(id: string): void { this.opened.delete(id); /* a browser tab cannot be closed from here */ }
  show(_id: string): void { /* no-op: a browser tab cannot be controlled from here */ }
  hide(_id: string): void { /* no-op */ }
  focus(_id: string): void { /* no-op */ }
  alwaysOnTop(_id: string, _on: boolean): void { /* no-op */ }
  clickThrough(_id: string, _on: boolean): void { /* no-op */ }
  move(_id: string, _x: number, _y: number): void { /* no-op */ }
  setBounds(_id: string, _r: { x: number; y: number; w: number; h: number }): void { /* no-op: a browser tab cannot be docked */ }
  quit(): void { this.opened.clear(); }
}

/**
 * Launch a URL in the OS browser: `open` (macOS) or `xdg-open` (Linux); `cmd /c start "" <url>` on Windows.
 * Only http://127.0.0.1 URLs are ever launched — enforced here by a parsed comparison (see loopback.ts),
 * not just assumed: https, remote hosts, userinfo (`http://127.0.0.1:1@evil.example/`), `localhost`,
 * `[::1]` and non-http schemes are refused so a remote page can never be opened via the fallback (ROADMAP
 * "no remote content"); with `port` given, any other loopback port is refused too. The URL is a single
 * argument — no shell interpolation. Returns false when refused or when no launcher is available.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform, port?: number): boolean {
  if (!isLoopbackUrl(url, port)) return false;
  const href = new URL(url).toString();
  const cmd = platform === 'darwin' ? ['open', href]
    : platform === 'win32' ? ['cmd', '/c', 'start', '', href]
      : ['xdg-open', href];
  try {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore' });
    p.on('error', () => {});
    p.unref?.();
    return true;
  } catch { return false; }
}
