// trenchscope — Screener screen: ranked token table + neon sparklines + side spotlight at wide widths.
// Rows are `ScreenerRow`s (fixtures or the data store); cells the health registry cannot vouch
// for render as a dim dash with the reason in the panel caption, never as a number.
// Cyberspace styling (task-1297): rain zones in the filter-bar gap, the table/spotlight gutter and the
// spotlight's blank middle; the selected ticker in phosphor; ▲/▼ on every direction (VISUAL-V2 §6.5).
import {
  Canvas, table, sparkline, sparkArea, heatPct, launchpadBadge, ratioBar, badge, pctStyle, statGrid,
  fmtUsd, fmtPrice, fmtAge, fmtNum, fmtPct, fmtPctDir, fmtDeltaDir, shortAddr, header, footer, breakpoint, mix, isCalm, onAccent,
  type Column, type Breakpoint, type Hex,
} from '@dexterm/tui';
import type { Gate } from '@dexterm/data';
import type { AppState } from '../state.ts';
import { layoutFor } from '../custom.ts';
import { headerModel } from '../state.ts';
import type { ScreenerRow } from '../screener/rows.ts';
import { auditCell } from './audit-cell.ts';
import { renderSimple } from './simple.ts';
import { screenerView, gateCaption, feedCondition, type ScreenerState } from '../screener/view.ts';
import { SORT_KEYS, sortSpec } from '../screener/sort.ts';
import { RUG_FLAG_THRESHOLD, RUG_MODEL_LABEL, fmtRugP, rugDataAge, rugP } from '../screener/rug.ts';
import { drawCoin, imagesOn } from './coin.ts';
import { COIN_ICON_W } from '@dexterm/tui';
import { priceCell, priceModeOf, promoteMcap, fallbackCount, fallbackCaption, FALLBACK_MARK, MCAP_FALLBACK_NOTE, type PriceMode } from '../display.ts';

/** Table column key → health gate id (COLUMN_SOURCES). Columns without an entry are always shown. */
export const COLUMN_GATE: Record<string, string> = {
  lp: 'launchpad', age: 'age', price: 'price', m5: '5m', h1: '1h', h6: '6h', h24: '24h', vol: 'vol', liq: 'liq', mcap: 'mcap',
  holders: 'holders', org: 'org', txns: 'bs', spark: 'sparkline', flags: 'flags',
};

const DEFAULT_QUERY = 'vol24 > 250K  liq > 50K  age < 30d  chain:solana';

/**
 * LARP-detector badge for a verdict (task-1315): a short label + colour, or null for a verdict with
 * no badge. Only ever called for a mint whose verdict was actually computed (present in larpByMint).
 */
export function larpBadge(verdict: string | undefined, t: Canvas['theme']): { text: string; fg: Hex } | null {
  switch (verdict) {
    case 'LARP': return { text: 'LARP', fg: t.down };
    case 'REAL_PRODUCT': return { text: 'REAL', fg: t.up };
    case 'EARLY_BUT_REAL': return { text: 'REAL?', fg: mix(t.bg, t.up, 0.8) };
    // A meme that claims no product: neutral, neither a LARP nor a real product.
    case 'NO_PRODUCT_CLAIMED': return { text: 'MEME', fg: t.muted };
    case 'UNVERIFIABLE':
    case 'AMBIGUOUS': return { text: 'UNKNOWN', fg: t.warn };
    default: return null;
  }
}

/** The H1 p(rug) score bucketed for the RISK column: HIGH at the model's own flag line, MED from 0.35. */
export function riskLevel(p: number): 'LOW' | 'MED' | 'HIGH' {
  return p >= RUG_FLAG_THRESHOLD ? 'HIGH' : p >= 0.35 ? 'MED' : 'LOW';
}

/** task-1326: the icon cell renderer the screener passes when images are on (null = no icon column). */
export type IconCell = (cv: Canvas, x: number, y: number, w: number, r: ScreenerRow, bg: Hex) => void;

export function screenerColumns(c: Canvas, bp: Breakpoint, gates: Record<string, Gate> | null = null, larp: Map<string, { verdict: string }> | null = null, icon: IconCell | null = null, mode: PriceMode = 'price'): Column<ScreenerRow>[] {
  const t = c.theme;
  const muted = (bg: Hex) => ({ fg: t.muted, bg });
  const dash = (cv: Canvas, x: number, y: number, w: number, bg: Hex, align: 'left' | 'right' = 'right') => {
    if (align === 'right') cv.textR(x, y, w, '—', { fg: t.dim, bg }); else cv.text(x, y, '—', { fg: t.dim, bg });
  };
  void gates; // the gate drives the panel caption (gateCaption); cells only ever dash a null
  const cols: Column<ScreenerRow>[] = [
    { key: 'rank', label: '#', w: 3, align: 'right', prio: 0, render: (cv, x, y, w, _r, bg, m) => { cv.textR(x, y, w, String(m.index + 1), { fg: t.dim, bg }); } },
    // task-1326: the coin image (2 cells, quadrant art or real pixels). Drops before the numbers when narrow.
    ...(icon ? [{ key: 'img', label: '', w: COIN_ICON_W, prio: 2, render: (cv, x, y, w, r, bg) => { if (!r.skeleton) icon(cv, x, y, w, r, bg); } } as Column<ScreenerRow>] : []),
    { key: 'token', label: 'TOKEN', w: bp === 'compact' ? 12 : 22, prio: 0, flex: bp !== 'compact', render: (cv, x, y, w, r, bg, m) => {
      const cx = cv.text(x, y, r.symbol, { fg: m.selected ? t.borderFocus : t.text, bg, b: true }, Math.min(10, w));
      if (w > 14) cv.text(cx + 1, y, r.name, muted(bg), w - (cx - x) - 1);
    } },
    { key: 'lp', label: 'LP', w: 6, prio: 4, render: (cv, x, y, w, r, bg) => { if (r.launchpad === 'unknown') dash(cv, x, y, w, bg, 'left'); else launchpadBadge(cv, x, y, r.launchpad, { on: bg }); } },
    { key: 'age', label: 'AGE', w: 5, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => { if (r.ageMin === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtAge(r.ageMin), muted(bg)); } },
    { key: 'price', label: 'PRICE', w: 11, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => { if (r.price === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtPrice(r.price), { fg: t.text, bg }); } },
    { key: 'm5', label: '5M', w: 7, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.chg.m5, bg) },
    { key: 'h1', label: '1H', w: 7, align: 'right', prio: 1, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.chg.h1, bg) },
    { key: 'h6', label: '6H', w: 7, align: 'right', prio: 6, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.chg.h6, bg) },
    { key: 'h24', label: '24H', w: 8, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.chg.h24, bg) },
    { key: 'vol', label: 'VOL 24H', w: 9, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => { if (r.vol24 === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtUsd(r.vol24, { digits: 1 }), { fg: t.text, bg }); } },
    { key: 'liq', label: 'LIQ', w: 8, align: 'right', prio: 1, render: (cv, x, y, w, r, bg) => { if (r.liq === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtUsd(r.liq, { digits: 1 }), { fg: r.liq !== null && r.liq < 50e3 ? t.warn : t.text, bg }); } },
    { key: 'mcap', label: 'MCAP', w: mode === 'mcap' ? 9 : 8, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => {
      // task-1366: in mcap mode a token without a supply shows its PRICE here, marked ᵖ in amber (the caption counts them)
      if (r.mcap === null && mode === 'mcap' && r.price !== null) { cv.textR(x, y, w, fmtPrice(r.price) + FALLBACK_MARK, { fg: t.warn, bg }); return; }
      if (r.mcap === null) { dash(cv, x, y, w, bg); return; }
      // sources disagree (D-06 rule): amber with a trailing ? so the plain render carries the doubt too
      if (r.mcapFlagged) cv.textR(x, y, w, fmtUsd(r.mcap, { digits: 1 }) + '?', { fg: t.warn, bg });
      else cv.textR(x, y, w, fmtUsd(r.mcap, { digits: 1 }), { fg: t.text, bg });
    } },
    { key: 'holders', label: 'HOLDERS', w: 8, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => { if (r.holders === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtNum(r.holders), { fg: t.text, bg }); } },
    { key: 'org', label: 'ORG', w: 4, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => {
      if (r.org === null) { dash(cv, x, y, w, bg); return; }
      cv.textR(x, y, w, String(Math.round(r.org)), { fg: r.org >= 70 ? t.up : r.org >= 40 ? t.warn : t.down, bg });
    } },
    // task-1361: p(rug) from the H1-v0.1 heuristic (screener/rug.ts). A model output: the panel caption names
    // the model, the spotlight adds the data age. Dim when the row is stale; dashed when nothing is scoreable.
    // Flat themes draw the same score as a 5-step gauge. Below MED it stays grey: the heuristic only adds points
    // for red flags it can see, so a low score means "nothing flagged", never "safe".
    t.flat ? { key: 'rug', label: 'RISK', w: 6, prio: 1, render: (cv, x, y, w, r, bg) => {
      const p = rugP(r);
      if (p === null) { dash(cv, x, y, w, bg, 'left'); return; }
      const lvl = riskLevel(p);
      const fg = r.stale ? t.dim : lvl === 'HIGH' ? t.down : lvl === 'MED' ? t.warn : t.muted;
      const on = Math.max(1, Math.min(5, Math.round(p * 5)));
      const off = mix(bg, t.dim, 0.45);
      for (let i = 0; i < Math.min(5, w); i++) cv.put(x + i, y, i < on ? '▮' : '▯', { fg: i < on ? fg : off, bg, b: lvl === 'HIGH' });
    } } : { key: 'rug', label: 'P(RUG)', w: 6, align: 'right', prio: 3, render: (cv, x, y, w, r, bg) => {
      const p = rugP(r);
      if (p === null) { dash(cv, x, y, w, bg); return; }
      cv.textR(x, y, w, fmtRugP(p), { fg: r.stale ? t.dim : p >= RUG_FLAG_THRESHOLD ? t.down : p >= 0.35 ? t.warn : t.text, bg });
    } },
    { key: 'txns', label: 'B/S 24H', w: 10, prio: 5, render: (cv, x, y, w, r, bg) => { if (r.buys === null || r.sells === null) dash(cv, x, y, w, bg, 'left'); else ratioBar(cv, x, y, w, r.buys, r.sells, { bg }); } },
    { key: 'spark', label: '24H TREND', w: t.flat ? 12 : 16, prio: 1, render: (cv, x, y, w, r, bg) => sparkline(cv, x, y, w, r.spark, { bg }) },
    { key: 'flags', label: 'FLAGS', w: 14, prio: 3, render: (cv, x, y, w, r, bg) => {
      let cx = x;
      // task-1315: lead with the LARP-detector verdict, but only for a mint we actually vetted.
      const lb = larpBadge(larp?.get(r.mint)?.verdict, t);
      if (lb && cx + lb.text.length + 2 <= x + w) cx = badge(cv, cx, y, lb.text, lb.fg, { on: bg }) + 1;
      for (const f of r.flags.slice(0, 2)) { if (cx + f.length + 2 > x + w) break; cx = badge(cv, cx, y, f, f === 'MINT' || f === 'FREEZE' || f === 'DEAD' ? t.down : t.warn, { on: bg }) + 1; }
      if (!r.flags.length && !lb) auditCell(cv, x, y, r, bg);
    } },
  ];
  return promoteMcap(cols, mode); // task-1366: MCAP takes PRICE's slot in mcap mode
}

export function renderScreener(c: Canvas, state: AppState): void {
  // trenchscope: the simple split view is the default face of the screener; the filter editor still opens over it
  if (state.simple && state.screener.mode !== 'filter') { renderSimple(c, state); return; }
  const t = c.theme;
  const bp = breakpoint(c.w);
  const sc = state.screener;
  header(c, headerModel(state));
  const top = 2, bottom = c.h - 1;
  // task-1358: the spotlight width comes from the active workspace's solved layout (44 at ≥ 140 cols by default).
  const sideW = layoutFor(state.custom, c.w, c.h).spotlightW;
  const tableW = c.w - sideW - (sideW ? 1 : 0);
  filterBar(c, sc, top, tableW);
  const rows = screenerView(sc);
  const sort = sortSpec(sc.sort.key);
  const total = sc.rows.length;
  const gated = gateCaption(sc.gates, Object.values(COLUMN_GATE));
  const mode = priceModeOf(state);
  const fallback = mode === 'mcap' ? fallbackCaption(fallbackCount(rows, (r) => r)) : null;
  const sel0 = Math.min(state.selected || 0, Math.max(0, rows.length - 1));
  // "N of M tokens" when a filter hides some; "M tokens" otherwise. When the feed scanned a wider
  // candidate pool than it enriched into rows, trail the real pool size (task-1303). Row position
  // trails so hundreds read at a glance.
  const shown = rows.length === total ? `${total} tokens` : `${rows.length} of ${total} tokens`;
  const count = (sc.pool ?? 0) > total ? `${shown} · pool ${sc.pool}` : shown;
  const pos = rows.length > 0 ? `row ${sel0 + 1}/${rows.length}` : null;
  // Ordered by priority: the box drops its caption whole when it overflows (canvas.box), so when the
  // pool size (task-1303) makes the line too long we shed the low-value tail (position, then refresh
  // age) rather than losing the pool/sort/gate facts. Budget mirrors box()'s title+caption fit test.
  const segs = [
    count,
    `sorted by ${sort?.label ?? sc.sort.key}${sc.sort.dir === 'asc' ? ' asc' : ''}`,
    gated || null,
    fallback, // task-1366: rows whose MCAP cell is a price (supply unknown)
    // task-1361: the P(RUG) column is a model output, so the panel says which model (sheds before the facts above).
    sc.sort.key === 'rug' ? null : `p(rug) = ${RUG_MODEL_LABEL}`,
    // The wide pool is still trickling in under the DexScreener budget (task-1303): tell the user the
    // tail is slowing, not stalled. Ranks above the refresh age / row position so it survives a trim.
    sc.slowing ? '◔ rate-limited, slowing down' : null,
    `refreshed ${state.refreshedAgo || '2s'} ago`,
    pos,
  ].filter((s): s is string => !!s);
  const capBudget = tableW - ' SCREENER '.length - 8;
  let caption = segs.join(' · ');
  while (caption.length > capBudget && segs.length > 1) { segs.pop(); caption = segs.join(' · '); }
  const box = c.box(0, top + 1, tableW, bottom - top - 1, { title: 'SCREENER', caption });
  const sel = Math.min(state.selected || 0, Math.max(0, rows.length - 1));
  const rowsVisible = box.h - 2;
  const scroll = Math.max(0, Math.min(sel - rowsVisible + 2, rows.length - rowsVisible));
  // task-1326: a 2-cell coin icon per row when images are on and the frame is not compact (never on fixtures).
  const icon: IconCell | null = imagesOn(state) && bp !== 'compact'
    ? (cv, x, y, w, r, bg) => { drawCoin(cv, state, { x, y, w, h: 1, url: r.image, symbol: r.symbol, bg, prio: 1, mode: 'quad' }); }
    : null;
  table(c, box.x + 1, box.y, box.w - 2, box.h, {
    columns: screenerColumns(c, bp, sc.gates, state.larpByMint ?? null, icon, mode), rows, selected: sel, scroll: Math.max(0, scroll), sortKey: sc.sort.key, sortDir: sc.sort.dir, bg: box.bg,
  });
  if (rows.length === 0) emptyState(c, box, sc);
  if (sideW) {
    c.rainZone(tableW, top, 1, bottom - top, 1); // the gutter between table and spotlight
    const row = rows[sel];
    if (row) spotlight(c, c.w - sideW, top, sideW, bottom - top, row, sc.gates, imagesOn(state) ? (cv, x, y, w, h) => { drawCoin(cv, state, { x, y, w, h, url: row.image, symbol: row.symbol, bg: c.theme.panel, prio: 2 }); } : null, state.now.getTime(), mode);
    else c.box(c.w - sideW, top, sideW, bottom - top, { title: 'SPOTLIGHT' });
  }
  if (sc.mode === 'sort') sortMenu(c, sc, box);
  const hints = sc.mode === 'filter'
    ? [['⏎', 'apply'], ['esc', 'cancel'], ['ctrl+u', 'clear']] as const
    : sc.mode === 'sort'
      ? [['j/k', 'move'], ['⏎', 'pick / flip'], ['esc', 'close']] as const
      : sc.query
        ? [['j/k', 'move'], ['⏎', 'open'], ['g', 'go to'], ['/', 'filter'], ['\\', 'clear filter'], ['s', 'sort'], ['w', 'watch'], ['a', 'ask'], ['q', 'quit']] as const
        : [['j/k', 'move'], ['PgUp/Dn·G', 'page'], ['[ ]', 'feed'], ['⏎', 'open'], ['g', 'go to'], ['/', 'filter'], ['s', 'sort'], ['w', 'watch'], ['a', 'ask'], ['q', 'quit']] as const;
  footer(c, hints, state.theme.name, isCalm(state.vfx));
}

/** Row 2: the `⌕` query (or the editor) on the left, presets on the right; the gap between them rains. */
function filterBar(c: Canvas, sc: ScreenerState, fy: number, tableW: number): void {
  const t = c.theme;
  c.fill(0, fy, tableW, 1, ' ', { bg: t.bg });
  let x = c.text(1, fy, '⌕ ', { fg: t.pop ?? t.accent, bg: t.bg, b: true });
  if (sc.mode === 'filter') {
    const text = sc.edit.text;
    x = c.text(x, fy, text, { fg: t.text, bg: t.bg }, Math.max(0, tableW - x - 2));
    c.put(x, fy, '▏', { fg: t.pop ?? t.accent, bg: t.bg, b: true, soft: true });
    x += 1;
    const err = sc.edit.error;
    const msg = err ? `✗ ${err.error}` : text.trim() ? '✓ ⏎ to apply' : 'type a filter · fields: vol24 liq mcap age holders org … · tags: launchpad: flag: chain:';
    const mx = x + 2;
    if (mx < tableW - 8) c.text(mx, fy, msg, { fg: err ? t.down : t.dim, bg: t.bg, i: !err }, tableW - mx - 1);
    return;
  }
  if (sc.notice) {
    x = c.text(x, fy, sc.notice, { fg: t.warn, bg: t.bg, i: true }, tableW - x - 2);
  } else {
    x = c.text(x, fy, sc.query || DEFAULT_QUERY, { fg: sc.query ? t.text : t.muted, bg: t.bg, i: !sc.query }, tableW - x - 2);
  }
  // presets, right-aligned; disabled ones dim with their caption ('needs key', 'D-08', …). The
  // task-1303 feed switcher can outgrow a narrow frame, so when the full set won't fit we window
  // around the active preset — reading forward from it, counting each disabled preset's caption so
  // the window never hides why a preset is off — and mark the trimmed sides with ‹ / › instead of
  // dropping the whole bar.
  const items = sc.presets.map((p) => ({ p, label: ` ${p.label} `, cap: (!p.available || p.approx) && p.caption ? `${p.caption} ` : '' }));
  const avail = tableW - 2 - (x + 4);
  const w = (it: (typeof items)[number]) => it.label.length + 1 + it.cap.length;
  if (avail > 6 && items.length) {
    let lo = 0, hi = items.length;
    if (items.reduce((s, it) => s + w(it), 0) > avail) {
      // Something is always hidden here, so budget for the trailing › (1 col); the leading ‹ (2 cols)
      // only costs once we have actually trimmed the left (lo > 0), so account for it per step.
      const budget = avail - 1;
      const ai = Math.max(0, items.findIndex((it) => it.p.id === sc.preset));
      lo = ai; hi = ai + 1;
      let used = w(items[ai]);
      for (;;) {
        const canR = hi < items.length && used + w(items[hi]) + (lo > 0 ? 2 : 0) <= budget;
        const canL = lo > 0 && used + w(items[lo - 1]) + (lo - 1 > 0 ? 2 : 0) <= budget;
        if (!canR && !canL) break;
        if (canR) used += w(items[hi++]); else used += w(items[--lo]);
      }
    }
    const win = items.slice(lo, hi);
    const total = win.reduce((s, it) => s + w(it), 0) + (lo > 0 ? 2 : 0) + (hi < items.length ? 1 : 0);
    let px = tableW - 2 - total;
    if (px > x + 2) {
      c.rainZone(x + 1, fy, px - x - 2, 1, 1);
      if (lo > 0) px = c.text(px, fy, '‹ ', { fg: t.dim, bg: t.bg });
      for (const it of win) {
        const active = it.p.id === sc.preset;
        if (active) px = c.text(px, fy, it.label, { fg: onAccent(t.borderFocus), bg: t.borderFocus, b: true }) + 1;
        else if (it.p.available) px = c.text(px, fy, it.label, { fg: t.muted, bg: t.bg }) + 1;
        else px = c.text(px, fy, it.label, { fg: t.dim, bg: t.bg, d: true }) + 1;
        // An approximation preset is available but still shows its caption ('approx'), so the UI never
        // implies the keyed signal; a disabled preset shows its reason ('needs key', 'D-08', …).
        if (it.cap) px = c.text(px - 1, fy, it.cap, { fg: t.dim, bg: t.bg, i: true }) + 1;
      }
      if (hi < items.length) c.text(px, fy, '›', { fg: t.dim, bg: t.bg });
    }
  }
}

function emptyState(c: Canvas, box: { x: number; y: number; w: number; h: number; bg: Hex }, sc: ScreenerState): void {
  const t = c.theme;
  const y = box.y + Math.min(4, Math.floor(box.h / 2));
  // task-1305 (M6): when the live feed has no rows, say *why* — connecting / offline / rate-limited —
  // instead of an indefinite "waiting for the feed". A degraded color flags the two actionable states.
  let msg: string;
  let fg = t.muted;
  if (sc.rows.length === 0) {
    if (sc.source === 'fixtures') msg = 'no rows';
    else {
      const cond = feedCondition(sc);
      msg = cond.message;
      if (cond.kind === 'offline' || cond.kind === 'ratelimited') fg = t.warn;
    }
  } else {
    msg = `no tokens match "${sc.query}" · / to edit, ctrl+u then ⏎ to clear`;
  }
  // Keep the message legible: rain must not write into the spaces inside it (task-1305, QA M7).
  c.noRain(box.x, y, box.w, 1);
  c.textC(box.x, y, box.w, msg, { fg, bg: box.bg, i: true });
}

/** The `s` sort menu: a small centered list over the table. */
function sortMenu(c: Canvas, sc: ScreenerState, over: { x: number; y: number; w: number; h: number }): void {
  const t = c.theme;
  const w = 30, h = SORT_KEYS.length + 2;
  const x = over.x + Math.max(0, Math.floor((over.w - w) / 2));
  const y = over.y + Math.max(0, Math.floor((over.h - h) / 2));
  const box = c.box(x, y, w, h, { title: 'SORT BY', caption: '⏎ pick · again flips', focus: true, bg: t.panelAlt });
  c.noRain(x, y, w, h);
  SORT_KEYS.forEach((k, i) => {
    const cur = k.key === sc.sort.key;
    const hot = i === sc.sortCursor;
    const bg = hot ? t.selBg : box.bg;
    c.fill(box.x, box.y + i, box.w, 1, ' ', { bg });
    c.text(box.x + 1, box.y + i, hot ? '▸' : ' ', { fg: t.pop ?? t.accent, bg });
    c.text(box.x + 3, box.y + i, k.label, { fg: cur ? t.accent : t.text, bg, b: cur });
    const dir = cur ? (sc.sort.dir === 'desc' ? '▼' : '▲') : (k.defaultDir === 'desc' ? '▽' : '△');
    c.textR(box.x + 1, box.y + i, box.w - 2, dir, { fg: cur ? t.accent : t.dim, bg });
  });
}

/** Right-hand spotlight card for the selected row (wide layouts only). */
export function spotlight(c: Canvas, x: number, y: number, w: number, h: number, tk: ScreenerRow, gates: Record<string, Gate> | null = null, hero: ((cv: Canvas, x: number, y: number, w: number, h: number) => void) | null = null, now: number | null = null, mode: PriceMode = 'price'): void {
  const t = c.theme;
  const off = (id: string) => !!gates && gates[id]?.available === false;
  const gateWord = (id: string) => (gates?.[id]?.state === 'needs-key' ? 'needs key' : gates?.[id]?.state === 'disabled' ? 'off' : 'degraded');
  const box = c.box(x, y, w, h, { title: `$${tk.symbol}`, caption: shortAddr(tk.mint, 5), focus: true });
  const bg = box.bg;
  let cy = box.y;
  // task-1326: a 6×3 coin image in the card's top-right corner (name / price / gap rows); text keeps clear of it.
  const heroW = hero ? 6 : 0;
  c.text(box.x + 1, cy, tk.name, { fg: t.muted, bg }, box.w - 2 - (heroW ? heroW + 1 : 0));
  cy += 1;
  // task-1366: the headline number follows the price mode (mcap first, the price beside it; a price + note without a supply)
  const head = priceCell(mode, tk.price, tk.mcap);
  let cx = c.text(box.x + 1, cy, head.text, { fg: head.fallback ? t.warn : t.text, bg, b: true });
  if (head.kind === 'mcap' && tk.price !== null) cx = c.text(cx + 1, cy, `(${fmtPrice(tk.price)})`, { fg: t.dim, bg });
  cx = c.text(cx + 1, cy, fmtPctDir(tk.chg.h24), pctStyle(c, tk.chg.h24, bg));
  c.text(cx + 1, cy, '24h', { fg: t.dim, bg });
  if (head.fallback) c.text(box.x + 1, cy + 1, MCAP_FALLBACK_NOTE, { fg: t.warn, bg, i: true }, box.w - 2 - (heroW ? heroW + 1 : 0));
  if (tk.launchpad !== 'unknown') launchpadBadge(c, box.x + box.w - 8 - (heroW ? heroW + 1 : 0), cy, tk.launchpad, { on: bg });
  if (hero) hero(c, box.x + box.w - 1 - heroW, box.y, heroW, 3);
  cy += 2;
  sparkArea(c, box.x + 1, cy, box.w - 2, 4, tk.spark, { bg });
  cy += 5;
  const holdersOff = off('holders');
  const orgOff = off('org');
  const holdersSub = tk.holders24 !== null ? fmtDeltaDir(tk.holders24)
    : tk.holdersChgPct !== null ? fmtPctDir(tk.holdersChgPct) + ' 24h' : undefined;
  cy += statGrid(c, box.x + 1, cy, box.w - 2, [
    tk.mcapFlagged
      ? { label: 'mcap', value: fmtUsd(tk.mcap, { digits: 1 }) + '?', sub: 'sources differ', style: { fg: t.warn, bg, b: true } }
      : { label: 'mcap', value: fmtUsd(tk.mcap, { digits: 1 }) },
    { label: 'liquidity', value: fmtUsd(tk.liq, { digits: 1 }) },
    { label: 'vol 24h', value: fmtUsd(tk.vol24, { digits: 1 }) },
    holdersOff
      ? { label: 'holders', value: '—', sub: gateWord('holders'), style: { fg: t.dim, bg } }
      : { label: 'holders', value: fmtNum(tk.holders), sub: tk.holders === null ? undefined : holdersSub, style: tk.holders === null ? { fg: t.dim, bg } : undefined },
    orgOff || tk.org === null
      ? { label: 'organic', value: '—', sub: orgOff ? gateWord('org') : undefined, style: { fg: t.dim, bg } }
      : { label: 'organic', value: `${Math.round(tk.org)}/100`, style: { fg: tk.org >= 70 ? t.up : tk.org >= 40 ? t.warn : t.down, b: true } },
    tk.top10 === null
      ? { label: 'top 10', value: '—', sub: holdersOff ? gateWord('holders') : 'no audit', style: { fg: t.dim, bg } }
      : { label: 'top 10', value: `${tk.top10.toFixed(1)}%`, style: { fg: tk.top10 > 30 ? t.warn : t.text, b: true } },
  ], { bg, cols: 2 });
  cy += 1;
  c.text(box.x + 1, cy, 'BUYS / SELLS 24H', { fg: t.dim, bg });
  cy += 1;
  if (tk.buys !== null && tk.sells !== null && !off('bs')) {
    ratioBar(c, box.x + 1, cy, box.w - 2, tk.buys, tk.sells, { bg });
    cy += 1;
    c.text(box.x + 1, cy, '▲' + fmtNum(tk.buys), { fg: t.up, bg });
    c.textR(box.x + 1, cy, box.w - 2, '▼' + fmtNum(tk.sells), { fg: t.down, bg });
  } else {
    c.text(box.x + 1, cy, '—', { fg: t.dim, bg });
    cy += 1;
    c.text(box.x + 1, cy, off('bs') ? gateWord('bs') : 'no txn counts', { fg: t.dim, bg });
  }
  cy += 2;
  c.text(box.x + 1, cy, 'SAFETY', { fg: t.dim, bg });
  cy += 1;
  // null = the keyless sources did not say: shown as an open circle, never as a pass or a fail
  // A missing value says why: "needs key" only when its source really is keyless-gated, else "not reported".
  const why = (gate: string | null): string => (gate && off(gate) ? gateWord(gate) : 'not reported');
  const checks: Array<[label: string, ok: boolean | null, missing: string]> = [
    ['mint authority', tk.mintAuth === null ? null : !tk.mintAuth, why('flags')],
    ['freeze authority', tk.freezeAuth === null ? null : !tk.freezeAuth, why('flags')],
    [tk.lpLocked === null ? 'LP locked' : `LP locked ${Math.round(tk.lpLocked)}%`, tk.lpLocked === null ? null : tk.lpLocked >= 90, tk.dex === 'pumpfun' ? 'on curve, no LP yet' : why(null)],
    [tk.dev === null ? 'dev holds' : `dev holds ${tk.dev.toFixed(2)}%`, tk.dev === null ? null : tk.dev < 3, why('dev')],
    [tk.bundled === null ? 'bundled' : `bundled ${tk.bundled.toFixed(0)}%`, tk.bundled === null ? null : tk.bundled < 10, why('bundled')],
    [tk.snipers === null ? 'snipers' : `snipers ${tk.snipers}`, tk.snipers === null ? null : tk.snipers < 5, why('snipers')],
  ];
  for (const [label, ok, missing] of checks) {
    if (cy >= box.y + box.h - 5) break;
    if (ok === null) {
      c.text(box.x + 1, cy, '○', { fg: t.dim, bg });
      const lx = c.text(box.x + 3, cy, label, { fg: t.dim, bg }, box.w - 4);
      c.text(lx + 1, cy, missing, { fg: t.dim, bg, i: true }, Math.max(0, box.x + box.w - 1 - (lx + 1)));
    } else {
      c.text(box.x + 1, cy, ok ? '✓' : '✗', { fg: ok ? t.up : t.down, bg, b: true });
      c.text(box.x + 3, cy, label, { fg: ok ? t.text : t.warn, bg }, box.w - 4);
    }
    cy += 1;
  }
  // task-1361: p(rug) is a MODEL OUTPUT, so the card says so: value, model id + kind, and how old the scored data is.
  const ay = box.y + box.h - 3;
  if (cy < ay - 3) {
    const p = rugP(tk);
    const age = now === null ? null : rugDataAge(tk, now);
    if (p === null) {
      c.text(box.x + 1, cy, '○', { fg: t.dim, bg });
      c.text(box.x + 3, cy, `p(rug) — · ${RUG_MODEL_LABEL}`, { fg: t.dim, bg }, box.w - 4);
      c.text(box.x + 3, cy + 1, 'model output · no data to score', { fg: t.dim, bg, i: true }, box.w - 4);
    } else {
      const risky = p >= RUG_FLAG_THRESHOLD;
      c.text(box.x + 1, cy, risky ? '✗' : p >= 0.35 ? '△' : '✓', { fg: risky ? t.down : p >= 0.35 ? t.warn : t.up, bg, b: true });
      const vx = c.text(box.x + 3, cy, `p(rug) ${fmtRugP(p)}`, { fg: risky ? t.down : p >= 0.35 ? t.warn : t.text, bg, b: true });
      c.text(vx + 1, cy, `· ${RUG_MODEL_LABEL}`, { fg: t.dim, bg, i: true }, Math.max(0, box.x + box.w - 1 - (vx + 1)));
      c.text(box.x + 3, cy + 1, `model output · data ${age ? `${age} old` : 'age unknown'}`, { fg: t.dim, bg, i: true }, box.w - 4);
    }
    cy += 2;
  }
  // the blank middle of the card is a quiet rain zone
  if (ay - 2 > cy) c.rainZone(box.x + 1, cy + 1, box.w - 2, ay - 2 - cy, 2);
  // AI one-liner (coral is the analyst's voice: title and verdict, VISUAL-V2 §2)
  c.hline(box.x, ay - 1, box.w, { fg: mix(t.border, t.ai, 0.4), bg, soft: true });
  c.text(box.x + 1, ay, '✦ claude', { fg: t.ai, bg, b: true });
  c.heading(box.x + 1, ay, 8);
  if (tk.aiNote) c.text(box.x + 1, ay + 1, tk.aiNote, { fg: t.ai, bg }, box.w - 2);
  else c.text(box.x + 1, ay + 1, 'press a for a claude analysis', { fg: t.dim, bg, i: true }, box.w - 2);
  c.textR(box.x + 1, ay, box.w - 2, 'a → full analysis', { fg: t.dim, bg });
}
