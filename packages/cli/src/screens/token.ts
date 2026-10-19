// trenchscope — Token detail screen: glowing candles + on-chain stats + holders/tape rain + decrypting analyst.
// Cyberspace styling (task-1297): pump/dump band on the price line, rain zones in the title strip and
// the blank panel areas, ▲/▼ everywhere a direction is shown, the analyst's verdict and tool lines in
// coral with the Claude-Code spinner and decrypt stream (VISUAL-V2 §3).
import {
  Canvas, candleChart, statGrid, bar, badge, launchpadBadge, pctStyle, tapeRain, decryptText, spinnerGlyph,
  fmtUsd, fmtPrice, fmtMcap, fmtAge, fmtAgeSec, fmtNum, fmtPctDir, fmtDeltaDir, shortAddr, wrap, header, footer, breakpoint, mix, isCalm,
  type Style,
} from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { renderTokenLive } from '../live/screens/token-live.ts';
import { aiTranscript, type FixtureToken } from '../fixtures.ts';
import { renderAnalystSession } from './analyst-session.ts';
import { renderSocialPanel } from './social-panel.ts';
import { layoutFor } from '../custom.ts';
import { chartMode, priceModeOf } from '../display.ts';

type Level = 'ok' | 'warn' | 'bad';

export function renderToken(c: Canvas, state: AppState): void {
  if (state.live?.token && state.screener.source !== 'fixtures') return renderTokenLive(c, state, state.live.token.view); // task-1298: live data path
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const tk = state.token || state.fx.tokens[state.selected || 0];
  const top = 2, bottom = c.h - 1;
  const lay = layoutFor(state.custom, c.w, c.h); // task-1358: analyst width + chart share from the workspace layout
  const showAi = state.aiOpen !== false && bp !== 'compact' && lay.analystW > 0;
  const aiW = showAi ? lay.analystW : 0;
  const mainW = c.w - aiW;
  const v = state.vfx;
  const pumping = v.mood === 'pump';
  const dumping = v.mood === 'dump';

  // ---- title strip
  let y = top;
  c.fill(0, y, mainW, 2, ' ', { bg: t.bg });
  let x = c.text(1, y, '‹ ', { fg: t.muted, bg: t.bg });
  x = c.text(x, y, `$${tk.symbol}`, { fg: t.borderFocus, bg: t.bg, b: true });
  c.heading(3, y, tk.symbol.length + 1);
  x = c.text(x + 1, y, tk.name, { fg: t.muted, bg: t.bg });
  x = launchpadBadge(c, x + 2, y, tk.launchpad, { on: t.bg });
  if (tk.migrated && tk.launchpad === 'pump.fun') x = badge(c, x + 1, y, 'PUMPSWAP', t.pump, { on: t.bg });
  x = c.text(x + 2, y, shortAddr(tk.mint, 6), { fg: t.dim, bg: t.bg });
  x = c.text(x + 2, y, `age ${fmtAge(tk.ageMin)}`, { fg: t.dim, bg: t.bg });
  const socials = [tk.socials.x && 'X', tk.socials.tg && 'TG', tk.socials.web && 'WEB'].filter((s): s is string => !!s);
  let sx = mainW - 2 - socials.reduce((s, k) => s + k.length + 3, 0);
  if (sx > x + 2) { c.rainZone(x + 1, y, sx - x - 2, 1, 1); for (const s of socials) sx = badge(c, sx, y, s, t.muted, { on: t.bg }) + 1; }
  y += 1;
  // price line: pump glow = gold bg band, dump = red band (the rain ramp of the moment)
  const priceBg = pumping ? mix(t.bg, t.rainPump[2], 0.3) : dumping ? mix(t.bg, t.rainDump[2], 0.3) : t.bg;
  // task-1366: mcap mode leads with the market cap and keeps the price beside it (fixture tokens always carry a supply)
  const cm = chartMode(priceModeOf(state), tk.price, tk.mcap);
  if (cm.kind === 'mcap') {
    x = c.text(1, y, fmtMcap(tk.mcap), { fg: pumping ? t.rainPump[3] : t.text, bg: priceBg, b: true });
    x = c.text(x, y, ` (${fmtPrice(tk.price)})`, { fg: t.dim, bg: priceBg });
  } else x = c.text(1, y, fmtPrice(tk.price), { fg: cm.label ? t.warn : pumping ? t.rainPump[3] : t.text, bg: priceBg, b: true });
  const deltas: Array<[string, number]> = [['5m', tk.chg.m5], ['1h', tk.chg.h1], ['6h', tk.chg.h6], ['24h', tk.chg.h24]];
  x = c.text(x, y, '  ', { bg: t.bg });
  for (const [k, vv] of deltas) {
    x = c.text(x, y, k, { fg: t.dim, bg: t.bg });
    x = c.text(x + 1, y, fmtPctDir(vv), { ...pctStyle(c, vv, t.bg), b: k === '24h' });
    x += 2;
  }
  if (pumping) x = badge(c, x + 1, y, '▲ PUMPING', t.rainPump[3], { bg: mix(t.bg, t.rainPump[2], 0.35), bold: true }) + 1;
  if (dumping) x = badge(c, x + 1, y, '▼ DUMPING', t.rainDump[3], { bg: mix(t.bg, t.rainDump[2], 0.35), bold: true }) + 1;
  c.rainZone(x + 1, y, Math.max(0, mainW - x - 2), 1, 1);
  y += 1;

  // ---- chart
  const chartH = Math.max(10, Math.floor((bottom - y) * lay.chartFrac));
  const cb = c.box(0, y, mainW, chartH, { title: cm.label ? (cm.kind === 'mcap' ? `${tk.symbol} ${cm.label} · 1h` : `${tk.symbol}/SOL · ${cm.label} · 1h`) : `${tk.symbol}/SOL · 1h`, caption: 'ohlcv: geckoterminal' });
  const tfx = cb.x + cb.w - 2;
  const tfs = ['1m', '5m', '15m', '1h', '4h', '1d'];
  let tx = tfx - tfs.reduce((s, f) => s + f.length + 1, 0) - 24;
  for (const f of tfs) tx = c.text(tx, cb.y - 1, f, f === '1h' ? { fg: t.accent, bg: cb.bg, b: true } : { fg: t.dim, bg: cb.bg }) + 1;
  candleChart(c, cb.x + 1, cb.y, cb.w - 2, cb.h, tk.candles, { bg: cb.bg, interval: '1h', scale: cm.scale ?? undefined, axisFmt: cm.axisFmt });
  y += chartH;

  // ---- task-1330: the SOCIAL panel (`s`) replaces the ON-CHAIN / HOLDERS band; the chart stays.
  if (state.tokenSocial) {
    renderSocialPanel(c, 0, y, mainW, bottom - y, state, { mint: tk.mint, symbol: tk.symbol, now: state.now.getTime() });
  } else {
  // ---- stats + holders/trades split
  const lower = bottom - y;
  const statsW = bp === 'compact' ? mainW : Math.min(44, Math.floor(mainW * 0.4));
  const sb = c.box(0, y, statsW, lower, { title: 'ON-CHAIN' });
  let sy = sb.y;
  sy += statGrid(c, sb.x + 1, sy, sb.w - 2, [
    { label: 'mcap', value: fmtUsd(tk.mcap, { digits: 1 }) },
    { label: 'fdv', value: fmtUsd(tk.fdv, { digits: 1 }) },
    { label: 'liquidity', value: fmtUsd(tk.liq, { digits: 1 }), sub: `${(tk.liq / tk.mcap * 100).toFixed(1)}% of mcap` },
    { label: 'vol 24h', value: fmtUsd(tk.vol24, { digits: 1 }) },
    { label: 'holders', value: fmtNum(tk.holders), sub: fmtDeltaDir(tk.holders24) + ' 24h' },
    { label: 'organic', value: `${tk.org}/100`, style: { fg: tk.org >= 70 ? t.up : tk.org >= 40 ? t.warn : t.down, b: true } },
  ], { bg: sb.bg, cols: 2 });
  sy += 1;
  const rows: Array<[string, string, Level]> = [
    ['Top 10 holders', `${tk.top10.toFixed(1)}%`, tk.top10 < 25 ? 'ok' : tk.top10 < 35 ? 'warn' : 'bad'],
    ['Dev wallet', `${tk.dev.toFixed(2)}%`, tk.dev < 3 ? 'ok' : 'warn'],
    ['Bundled supply', `${tk.bundled.toFixed(1)}%`, tk.bundled < 10 ? 'ok' : 'warn'],
    ['Snipers (block 0-2)', String(tk.snipers), tk.snipers < 5 ? 'ok' : 'warn'],
    ['LP locked / burned', `${tk.lpLocked}%`, tk.lpLocked >= 90 ? 'ok' : 'bad'],
    ['Mint authority', tk.mintAuth ? 'ENABLED' : 'revoked', tk.mintAuth ? 'bad' : 'ok'],
    ['Freeze authority', tk.freezeAuth ? 'ENABLED' : 'revoked', tk.freezeAuth ? 'bad' : 'ok'],
    ['Dev history', `${tk.devHistory.launches} launches · ${tk.devHistory.rugged} rugs`, tk.devHistory.rugged ? 'warn' : 'ok'],
    ['RugCheck score', `${tk.rug.score}/100`, tk.rug.score < 30 ? 'ok' : tk.rug.score < 60 ? 'warn' : 'bad'],
  ];
  for (const [label, val, lvl] of rows) {
    if (sy >= sb.y + sb.h) break;
    const color = lvl === 'ok' ? t.up : lvl === 'warn' ? t.warn : t.down;
    c.text(sb.x + 1, sy, lvl === 'ok' ? '●' : lvl === 'warn' ? '◐' : '○', { fg: color, bg: sb.bg });
    c.text(sb.x + 3, sy, label, { fg: t.muted, bg: sb.bg }, Math.max(0, sb.w - 4 - val.length - 1));
    c.textR(sb.x + 1, sy, sb.w - 2, val, { fg: lvl === 'ok' ? t.text : color, bg: sb.bg, b: lvl === 'bad' });
    sy += 1;
  }
  if (sy + 1 < sb.y + sb.h) c.rainZone(sb.x + 1, sy + 1, sb.w - 2, sb.y + sb.h - sy - 1, 2);

  if (bp !== 'compact') {
    const hx = statsW;
    const hw = mainW - statsW;
    const hb = c.box(hx, y, hw, lower, { title: 'HOLDERS', caption: 'holders · trades · traders  (h/t/r)' });
    let hy = hb.y;
    c.text(hb.x + 1, hy, 'WALLET', { fg: t.dim, bg: hb.bg });
    c.textR(hb.x + 1, hy, hb.w - 2, '%     SOL', { fg: t.dim, bg: hb.bg });
    hy += 1;
    const maxPct = Math.max(...tk.holdersTop.map((h) => h.pct));
    const barW = Math.max(6, hb.w - 36);
    for (const h of tk.holdersTop) {
      if (hy >= hb.y + hb.h) break;
      const cx = c.text(hb.x + 1, hy, shortAddr(h.addr, 4), { fg: t.text, bg: hb.bg });
      if (h.kind) badge(c, cx + 1, hy, h.kind.toUpperCase(), h.kind === 'dev' ? t.warn : h.kind === 'sniper' ? t.down : h.kind === 'LP' ? t.accent : t.muted, { on: hb.bg });
      const bx = hb.x + 22;
      bar(c, bx, hy, barW, (h.pct / maxPct) * 100, { bg: hb.bg, color: h.kind === 'LP' ? t.accent : t.mono ? t.muted : h.pct > 5 ? t.warn : t.up });
      c.textR(hb.x + 1, hy, hb.w - 2, `${h.pct.toFixed(2).padStart(5)}  ${fmtNum(h.sol).padStart(6)}`, { fg: h.pct > 5 ? t.warn : t.muted, bg: hb.bg });
      hy += 1;
    }
    // trade tape: text rows on the left, falling rain lines on the right
    if (hy + 3 < hb.y + hb.h) {
      hy += 1;
      c.hline(hb.x, hy - 1, hb.w, { fg: t.border, bg: hb.bg, soft: true });
      c.text(hb.x + 1, hy, 'TAPE', { fg: t.dim, bg: hb.bg });
      c.heading(hb.x + 1, hy, 4);
      c.textR(hb.x + 1, hy, hb.w - 2, 'live · ws', { fg: t.dim, bg: hb.bg });
      hy += 1;
      const tapeTop = hy;
      const textW = 46;
      const rainX = hb.x + textW + 2;
      const rainW = hb.x + hb.w - 1 - rainX;
      for (const tr of tk.trades) {
        if (hy >= hb.y + hb.h) break;
        const color = tr.side === 'buy' ? t.up : t.down;
        let cx = c.text(hb.x + 1, hy, fmtAgeSec(tr.ago).padStart(4), { fg: t.dim, bg: hb.bg });
        cx = c.text(cx + 1, hy, tr.side === 'buy' ? '▲BUY ' : '▼SELL', { fg: color, bg: hb.bg, b: true });
        cx = c.textR(cx + 1, hy, 8, fmtUsd(tr.usd), { fg: t.text, bg: hb.bg });
        cx = c.text(cx + 2, hy, fmtPrice(tr.price), { fg: t.muted, bg: hb.bg });
        cx = c.text(cx + 2, hy, shortAddr(tr.addr, 3), { fg: t.dim, bg: hb.bg });
        if (tr.tag) badge(c, cx + 1, hy, tr.tag, tr.tag === 'smart' ? t.accent : t.warn, { on: hb.bg });
        hy += 1;
      }
      const tapeH = hb.y + hb.h - tapeTop;
      if (rainW >= 6 && tapeH >= 3) tapeRain(c, rainX, tapeTop, rainW, tapeH, tk.trades, v.frame, { bg: hb.bg });
    }
  }

  }
  if (showAi) analystPanel(c, mainW, top, aiW, bottom - top, tk, state);
  footer(c, state.tokenSocial
    ? [['esc', 'back'], ['s', 'on-chain'], ['f', 'filter'], ['x', state.socialShowSpam ? 'hide spam' : 'show hidden'], ['K', 'KOL lists'], ['a', showAi ? 'hide analyst' : 'analyst'], ['w', 'watch'], ['q', 'quit']]
    : [['esc', 'back'], ['g', 'go to'], ['a', showAi ? 'hide analyst' : 'analyst'], ['h/t/r', 'holders/trades/traders'], ['w', 'watch'], ['b', 'alert'], ['1-6', 'timeframe'], ['q', 'quit']], state.theme.name, isCalm(v));
}

// ---------------- AI analyst panel (coral for the verdict and tool-call lines; answers decrypt in) ----------------
export function analystPanel(c: Canvas, x: number, y: number, w: number, h: number, tk: FixtureToken, state: AppState): void {
  if (state.analyst) {
    renderAnalystSession(c, x, y, w, h, state.analyst, {
      frame: state.vfx.frame, code: state.vfx.code, calm: isCalm(state.vfx),
      chips: [`$${tk.symbol}`, 'holders:20', 'trades:1h', 'rugcheck', 'candles'],
      input: state.aiInput ?? '', inputFocused: state.aiFocused === true,
      scroll: state.aiScroll, revealAll: state.aiRevealAll,
      inputHint: `press i to ask about $${tk.symbol}…  read-only · never trades`,
    });
    return;
  }
  const t = c.theme;
  const bc = mix(t.border, t.ai, 0.55);
  const box = c.box(x, y, w, h, { title: '✦ ANALYST · claude', titleFg: t.ai, caption: 'claude -p · 4 tools · local', captionFg: t.dim, border: bc });
  const bg = box.bg;
  const inner = box.w - 2;
  let cy = box.y;
  // context chips
  let cx = box.x + 1;
  for (const chip of [`$${tk.symbol}`, 'holders:20', 'trades:1h', 'rugcheck', 'screener']) {
    if (cx + chip.length + 3 > box.x + box.w - 1) break;
    cx = badge(c, cx, cy, chip, t.ai, { on: bg }) + 1;
  }
  cy += 2;
  const lines = state.transcript || aiTranscript(tk);
  const inputY = box.y + box.h - 2;
  const ai = state.ai ?? { phase: 'done' as const, cut: lines.length, revealed: 0 };
  const frame = state.vfx.frame;
  const code = state.vfx.code;
  const cut = ai.phase === 'done' ? lines.length : ai.cut;
  let revealedLeft = ai.revealed;
  // text writer that is plain for settled lines and decrypting for the streaming line
  const write = (lx: number, ly: number, str: string, st: Style, maxW: number, streaming: boolean): boolean => {
    if (!streaming) { c.text(lx, ly, str, st, maxW); return true; }
    const n = Math.min(revealedLeft, str.length);
    decryptText(c, lx, ly, str, n, frame, st, maxW, code);
    revealedLeft -= str.length + 1;
    return revealedLeft > -6; // keep drawing the scramble window
  };
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    if (cy >= inputY - 1) break;
    if (li > cut && revealedLeft <= 0) break;       // streaming budget spent: later messages are not here yet
    const streaming = li >= cut;
    if (streaming && ai.phase === 'thinking') {
      // Claude-Code-style spinner line
      c.text(box.x + 2, cy, spinnerGlyph(frame), { fg: t.ai, bg, b: true });
      const status = ['Thinking', 'Reading holders', 'Checking rugcheck', 'Decrypting'][Math.floor(frame / 24) % 4];
      c.text(box.x + 4, cy, `${status}…`, { fg: t.ai, bg, b: true });
      c.text(box.x + 5 + status.length, cy, `(esc to interrupt · ${(frame / 30).toFixed(1)}s · ↓ ${Math.floor(frame * 11)} tokens)`, { fg: t.dim, bg }, inner - status.length - 6);
      cy += 1;
      break;
    }
    if (ln.role === 'user') {
      c.text(box.x + 1, cy, '›', { fg: t.accent, bg, b: true });
      for (const w2 of wrap(ln.text, inner - 3)) { if (cy >= inputY - 1) break; c.text(box.x + 3, cy, w2, { fg: t.text, bg, b: true }); cy += 1; }
      cy += 1;
    } else if (ln.role === 'tool') {
      c.text(box.x + 3, cy, '↳ ' + ln.text, { fg: t.ai, bg, i: true }, inner - 3);
      cy += 1;
    } else if ('verdict' in ln && ln.verdict) {
      const vc = ln.verdict === 'watch' ? t.up : ln.verdict === 'avoid' ? t.down : t.warn;
      c.fill(box.x + 1, cy, inner, 1, ' ', { bg: mix(bg, vc, 0.18) });
      c.text(box.x + 2, cy, `● ${ln.verdict.toUpperCase()}`, { fg: vc, bg: mix(bg, vc, 0.18), b: true });
      c.textR(box.x + 1, cy, inner - 1, `conf ${ln.verdict === 'watch' ? '0.62' : ln.verdict === 'avoid' ? '0.81' : '0.44'} `, { fg: t.muted, bg: mix(bg, vc, 0.18) });
      cy += 1;
      for (const w2 of wrap(ln.text, inner - 2)) { if (cy >= inputY - 1) break; if (!write(box.x + 2, cy, w2, { fg: t.ai, bg }, inner - 2, streaming)) break; cy += 1; }
      cy += 1;
    } else if ('bullets' in ln) {
      let stop = false;
      for (const b of ln.bullets) {
        if (stop) break;
        const ws = wrap(b, inner - 4);
        for (let i = 0; i < ws.length; i++) {
          if (cy >= inputY - 1) { stop = true; break; }
          c.text(box.x + 2, cy, i === 0 ? '•' : ' ', { fg: t.ai, bg });
          if (!write(box.x + 4, cy, ws[i], { fg: t.text, bg }, inner - 4, streaming)) { stop = true; cy += 1; break; }
          cy += 1;
        }
      }
      cy += 1;
    } else {
      for (const w2 of wrap(ln.text, inner - 2)) { if (cy >= inputY - 1) break; if (!write(box.x + 2, cy, w2, { fg: t.text, bg }, inner - 2, streaming)) { cy += 1; break; } cy += 1; }
      cy += 1;
    }
  }
  if (inputY - 2 > cy) c.rainZone(box.x + 1, cy, inner, inputY - 2 - cy, 2);
  // guard rail line
  c.hline(box.x, inputY - 1, box.w, { fg: bc, bg, soft: true });
  c.put(box.x, inputY - 1, '├', { fg: bc, bg, soft: true });
  c.put(box.x + box.w - 1, inputY - 1, '┤', { fg: bc, bg, soft: true });
  c.text(box.x + 1, inputY, '▌', { fg: t.ai, bg, b: true, soft: true });
  c.text(box.x + 2, inputY, state.aiInput || `ask about $${tk.symbol}…  read-only · never trades`, { fg: state.aiInput ? t.text : t.dim, bg, i: !state.aiInput }, inner - 2);
}
