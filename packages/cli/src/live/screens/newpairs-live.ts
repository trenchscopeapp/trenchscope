// trenchscope — live NEW PAIRS screen (task-1298): the layout of screens/newpairs.ts over NewPairRows.
// The table caption names the push source and its rate, the sub-tabs count real rows, forensics
// columns the keyless sources cannot answer dash out and the spotlight says what is missing and why.
import {
  Canvas, table, sparkline, sparkArea, launchpadBadge, bar, badge, statGrid, ratioBar, heatPct,
  fmtUsd, fmtPrice, fmtAge, fmtNum, fmtPct, shortAddr, header, footer, breakpoint, mix,
  type Column, type Hex,
} from '@dexterm/tui';
import { auditCell } from '../../screens/audit-cell.ts';
import type { AppState } from '../../state.ts';
import { headerModel } from '../../state.ts';
import type { NewPairRow, NewPairsLive } from '../newpairs.ts';
import { PUMP_GRADUATION_USD } from '../newpairs.ts';
import { drawCoin, imagesOn } from '../../screens/coin.ts';
import { COIN_ICON_W } from '@dexterm/tui';
import { launchIntelCells, type IntelCell } from '../intel.ts';
import { priceCell, priceModeOf, fallbackCount, fallbackCaption, FALLBACK_MARK, MCAP_FALLBACK_NOTE } from '../../display.ts';

type Level = 'ok' | 'warn' | 'bad' | 'na';

export function renderNewPairsLive(c: Canvas, state: AppState, live: NewPairsLive): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const now = state.now.getTime();
  const top = 2, bottom = c.h - 1;
  const sideW = bp === 'wide' ? 46 : 0;
  const tableW = c.w - sideW - (sideW ? 1 : 0);
  const rows = live.list();
  const sel = Math.min(Math.max(0, state.selected || 0), Math.max(0, rows.length - 1));
  const st = live.status();
  const dash = (cv: Canvas, x: number, y: number, w: number, bg: Hex, align: 'left' | 'right' = 'right') => {
    if (align === 'right') cv.textR(x, y, w, '—', { fg: t.dim, bg }); else cv.text(x, y, '—', { fg: t.dim, bg });
  };
  const intel = state.live?.intel;
  const intelCell = (cv: Canvas, x: number, y: number, w: number, cell: IntelCell, bg: Hex) => {
    cv.textR(x, y, w, cell.short, { fg: cell.level === 'bad' ? t.down : cell.level === 'warn' ? t.warn : cell.level === 'ok' ? t.muted : t.dim, bg });
  };
  // sub-tabs (real counts)
  const fy = top;
  let x = 1;
  const graduating = rows.filter((r) => r.bonding !== null && r.bonding >= 80 && !r.migrated).length;
  const migrated = rows.filter((r) => r.migrated).length;
  const tabs: Array<[string, number]> = [['New', rows.length], ['Graduating', graduating], ['Migrated', migrated]];
  for (const [lab, n] of tabs) {
    const active = lab === 'New';
    x = c.text(x, fy, ` ${lab} `, active ? { fg: t.text, bg: t.tabActiveBg, b: true } : { fg: t.muted, bg: t.bg });
    x = c.text(x, fy, `${n} `, { fg: active ? t.accent : t.dim, bg: active ? t.tabActiveBg : t.bg }) + 1;
  }
  const lat = st.latency.p50 !== null ? `event→row p50 ${Math.round(st.latency.p50)}ms` : '';
  const rlat = st.renderLatency.p50 !== null ? ` · →screen p50 ${Math.round(st.renderLatency.p50)}ms` : '';
  const note = state.live?.notice ?? '';
  c.text(x + 2, fy, note || `${lat}${rlat}` || 'waiting for the first create…', { fg: note ? t.warn : t.dim, bg: t.bg, i: true }, tableW - x - 4);
  const mode = priceModeOf(state); // task-1366
  const fb = mode === 'mcap' ? fallbackCaption(fallbackCount(rows, (r) => r)) : null;
  const box = c.box(0, top + 1, tableW, bottom - top - 1, { title: 'NEW PAIRS', caption: fb ? `${st.caption} · ${fb}` : st.caption, captionFg: st.headerStatus ? t.warn : undefined });
  const cols: Column<NewPairRow>[] = [
    { key: 'age', label: 'AGE', w: 5, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => { const m = Math.max(0, (now - r.createdAt) / 60000); cv.textR(x, y, w, fmtAge(m), { fg: m < 2 ? t.accent : t.muted, bg, b: m < 2 }); } },
    // task-1326: the coin image once a poll has seen the mint (a fresh create has none yet → the ticker placeholder).
    ...(imagesOn(state) && bp !== 'compact' ? [{ key: 'img', label: '', w: COIN_ICON_W, prio: 2, render: (cv, x, y, w, r, bg) => { drawCoin(cv, state, { x, y, w, h: 1, url: r.image, symbol: r.symbol, bg, prio: 1, mode: 'quad' }); } } as Column<NewPairRow>] : []),
    { key: 'token', label: 'TOKEN', w: bp === 'compact' ? 12 : 20, prio: 0, flex: bp !== 'compact', render: (cv, x, y, w, r, bg) => {
      const cx = cv.text(x, y, r.symbol, { fg: t.text, bg, b: true }, Math.min(10, w));
      if (w > 14) cv.text(cx + 1, y, r.name, { fg: t.muted, bg }, w - (cx - x) - 1);
    } },
    { key: 'lp', label: 'LAUNCH', w: 6, prio: 1, render: (cv, x, y, w, r, bg) => { if (r.launchpad === 'unknown') dash(cv, x, y, w, bg, 'left'); else launchpadBadge(cv, x, y, r.launchpad, { on: bg }); } },
    { key: 'bond', label: 'BONDING', w: 14, prio: 1, render: (cv, x, y, w, r, bg) => {
      if (r.migrated) { cv.text(x, y, 'migrated', { fg: t.dim, bg }); return; }
      if (r.bonding === null) { dash(cv, x, y, w, bg, 'left'); return; }
      bar(cv, x, y, w - 5, r.bonding, { bg, color: r.bonding > 80 ? t.warn : t.pump });
      cv.textR(x + w - 4, y, 4, `${Math.round(r.bonding)}%`, { fg: r.bonding > 80 ? t.warn : t.muted, bg });
    } },
    { key: 'mcap', label: 'MCAP', w: 8, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => {
      // task-1366: in mcap mode a launch without a supply shows its price here, marked ᵖ in amber
      if (r.mcap === null && mode === 'mcap' && r.price !== null) { cv.textR(x, y, w, fmtPrice(r.price) + FALLBACK_MARK, { fg: t.warn, bg }); return; }
      if (r.mcap === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtUsd(r.mcap, { digits: 1 }), { fg: t.text, bg });
    } },
    { key: 'liq', label: 'LIQ', w: 7, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => { if (r.liq === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtUsd(r.liq, { digits: 1 }), { fg: t.text, bg }); } },
    { key: 'm5', label: '5M', w: 7, align: 'right', prio: 0, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.chg.m5, bg) },
    { key: 'h1', label: '1H', w: 7, align: 'right', prio: 3, render: (cv, x, y, w, r, bg) => heatPct(cv, x, y, w, r.chg.h1, bg) },
    { key: 'holders', label: 'HLD', w: 5, align: 'right', prio: 2, render: (cv, x, y, w, r, bg) => { if (r.holders === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, fmtNum(r.holders), { fg: t.text, bg }); } },
    { key: 'bs', label: 'B/S 5M', w: 8, prio: 4, render: (cv, x, y, w, r, bg) => { if (r.buys === null || r.sells === null) dash(cv, x, y, w, bg, 'left'); else ratioBar(cv, x, y, w, Math.max(0, r.buys), Math.max(0, r.sells), { bg }); } },
    { key: 'dev', label: 'DEV', w: 5, align: 'right', prio: 3, render: (cv, x, y, w, r, bg) => { if (r.dev === null) dash(cv, x, y, w, bg); else cv.textR(x, y, w, `${r.dev.toFixed(1)}%`, { fg: r.dev > 5 ? t.down : t.muted, bg }); } },
    // task-1359: SNIPE / BUNDLE come from the wallet-intel scan of that mint (the selected row is scanned after a
    // short dwell when a free Helius key is set); an unscanned row keeps the dash, a scan in flight shows `…`.
    { key: 'snipe', label: 'SNIPE', w: 5, align: 'right', prio: 4, render: (cv, x, y, w, r, bg) => intelCell(cv, x, y, w, launchIntelCells(intel, r.mint).snipers, bg) },
    { key: 'bund', label: 'BUNDLE', w: 6, align: 'right', prio: 4, render: (cv, x, y, w, r, bg) => intelCell(cv, x, y, w, launchIntelCells(intel, r.mint).bundle, bg) },
    { key: 'spark', label: 'TREND', w: 12, prio: 2, render: (cv, x, y, w, r, bg) => { if (r.spark) sparkline(cv, x, y, w, r.spark, { bg }); else dash(cv, x, y, w, bg, 'left'); } },
    { key: 'flags', label: 'RISK', w: 13, prio: 5, render: (cv, x, y, w, r, bg) => {
      let cx = x;
      for (const f of r.flags.slice(0, 2)) { if (cx + f.length + 2 > x + w) break; cx = badge(cv, cx, y, f, f === 'MINT' || f === 'FREEZE' || f === 'DEAD' ? t.down : t.warn, { on: bg }) + 1; }
      if (!r.flags.length) auditCell(cv, x, y, r, bg);
    } },
  ];
  if (rows.length) table(c, box.x + 1, box.y, box.w - 2, box.h, { columns: cols, rows, selected: sel, scroll: 0, bg: box.bg });
  else {
    const s = st.stream;
    const msg = st.mode === 'off' ? 'push feed off · r to poll jup recent' : s?.state === 'open' ? `connected to pumpportal · waiting for the first create (≈15/min measured)` : `pumpportal ${s?.state ?? 'connecting'}${s?.lastError ? ` · ${s.lastError}` : ''} · polling jup recent`;
    c.textC(box.x, box.y + Math.min(4, Math.floor(box.h / 2)), box.w, msg, { fg: t.muted, bg: box.bg, i: true });
  }
  if (sideW && rows[sel]) pairSpotlight(c, c.w - sideW, top, sideW, bottom - top, rows[sel], now, state);
  const watched = rows[sel] && state.live?.watch?.has(rows[sel].mint) ? 'unwatch' : 'watch';
  footer(c, [['j/k', 'move'], ['⏎', 'open'], ['p', 'pause feed'], ['w', watched], ['b', 'alert'], ['r', 'refresh'], ['q', 'quit']], state.theme.name);
}

function pairSpotlight(c: Canvas, x: number, y: number, w: number, h: number, r: NewPairRow, now: number, state: AppState): void {
  const t = c.theme;
  const ageMin = Math.max(0, (now - r.createdAt) / 60000);
  const box = c.box(x, y, w, h, { title: `$${r.symbol}`, caption: `${fmtAge(ageMin)} old · ${shortAddr(r.mint, 4)}`, focus: true });
  const bg = box.bg;
  let cy = box.y;
  c.text(box.x + 1, cy, r.name, { fg: t.muted, bg }, box.w - 10);
  if (r.launchpad !== 'unknown') launchpadBadge(c, box.x + box.w - 8, cy, r.launchpad, { on: bg });
  cy += 1;
  // task-1366: the headline follows the price mode (mcap, then the price beside it; a price + note without a supply)
  const head = priceCell(priceModeOf(state), r.price, r.mcap);
  let cx = c.text(box.x + 1, cy, head.text, { fg: head.text === '—' ? t.dim : head.fallback ? t.warn : t.text, bg, b: true });
  if (head.kind === 'mcap' && r.price !== null) cx = c.text(cx + 1, cy, `(${fmtPrice(r.price)})`, { fg: t.dim, bg });
  c.text(cx + 1, cy, r.chg.h1 === null ? '' : fmtPct(r.chg.h1), { fg: (r.chg.h1 ?? 0) >= 0 ? t.up : t.down, bg });
  if (head.fallback) c.text(box.x + 1, cy + 1, MCAP_FALLBACK_NOTE, { fg: t.warn, bg, i: true }, box.w - 8);
  // Fast lane (task-1312): honest feed badge — LIVE when this launch arrived via the PumpPortal push,
  // POLL when it came from the Jupiter-recent poll (the fallback when the socket is down).
  const pushed = r.latencyMs !== null;
  badge(c, box.x + box.w - 6, cy, pushed ? 'LIVE' : 'POLL', pushed ? t.up : t.dim, { on: bg });
  cy += 2;
  if (r.migrated) {
    c.text(box.x + 1, cy, 'MIGRATED', { fg: t.dim, bg });
    c.textR(box.x + 1, cy, box.w - 2, 'bonding complete → PumpSwap', { fg: t.muted, bg });
    cy += 2;
  } else if (r.bonding !== null) {
    c.text(box.x + 1, cy, 'BONDING CURVE', { fg: t.dim, bg });
    c.textR(box.x + 1, cy, box.w - 2, `${Math.round(r.bonding)}% → PumpSwap at ${fmtUsd(PUMP_GRADUATION_USD, { digits: 0 })}`, { fg: t.muted, bg });
    cy += 1;
    bar(c, box.x + 1, cy, box.w - 2, r.bonding, { bg, color: r.bonding > 80 ? t.warn : t.pump });
    cy += 1;
    c.text(box.x + 1, cy, 'est. from curve reserves at create (pumpportal)', { fg: t.dim, bg, i: true }, box.w - 2);
    cy += 1;
  }
  if (r.spark) sparkArea(c, box.x + 1, cy, box.w - 2, 3, r.spark, { bg });
  else c.text(box.x + 1, cy + 1, 'no price history yet', { fg: t.dim, bg, i: true });
  cy += 4;
  const d = (n: number | null, f: (n: number) => string) => (n === null ? '—' : f(n));
  cy += statGrid(c, box.x + 1, cy, box.w - 2, [
    { label: 'mcap', value: d(r.mcap, (n) => fmtUsd(n, { digits: 1 })), sub: r.marketCapSol !== null ? `${r.marketCapSol.toFixed(1)} SOL at create` : undefined },
    { label: 'liquidity', value: d(r.liq, (n) => fmtUsd(n, { digits: 1 })) },
    { label: 'holders', value: d(r.holders, fmtNum) },
    { label: 'vol 24h', value: d(r.vol, (n) => fmtUsd(n, { digits: 1 })) },
  ], { bg, cols: 2 });
  cy += 1;
  c.text(box.x + 1, cy, 'LAUNCH FORENSICS', { fg: t.dim, bg });
  c.textR(box.x + 1, cy, box.w - 2, `via ${r.via.map((s) => (s === 'jupiter-tokens' ? 'jup' : s)).join(' · ') || '—'}`, { fg: t.dim, bg });
  cy += 1;
  const auth = r.mintAuth === null && r.freezeAuth === null ? null : !!(r.mintAuth || r.freezeAuth);
  const cells = launchIntelCells(state.live?.intel, r.mint, 'scans after ~2 s on this row');
  const rows: Array<[string, string, Level]> = [
    ['Dev wallet', r.dev === null ? (r.creator ? `creator ${shortAddr(r.creator, 4)} · share unknown` : '— (jup not yet indexed)') : `${r.dev.toFixed(1)}%${r.creator ? ` · ${shortAddr(r.creator, 4)}` : ''}`, r.dev === null ? 'na' : r.dev > 5 ? 'warn' : 'ok'],
    ['Initial buy', r.initialBuySol === null ? '—' : `${r.initialBuySol.toFixed(2)} SOL by creator`, r.initialBuySol === null ? 'na' : r.initialBuySol > 2 ? 'warn' : 'ok'],
    ['Bundled at launch', cells.bundle.text, cells.bundle.level],
    ['Snipers (first 3 slots)', cells.snipers.text, cells.snipers.level],
    ['Mint / freeze', auth === null ? '— (rugcheck/jup pending)' : auth ? 'ENABLED' : 'revoked', auth === null ? 'na' : auth ? 'bad' : 'ok'],
    ['Socials', `${[r.socials.x && 'X', r.socials.tg && 'TG', r.socials.web && 'web'].filter(Boolean).join(' ') || (r.via.includes('jupiter-tokens') ? 'none' : '—')}`, r.socials.x || r.socials.tg || r.socials.web ? 'ok' : r.via.includes('jupiter-tokens') ? 'warn' : 'na'],
  ];
  for (const [label, val, lvl] of rows) {
    if (cy >= box.y + box.h - 5) break;
    const color = lvl === 'ok' ? t.up : lvl === 'warn' ? t.warn : lvl === 'bad' ? t.down : t.dim;
    c.text(box.x + 1, cy, lvl === 'ok' ? '●' : lvl === 'warn' ? '◐' : lvl === 'bad' ? '○' : '·', { fg: color, bg });
    c.text(box.x + 3, cy, label, { fg: t.muted, bg });
    cy += 1;
    c.text(box.x + 3, cy, val, { fg: lvl === 'ok' ? t.text : lvl === 'na' ? t.dim : color, bg, i: lvl === 'na' }, box.w - 4);
    cy += 1;
  }
  const ay = box.y + box.h - 3;
  c.hline(box.x, ay - 1, box.w, { fg: t.border, bg });
  c.text(box.x + 1, ay, '✦ claude', { fg: t.ai, bg, b: true });
  c.text(box.x + 10, ay, '◌ demo data · not wired yet', { fg: t.warn, bg, i: true }, box.w - 11);
  const lat = r.latencyMs === null ? 'polled (jup recent)' : `pushed · event→row ${Math.round(r.latencyMs)}ms${r.drawnAt !== null && r.receivedAt !== null ? ` · →screen ${Math.round(r.drawnAt - r.receivedAt)}ms` : ''}`;
  c.text(box.x + 1, ay + 1, lat, { fg: t.dim, bg }, box.w - 2);
  void state;
}
