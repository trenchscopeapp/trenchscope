// trenchscope — Watchlist + alerts log + analyst digest.
// Cyberspace styling (task-1297): alert glyphs ▲/▼/✦/◆ beside the badges, claude notes and the digest
// headline in coral, rain zones under the alerts and the digest, ▲ on holder deltas.
import {
  Canvas, table, sparkline, heatPct, launchpadBadge, badge,
  fmtUsd, fmtPrice, fmtAge, wrap, header, footer, breakpoint, mix, isCalm,
  type Column,
} from '@dexterm/tui';
import { priceModeOf, promoteMcap, supplyRatio, mcapAt, priceCell, fallbackCount, fallbackCaption, FALLBACK_MARK } from '../display.ts';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { renderWatchlistLive } from '../live/screens/watchlist-live.ts';
import type { WatchRow } from '../fixtures.ts';

type DigestKind = 'head' | 'ok' | 'warn' | 'bad' | 'dim' | '';

export function renderWatchlist(c: Canvas, state: AppState): void {
  if (state.live && state.screener.source !== 'fixtures') return renderWatchlistLive(c, state, state.live.watch); // task-1298: live data path
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const top = 2, bottom = c.h - 1;
  const sel = state.selected || 0;
  const rows = state.fx.watch;
  const listH = Math.max(8, Math.min(rows.length + 4, Math.floor((bottom - top) * 0.5)));
  const mode = priceModeOf(state); // task-1366
  const fb = mode === 'mcap' ? fallbackCaption(fallbackCount(rows, (r) => ({ price: r.token.price, mcap: r.token.mcap }))) : null;
  const box = c.box(0, top, c.w, listH, { title: 'WATCHLIST', caption: `${rows.length} tokens · PnL vs entry${fb ? ` · ${fb}` : ''}` });
  const cols: Column<WatchRow>[] = [
    { key: 'token', label: 'TOKEN', w: 22, prio: 0, flex: true, render: (cv, x, y, w, r, bg, m) => {
      const cx = cv.text(x, y, r.token.symbol, { fg: m.selected ? t.borderFocus : t.text, bg, b: true }, 10);
      cv.text(cx + 1, y, r.token.name, { fg: t.muted, bg }, w - (cx - x) - 1);
    } },
    { key: 'lp', label: 'LP', w: 6, prio: 3, render: (cv, x, y, _w, r, bg) => { launchpadBadge(cv, x, y, r.token.launchpad, { on: bg }); } },
    { key: 'price', label: 'PRICE', w: 11, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, fmtPrice(r.token.price), { fg: t.text, bg }); } },
    // task-1366: in mcap mode the entry reads as the market cap at entry (entry price × the CURRENT supply ratio)
    { key: 'entry', label: mode === 'mcap' ? 'ENTRY MC' : 'ENTRY', w: 11, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => {
      const ratio = mode === 'mcap' ? supplyRatio(r.token.price, r.token.mcap) : null;
      cv.textR(x, y, w, ratio !== null ? fmtUsd(mcapAt(r.entry, ratio), { digits: 1 }) : fmtPrice(r.entry) + (mode === 'mcap' ? FALLBACK_MARK : ''), { fg: t.muted, bg });
    } },
    { key: 'pnl', label: 'VS ENTRY', w: 9, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, (r.token.price / r.entry - 1) * 100, bg) },
    { key: 'h1', label: '1H', w: 7, align: 'right', prio: 1, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.token.chg.h1, bg) },
    { key: 'h24', label: '24H', w: 8, align: 'right', prio: 1, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.token.chg.h24, bg) },
    { key: 'mcap', label: 'MCAP', w: mode === 'mcap' ? 9 : 8, align: 'right', prio: 1, render: (cv, x, y, w, r, bg) => {
      const pc = priceCell(mode, r.token.price, r.token.mcap);
      if (pc.fallback) cv.textR(x, y, w, pc.text + FALLBACK_MARK, { fg: t.warn, bg }); else cv.textR(x, y, w, fmtUsd(r.token.mcap, { digits: 1 }), { fg: t.text, bg });
    } },
    { key: 'liq', label: 'LIQ', w: 8, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, fmtUsd(r.token.liq, { digits: 1 }), { fg: t.text, bg }); } },
    { key: 'spark', label: '24H TREND', w: 16, prio: 1, render: (cv, x, y, w, r, bg) => sparkline(cv, x, y, w, r.token.spark, { bg }) },
    { key: 'note', label: 'NOTE', w: 30, prio: 2, render: (cv, x, y, w, r, bg) => { cv.text(x, y, r.note, { fg: r.note.startsWith('claude') ? t.ai : t.muted, bg, i: true }, w); } },
    { key: 'added', label: 'ADDED', w: 6, align: 'right', prio: 4, render: (cv, x, y, w, r, bg) => { cv.textR(x, y, w, fmtAge(r.added), { fg: t.dim, bg }); } },
  ];
  table(c, box.x + 1, box.y, box.w - 2, box.h, { columns: promoteMcap(cols, mode), rows, selected: sel, bg: box.bg });

  const y2 = top + listH;
  const h2 = bottom - y2;
  const alertsW = bp === 'compact' ? c.w : Math.floor(c.w * 0.58);
  const ab = c.box(0, y2, alertsW, h2, { title: 'ALERTS', caption: 'price · holders · risk · smart money · claude' });
  let ay = ab.y;
  for (const a of state.fx.alerts) {
    if (ay >= ab.y + ab.h) break;
    const color = a.level === 'up' ? t.up : a.level === 'down' ? t.down : a.level === 'ai' ? t.ai : t.accent;
    const glyph = a.level === 'up' ? '▲' : a.level === 'down' ? '▼' : a.level === 'ai' ? '✦' : '◆';
    let cx = c.text(ab.x + 1, ay, fmtAge(a.ago).padStart(4), { fg: t.dim, bg: ab.bg });
    cx = c.text(cx + 1, ay, glyph, { fg: color, bg: ab.bg, b: true });
    cx = badge(c, cx + 1, ay, a.kind.toUpperCase().padEnd(9), color, { on: ab.bg }) + 1;
    c.text(cx, ay, a.text, { fg: a.level === 'ai' ? t.ai : t.text, bg: ab.bg }, ab.w - (cx - ab.x) - 1);
    ay += 1;
  }
  if (ay + 1 < ab.y + ab.h) c.rainZone(ab.x + 1, ay + 1, ab.w - 2, ab.y + ab.h - ay - 1, 2);
  if (bp !== 'compact') {
    const rb = c.box(alertsW, y2, c.w - alertsW, h2, { title: '✦ ANALYST DIGEST', titleFg: t.ai, caption: 'every 15m · claude -p', border: mix(t.border, t.ai, 0.55) });
    const lines: Array<[DigestKind, string]> = [
      ['head', 'Watchlist health: 4 of 6 intact'],
      ['', ''],
      ['ok', `${rows[0].token.symbol}: momentum intact, holders ▲${Math.abs(rows[0].token.holders24)} 24h`],
      ['ok', `${rows[1].token.symbol}: consolidating above entry, no dev sells`],
      ['warn', `${rows[2].token.symbol}: volume fading, thesis needs a catalyst`],
      ['bad', `${rows[4].token.symbol}: wash-trade signature (organic ${rows[4].token.org}), consider dropping`],
      ['ok', `${rows[3].token.symbol}: smart wallets accumulating (3 tagged buys)`],
      ['', ''],
      ['dim', 'Suggested: alert on CATWIF liq < $80K; review SNAIL at 1.2M'],
      ['dim', 'I do not trade. Confirm any action in the Trade panel (v2).'],
    ];
    let ry = rb.y;
    for (const [kind, text] of lines) {
      if (ry >= rb.y + rb.h) break;
      const fg = kind === 'head' ? t.ai : kind === 'ok' ? t.up : kind === 'warn' ? t.warn : kind === 'bad' ? t.down : t.dim;
      const mark = kind === 'ok' ? '●' : kind === 'warn' ? '◐' : kind === 'bad' ? '○' : ' ';
      const indent = kind && kind !== 'head' && kind !== 'dim' ? 3 : 1;
      const parts = text ? wrap(text, rb.w - 1 - indent) : [''];
      parts.forEach((part, i) => {
        if (ry >= rb.y + rb.h) return;
        if (indent === 3 && i === 0) c.text(rb.x + 1, ry, mark, { fg, bg: rb.bg });
        c.text(rb.x + indent, ry, part, { fg: indent === 3 ? t.text : fg, bg: rb.bg, b: kind === 'head' }, rb.w - 1 - indent);
        ry += 1;
      });
    }
    if (ry + 1 < rb.y + rb.h) c.rainZone(rb.x + 1, ry + 1, rb.w - 2, rb.y + rb.h - ry - 1, 2);
  }
  // task-1388: `g` opens the go-to prompt here too (keymap + the ? overlay list it); the footer is kept
  // byte-identical to prototype-v2 (snapshot parity), so the hint lives in `?` and on the screener footer.
  footer(c, [['j/k', 'move'], ['⏎', 'open'], ['d', 'remove'], ['n', 'note'], ['b', 'add alert'], ['a', 'ask claude'], ['q', 'quit']], state.theme.name, isCalm(state.vfx));
}
