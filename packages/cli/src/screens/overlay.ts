// trenchscope — modal overlays (task-1305): the first-run WELCOME card (shown once, then reachable with
// `?`) and the `?` HELP card that lists every key for the screen underneath it. Both are drawn last,
// after the effects pass, so the card is crisp and no rain/scanline crosses it. Any key closes the
// overlay; `?` toggles help.
import { Canvas, DEFAULT_KEYMAP, mix, type Keymap, type AppAction, type Binding, type ScreenKey } from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { renderPnlOverlay } from '../pnl-app.ts';

/** Pretty single-key display for a keymap id ('enter' → '⏎', 'pagedown' → 'PgDn', 'ctrl+f' → '^F'). */
function prettyKey(id: string): string {
  switch (id) {
    case 'enter': return '⏎';
    case 'esc': return 'esc';
    case 'tab': return 'tab';
    case 'space': return 'spc';
    case 'up': return '↑'; case 'down': return '↓'; case 'left': return '←'; case 'right': return '→';
    case 'home': return 'home'; case 'end': return 'end';
    case 'pageup': return 'PgUp'; case 'pagedown': return 'PgDn';
    case 'backspace': return '⌫';
  }
  // task-1358 chords: "ctrl+w s" → "^W s"
  if (id.includes(' ')) return id.split(' ').map(prettyKey).join(' ');
  if (id.startsWith('ctrl+')) return '^' + id.slice(5).toUpperCase();
  if (id.startsWith('alt+')) return '⌥' + id.slice(4);
  return id;
}

/** Collapse a binding's key list to a compact display, dropping synonyms that render the same. */
function keysDisplay(b: Binding<AppAction>): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const k of b.keys) {
    const p = prettyKey(k);
    if (seen.has(p)) continue;
    seen.add(p);
    parts.push(p);
  }
  return parts.join('/');
}

/** A single "keys — what" help row. */
export interface HelpRow { keys: string; label: string }

/**
 * Extra behaviours handled directly in the interactive loop (not in the keymap), surfaced in help so
 * the overlay really does list every key. `fixtures` adds the demo-event keys that only fire on
 * `--fixtures`.
 */
export function OVERLAY_HINTS(screen: ScreenKey, fixtures: boolean): HelpRow[] {
  const rows: HelpRow[] = [
    { keys: 'c', label: 'calm mode (effects off)' },
    { keys: '?', label: 'this help' },
  ];
  if (screen === 'analyst') rows.unshift({ keys: 'type', label: 'ask a follow-up · ⏎ send · esc clear/back' });
  if (fixtures) rows.push({ keys: 'n/u/d/x', label: 'demo: new pair · pump · dump · rug' });
  return rows;
}

/** The help rows for a screen: the keymap bindings that apply there, plus the loop-handled extras.
 *  A global key shadowed by a screen-specific binding (e.g. `1` = timeframe on the token screen, not
 *  "screener") is attributed to the screen binding, mirroring Keymap.resolve's precedence. */
export function helpRows(screen: ScreenKey, fixtures: boolean, keymap: Keymap<AppAction> = DEFAULT_KEYMAP, overridden: ReadonlySet<string> = new Set()): HelpRow[] {
  const bindings = keymap.forScreen(screen);
  const screenKeys = new Set<string>();
  for (const b of bindings) if (b.screen === screen) for (const k of b.keys) screenKeys.add(k);
  const order: AppAction[] = [];
  const rowFor = new Map<AppAction, { label: string; keys: string[] }>();
  for (const b of bindings) {
    if (!b.label) continue;
    for (const k of b.keys) {
      if (!b.screen && screenKeys.has(k)) continue; // this global key is overridden on this screen
      let r = rowFor.get(b.action);
      if (!r) { r = { label: b.label, keys: [] }; rowFor.set(b.action, r); order.push(b.action); }
      r.keys.push(k);
    }
  }
  const rows: HelpRow[] = [];
  for (const action of order) {
    const r = rowFor.get(action)!;
    if (!r.keys.length) continue;
    // task-1358: a `·` marks a binding the user changed in config.keymap
    const mark = overridden.has(`|${action}`) || overridden.has(`${screen}|${action}`) ? ' ·' : '';
    rows.push({ keys: keysDisplay({ keys: r.keys, action }), label: r.label + mark });
  }
  return [...rows, ...OVERLAY_HINTS(screen, fixtures)];
}

const SCREEN_TITLE: Record<ScreenKey, string> = {
  screener: 'Screener', token: 'Token detail', newpairs: 'New pairs', watchlist: 'Watchlist', analyst: 'Analyst', boot: 'Screener',
  ticket: 'Paper trade ticket', positions: 'Paper positions',
  trending: 'Trending in the space', kol: 'KOL lists', bubbles: 'Bubble map', narrative: 'Narrative board',
  plans: 'Order plans & mandates', follows: 'Followed wallets', rules: 'Rules (alerts + proposals only)',
};

/** Draw a centered modal card and return its inner rect, or null when the terminal is too small. */
function card(c: Canvas, want: { w: number; h: number }, title: string, caption: string) {
  const w = Math.min(want.w, c.w - 2);
  const h = Math.min(want.h, c.h - 2);
  if (w < 24 || h < 6) return null;
  const x = Math.max(0, Math.floor((c.w - w) / 2));
  const y = Math.max(0, Math.floor((c.h - h) / 2));
  c.noRain(x, y, w, h);
  const box = c.box(x, y, w, h, { title, caption, focus: true, bg: c.theme.panelAlt });
  return box;
}

function renderWelcome(c: Canvas, state: AppState): void {
  const t = c.theme;
  const box = card(c, { w: 72, h: 22 }, 'WELCOME TO TRENCHSCOPE', 'press any key to start');
  if (!box) return;
  const bg = box.bg;
  let y = box.y;
  const line = (s: string, st = { fg: t.text, bg }) => { c.text(box.x + 2, y, s, st, box.w - 4); y += 1; };
  const gap = () => { y += 1; };
  line('A terminal dex screener for Solana — live, keyless, read-only.', { fg: t.muted, bg });
  line('Browse tokens, open a token for safety & holders, ask a local', { fg: t.muted, bg });
  line('Claude to scan the trenches. No wallet, no keys, no trades.', { fg: t.muted, bg });
  gap();
  c.text(box.x + 2, y, 'GET AROUND', { fg: t.accent, bg, b: true }); y += 1;
  const hints: Array<[string, string]> = [
    ['1-4', 'switch screens (screener · new pairs · watchlist · analyst)'],
    ['j/k', 'move · ⏎ open a token · esc go back'],
    ['/', 'filter · s sort · [ ] change the feed'],
    ['a', 'ask Claude about what you are looking at'],
    ['?', 'show every key for the current screen, anytime'],
    ['q', 'quit (your terminal is always restored)'],
  ];
  for (const [k, what] of hints) {
    c.text(box.x + 3, y, k.padEnd(5), { fg: t.borderFocus, bg, b: true });
    c.text(box.x + 9, y, what, { fg: t.text, bg }, box.w - 11);
    y += 1;
  }
  gap();
  c.hline(box.x, y, box.w, { fg: mix(t.border, t.warn, 0.4), bg, soft: true }); y += 1;
  line('Safety: trenchscope never signs, holds keys, or sends funds. Trading is PAPER (simulated).', { fg: t.warn, bg });
  line('Nothing here is financial advice — do your own research.', { fg: t.warn, bg });
}

function renderHelp(c: Canvas, state: AppState): void {
  const t = c.theme;
  const screen = state.screen === 'boot' ? 'screener' : state.screen;
  const fixtures = state.screener.source === 'fixtures';
  const ov = new Set((state.custom?.keymapResult.overridden ?? []).map((o) => `${o.screen ?? ''}|${o.action}`));
  const rows = helpRows(screen, fixtures, state.custom?.keymap ?? DEFAULT_KEYMAP, ov);
  // task-1330: the global key table outgrew a 40-row terminal (T trending, K KOL lists); when one column
  // cannot show every row the card goes two columns wide (110) so the last rows (the fixture demo keys) are never cut.
  const maxRows = c.h - 2 - 7;
  const columns = rows.length > maxRows && c.w >= 112 ? 2 : 1;
  const perCol = columns === 2 ? Math.ceil(rows.length / 2) : rows.length;
  const want = { w: columns === 2 ? 110 : 64, h: perCol + 7 };
  const box = card(c, want, `KEYS — ${SCREEN_TITLE[screen]}`, 'esc or ? to close');
  if (!box) return;
  const bg = box.bg;
  const keyW = Math.min(12, Math.max(...rows.map((r) => r.keys.length)) + 1);
  const colW = Math.floor((box.w - 2) / columns);
  rows.forEach((r, i) => {
    const col = Math.floor(i / perCol);
    const y = box.y + (i % perCol);
    if (y >= box.y + box.h - 2) return;
    const x = box.x + 2 + col * colW;
    c.text(x, y, r.keys.padEnd(keyW), { fg: t.borderFocus, bg, b: true });
    c.text(x + keyW + 1, y, r.label, { fg: t.text, bg }, colW - keyW - 3);
  });
  const fy = box.y + box.h - 1;
  c.hline(box.x, fy - 1, box.w, { fg: mix(t.border, t.warn, 0.4), bg, soft: true });
  c.text(box.x + 2, fy, 'read-only · no keys · no trades · not financial advice', { fg: t.warn, bg, i: true }, box.w - 4);
}

/** task-1358: the WORKSPACES card — 1-9 pick, j/k move + ⏎, esc close. Built-ins first, then ~/.dexterm/workspaces/*.json. */
function renderWorkspaces(c: Canvas, state: AppState): void {
  const t = c.theme;
  const ui = state.custom;
  const items = ui?.workspaces ?? [];
  const box = card(c, { w: 76, h: Math.min(c.h - 2, items.length + 7) }, 'WORKSPACES', '1-9 pick · j/k + ⏎ · ^W s save current · esc close');
  if (!box) return;
  const bg = box.bg;
  if (!items.length) { c.text(box.x + 2, box.y, 'no workspaces loaded (config not read on this run)', { fg: t.muted, bg }, box.w - 4); return; }
  const cursor = Math.max(0, Math.min(items.length - 1, ui?.listCursor ?? 0));
  let slot = 0;
  items.forEach((w, i) => {
    const y = box.y + i;
    if (y >= box.y + box.h - 2) return;
    const active = ui?.active === w.name;
    const picked = i === cursor;
    const n = w.error ? ' ' : slot < 9 ? String(++slot) : ' ';
    c.text(box.x + 2, y, `${picked ? '›' : ' '} ${n} `, { fg: picked ? t.accent : t.dim, bg, b: picked });
    c.text(box.x + 7, y, w.name.padEnd(22), { fg: w.error ? t.down : active ? t.borderFocus : t.text, bg, b: active });
    const what = w.error ? `⚠ ${w.error}` : `${w.builtin ? 'built-in' : 'file'} · ${w.workspace.description ?? (w.workspace.start ? `starts on ${w.workspace.start}` : '')}${w.workspace.popups?.length ? ` · ${w.workspace.popups.length} popup${w.workspace.popups.length > 1 ? 's' : ''}` : ''}`;
    c.text(box.x + 30, y, what, { fg: w.error ? t.down : t.muted, bg }, box.w - 32);
  });
  const fy = box.y + box.h - 1;
  c.hline(box.x, fy - 1, box.w, { fg: mix(t.border, t.warn, 0.4), bg, soft: true });
  c.text(box.x + 2, fy, `active: ${ui?.active ?? 'default'} · a workspace only navigates, re-themes and opens read-only popups`, { fg: t.warn, bg, i: true }, box.w - 4);
}

/**
 * task-1388: the GO-TO prompt — a one-line "paste a contract address (or a dexscreener / pump.fun / solscan
 * URL) to open any coin" input, opened with `g`. Read-only: ⏎ opens the coin's live token screen, esc cancels.
 * Drawn as a centered card so it works the same on every screen that offers it.
 */
export function renderGotoPrompt(c: Canvas, state: AppState): void {
  const g = state.goto;
  if (!g) return;
  const t = c.theme;
  const box = card(c, { w: 68, h: 7 }, 'GO TO COIN', '⏎ open · esc cancel');
  if (!box) return;
  const bg = box.bg;
  c.text(box.x + 2, box.y, 'paste or type a contract address (or a coin URL):', { fg: t.muted, bg }, box.w - 4);
  const shown = g.input.length > box.w - 6 ? '…' + g.input.slice(-(box.w - 7)) : g.input;
  c.text(box.x + 2, box.y + 2, '› ', { fg: t.accent, bg, b: true });
  c.text(box.x + 4, box.y + 2, shown, { fg: t.text, bg, b: true }, box.w - 7);
  c.text(box.x + 4 + shown.length, box.y + 2, '▏', { fg: t.borderFocus, bg });
  const fy = box.y + box.h - 1;
  c.hline(box.x, fy - 1, box.w, { fg: mix(t.border, t.warn, 0.4), bg, soft: true });
  c.text(box.x + 2, fy, g.notice ?? 'read-only — opens the token screen, never trades or signs', { fg: g.notice ? t.down : t.warn, bg, i: true }, box.w - 4);
}

/** Draw the active overlay (welcome or help). Called by renderFrame after the effects pass. */
export function renderOverlay(c: Canvas, state: AppState): void {
  if (state.overlay === 'welcome') renderWelcome(c, state);
  else if (state.overlay === 'help') renderHelp(c, state);
  else if (state.overlay === 'workspaces') renderWorkspaces(c, state);
  else if (state.overlay === 'pnl') renderPnlOverlay(c, state);
  else if (state.overlay === 'links' && state.linkMenu) {
    const menu = state.linkMenu;
    const box = card(c, { w: 100, h: Math.min(24, menu.items.length * 2 + 6) }, 'ADVERTISED LINKS (UNTRUSTED)', 'j/k select · enter open · esc close');
    if (!box) return;
    const count = Math.max(1, Math.floor((box.h - 2) / 2));
    const start = Math.max(0, menu.selected - count + 1);
    menu.items.slice(start, start + count).forEach((item, i) => {
      const selected = start + i === menu.selected;
      c.text(box.x + 1, box.y + i * 2, `${selected ? '›' : ' '} ${item.kind}`, { fg: selected ? c.theme.accent : c.theme.muted, bg: box.bg }, box.w - 2);
      c.text(box.x + 3, box.y + i * 2 + 1, item.url.replace(/[\p{Cc}\p{Cf}]/gu, ''), { fg: c.theme.text, bg: box.bg }, box.w - 4);
    });
  }
}
