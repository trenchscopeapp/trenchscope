// @dexterm/tui — terminal image-protocol detection (task-1326).
//
// Two stages. (1) ENVIRONMENT, pure and instant: TERM_PROGRAM / TERM / a few vendor variables name the
// terminals whose protocol is known (kitty, Ghostty, WezTerm, Konsole → kitty graphics; iTerm2 → OSC 1337
// inline images; Apple Terminal.app, tmux, screen, unknown → half-block art). (2) A short CAPABILITY QUERY on
// the real tty: a kitty graphics probe (`ESC_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA ESC\`), a cell-size request
// (`CSI 16 t`) and primary device attributes (`CSI c`). The DA1 reply terminates the exchange on every
// terminal, so the reader stops at the first `c`-final CSI or after `timeoutMs`, whichever comes first;
// unknown terminals that answer nothing cost one timeout (default 150 ms) and get block art. Reply parsing
// is pure (`parseQueryReply`) so it is testable with recorded terminal output.
export type ImageProtocol = 'kitty' | 'iterm' | 'sixel' | 'blocks';

export interface ImageCaps {
  protocol: ImageProtocol;
  /** Cell size in pixels when the terminal reported it (sixel sizing, kitty aspect); null = unknown. */
  cellPx: { w: number; h: number } | null;
  /** Why this protocol was chosen (for `doctor` / the handoff). */
  reason: string;
  /** What the environment alone suggested, before the query. */
  envProtocol: ImageProtocol;
  /** Capability-query facts, when a query ran. */
  query?: QueryFacts;
}

export interface QueryFacts {
  kittyOk: boolean;
  sixel: boolean;
  da1: string | null;
  cellPx: { w: number; h: number } | null;
  /** Bytes consumed by the reply parser; anything after is input (keys) and must be handed back. */
  consumed: number;
  elapsedMs: number;
  timedOut: boolean;
}

export interface DetectEnv {
  TERM?: string; TERM_PROGRAM?: string; TERM_PROGRAM_VERSION?: string; LC_TERMINAL?: string;
  KITTY_WINDOW_ID?: string; GHOSTTY_RESOURCES_DIR?: string; WEZTERM_EXECUTABLE?: string; KONSOLE_VERSION?: string;
  TMUX?: string; STY?: string; WT_SESSION?: string; VSCODE_INJECTION?: string; DEXTERM_IMAGES?: string;
}

/** Stage 1: the environment's verdict. Pure. */
export function protocolFromEnv(env: DetectEnv): { protocol: ImageProtocol; reason: string } {
  const prog = (env.TERM_PROGRAM || '').toLowerCase();
  const term = (env.TERM || '').toLowerCase();
  const lcTerm = (env.LC_TERMINAL || '').toLowerCase();
  // Multiplexers do not pass graphics through without extra setup: block art is the only safe answer.
  if (env.TMUX || prog === 'tmux' || term.startsWith('tmux') || term.startsWith('screen') || env.STY) return { protocol: 'blocks', reason: 'tmux/screen multiplexer (no graphics passthrough)' };
  if (env.KITTY_WINDOW_ID || prog === 'kitty' || term === 'xterm-kitty') return { protocol: 'kitty', reason: 'kitty' };
  if (prog === 'ghostty' || term === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR) return { protocol: 'kitty', reason: 'Ghostty (kitty graphics)' };
  if (prog === 'wezterm' || env.WEZTERM_EXECUTABLE) return { protocol: 'kitty', reason: 'WezTerm (kitty graphics)' };
  if (env.KONSOLE_VERSION) return { protocol: 'kitty', reason: 'Konsole (kitty graphics)' };
  if (prog === 'iterm.app' || lcTerm === 'iterm2') return { protocol: 'iterm', reason: 'iTerm2 (inline images)' };
  if (prog === 'apple_terminal') return { protocol: 'blocks', reason: 'Apple Terminal.app has no inline-image protocol' };
  if (prog === 'vscode' || env.VSCODE_INJECTION) return { protocol: 'blocks', reason: 'VS Code terminal (images off by default)' };
  if (env.WT_SESSION) return { protocol: 'blocks', reason: 'Windows Terminal (sixel only when advertised)' };
  return { protocol: 'blocks', reason: `unknown terminal (${env.TERM_PROGRAM || env.TERM || 'no TERM'})` };
}

/** The probe bytes written to the tty: kitty query, cell-size report, DA1 (always answered last). */
export const CAPABILITY_QUERY = '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[c';

/**
 * Stage 2 parser, pure: scan a reply buffer for the kitty acknowledgement, the `CSI 6;h;w t` cell size and
 * the DA1 `CSI ? … c` line; sixel is advertised as parameter 4 in DA1. Returns how many bytes belong to
 * the replies (the rest is user input). `done` is true once DA1 arrived.
 */
export function parseQueryReply(buf: string): { facts: Omit<QueryFacts, 'elapsedMs' | 'timedOut'>; done: boolean } {
  let kittyOk = false, sixel = false, da1: string | null = null, cellPx: QueryFacts['cellPx'] = null;
  let consumed = 0;
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== '\x1b') { i += 1; continue; }
    // APC: ESC _ ... ESC \  (kitty reply: ESC_Gi=31;OK ESC\)
    if (buf[i + 1] === '_') {
      const end = buf.indexOf('\x1b\\', i + 2);
      if (end < 0) break; // partial
      const body = buf.slice(i + 2, end);
      if (/^Gi=31;OK/.test(body)) kittyOk = true;
      i = end + 2; consumed = i;
      continue;
    }
    if (buf[i + 1] === '[') {
      let j = i + 2;
      while (j < buf.length && /[0-9;?]/.test(buf[j])) j += 1;
      const fin = buf[j];
      if (fin === undefined) break; // partial CSI
      const params = buf.slice(i + 2, j);
      if (fin === 't') {
        const m = /^6;(\d+);(\d+)$/.exec(params);
        if (m) cellPx = { h: Number(m[1]), w: Number(m[2]) };
        i = j + 1; consumed = i; continue;
      }
      if (fin === 'c' && params.startsWith('?')) {
        da1 = params;
        const ps = params.slice(1).split(';');
        sixel = ps.includes('4');
        i = j + 1; consumed = i;
        return { facts: { kittyOk, sixel, da1, cellPx, consumed }, done: true };
      }
      // some other CSI (a key?): not ours — stop consuming here
      break;
    }
    break;
  }
  return { facts: { kittyOk, sixel, da1, cellPx, consumed }, done: false };
}

/** Stage 1 + 2 verdict, pure given the query facts. */
export function resolveProtocol(env: DetectEnv, q: QueryFacts | null): ImageCaps {
  const e = protocolFromEnv(env);
  const forced = (env.DEXTERM_IMAGES || '').toLowerCase();
  if (forced === 'kitty' || forced === 'iterm' || forced === 'sixel' || forced === 'blocks') return { protocol: forced, cellPx: q?.cellPx ?? null, reason: `DEXTERM_IMAGES=${forced}`, envProtocol: e.protocol, ...(q ? { query: q } : {}) };
  if (e.reason.startsWith('tmux')) return { protocol: 'blocks', cellPx: q?.cellPx ?? null, reason: e.reason, envProtocol: e.protocol, ...(q ? { query: q } : {}) };
  if (q?.kittyOk) return { protocol: 'kitty', cellPx: q.cellPx, reason: 'terminal answered the kitty graphics query', envProtocol: e.protocol, query: q };
  if (e.protocol === 'kitty' && (!q || q.timedOut)) return { protocol: 'kitty', cellPx: q?.cellPx ?? null, reason: `${e.reason}; query unanswered, trusting the environment`, envProtocol: e.protocol, ...(q ? { query: q } : {}) };
  if (e.protocol === 'kitty' && q && !q.kittyOk) return { protocol: q.sixel ? 'sixel' : 'blocks', cellPx: q.cellPx, reason: `${e.reason} but the kitty query was refused`, envProtocol: e.protocol, query: q };
  if (e.protocol === 'iterm') return { protocol: 'iterm', cellPx: q?.cellPx ?? null, reason: e.reason, envProtocol: e.protocol, ...(q ? { query: q } : {}) };
  if (q?.sixel) return { protocol: 'sixel', cellPx: q.cellPx, reason: 'DA1 advertises sixel', envProtocol: e.protocol, query: q };
  return { protocol: 'blocks', cellPx: q?.cellPx ?? null, reason: e.reason, envProtocol: e.protocol, ...(q ? { query: q } : {}) };
}

export interface QueryIo {
  write(s: string): void;
  /** Subscribe to raw input chunks; returns an unsubscribe. */
  onData(cb: (chunk: string) => void): () => void;
  now?: () => number;
}

/**
 * Run the capability query on a raw-mode tty. Resolves with the facts plus any trailing bytes that were
 * NOT part of a reply (early keypresses), so the caller can feed them to its key parser. Never rejects.
 */
export function queryTerminal(io: QueryIo, timeoutMs = 150): Promise<{ facts: QueryFacts; leftover: string }> {
  const now = io.now ?? (() => Date.now());
  const t0 = now();
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    let off: () => void = () => {};
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      const { facts } = parseQueryReply(buf);
      resolve({ facts: { ...facts, elapsedMs: now() - t0, timedOut }, leftover: buf.slice(facts.consumed) });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    off = io.onData((chunk) => {
      buf += chunk;
      if (parseQueryReply(buf).done) finish(false);
    });
    try { io.write(CAPABILITY_QUERY); } catch { finish(true); }
  });
}
