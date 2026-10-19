// trenchscope — New pairs feed (pump.fun / DBC / Bonk launches, bonding progress, risk flags) + spotlight.
// Cyberspace styling (task-1297): a pair younger than a minute gets the magenta NEW treatment (its
// arrival fires the glitch via pulse in the loop); rain zones in the sub-tab gap, the gutter and the
// spotlight's blank middle; ▲/▼ on directions; the claude one-liner in coral.
import {
  Canvas, table, sparkline, sparkArea, heatPct, launchpadBadge, bar, badge, statGrid, ratioBar,
  fmtUsd, fmtPrice, fmtAge, fmtNum, fmtPctDir, header, footer, breakpoint, mix, isCalm,
  type Column,
} from '@dexterm/tui';
import { auditCell } from './audit-cell.ts';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { renderNewPairsLive } from '../live/screens/newpairs-live.ts';
import { layoutFor } from '../custom.ts';
import { priceCell, priceModeOf, MCAP_FALLBACK_NOTE, type PriceMode } from '../display.ts';
import type { FixtureToken } from '../fixtures.ts';

type Level = 'ok' | 'warn' | 'bad';

export function renderNewPairs(c: Canvas, state: AppState): void {
  if (state.live && state.screener.source !== 'fixtures') return renderNewPairsLive(c, state, state.live.newpairs); // task-1298: live data path
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const top = 2, bottom = c.h - 1;
  const sideW = layoutFor(state.custom, c.w, c.h).pairSpotlightW; // task-1358: from the workspace layout (46 at wide by default)
  const tableW = c.w - sideW - (sideW ? 1 : 0);
  const sel = state.selected || 0;
  const pairs = state.fx.newPairs;
  // sub-tabs
  const fy = top;
  let x = 1;
  const tabs: Array<[string, number]> = [['New', pairs.length], ['Graduating', 4], ['Migrated 1h', 7], ['Trenches', 3]];
  for (const [lab, n] of tabs) {
    const active = lab === 'New';
    x = c.text(x, fy, ` ${lab} `, active ? { fg: t.borderFocus, bg: t.tabActiveBg, b: true } : { fg: t.muted, bg: t.bg });
    x = c.text(x, fy, `${n} `, { fg: active ? t.accent : t.dim, bg: active ? t.tabActiveBg : t.bg }) + 1;
  }
  x = c.text(x + 2, fy, 'min liq 5K · dev < 5% · no mint auth', { fg: t.dim, bg: t.bg, i: true }, tableW - x - 4);
  c.rainZone(x + 1, fy, Math.max(0, tableW - x - 2), 1, 1);
  const box = c.box(0, top + 1, tableW, bottom - top - 1, { title: 'NEW PAIRS', caption: 'ws: pumpportal newToken · jup tokens/v2/recent' });
  const fresh = (r: FixtureToken) => r.ageMin < 1;
  const cols: Column<FixtureToken>[] = [
    { key: 'age', label: 'AGE', w: 5, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => {
      if (fresh(r)) { cv.fill(x, y, w, 1, ' ', { bg: mix(bg, t.pump, 0.35) }); cv.textR(x, y, w, 'NEW', { fg: '#ffffff', bg: mix(bg, t.pump, 0.35), b: true }); return; }
      cv.textR(x, y, w, fmtAge(r.ageMin), { fg: r.ageMin < 2 ? t.accent : t.muted, bg, b: r.ageMin < 2 });
    } },
    { key: 'token', label: 'TOKEN', w: bp === 'compact' ? 12 : 20, prio: 0, flex: bp !== 'compact', render: (cv, x, y, w, r, bg, m) => {
      const cx = cv.text(x, y, r.symbol, { fg: fresh(r) ? t.pump : m.selected ? t.borderFocus : t.text, bg, b: true }, Math.min(10, w));
      if (w > 14) cv.text(cx + 1, y, r.name, { fg: t.muted, bg }, w - (cx - x) - 1);
    } },
    { key: 'lp', label: 'LAUNCH', w: 6, prio: 1, render: (cv, x, y, _w, r, bg) => { launchpadBadge(cv, x, y, r.launchpad, { on: bg }); } },
    { key: 'bond', label: 'BONDING', w: 14, prio: 1, render: (cv, x, y, w, r, bg) => {
      if (r.bonding == null) { cv.text(x, y, 'migrated', { fg: t.dim, bg }); return; }
      bar(cv, x, y, w - 5, r.bonding, { bg, color: r.bonding > 80 ? t.warn : t.pump });
      cv.textR(x + w - 4, y, 4, `${Math.round(r.bonding)}%`, { fg: r.bonding > 80 ? t.warn : t.muted, bg });
    } },
    { key: 'mcap', label: 'MCAP', w: 8, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, fmtUsd(r.mcap, { digits: 1 }), { fg: t.text, bg }); } },
    { key: 'liq', label: 'LIQ', w: 7, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, fmtUsd(r.liq, { digits: 1 }), { fg: t.text, bg }); } },
    { key: 'm5', label: '5M', w: 7, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.chg.m5, bg) },
    { key: 'h1', label: '1H', w: 7, align: 'right', prio: 3, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.chg.h1, bg) },
    { key: 'holders', label: 'HLD', w: 5, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, fmtNum(r.holders), { fg: t.text, bg }); } },
    { key: 'bs', label: 'B/S 5M', w: 8, prio: 4, render: (cv, x, y, w, r, bg) => ratioBar(cv, x, y, w, Math.max(1, r.buys % 37), Math.max(1, r.sells % 29), { bg }) },
    { key: 'dev', label: 'DEV', w: 5, align: 'right', prio: 3, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, `${r.dev.toFixed(1)}%`, { fg: r.dev > 5 ? t.down : t.muted, bg }); } },
    { key: 'snipe', label: 'SNIPE', w: 5, align: 'right', prio: 4, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, String(r.snipers), { fg: r.snipers > 10 ? t.down : r.snipers > 4 ? t.warn : t.muted, bg }); } },
    { key: 'bund', label: 'BUNDLE', w: 6, align: 'right', prio: 4, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, `${r.bundled.toFixed(0)}%`, { fg: r.bundled > 15 ? t.down : t.muted, bg }); } },
    { key: 'spark', label: 'TREND', w: 12, prio: 2, render: (cv, x, y, w, r, bg) => sparkline(cv, x, y, w, r.spark, { bg }) },
    { key: 'flags', label: 'RISK', w: 13, prio: 5, render: (cv, x, y, w, r, bg) => {
      let cx = x;
      for (const f of r.flags.slice(0, 2)) { if (cx + f.length + 2 > x + w) break; cx = badge(cv, cx, y, f, f === 'MINT' || f === 'FREEZE' ? t.down : t.warn, { on: bg }) + 1; }
      if (!r.flags.length) auditCell(cv, x, y, r, bg);
    } },
  ];
  table(c, box.x + 1, box.y, box.w - 2, box.h, { columns: cols, rows: pairs, selected: sel, scroll: 0, bg: box.bg });
  if (sideW) {
    c.rainZone(tableW, top, 1, bottom - top, 1);
    pairSpotlight(c, c.w - sideW, top, sideW, bottom - top, pairs[sel], priceModeOf(state));
  }
  // task-1388: `g` opens the go-to prompt here too (keymap + the ? overlay list it); the footer is kept
  // byte-identical to prototype-v2 (snapshot parity), so the hint lives in `?` and on the screener footer.
  footer(c, [['j/k', 'move'], ['⏎', 'open'], ['p', 'pause feed'], ['f', 'filters'], ['w', 'watch'], ['a', 'ask claude'], ['q', 'quit']], state.theme.name, isCalm(state.vfx));
}

function pairSpotlight(c: Canvas, x: number, y: number, w: number, h: number, tk: FixtureToken, mode: PriceMode = 'price'): void {
  const t = c.theme;
  const box = c.box(x, y, w, h, { title: `$${tk.symbol}`, caption: `${fmtAge(tk.ageMin)} old`, focus: true });
  const bg = box.bg;
  let cy = box.y;
  c.text(box.x + 1, cy, tk.name, { fg: t.muted, bg }, box.w - 2);
  launchpadBadge(c, box.x + box.w - 8, cy, tk.launchpad, { on: bg });
  cy += 1;
  // task-1366: the headline follows the price mode (mcap, then the price beside it)
  const head = priceCell(mode, tk.price, tk.mcap);
  let cx = c.text(box.x + 1, cy, head.text, { fg: head.fallback ? t.warn : t.text, bg, b: true });
  if (head.kind === 'mcap') cx = c.text(cx + 1, cy, `(${fmtPrice(tk.price)})`, { fg: t.dim, bg });
  c.text(cx + 1, cy, fmtPctDir(tk.chg.h1), { fg: tk.chg.h1 >= 0 ? t.up : t.down, bg });
  if (head.fallback) c.text(box.x + 1, cy + 1, MCAP_FALLBACK_NOTE, { fg: t.warn, bg, i: true }, box.w - 2);
  cy += 2;
  if (tk.bonding != null) {
    c.text(box.x + 1, cy, 'BONDING CURVE', { fg: t.dim, bg });
    c.textR(box.x + 1, cy, box.w - 2, `${Math.round(tk.bonding)}% → PumpSwap at $69K`, { fg: t.muted, bg });
    cy += 1;
    bar(c, box.x + 1, cy, box.w - 2, tk.bonding, { bg, color: tk.bonding > 80 ? t.warn : t.pump });
    cy += 2;
  }
  sparkArea(c, box.x + 1, cy, box.w - 2, 4, tk.spark, { bg });
  cy += 5;
  cy += statGrid(c, box.x + 1, cy, box.w - 2, [
    { label: 'mcap', value: fmtUsd(tk.mcap, { digits: 1 }) },
    { label: 'liquidity', value: fmtUsd(tk.liq, { digits: 1 }) },
    { label: 'holders', value: fmtNum(tk.holders) },
    { label: 'vol since launch', value: fmtUsd(tk.vol24, { digits: 1 }) },
  ], { bg, cols: 2 });
  cy += 1;
  c.text(box.x + 1, cy, 'LAUNCH FORENSICS', { fg: t.dim, bg });
  cy += 1;
  const rows: Array<[string, string, Level]> = [
    ['Dev wallet', `${tk.dev.toFixed(1)}% · ${tk.devHistory.launches} prior · ${tk.devHistory.rugged} rugs`, tk.devHistory.rugged ? 'bad' : tk.dev > 5 ? 'warn' : 'ok'],
    ['Bundled at launch', `${tk.bundled.toFixed(0)}% across ${Math.max(1, Math.round(tk.bundled / 4))} wallets`, tk.bundled > 15 ? 'bad' : tk.bundled > 8 ? 'warn' : 'ok'],
    ['Snipers block 0-2', `${tk.snipers} wallets`, tk.snipers > 10 ? 'bad' : tk.snipers > 4 ? 'warn' : 'ok'],
    ['Top 10 holders', `${tk.top10.toFixed(1)}%`, tk.top10 > 40 ? 'bad' : tk.top10 > 25 ? 'warn' : 'ok'],
    ['Mint / freeze', tk.mintAuth || tk.freezeAuth ? 'ENABLED' : 'revoked', tk.mintAuth || tk.freezeAuth ? 'bad' : 'ok'],
    ['Socials', `${[tk.socials.x && 'X', tk.socials.tg && 'TG', tk.socials.web && 'web'].filter(Boolean).join(' ') || 'none'}${tk.socials.x ? ` · ${fmtNum(tk.xFollowers)} followers` : ''}`, tk.socials.x ? 'ok' : 'warn'],
  ];
  for (const [label, val, lvl] of rows) {
    if (cy >= box.y + box.h - 6) break;
    const color = lvl === 'ok' ? t.up : lvl === 'warn' ? t.warn : t.down;
    c.text(box.x + 1, cy, lvl === 'ok' ? '●' : lvl === 'warn' ? '◐' : '○', { fg: color, bg });
    c.text(box.x + 3, cy, label, { fg: t.muted, bg });
    cy += 1;
    c.text(box.x + 3, cy, val, { fg: lvl === 'ok' ? t.text : color, bg }, box.w - 4);
    cy += 1;
  }
  const ay = box.y + box.h - 4;
  if (ay - 2 > cy) c.rainZone(box.x + 1, cy, box.w - 2, ay - 2 - cy, 2);
  c.hline(box.x, ay - 1, box.w, { fg: mix(t.border, t.ai, 0.4), bg, soft: true });
  c.text(box.x + 1, ay, '✦ claude', { fg: t.ai, bg, b: true });
  c.heading(box.x + 1, ay, 8);
  const good = rows.filter((r) => r[2] === 'ok').length;
  const line = good >= 5 ? 'clean launch, watch holder velocity for 10m' : good >= 3 ? 'mixed: bundled supply is the risk here' : 'skip: dev + bundle pattern matches prior rugs';
  c.text(box.x + 1, ay + 1, line, { fg: t.ai, bg }, box.w - 2);
  c.text(box.x + 1, ay + 2, `${good}/${rows.length} checks pass · a → full analysis`, { fg: t.dim, bg }, box.w - 2);
}
