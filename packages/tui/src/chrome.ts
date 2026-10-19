// @dexterm/tui — app chrome: header (brand, tabs, status cluster), footer (key hints, size), toast.
// The header's blank middle, the band under it and the footer's free space are rain zones (kind 1).
import type { Canvas } from './canvas.ts';
import { keyHints, dirGlyph, type Hint } from './widgets.ts';
import { fmtPct, clock } from './fmt.ts';
import { mix } from './color.ts';
import type { Toast } from './fx.ts';

// 'ticket' (PAPER trade ticket) and 'positions' (PAPER portfolio) are task-1310 secondary screens:
// reached from the token screen / a global key, not tabs, so SCREENS (the 1-4 tab bar) is unchanged.
// 'trending' (TRENDING IN THE SPACE, key T) and 'kol' (KOL lists, key K) are task-1330 secondary screens.
export type ScreenKey = 'screener' | 'newpairs' | 'watchlist' | 'analyst' | 'token' | 'boot' | 'ticket' | 'positions' | 'trending' | 'kol' | 'bubbles' | 'narrative' | 'plans' | 'follows' | 'rules';

export interface ScreenTab {
  key: ScreenKey;
  label: string;
  hot: string;
}

export const SCREENS: ScreenTab[] = [
  { key: 'screener', label: 'Screener', hot: '1' },
  { key: 'newpairs', label: 'New pairs', hot: '2' },
  { key: 'watchlist', label: 'Watchlist', hot: '3' },
  { key: 'analyst', label: 'Analyst', hot: '4' },
];

/** What the header needs to know. Screens pass a view of their state. */
export interface HeaderModel {
  screen: ScreenKey;
  paused: boolean;
  /** SOL price cluster; null hides it (live mode without a SOL quote yet). */
  sol: { price: number; chg24: number } | null;
  now: Date;
  /** IANA zone for the clock; omit for local time. */
  timeZone?: string;
  feedLabel?: string;
  /** Replaces the live/paused marker, e.g. '◐ degraded: gecko'. */
  status?: string;
  /** Effects off: the live marker says so. */
  calm?: boolean;
  /** false hides the screen tabs (the simple view shows only the wordmark and the status cluster). */
  tabs?: boolean;
}

export function header(c: Canvas, m: HeaderModel): void {
  const t = c.theme;
  const bg = t.headBg;
  c.fill(0, 0, c.w, 1, ' ', { bg });
  // right status cluster (computed first so tabs never collide with it)
  const solStr = m.sol ? `SOL $${m.sol.price.toFixed(2)} ` : '';
  const chgStr = m.sol ? dirGlyph(m.sol.chg24) + fmtPct(Math.abs(m.sol.chg24), { sign: false }) : '';
  const live = m.status ?? (m.paused ? '◌ paused' : m.calm ? '◉ live · calm' : '◉ live');
  const feed = c.w >= 150 ? ` ${m.feedLabel || 'dexscreener · jup · gecko · rugcheck'}   ` : '';
  const clk = clock(m.now, m.timeZone);
  const rightW = feed.length + solStr.length + chgStr.length + (m.sol ? 2 : 0) + live.length + 2 + clk.length + 1;
  let rx = c.w - rightW;
  if (feed) rx = c.text(rx, 0, feed, { fg: t.dim, bg });
  if (m.sol) {
    rx = c.text(rx, 0, solStr, { fg: t.muted, bg });
    rx = c.text(rx, 0, chgStr, { fg: m.sol.chg24 >= 0 ? t.up : t.down, bg });
    rx = c.text(rx, 0, '  ', { bg });
  }
  rx = c.text(rx, 0, live, { fg: m.status ? t.warn : m.paused ? t.warn : t.pop ?? t.up, bg, b: true });
  rx = c.text(rx, 0, '  ', { bg });
  c.text(rx, 0, clk, { fg: t.muted, bg });
  const limit = c.w - rightW - 1;
  // logo: "trench" accent, "scope" white, both bold; registered as a heading so it chromatic-aberrates
  let x = c.text(1, 0, ' trench', { fg: t.borderFocus, bg, b: true });
  x = c.text(x, 0, 'scope', { fg: t.text, bg, b: true });
  // the wordmark's block cursor, in the theme's pop colour where it has one (mono, matching the site)
  x = c.text(x, 0, t.pop ? '▌' : ' ', { fg: t.pop ?? t.text, bg });
  c.heading(2, 0, 11);
  if (m.tabs !== false) x = c.text(x, 0, '┃ ', { fg: t.border, bg, soft: true });
  const compact = c.w < 110;
  for (const s of m.tabs === false ? [] : SCREENS) {
    const active = s.key === m.screen || ((m.screen === 'token' || m.screen === 'ticket') && s.key === 'screener');
    const label = compact ? ` ${s.hot} ${s.label.split(' ')[0]} ` : ` ${s.hot} ${s.label} `;
    if (x + label.length > limit) break;
    if (active) {
      x = c.text(x, 0, label, { fg: t.borderFocus, bg: t.tabActiveBg, b: true });
      c.put(x, 0, '▌', { fg: t.tabActiveBg, bg, soft: true });
      x += 1;
    } else {
      x = c.text(x, 0, label, { fg: t.muted, bg });
      x += 1;
    }
  }
  // blank middle of the header + the band under it are rain zones
  c.rainZone(x, 0, Math.max(0, c.w - rightW - x - 1), 1, 1);
  c.fill(0, 1, c.w, 1, ' ', { bg: t.bg });
  c.rainZone(0, 1, c.w, 1, 1);
}

export function footer(c: Canvas, hints: readonly Hint[], themeName: string, calm = false): void {
  const t = c.theme;
  const y = c.h - 1;
  c.fill(0, y, c.w, 1, ' ', { bg: t.headBg });
  const right = ` ${themeName}${calm ? ' · calm' : ''} · ${c.w}×${c.h} `;
  const end = keyHints(c, 1, y, c.w - right.length - 2, hints, t.headBg);
  // Prototype parity: the label is drawn at the last column and clipped (fix queued for D-19).
  c.textR(c.w - 1, y, right.length, right, { fg: t.dim, bg: t.headBg });
  c.rainZone(end, y, Math.max(0, c.w - right.length - 1 - end), 1, 1);
}

/** Toast (bottom-right, above the footer). */
export function toast(c: Canvas, tst: Toast | null | undefined): void {
  if (!tst) return;
  const t = c.theme;
  const { text, level } = tst;
  const color = level === 'up' ? t.up : level === 'down' ? t.down : level === 'warn' ? t.warn : level === 'ai' ? t.ai : t.accent;
  const w = Math.min(c.w - 4, text.length + 4);
  const x = c.w - w - 1, y = c.h - 4;
  const bg = mix(t.bg, color, 0.14);
  c.fill(x, y, w, 3, ' ', { bg });
  c.noRain(x, y, w, 3);
  c.hline(x, y, w, { fg: color, bg, soft: true }, '▔');
  c.hline(x, y + 2, w, { fg: color, bg, soft: true }, '▁');
  c.text(x + 2, y + 1, text, { fg: t.text, bg, b: true }, w - 4);
  c.put(x, y + 1, '▌', { fg: color, bg, soft: true });
}
