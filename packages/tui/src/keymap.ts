// @dexterm/tui — key decoding and keymap (SPEC §7.7: vim keys plus arrows, single-key verbs).
// parseKeys() turns a raw stdin chunk into named keys; Keymap maps named keys to actions,
// with per-screen overrides layered on a global table.

export type KeyName =
  | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'enter' | 'esc' | 'tab' | 'backspace' | 'delete' | 'space'
  | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12'
  | 'char';

export interface Key {
  name: KeyName;
  /** The printable character for name === 'char' (also set for ctrl+letter as the letter). */
  ch?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  raw: string;
}

const CSI_FINAL: Record<string, KeyName> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
  '1~': 'home', '2~': 'delete', '3~': 'delete', '4~': 'end', '5~': 'pageup', '6~': 'pagedown', '7~': 'home', '8~': 'end',
  '11~': 'f1', '12~': 'f2', '13~': 'f3', '14~': 'f4', '15~': 'f5', '17~': 'f6', '18~': 'f7', '19~': 'f8', '20~': 'f9', '21~': 'f10', '23~': 'f11', '24~': 'f12',
};
const SS3_FINAL: Record<string, KeyName> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };

/** Decode one raw stdin chunk (utf8 string) into zero or more keys. */
export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i];
    if (c === '\x1b') {
      const next = data[i + 1];
      if (next === '[') {
        // CSI: ESC [ params final
        let j = i + 2;
        let params = '';
        while (j < data.length && /[0-9;]/.test(data[j])) params += data[j++];
        const fin = data[j];
        if (fin === undefined) { keys.push({ name: 'esc', raw: c }); i = data.length; break; }
        // task-1388: bracketed-paste markers (ESC [ 200~ / 201~). trenchscope never enables the mode, but a
        // terminal/multiplexer that does would otherwise wrap a paste in them and the unknown-CSI branch
        // below would surface each as `esc` — cancelling the go-to prompt before the pasted mint arrives.
        // Swallow the markers so the printable paste flows through as plain chars.
        if (fin === '~' && (params === '200' || params === '201')) { i = j + 1; continue; }
        const raw = data.slice(i, j + 1);
        const parts = params.split(';');
        const mod = parts.length > 1 ? Number(parts[1]) - 1 : 0;
        const key = fin === '~' ? CSI_FINAL[`${parts[0]}~`] : CSI_FINAL[fin];
        if (key) {
          keys.push({ name: key, raw, shift: !!(mod & 1), alt: !!(mod & 2), ctrl: !!(mod & 4) });
        } else {
          keys.push({ name: 'esc', raw }); // unknown CSI, surface as esc so the UI still reacts
        }
        i = j + 1;
        continue;
      }
      if (next === 'O' && data[i + 2] && SS3_FINAL[data[i + 2]]) {
        keys.push({ name: SS3_FINAL[data[i + 2]], raw: data.slice(i, i + 3) });
        i += 3;
        continue;
      }
      if (next !== undefined && next !== '\x1b') {
        // alt+key
        const inner = parseKeys(next);
        for (const k of inner) keys.push({ ...k, alt: true, raw: c + k.raw });
        i += 2;
        continue;
      }
      keys.push({ name: 'esc', raw: c });
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') { keys.push({ name: 'enter', raw: c }); i++; continue; }
    if (c === '\t') { keys.push({ name: 'tab', raw: c }); i++; continue; }
    if (c === '\x7f' || c === '\b') { keys.push({ name: 'backspace', raw: c }); i++; continue; }
    if (c === ' ') { keys.push({ name: 'space', ch: ' ', raw: c }); i++; continue; }
    const code = c.charCodeAt(0);
    if (code < 32) {
      keys.push({ name: 'char', ch: String.fromCharCode(code + 96), ctrl: true, raw: c });
      i++;
      continue;
    }
    // printable (may be a surrogate pair)
    const cp = data.codePointAt(i) as number;
    const s = String.fromCodePoint(cp);
    keys.push({ name: 'char', ch: s, raw: s });
    i += s.length;
  }
  return keys;
}

/**
 * Canonical key id used in bindings: 'j', 'enter', 'up', 'ctrl+c', 'ctrl+l', 'alt+x', 'shift+tab'.
 * Printable characters are case-sensitive ('G' and 'g' differ).
 */
export function keyId(k: Key): string {
  const base = k.name === 'char' ? (k.ch ?? '') : k.name;
  let id = '';
  if (k.ctrl) id += 'ctrl+';
  if (k.alt) id += 'alt+';
  if (k.shift && k.name !== 'char') id += 'shift+';
  return id + base;
}

export interface Binding<A extends string = string> {
  keys: string[];
  action: A;
  /** Footer label, e.g. 'move'. */
  label?: string;
  /** Screen this binding applies to; omitted = global. */
  screen?: string;
}

export class Keymap<A extends string = string> {
  private global = new Map<string, Binding<A>>();
  private perScreen = new Map<string, Map<string, Binding<A>>>();
  /** First keys of two-key chords ("ctrl+w s" → "ctrl+w"), task-1358. */
  private prefixes = new Set<string>();
  readonly bindings: Binding<A>[] = [];

  constructor(bindings: Binding<A>[] = []) {
    for (const b of bindings) this.bind(b);
  }

  bind(b: Binding<A>): this {
    this.bindings.push(b);
    const target = b.screen ? this.getScreen(b.screen) : this.global;
    for (const k of b.keys) {
      target.set(k, b);
      const sp = k.indexOf(' ');
      if (sp > 0) this.prefixes.add(k.slice(0, sp));
    }
    return this;
  }

  /** Whether `id` starts a two-key chord (the loop then waits for the second key). */
  isPrefix(id: string): boolean { return this.prefixes.has(id); }

  /** Resolve an already-formed key id (or chord id like "ctrl+w s"): screen bindings first, then global. */
  resolveId(id: string, screen?: string): A | undefined {
    if (screen) {
      const hit = this.perScreen.get(screen)?.get(id);
      if (hit) return hit.action;
    }
    return this.global.get(id)?.action;
  }

  private getScreen(screen: string): Map<string, Binding<A>> {
    let m = this.perScreen.get(screen);
    if (!m) { m = new Map(); this.perScreen.set(screen, m); }
    return m;
  }

  /** Resolve a decoded key to an action: screen bindings first, then global. */
  resolve(k: Key, screen?: string): A | undefined {
    const id = keyId(k);
    if (screen) {
      const hit = this.perScreen.get(screen)?.get(id);
      if (hit) return hit.action;
    }
    return this.global.get(id)?.action;
  }

  /** Resolve a raw stdin chunk; returns one action per decoded key that matched. */
  resolveRaw(data: string, screen?: string): A[] {
    const out: A[] = [];
    for (const k of parseKeys(data)) {
      const a = this.resolve(k, screen);
      if (a !== undefined) out.push(a);
    }
    return out;
  }

  /** Bindings visible on a screen (global + that screen), for footers and the `?` overlay. */
  forScreen(screen?: string): Binding<A>[] {
    return this.bindings.filter((b) => !b.screen || b.screen === screen);
  }
}

/** Actions of the prototype's interactive loop plus the screener's (D-03) and the live screens' (task-1298). */
export type AppAction =
  | 'quit' | 'screen.screener' | 'screen.newpairs' | 'screen.watchlist' | 'screen.analyst' | 'screen.next'
  | 'move.down' | 'move.up' | 'move.top' | 'move.bottom' | 'move.pageup' | 'move.pagedown' | 'open' | 'back' | 'analyst.toggle' | 'input.focus' | 'copy.ca' | 'theme.next' | 'pause.toggle' | 'help.toggle'
  | 'filter.edit' | 'filter.clear' | 'sort.menu' | 'preset.next' | 'preset.prev' | 'refresh' | 'view.toggle'
  | 'watch.add' | 'watch.remove' | 'alert.propose' | 'alert.confirm' | 'alert.dismiss'
  | 'tf.1' | 'tf.2' | 'tf.3' | 'tf.4' | 'tf.5' | 'tf.6'
  // task-1310 PAPER trading: open the ticket pre-set to a side, and the positions screen.
  | 'trade.buy' | 'trade.sell' | 'screen.positions'
  // task-1315 LARP detector: open the coin's website / X / Telegram in the browser, or list all links.
  | 'open.web' | 'open.x' | 'open.tg' | 'open.links' | 'analyst.larp'
  // task-1290 popup host: open/toggle the live chart popup (frameless HUD window) for the open token.
  | 'popup.chart' | 'popup.token' | 'popup.feeds'
  // task-1323: the token screen's tape area shows BUY/SELL FLOW by default; this swaps in the raw trade tape.
  | 'tape.toggle'
  // task-1324 AI SCAN MODE: toggle the autonomous watcher; resume scanning after a lock.
  | 'scan.toggle' | 'scan.resume'
  // task-1330 keyless social layer: the TRENDING screen (T), the token screen's SOCIAL panel (s), KOL lists (K),
  // the panel/board verbs (f filter · x hidden spam · n narrative · a summary · s sources) and the KOL screen's verbs.
  | 'screen.trending' | 'social.toggle' | 'social.kol' | 'social.filter' | 'social.spam' | 'social.sources' | 'social.narrative' | 'social.summary'
  | 'kol.toggle' | 'kol.mute' | 'kol.remove' | 'kol.add' | 'kol.importx' | 'kol.focus'
  // task-1356 AI suite: the NARRATIVE BOARD screen (N, global) + its popup (p on that screen).
  | 'screen.narrative' | 'narrative.window' | 'narrative.popup'
  // task-1340 wallet intel: the BUBBLE MAP screen (M on the token screen), its popup (M there), treemap, zoom, deep scan.
  | 'intel.bubbles' | 'popup.bubbles' | 'bubbles.view' | 'bubbles.zoom' | 'bubbles.deep'
  // task-1282 JARVIS voice: push-to-talk. Handled in the interactive loop (the controller lives there),
  // so applyAction has no case for it; the binding exists for the footer hint and the `?` help card.
  // task-1411: the in-voice controls (only live once voice is on) — mute, cycle voice, nudge the speaking
  // rate slower/faster — are loop-handled the same way and documented here for the `?` help card.
  | 'voice.talk' | 'voice.mute' | 'voice.cycle' | 'voice.rate'
  // task-1355 order plans & standing mandates: the PLANS screen (O, global). On the screen, tab flips
  // plans ⇄ mandates, a arms the selected row (hold-to-confirm modal, physical keypress only), c cancels a
  // plan / r revokes a mandate, ! panics (revokes everything). Arming is NEVER reachable by voice/agent.
  | 'screen.plans' | 'plans.tab' | 'plans.arm' | 'plans.cancel' | 'plans.revoke' | 'plans.panic' | 'plans.popup' | 'plans.gate'
  // task-1363: L on the plans screen raises the FIRE PATH modal (paper ⇄ live devnet fast wallet); the switch itself is a captured keypress.
  | 'plans.live'
  // task-1360 copy trading: the FOLLOWED WALLETS screen (U, global): follow a wallet by typing its address (i), unfollow
  // (d), poll now (r, the global refresh). Alerts on a followed wallet's buys/sells are toasts anywhere. Read-only here.
  | 'screen.follows' | 'follows.add' | 'follows.remove'
  // Tier 2: m previews the MIRROR TICKET for the selected wallet's latest buy; m again PROPOSES it (an inert order plan).
  | 'follows.mirror'
  // Tier 3: A raises the AUTO-MIRROR modal for the selected wallet (enable = captured keypress in the loop; A while ON = off).
  | 'follows.auto'
  // task-1358 workspaces: a `ctrl+w` chord (tmux-like prefix; the second key within 1.5 s). w lists them,
  // n/N step, s saves the current layout under a typed name, m switches to the morning HUD, o opens the
  // active workspace's popups, d returns to the default; `ctrl+w 1..9` (loop-handled) picks a slot.
  | 'workspace.list' | 'workspace.next' | 'workspace.prev' | 'workspace.save' | 'workspace.morning' | 'workspace.popups' | 'workspace.default'
  // task-1358 Tier 3 rules engine: the RULES screen (ctrl+r, global). On it: i types a new rule, ⏎ edits the selected
  // one (a live "would match N rows" dry-run while typing), space toggles enabled, d deletes, tab flips rules ⇄
  // proposals, x dismisses a proposal; ⏎ on a proposal ACTS on it (opens the paper ticket editor / asks the analyst —
  // the user still confirms there). Rules only alert or PROPOSE; nothing on this screen arms or signs.
  | 'screen.rules' | 'rules.new' | 'rules.edit' | 'rules.toggle' | 'rules.remove' | 'rules.tab' | 'rules.dismiss' | 'rules.act'
  // task-1366: `$` flips the price display mode (USD price ⇄ market cap) everywhere and persists it to config.json.
  | 'display.priceMode'
  // task-1388 GO-TO prompt: `g` on the list and token screens opens a one-line input; paste or type a base58
  // mint (or a dexscreener/pump.fun/solscan URL) and ⏎ opens that coin's live token screen (read-only). Esc
  // cancels, bad input shows a notice. Per-screen so the global `g` (move to top) still has `home`.
  | 'goto.open'
  // task-1401 EXPORT / SHARE: `E` (global, unused before) renders the current view to a PNG + a text report in
  // ~/.dexterm/exports with its data ages and the LIVE / SAMPLE / REPLAY label. Local files only; nothing uploads.
  | 'export.view'
  // task-1407 PNL CARDS: `H` on the token, positions and followed-wallets screens previews a shareable PnL card built from
  // recorded fills (PAPER / LIVE / TRACKED stamp); share = save + clipboard + X compose intent in the user's browser.
  | 'pnl.card';

/** The prototype's key table (README of dexterm/prototype) plus the SPEC §4.1 screener keys. */
export const DEFAULT_KEYMAP = new Keymap<AppAction>([
  { keys: ['q', 'ctrl+c'], action: 'quit', label: 'quit' },
  { keys: ['1'], action: 'screen.screener', label: 'screener' },
  { keys: ['2'], action: 'screen.newpairs', label: 'new pairs' },
  { keys: ['3'], action: 'screen.watchlist', label: 'watchlist' },
  { keys: ['4'], action: 'screen.analyst', label: 'analyst' },
  { keys: ['tab'], action: 'screen.next', label: 'screens' },
  { keys: ['j', 'down'], action: 'move.down', label: 'move' },
  { keys: ['k', 'up'], action: 'move.up', label: 'move' },
  { keys: ['g', 'home'], action: 'move.top', label: 'top' },
  { keys: ['G', 'end'], action: 'move.bottom', label: 'bottom' },
  // task-1388 GO-TO prompt: `g` on the list and token screens opens the "open any coin" input. Per-screen so it
  // overrides the global `g` (move to top) only here; `home` still moves to top on these screens. Collision-free
  // with every other verb on these screens (the token screen's `g` was only "scroll answer to top", kept on home).
  { keys: ['g'], action: 'goto.open', label: 'go to coin', screen: 'screener' },
  { keys: ['g'], action: 'goto.open', label: 'go to coin', screen: 'newpairs' },
  { keys: ['g'], action: 'goto.open', label: 'go to coin', screen: 'watchlist' },
  { keys: ['g'], action: 'goto.open', label: 'go to coin', screen: 'token' },
  { keys: ['pagedown', 'ctrl+f'], action: 'move.pagedown', label: 'page' },
  { keys: ['pageup', 'ctrl+b'], action: 'move.pageup', label: 'page' },
  { keys: ['enter'], action: 'open', label: 'open' },
  { keys: ['esc', 'backspace'], action: 'back', label: 'back' },
  { keys: ['a'], action: 'analyst.toggle', label: 'ask claude' },
  // task-1282 JARVIS voice: push-to-talk toggle (hold not possible in a terminal). Lowercase v is free
  // on every screen; the loop auto-enables voice mode on first use and shows a live mic indicator.
  { keys: ['v'], action: 'voice.talk', label: 'voice' },
  // task-1411: in-voice controls (loop-handled; only act while voice is on). `m` mute, `,` change voice,
  // `<`/`>` slow down / speed up the spoken reply (saved to config.voice.rate). Per-screen `m` bindings
  // (kol/bubbles/follows) override this global one on those screens, exactly like `voice.talk`.
  { keys: ['m'], action: 'voice.mute', label: 'mute voice' },
  { keys: [','], action: 'voice.cycle', label: 'change voice' },
  { keys: ['<', '>'], action: 'voice.rate', label: 'slower / faster voice' },
  // task-1311: `i` focuses the chat input on the token / analyst screens (QA B1–B3); the loop only
  // captures keystrokes into the input while it is focused, so the number keys and `q` never type.
  { keys: ['i'], action: 'input.focus', label: 'ask', screen: 'token' },
  { keys: ['i'], action: 'input.focus', label: 'ask', screen: 'analyst' },
  { keys: ['?'], action: 'help.toggle', label: 'help' },
  { keys: ['t'], action: 'theme.next', label: 'theme' },
  { keys: ['p'], action: 'pause.toggle', label: 'pause' },
  // task-1366: `$` (unbound on every screen) toggles price ⇄ market cap on every screen + both charts; persisted.
  { keys: ['$'], action: 'display.priceMode', label: 'price ⇄ mcap' },
  // task-1401: `E` exports the current view (PNG + text report, local only). Free on every screen.
  { keys: ['E'], action: 'export.view', label: 'export PNG + report' },
  // task-1407: `H` (free capital everywhere) opens the PnL card preview on the screens that have fills to card.
  { keys: ['H'], action: 'pnl.card', label: 'PnL card (share)', screen: 'token' },
  { keys: ['H'], action: 'pnl.card', label: 'PnL card (share)', screen: 'positions' },
  { keys: ['H'], action: 'pnl.card', label: 'PnL card (share)', screen: 'follows' },
  // trenchscope: `f` switches the screener between the simple split view and the full table.
  { keys: ['f'], action: 'view.toggle', label: 'simple ⇄ full table', screen: 'screener' },
  { keys: ['/'], action: 'filter.edit', label: 'filter', screen: 'screener' },
  { keys: ['\\'], action: 'filter.clear', label: 'clear filter', screen: 'screener' },
  { keys: ['s'], action: 'sort.menu', label: 'sort', screen: 'screener' },
  { keys: [']', 'right', 'l'], action: 'preset.next', label: 'preset', screen: 'screener' },
  { keys: ['[', 'left', 'h'], action: 'preset.prev', label: 'preset', screen: 'screener' },
  { keys: ['r'], action: 'refresh', label: 'refresh', screen: 'screener' },
  // task-1298 live screens: watchlist keys and the token screen's timeframe tabs (SPEC §4.3 footer `1-6`)
  { keys: ['w'], action: 'watch.add', label: 'watch' },
  { keys: ['d'], action: 'watch.remove', label: 'remove', screen: 'watchlist' },
  { keys: ['b'], action: 'alert.propose', label: 'alert' },
  { keys: ['y'], action: 'alert.confirm', label: 'confirm alert' },
  { keys: ['x'], action: 'alert.dismiss', label: 'dismiss alert' },
  { keys: ['1'], action: 'tf.1', label: '1m', screen: 'token' },
  { keys: ['2'], action: 'tf.2', label: '5m', screen: 'token' },
  { keys: ['3'], action: 'tf.3', label: '15m', screen: 'token' },
  { keys: ['4'], action: 'tf.4', label: '1h', screen: 'token' },
  { keys: ['5'], action: 'tf.5', label: '4h', screen: 'token' },
  { keys: ['6'], action: 'tf.6', label: '1d', screen: 'token' },
  // task-1311 (QA B5): copy the full contract address from the token screen. Overrides the global
  // `y` (confirm alert) on this screen only.
  { keys: ['y'], action: 'copy.ca', label: 'copy CA', screen: 'token' },
  { keys: ['r'], action: 'refresh', label: 'refresh', screen: 'token' },
  { keys: ['r'], action: 'refresh', label: 'refresh', screen: 'newpairs' },
  { keys: ['r'], action: 'refresh', label: 'refresh', screen: 'watchlist' },
  // task-1310 PAPER trading. Capital B/S on the token screen open the ticket (collision-free with the
  // global `b` alert and screener `s` sort); `P` opens the positions screen from anywhere.
  { keys: ['B'], action: 'trade.buy', label: 'paper buy', screen: 'token' },
  { keys: ['S'], action: 'trade.sell', label: 'paper sell', screen: 'token' },
  { keys: ['P'], action: 'screen.positions', label: 'positions' },
  { keys: ['r'], action: 'refresh', label: 'refresh', screen: 'positions' },
  // task-1315 LARP detector: open the coin's advertised links from the token screen. Capital letters
  // stay collision-free with the lowercase verbs (t theme, w watch, x dismiss) and the B/S/P pattern.
  { keys: ['W'], action: 'open.web', label: 'open site', screen: 'token' },
  { keys: ['V'], action: 'analyst.larp', label: 'vet product (Claude)', screen: 'token' },
  { keys: ['X'], action: 'open.x', label: 'open X', screen: 'token' },
  { keys: ['T'], action: 'open.tg', label: 'open TG', screen: 'token' },
  { keys: ['L'], action: 'open.links', label: 'links', screen: 'token' },
  // task-1290 popup host: `C` on the token screen opens/toggles the frameless live-chart HUD window for
  // the open coin. (`P` is already the global positions key, so chart uses `C`.) Collision-free with the
  // token screen's other capitals (B/S trade, W/X/T/L links, V vet).
  { keys: ['C'], action: 'popup.chart', label: 'chart popup', screen: 'token' },
  // task-1359: `I` on the token screen opens/toggles the TOKEN-DETAIL HUD (identity, market, risk, snipers/bundled
  // from the wallet-intel scan); `M` on the trending screen opens/toggles the FEEDS HUD (the keyless social feed +
  // official news, newest first; ⏎ in the window opens that coin here). Both are read-only windows. `I` is unused
  // on the token screen (lowercase `i` stays "ask"); `M` on trending matches the M = popup pattern of the
  // narrative / bubbles / plans screens.
  { keys: ['I'], action: 'popup.token', label: 'token popup', screen: 'token' },
  { keys: ['M'], action: 'popup.feeds', label: 'feeds popup', screen: 'trending' },
  // task-1323: `F` flips the token screen's lower-right panel between BUY/SELL FLOW (default) and the raw
  // trade tape. `T` is already "open Telegram" on this screen, so the tape uses F (flow ⇄ tape).
  { keys: ['F'], action: 'tape.toggle', label: 'flow ⇄ tape', screen: 'token' },
  // task-1324 AI SCAN MODE: `Z` toggles the scan anywhere (unused elsewhere, collision-free with every
  // lowercase verb and the token screen's capitals B/S/P/W/V/X/T/L/C/F); `R` resumes scanning after a
  // lock (lowercase `r` stays refresh). Both are inert while the PAPER ticket or a text input has the keys.
  { keys: ['Z'], action: 'scan.toggle', label: 'AI scan' },
  { keys: ['R'], action: 'scan.resume', label: 'resume scan' },
  // task-1330 keyless social layer. `T` opens TRENDING IN THE SPACE from every screen except the token screen
  // (where `T` stays "open Telegram", task-1315; esc then T). `K` opens the KOL lists anywhere (unused before).
  // On the token screen lowercase `s` (unbound there) toggles the SOCIAL panel in place of ON-CHAIN/HOLDERS.
  // On the trending screen: f cycles the source filter, x shows/hides spam + squat rows, n cycles the narrative
  // filter, s shows the sources/health panel, a asks the analyst for the board summary (one chat turn), r refreshes.
  { keys: ['T'], action: 'screen.trending', label: 'trending' },
  { keys: ['K'], action: 'social.kol', label: 'KOL lists' },
  // task-1356 narrative board: global N opens it; on the board, w flips the 1h/24h window and M opens the HUD popup.
  { keys: ['N'], action: 'screen.narrative', label: 'narrative board' },
  { keys: ['w'], action: 'narrative.window', label: '1h/24h', screen: 'narrative' },
  { keys: ['M'], action: 'narrative.popup', label: 'popup', screen: 'narrative' },
  { keys: ['s'], action: 'social.toggle', label: 'social', screen: 'token' },
  { keys: ['f'], action: 'social.filter', label: 'filter', screen: 'trending' },
  { keys: ['x'], action: 'social.spam', label: 'hidden spam', screen: 'trending' },
  { keys: ['n'], action: 'social.narrative', label: 'narrative', screen: 'trending' },
  { keys: ['s'], action: 'social.sources', label: 'sources', screen: 'trending' },
  { keys: ['a'], action: 'social.summary', label: 'summary (claude)', screen: 'trending' },
  { keys: ['r'], action: 'refresh', label: 'refresh', screen: 'trending' },
  { keys: ['f'], action: 'social.filter', label: 'filter', screen: 'token' },
  // KOL screen: space toggles the selected list for the trending feed, m mutes/unmutes the selected handle,
  // d removes the selected handle from a manual list, i types a new handle into the selected manual list.
  { keys: ['space'], action: 'kol.toggle', label: 'enable/disable list', screen: 'kol' },
  { keys: ['m'], action: 'kol.mute', label: 'mute/unmute', screen: 'kol' },
  { keys: ['d'], action: 'kol.remove', label: 'remove handle', screen: 'kol' },
  { keys: ['i'], action: 'kol.add', label: 'add handle', screen: 'kol' },
  // task-1357 Login with X: X imports the user's OWN X lists (handles only, needs `trenchscope x login`); o focuses the
  // trending board + token panel on the selected handle (press again or f to clear).
  { keys: ['X'], action: 'kol.importx', label: 'import X lists', screen: 'kol' },
  { keys: ['o'], action: 'kol.focus', label: 'only this handle', screen: 'kol' },
  // task-1340 wallet intel. `M` on the token screen opens the BUBBLE MAP (holder graph: clusters by funding
  // source / same-slot buys / transfers, colour = rule) for the open coin; collision-free with the token screen's
  // other capitals (B/S/P/W/V/X/T/L/C/F/Z/R/K). On the bubble screen `M` opens/closes the popup HUD window, `m`
  // flips bubbles ⇄ treemap, `z` zooms the selected cluster, `D` forces a deep scan, `r` rescans, j/k select.
  { keys: ['M'], action: 'intel.bubbles', label: 'bubble map', screen: 'token' },
  { keys: ['M'], action: 'popup.bubbles', label: 'popup', screen: 'bubbles' },
  { keys: ['m'], action: 'bubbles.view', label: 'treemap ⇄ bubbles', screen: 'bubbles' },
  { keys: ['z'], action: 'bubbles.zoom', label: 'zoom cluster', screen: 'bubbles' },
  { keys: ['D'], action: 'bubbles.deep', label: 'deep scan', screen: 'bubbles' },
  { keys: ['r'], action: 'refresh', label: 'rescan', screen: 'bubbles' },
  // task-1355 order plans & standing mandates. `O` opens the PLANS screen from anywhere (collision-free with
  // every lowercase verb and the capitals B/S/P/W/V/X/T/L/C/F/Z/R/K/M/N/D). On the plans screen: tab flips
  // plans ⇄ mandates, `a` arms the selected row (opens the hold-to-confirm modal — a captured physical keypress
  // is the ONLY thing that arms; voice/agents can never reach this), `c` cancels the selected plan / `r` revokes
  // the selected mandate, `!` panics (revokes all), `M` opens the read-only popup. j/k select, esc backs out.
  { keys: ['O'], action: 'screen.plans', label: 'order plans' },
  { keys: ['tab'], action: 'plans.tab', label: 'plans ⇄ mandates', screen: 'plans' },
  { keys: ['a'], action: 'plans.arm', label: 'arm (hold)', screen: 'plans' },
  { keys: ['c'], action: 'plans.cancel', label: 'cancel plan', screen: 'plans' },
  { keys: ['r'], action: 'plans.revoke', label: 'revoke mandate', screen: 'plans' },
  { keys: ['!'], action: 'plans.panic', label: 'PANIC', screen: 'plans' },
  { keys: ['M'], action: 'plans.popup', label: 'popup', screen: 'plans' },
  { keys: ['G'], action: 'plans.gate', label: 'hands-free gate', screen: 'plans' },
  { keys: ['L'], action: 'plans.live', label: 'fire path paper/live', screen: 'plans' },
  // task-1360 copy trading. `U` opens the FOLLOWED WALLETS screen from anywhere (free capital: not B/S/P/W/V/X/T/L/C/F/Z/R/
  // K/M/N/D/O/G/I). On it: `i` types a wallet address (+ optional label) to follow, `d` unfollows the selected wallet,
  // `r` (global refresh) polls now. Nothing on this screen trades: a buy/sell alert is information only.
  { keys: ['U'], action: 'screen.follows', label: 'followed wallets' },
  { keys: ['i'], action: 'follows.add', label: 'follow a wallet', screen: 'follows' },
  { keys: ['d'], action: 'follows.remove', label: 'unfollow', screen: 'follows' },
  { keys: ['r'], action: 'refresh', label: 'poll now', screen: 'follows' },
  { keys: ['m'], action: 'follows.mirror', label: 'mirror ticket', screen: 'follows' },
  { keys: ['A'], action: 'follows.auto', label: 'auto-mirror', screen: 'follows' },
  // task-1358 workspaces (ctrl+w chord, global). `ctrl+w` itself is free everywhere except the chat input,
  // which owns it (delete word) while focused — the keymap never sees it there.
  { keys: ['ctrl+w w'], action: 'workspace.list', label: 'workspaces' },
  { keys: ['ctrl+w n', 'ctrl+w tab'], action: 'workspace.next', label: 'next workspace' },
  { keys: ['ctrl+w N'], action: 'workspace.prev', label: 'previous workspace' },
  { keys: ['ctrl+w s'], action: 'workspace.save', label: 'save workspace' },
  { keys: ['ctrl+w m'], action: 'workspace.morning', label: 'morning HUD' },
  { keys: ['ctrl+w o'], action: 'workspace.popups', label: 'open workspace popups' },
  { keys: ['ctrl+w d'], action: 'workspace.default', label: 'default workspace' },
  // task-1358 Tier 3 rules (ctrl+r global; the screen's own verbs below). Nothing here arms or signs: a rule's
  // ticket/ask is a PROPOSAL card; ⏎ on it opens the paper ticket editor / asks the analyst, where the user still confirms.
  { keys: ['ctrl+r'], action: 'screen.rules', label: 'rules' },
  { keys: ['i'], action: 'rules.new', label: 'new rule', screen: 'rules' },
  { keys: ['enter'], action: 'rules.act', label: 'edit / act', screen: 'rules' },
  { keys: ['e'], action: 'rules.edit', label: 'edit rule', screen: 'rules' },
  { keys: ['space'], action: 'rules.toggle', label: 'enable/disable', screen: 'rules' },
  { keys: ['d'], action: 'rules.remove', label: 'delete rule', screen: 'rules' },
  { keys: ['tab'], action: 'rules.tab', label: 'rules ⇄ proposals', screen: 'rules' },
  { keys: ['x'], action: 'rules.dismiss', label: 'dismiss proposal', screen: 'rules' },
]);
