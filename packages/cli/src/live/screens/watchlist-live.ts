// trenchscope — live WATCHLIST screen (task-1298): the layout of screens/watchlist.ts over the persisted list.
// ALERTS shows the real event log; the right panel lists alert PROPOSALS (y arms, x dismisses) and the
// armed rules, instead of the fixture "analyst digest" (Claude wiring is a later card).
import {
  Canvas, table, sparkline, heatPct, launchpadBadge, badge,
  fmtUsd, fmtPrice, fmtAge, header, footer, breakpoint,
  type Column, type Hex,
} from '@dexterm/tui';
import { priceModeOf, promoteMcap, supplyRatio, mcapAt, fallbackCount, fallbackCaption, FALLBACK_MARK } from '../../display.ts';
import type { AppState } from '../../state.ts';
import { headerModel } from '../../state.ts';
import type { WatchViewRow, WatchlistLive } from '../watchlist.ts';
import { fmtValue } from '@dexterm/data';
import { drawCoin, imagesOn } from '../../screens/coin.ts';
import { COIN_ICON_W } from '@dexterm/tui';

export function renderWatchlistLive(c: Canvas, state: AppState, live: WatchlistLive): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const now = state.now.getTime();
  const top = 2, bottom = c.h - 1;
  const rows = live.list();
  const sel = Math.min(Math.max(0, state.selected || 0), Math.max(0, rows.length - 1));
  const st = live.status();
  const listH = Math.max(8, Math.min(rows.length + 4, Math.floor((bottom - top) * 0.5)));
  const mode = priceModeOf(state); // task-1366
  const fb = mode === 'mcap' ? fallbackCaption(fallbackCount(rows, (r) => ({ price: r.row?.price, mcap: r.row?.mcap }))) : null;
  const box = c.box(0, top, c.w, listH, { title: 'WATCHLIST', caption: fb ? `${st.caption} · ${fb}` : st.caption });
  const dash = (cv: Canvas, x: number, y: number, w: number, bg: Hex) => cv.textR(x, y, w, '—', { fg: t.dim, bg });
  const cols: Column<WatchViewRow>[] = [
    // task-1326: the coin image from the latest market row (null until the first refresh → placeholder).
    ...(imagesOn(state) && bp !== 'compact' ? [{ key: 'img', label: '', w: COIN_ICON_W, prio: 2, render: (cv, x, y, w, r, bg) => { drawCoin(cv, state, { x, y, w, h: 1, url: r.row?.image ?? null, symbol: r.entry.symbol, bg, prio: 1, mode: 'quad' }); } } as Column<WatchViewRow>] : []),
    { key: 'token', label: 'TOKEN', w: 22, prio: 0, flex: true, render: (cv, x, y, w, r, bg) => {
      const cx = cv.text(x, y, r.entry.symbol, { fg: t.text, bg, b: true }, 10);
      cv.text(cx + 1, y, r.entry.name, { fg: t.muted, bg }, w - (cx - x) - 1);
    } },
    { key: 'lp', label: 'LP', w: 6, prio: 3, render: (cv, x, y, w, r, bg) => { if (r.entry.launchpad === 'unknown') cv.text(x, y, '—', { fg: t.dim, bg }); else launchpadBadge(cv, x, y, r.entry.launchpad, { on: bg }); void w; } },
    { key: 'price', label: 'PRICE', w: 11, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => {
      // Fast lane (task-1312): the on-chain push price when this mint is streaming LIVE, else the polled price.
      const live = state.live?.badgeFor(r.entry.mint) === 'LIVE' ? state.live?.livePrice(r.entry.mint) ?? null : null;
      const p = live ?? r.row?.price ?? null;
      if (p === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtPrice(p), { fg: r.stale && live === null ? t.muted : t.text, bg });
    } },
    // task-1366: in mcap mode the entry reads as the market cap at entry (entry price × the CURRENT supply ratio)
    { key: 'entry', label: mode === 'mcap' ? 'ENTRY MC' : 'ENTRY', w: 11, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => {
      if (r.entry.entryPrice === null) { dash(cv, x, y, w, bg); return; }
      const ratio = mode === 'mcap' ? supplyRatio(r.row?.price, r.row?.mcap) : null;
      cv.textR(x, y, w, ratio !== null ? fmtUsd(mcapAt(r.entry.entryPrice, ratio), { digits: 1 }) : fmtPrice(r.entry.entryPrice) + (mode === 'mcap' ? FALLBACK_MARK : ''), { fg: t.muted, bg });
    } },
    { key: 'pnl', label: 'VS ENTRY', w: 9, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.pnlPct, bg) },
    { key: 'h1', label: '1H', w: 7, align: 'right', prio: 1, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.row?.chg.h1 ?? null, bg) },
    { key: 'h24', label: '24H', w: 8, align: 'right', prio: 1, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.row?.chg.h24 ?? null, bg) },
    { key: 'mcap', label: 'MCAP', w: mode === 'mcap' ? 9 : 8, align: 'right', prio: 1, render: (cv, x, y, w, r, bg) => {
      // task-1366: in mcap mode a streaming (LIVE) price moves the market cap too (live price × the polled supply ratio);
      // without a supply the cell is the price, marked ᵖ in amber.
      const live = mode === 'mcap' && state.live?.badgeFor(r.entry.mint) === 'LIVE' ? state.live?.livePrice(r.entry.mint) ?? null : null;
      const ratio = supplyRatio(r.row?.price, r.row?.mcap);
      const v = live !== null && ratio !== null ? mcapAt(live, ratio) : r.row?.mcap ?? null;
      const p = live ?? r.row?.price ?? null;
      if (v === null && mode === 'mcap' && p !== null) { cv.textR(x, y, w, fmtPrice(p) + FALLBACK_MARK, { fg: t.warn, bg }); return; }
      if (v === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtUsd(v, { digits: 1 }), { fg: t.text, bg });
    } },
    { key: 'liq', label: 'LIQ', w: 8, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => { const v = r.row?.liq ?? null; if (v === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtUsd(v, { digits: 1 }), { fg: t.text, bg }); } },
    { key: 'spark', label: '24H TREND', w: 16, prio: 1, render: (cv, x, y, w, r, bg) => { if (r.row?.spark) sparkline(cv, x, y, w, r.row.spark, { bg }); else cv.text(x, y, '—', { fg: t.dim, bg }); } },
    { key: 'note', label: 'NOTE', w: 30, prio: 2, render: (cv, x, y, w, r, bg) => { cv.text(x, y, r.entry.note, { fg: t.muted, bg, i: true }, w); } },
    { key: 'added', label: 'ADDED', w: 6, align: 'right', prio: 4, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, fmtAge(Math.max(0, (now - r.entry.addedAt) / 60000)), { fg: t.dim, bg }); } },
  ];
  // Fast lane (task-1312): an honest per-row LIVE/POLL badge, only in live mode (the fast lane exists).
  if (state.live?.fastLane) {
    cols.splice(2, 0, { key: 'feed', label: 'FEED', w: 5, prio: 2, render: (cv, x, y, w, r, bg) => {
      const live = state.live?.badgeFor(r.entry.mint) === 'LIVE';
      badge(cv, x, y, live ? 'LIVE' : 'POLL', live ? t.up : t.dim, { on: bg }); void w;
    } });
  }
  if (rows.length) table(c, box.x + 1, box.y, box.w - 2, box.h, { columns: promoteMcap(cols, mode), rows, selected: sel, bg: box.bg });
  else c.textC(box.x, box.y + Math.min(3, Math.floor(box.h / 2)), box.w, 'watchlist is empty · press w on any token (screener, new pairs, token screen) to add it', { fg: t.muted, bg: box.bg, i: true });

  const y2 = top + listH;
  const h2 = bottom - y2;
  const alertsW = bp === 'compact' ? c.w : Math.floor(c.w * 0.58);
  const notice = live.notice ?? state.live?.notice ?? null;
  const ab = c.box(0, y2, alertsW, h2, { title: 'ALERTS', caption: notice ?? 'armed rules fire once into this log · nothing trades', captionFg: notice ? t.warn : undefined });
  let ay = ab.y;
  const events = live.events(h2);
  if (!events.length) c.text(ab.x + 1, ay, 'no alerts yet', { fg: t.dim, bg: ab.bg, i: true });
  for (const a of events) {
    if (ay >= ab.y + ab.h) break;
    const color = a.level === 'up' ? t.up : a.level === 'down' ? t.down : a.level === 'ai' ? t.ai : t.accent;
    let cx = c.text(ab.x + 1, ay, fmtAge(Math.max(0, (now - a.t) / 60000)).padStart(4), { fg: t.dim, bg: ab.bg });
    cx = badge(c, cx + 1, ay, a.kind.toUpperCase().padEnd(9), color, { on: ab.bg }) + 1;
    c.text(cx, ay, a.text, { fg: t.text, bg: ab.bg }, ab.w - (cx - ab.x) - 1);
    ay += 1;
  }
  if (bp !== 'compact') {
    const rb = c.box(alertsW, y2, c.w - alertsW, h2, { title: 'ALERT PROPOSALS', caption: 'y arm · x dismiss · b propose' });
    let ry = rb.y;
    const proposals = live.proposals();
    const armed = live.armed();
    const sym = (m: string) => live.store.get(m)?.symbol ?? m.slice(0, 6);
    if (!proposals.length && !armed.length) {
      c.text(rb.x + 1, ry, 'no proposals · b on a row proposes a liquidity alert', { fg: t.dim, bg: rb.bg, i: true }, rb.w - 2);
      ry += 1;
    }
    proposals.forEach((p, i) => {
      if (ry >= rb.y + rb.h) return;
      const hot = i === 0;
      c.text(rb.x + 1, ry, hot ? '▸' : ' ', { fg: t.accent, bg: rb.bg });
      c.text(rb.x + 3, ry, `${sym(p.mint)} ${p.kind} ${p.op} ${fmtValue(p.kind, p.value)}`, { fg: t.text, bg: rb.bg, b: hot }, rb.w - 4);
      c.textR(rb.x + 1, ry, rb.w - 2, p.note, { fg: t.dim, bg: rb.bg });
      ry += 1;
    });
    if (armed.length && ry < rb.y + rb.h) {
      ry += ry > rb.y ? 1 : 0;
      c.text(rb.x + 1, ry, 'ARMED', { fg: t.dim, bg: rb.bg });
      ry += 1;
      for (const r of armed) {
        if (ry >= rb.y + rb.h) break;
        c.text(rb.x + 1, ry, `● ${sym(r.mint)} ${r.kind} ${r.op} ${fmtValue(r.kind, r.value)}`, { fg: t.up, bg: rb.bg }, rb.w - 2);
        ry += 1;
      }
    }
    if (ry < rb.y + rb.h - 1) {
      ry = rb.y + rb.h - 1;
      c.text(rb.x + 1, ry, '✦ analyst digest: ◌ demo data · not wired yet', { fg: t.warn, bg: rb.bg, i: true }, rb.w - 2);
    }
  }
  footer(c, [['j/k', 'move'], ['⏎', 'open'], ['d', 'remove'], ['b', 'propose alert'], ['y/x', 'arm/dismiss'], ['r', 'refresh'], ['q', 'quit']], state.theme.name);
}
