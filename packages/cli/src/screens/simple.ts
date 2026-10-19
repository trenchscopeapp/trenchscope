// trenchscope: the simple split view (the default in the interactive app). One short coin list on the left;
// the selected coin's chart and a plain-English safety verdict on the right. `f` switches to the full table
// (renderScreener) and back. Everything shown here is derived from the same ScreenerRow the full table uses,
// so the two views can never disagree. It wears the same chrome as the full table and the site's tour (tab
// bar, titled panels, uppercase section labels, the standard footer) so switching views never changes the look.
import { brailleLine, fmtAge, fmtNum, fmtUsd, fmtPrice, fmtPctDir, header, footer, isCalm, launchpadBadge, mix, pctStyle, shortAddr, statGrid, type Canvas, type Hex } from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import type { ScreenerRow } from '../screener/rows.ts';
import { auditState } from '../screener/rows.ts';
import { screenerView } from '../screener/view.ts';
import { RUG_MODEL_LABEL, fmtRugP } from '../screener/rug.ts';
import { verdictFor, riskWord, type VerdictWord } from '../screener/verdict.ts';

export { verdictFor, riskWord, type VerdictWord, type Reason, type Verdict } from '../screener/verdict.ts';

const pct = (n: number) => `${Math.abs(n) >= 100 ? Math.round(Math.abs(n)) : Math.abs(n).toFixed(1)}%`;

/** Risk colour. A clean result is ink in the mono theme (hue is kept for direction and warnings), green elsewhere. */
function wordColor(c: Canvas, w: VerdictWord | 'avoid' | 'careful' | 'low'): Hex {
  const t = c.theme;
  return w === 'AVOID' || w === 'avoid' ? t.down : w === 'CAREFUL' || w === 'careful' ? t.warn : t.mono ? (w === 'low' ? t.muted : t.text) : t.up;
}

export function renderSimple(c: Canvas, state: AppState): void {
  const t = c.theme;
  header(c, headerModel(state));
  const rows = screenerView(state.screener);
  const sel = Math.min(state.selected || 0, Math.max(0, rows.length - 1));
  const top = 2, bottom = c.h - 1;
  const listW = c.w >= 120 ? 50 : Math.max(36, Math.floor(c.w * 0.45));
  const panelX = listW + 1;
  const panelW = c.w - panelX;
  c.fill(0, top, c.w, bottom - top, ' ', { bg: t.bg });

  // ---- row 2: the search line, like the full table's filter bar
  const query = state.screener.query;
  const qx = c.text(1, top, '⌕ ', { fg: t.pop ?? t.accent, bg: t.bg, b: true });
  c.text(qx, top, query || 'trending now', { fg: query ? t.text : t.muted, bg: t.bg, i: !query }, listW - qx - 1);

  // ---- left: the list, in a titled panel
  const caption = rows.length ? `${rows.length} coins · row ${sel + 1}/${rows.length}` : '';
  const box = c.box(0, top + 1, listW, bottom - top - 1, { title: query ? 'SEARCH' : 'TRENDING', caption });
  const bg0 = box.bg;
  const bx = box.x, right = box.x + box.w;
  // right-aligned numbers with a two-cell gap before the risk word (7 wide: 'careful'), one cell clear of the border
  const cols = { coin: bx + 1, mcap: right - 28, h24: right - 19, risk: right - 8 };
  const hy = box.y;
  c.text(cols.coin, hy, 'COIN', { fg: t.dim, bg: bg0 });
  c.textR(cols.mcap, hy, 8, 'MCAP', { fg: t.dim, bg: bg0 });
  c.textR(cols.h24, hy, 8, '24H', { fg: t.dim, bg: bg0 });
  c.text(cols.risk, hy, 'RISK', { fg: t.dim, bg: bg0 });
  const bodyY = hy + 1;
  const visible = Math.max(1, box.y + box.h - bodyY);
  const scroll = Math.max(0, Math.min(sel - Math.floor(visible / 2), rows.length - visible));
  for (let i = 0; i < visible; i++) {
    const r = rows[scroll + i];
    if (!r) break;
    const y = bodyY + i;
    const on = scroll + i === sel;
    const bg = on ? t.selBg : bg0;
    c.fill(bx, y, box.w, 1, ' ', { bg });
    if (on) c.put(bx, y, '▌', { fg: t.pop ?? t.accent, bg });
    const nx = c.text(cols.coin, y, r.symbol, { fg: on ? t.accent : t.text, bg, b: true }, 10);
    c.text(nx + 1, y, r.name, { fg: t.dim, bg }, Math.max(0, cols.mcap - nx - 2));
    c.textR(cols.mcap, y, 8, r.mcap === null ? '—' : fmtUsd(r.mcap, { digits: 1 }).replace('$', ''), { fg: t.text, bg });
    if (r.chg.h24 === null) c.textR(cols.h24, y, 8, '—', { fg: t.dim, bg });
    else c.textR(cols.h24, y, 8, `${r.chg.h24 > 0 ? '+' : r.chg.h24 < 0 ? '-' : ''}${pct(r.chg.h24)}`, pctStyle(c, r.chg.h24, bg));
    if (r.skeleton) continue;
    const w = riskWord(r, state.larpByMint?.get(r.mint)?.verdict ?? null);
    c.text(cols.risk, y, w, { fg: wordColor(c, w), bg, b: w === 'avoid' });
  }
  if (!rows.length) c.text(cols.coin, bodyY + 1, state.screener.rows.length ? 'nothing matches the search' : 'loading coins…', { fg: t.dim, bg: bg0, i: true });

  // ---- right: the selected coin
  const r = rows[sel];
  if (panelW >= 30) {
    if (r) coinPanel(c, panelX, top, panelW, bottom - top, r, state.larpByMint?.get(r.mint)?.verdict ?? null);
    else c.box(panelX, top, panelW, bottom - top, { title: 'COIN' });
  }

  footer(c, [['↑↓', 'move'], ['⏎', 'open coin'], ['/', 'search'], ['a', 'ask AI'], ['f', 'full table'], ['q', 'quit']], state.theme.name, isCalm(state.vfx));
}

function coinPanel(c: Canvas, x0: number, y0: number, w0: number, h0: number, r: ScreenerRow, larp: string | null): void {
  const t = c.theme;
  const box = c.box(x0, y0, w0, h0, { title: `$${r.symbol}`, caption: shortAddr(r.mint, 4), focus: true });
  const bg = box.bg;
  const x = box.x + 1, w = box.w - 2, y = box.y, h = box.h;
  let cy = y;
  const lpW = r.launchpad !== 'unknown' ? 7 : 0;
  c.text(x, cy, r.name, { fg: t.muted, bg }, Math.max(0, w - lpW - 1));
  if (lpW) launchpadBadge(c, x + w - lpW + 1, cy, r.launchpad, { on: bg });
  cy += 1;
  let px = c.text(x, cy, fmtPrice(r.price), { fg: t.text, bg, b: true });
  if (r.chg.h24 !== null) {
    px = c.text(px + 1, cy, fmtPctDir(r.chg.h24), pctStyle(c, r.chg.h24, bg));
    c.text(px + 1, cy, '24h', { fg: t.dim, bg });
  }
  cy += 2;
  if (cy + 2 > y + h) return; // a very short window: name and price only
  cy += statGrid(c, x, cy, w, [
    { label: 'mcap', value: r.mcap === null ? '—' : fmtUsd(r.mcap, { digits: 1 }) },
    { label: 'liquidity', value: r.liq === null ? '—' : fmtUsd(r.liq, { digits: 1 }) },
    { label: 'vol 24h', value: r.vol24 === null ? '—' : fmtUsd(r.vol24, { digits: 1 }) },
    { label: 'holders', value: fmtNum(r.holders), style: r.holders === null ? { fg: t.dim, bg } : undefined },
    { label: 'top 10', value: r.top10 === null ? '—' : `${r.top10.toFixed(1)}%`, style: r.top10 === null ? { fg: t.dim, bg } : r.top10 > 30 ? { fg: t.warn, bg, b: true } : undefined },
    { label: 'age', value: r.ageMin === null ? '—' : fmtAge(r.ageMin), style: r.ageMin === null ? { fg: t.dim, bg } : undefined },
  ].slice(0, h >= 30 ? 6 : 3), { bg, cols: w >= 54 ? 3 : 2 });
  cy += 1;
  if (cy + 6 > y + h) return; // no room for the chart and verdict

  // chart: the 24h path the windowed changes describe (a real candle feed replaces this when one is loaded)
  const chartH = Math.max(4, Math.min(14, Math.floor(h * 0.36)));
  c.text(x, cy, '24H PRICE PATH', { fg: t.dim, bg });
  cy += 1;
  const frameBg = mix(bg, t.panelAlt, 1);
  c.fill(x, cy, w, chartH, ' ', { bg: frameBg });
  if (r.spark && r.spark.length >= 2) brailleLine(c, x + 1, cy, w - 2, chartH, r.spark, { bg: frameBg });
  else c.textC(x, cy + Math.floor(chartH / 2), w, 'no price history yet', { fg: t.dim, bg: frameBg, i: true });
  cy += chartH + 1;

  // verdict: a reverse-video chip (ink for no red flags in mono; amber or red when something is wrong)
  const v = verdictFor(r, larp);
  c.text(x, cy, 'SAFETY VERDICT', { fg: t.dim, bg });
  cy += 1;
  const vColor = wordColor(c, v.word);
  const vx = c.text(x, cy, ` ${v.word} `, { fg: t.bg, bg: vColor, b: true });
  if (v.p !== null) c.text(vx + 2, cy, `risk score ${fmtRugP(v.p)} · ${RUG_MODEL_LABEL}`, { fg: t.dim, bg }, Math.max(0, x + w - vx - 2));
  cy += 2;
  const room = y + h - cy - 2;
  for (const reason of v.reasons.slice(0, Math.max(0, room))) {
    const color = reason.mark === '✗' ? t.down : reason.mark === '◐' ? t.muted : t.up;
    c.text(x, cy, reason.mark, { fg: color, bg, b: true });
    c.text(x + 2, cy, reason.text, { fg: reason.mark === '✗' ? t.text : t.muted, bg }, w - 2);
    cy += 1;
  }
  const noteY = y + h - 1;
  if (noteY > cy) c.text(x, noteY, auditState(r) === 'partial' ? 'some checks are still loading or unavailable · not financial advice' : 'not financial advice', { fg: t.dim, bg, i: true }, w);
}
