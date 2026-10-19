// trenchscope popup — dock the chart window beside the terminal (task-1325).
//
// macOS only (elsewhere every function degrades to "no docking": the shell's default geometry is used).
//
//   * Which terminal: TERM_PROGRAM (Apple_Terminal | iTerm.app), else LC_TERMINAL=iTerm2 (survives tmux/ssh).
//   * Which WINDOW: the one whose tab (Terminal.app) / session (iTerm2) has OUR controlling tty, found once and
//     then addressed by window id; the front window if no tty matches (e.g. inside tmux).
//   * One `osascript -l JavaScript` process does the work. It prints the screens first (AppKit, no Apple Events,
//     no permission), then the terminal window's bounds (Apple Events to the terminal app: from inside that
//     terminal this is the app talking to itself). With follow on it stays alive, re-checks every ~0.5 s, prints
//     only when something changed, and exits by itself when its parent (the TUI) is gone.
//   * Placement: right edge of the terminal, same top and height; left edge when the right side has no room;
//     overlapping the screen's right edge (always-on-top) when neither side has room; and for an unknown
//     terminal, the right edge of the main screen (always-on-top), full visible height.
//
// Nothing here reads keys, URLs or tickets: the script only carries our tty name and the terminal kind.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export type TerminalKind = 'terminal' | 'iterm' | 'unknown';
/** Logical points, top-left origin of the main display (what tao's LogicalPosition expects on macOS). */
export interface DockRect { x: number; y: number; w: number; h: number }
export interface DockScreen { frame: DockRect; visible: DockRect; scale: number }
export interface DockProbe { term: DockRect | null; screens: DockScreen[]; pending: boolean }
export interface DockPlacement { rect: DockRect; mode: 'right' | 'left' | 'overlap' | 'screen-right'; ontop: boolean; kind: TerminalKind }

/** The terminal app we run in, from the environment it sets. */
export function detectTerminal(env: NodeJS.ProcessEnv = process.env): TerminalKind {
  const tp = env.TERM_PROGRAM ?? '';
  if (tp === 'Apple_Terminal') return 'terminal';
  if (tp === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return 'iterm';
  return 'unknown';
}

/** Our controlling tty as the terminal apps report it (`/dev/ttys003`), or null. */
export function controllingTty(pid: number = process.pid, run: typeof spawnSync = spawnSync): string | null {
  try {
    const r = run('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 1500 });
    const t = String(r.stdout ?? '').trim();
    return /^ttys?\d+$/.test(t) ? `/dev/${t}` : null;
  } catch { return null; }
}

/** The JXA probe. `tty`/`kind` are JSON-encoded into the script (never interpolated raw). */
export function dockScript(kind: TerminalKind, tty: string | null, follow: boolean, everyS = 0.5): string {
  const every = Math.max(0.25, Math.min(5, Number.isFinite(everyS) ? everyS : 0.5));
  return `ObjC.import('AppKit');
ObjC.bindFunction('getppid', ['int', []]);
var KIND = ${JSON.stringify(kind)}, TTY = ${JSON.stringify(tty)}, FOLLOW = ${follow ? 'true' : 'false'}, EVERY = ${every};
var PARENT = $.getppid(), winId = null;
function rect(b) {
  if (!b) return null;
  if (Array.isArray(b) && b.length === 4) return [b[0], b[1], b[2] - b[0], b[3] - b[1]];
  if (typeof b.width === 'number') return [b.x, b.y, b.width, b.height];
  return null;
}
function screens() {
  var out = [], all = $.NSScreen.screens, mainH = all.objectAtIndex(0).frame.size.height;
  for (var i = 0; i < all.count; i++) {
    var s = all.objectAtIndex(i), f = s.frame, v = s.visibleFrame;
    out.push({ frame: [f.origin.x, mainH - f.origin.y - f.size.height, f.size.width, f.size.height],
               visible: [v.origin.x, mainH - v.origin.y - v.size.height, v.size.width, v.size.height], scale: s.backingScaleFactor });
  }
  return out;
}
function find(app, tabsOf) {
  if (!app.running()) return null;
  if (winId !== null) { try { return rect(app.windows.byId(winId).bounds()); } catch (e) { winId = null; } }
  var ws = app.windows();
  for (var i = 0; i < ws.length; i++) { if (TTY && tabsOf(ws[i])) { winId = ws[i].id(); return rect(ws[i].bounds()); } }
  return ws.length ? rect(ws[0].bounds()) : null;
}
function term() {
  try {
    if (KIND === 'terminal') return find(Application('com.apple.Terminal'), function (w) {
      var t = w.tabs(); for (var j = 0; j < t.length; j++) if (t[j].tty() === TTY) return true; return false; });
    if (KIND === 'iterm') return find(Application('com.googlecode.iterm2'), function (w) {
      var t = w.tabs(); for (var j = 0; j < t.length; j++) { var s = t[j].sessions(); for (var k = 0; k < s.length; k++) if (s[k].tty() === TTY) return true; } return false; });
  } catch (e) { return null; }
  return null;
}
function out(s) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
function run() {
  var sc = screens(), last = '';
  out(JSON.stringify({ screens: sc, term: null, pending: KIND !== 'unknown' }));
  for (;;) {
    var s = JSON.stringify({ screens: screens(), term: term(), pending: false });
    if (s !== last) { out(s); last = s; }
    if (!FOLLOW) return '';
    var pp = $.getppid(); if (pp !== PARENT || pp === 1) return '';
    delay(EVERY);
  }
}
`;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const toRect = (a: unknown): DockRect | null =>
  Array.isArray(a) && a.length === 4 && a.every(finite) && (a[2] as number) > 0 && (a[3] as number) > 0 ? { x: a[0], y: a[1], w: a[2], h: a[3] } : null;

/** Validate one probe line. Anything malformed → null (the caller keeps its last placement). */
export function parseDockProbe(line: string): DockProbe | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (!Array.isArray(r.screens) || r.screens.length === 0 || r.screens.length > 16) return null;
  const screens: DockScreen[] = [];
  for (const s of r.screens) {
    const so = (s ?? {}) as Record<string, unknown>;
    const frame = toRect(so.frame), visible = toRect(so.visible);
    if (!frame || !visible) return null;
    screens.push({ frame, visible, scale: finite(so.scale) ? so.scale : 1 });
  }
  return { screens, term: toRect(r.term), pending: r.pending === true };
}

const contains = (r: DockRect, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/**
 * Where the popup goes. Pure: unit-tested with synthetic screens/terminals.
 *   right   — the terminal's right edge, same top + height (a narrower window if 360–width pt fit)
 *   left    — mirrored, when the right side has no room
 *   overlap — neither side fits: the screen's right edge, always-on-top, over part of the terminal
 *   screen-right — unknown terminal: the main screen's right edge, full visible height, always-on-top
 */
export function dockRect(term: DockRect | null, screens: DockScreen[], kind: TerminalKind, opts: { width?: number; gap?: number } = {}): DockPlacement {
  const want = Math.max(360, Math.round(opts.width ?? 560));
  const gap = Math.max(0, Math.round(opts.gap ?? 4));
  const main = screens[0]?.visible ?? { x: 0, y: 25, w: 1440, h: 875 };
  if (!term) {
    const w = Math.min(want, Math.round(main.w * 0.5));
    return { rect: { x: main.x + main.w - w, y: main.y, w, h: main.h }, mode: 'screen-right', ontop: true, kind };
  }
  const cx = term.x + term.w / 2, cy = term.y + Math.min(term.h / 2, 40);
  const V = (screens.find((s) => contains(s.frame, cx, cy)) ?? screens[0])?.visible ?? main;
  const h = Math.max(200, Math.min(term.h, V.h));
  const y = Math.max(V.y, Math.min(term.y, V.y + V.h - h));
  const right = V.x + V.w - (term.x + term.w) - gap;
  const left = term.x - V.x - gap;
  if (right >= want) return { rect: { x: term.x + term.w + gap, y, w: want, h }, mode: 'right', ontop: false, kind };
  if (right >= 360) return { rect: { x: term.x + term.w + gap, y, w: right, h }, mode: 'right', ontop: false, kind };
  if (left >= want) return { rect: { x: term.x - gap - want, y, w: want, h }, mode: 'left', ontop: false, kind };
  const w = Math.min(want, V.w);
  return { rect: { x: V.x + V.w - w, y, w, h }, mode: 'overlap', ontop: true, kind };
}

const same = (a: DockPlacement | null, b: DockPlacement): boolean =>
  !!a && a.mode === b.mode && Math.abs(a.rect.x - b.rect.x) < 1 && Math.abs(a.rect.y - b.rect.y) < 1 && Math.abs(a.rect.w - b.rect.w) < 1 && Math.abs(a.rect.h - b.rect.h) < 1;

export interface TerminalDockOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  width?: number;
  gap?: number;
  followEvery?: number;
  /** Test seams. */
  spawnImpl?: (cmd: string, args: string[]) => ChildProcess;
  tty?: string | null;
}

/** Probes and follows the terminal window. Every failure degrades to "no docking"; it never throws. */
export class TerminalDock {
  readonly kind: TerminalKind;
  private readonly enabled: boolean;
  private readonly tty: string | null;
  private readonly opts: TerminalDockOptions;
  private child: ChildProcess | null = null;
  private last: DockPlacement | null = null;
  private readonly onExit = (): void => this.stop();

  constructor(opts: TerminalDockOptions = {}) {
    this.opts = opts;
    this.kind = detectTerminal(opts.env ?? process.env);
    this.enabled = (opts.platform ?? process.platform) === 'darwin';
    this.tty = opts.tty !== undefined ? opts.tty : (this.enabled && this.kind !== 'unknown' ? controllingTty() : null);
  }

  get following(): boolean { return this.child !== null; }

  private run(follow: boolean): ChildProcess {
    const args = ['-l', 'JavaScript', '-e', dockScript(this.kind, this.tty, follow, this.opts.followEvery)];
    return this.opts.spawnImpl ? this.opts.spawnImpl('osascript', args) : spawn('osascript', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  }

  private place1(p: DockProbe): DockPlacement {
    return dockRect(p.term, p.screens, p.term ? this.kind : (this.kind === 'unknown' ? 'unknown' : this.kind), { width: this.opts.width, gap: this.opts.gap });
  }

  /**
   * One probe, at most `timeoutMs`. Resolves with the terminal-docked placement, or — when the terminal did
   * not answer in time (first-run Automation prompt, app busy) — the screen-right placement from the screens
   * line, or null off macOS / when even that failed.
   */
  place(timeoutMs = 1500): Promise<DockPlacement | null> {
    if (!this.enabled) return Promise.resolve(null);
    return new Promise((resolve) => {
      let best: DockProbe | null = null, buf = '', done = false;
      let child: ChildProcess;
      try { child = this.run(false); } catch { resolve(null); return; }
      const finish = (): void => {
        if (done) return; done = true; clearTimeout(t);
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        const p = best ? this.place1(best) : null;
        if (p) this.last = p;
        resolve(p);
      };
      const t = setTimeout(finish, timeoutMs);
      child.on('error', finish);
      child.on('exit', finish);
      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const p = parseDockProbe(buf.slice(0, i)); buf = buf.slice(i + 1);
          if (p) { best = p; if (!p.pending) finish(); }
        }
      });
    });
  }

  /** Follow the terminal: `onPlace` fires on every changed placement. Idempotent; stop() ends it. */
  follow(onPlace: (p: DockPlacement) => void): void {
    if (!this.enabled || this.child || this.kind === 'unknown') return;
    let buf = '';
    try { this.child = this.run(true); } catch { this.child = null; return; }
    const child = this.child;
    child.on('error', () => { if (this.child === child) this.child = null; });
    child.on('exit', () => { if (this.child === child) this.child = null; });
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const p = parseDockProbe(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (!p || p.pending || !p.term) continue; // never jump to screen-right while following
        const pl = this.place1(p);
        if (!same(this.last, pl)) { this.last = pl; try { onPlace(pl); } catch { /* the window may be gone */ } }
      }
    });
    process.once('exit', this.onExit);
  }

  stop(): void {
    const c = this.child; this.child = null;
    process.removeListener('exit', this.onExit);
    if (c) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  }

  /** The child's pid while following (for the CPU measurement). */
  get pid(): number | undefined { return this.child?.pid; }
}
