// trenchscope — PAPER positions screen (task-1310 T0, SPEC §6.1 "book"). The simulated wallet: balance,
// equity, open positions with live PnL (marked from the keyless price feed) and the trade history.
// Labelled PAPER on every frame; nothing here signs, holds a key or sends anything.
import {
  Canvas, header, footer, breakpoint, mix, isCalm, fmtPriceBare, fmtMcap, fmtNum, fmtPct, fmtAgeSec, shortAddr,
} from '@dexterm/tui';
import { lamportsToSol, rawToTokens, positionPnl } from '@dexterm/data';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import type { PositionsView } from '../trade.ts';
import { priceModeOf, supplyRatio, FALLBACK_MARK } from '../display.ts';

export function sol(n: number, digits = 4): string {
  return `${n >= 0 ? '' : '-'}${Math.abs(n).toFixed(digits)}`;
}
export function signedSol(n: number, digits = 4): string {
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(digits)}`;
}

/**
 * USD for position-sized amounts (task-1323): cents below $1K (`$192.50`), compact above (`$12.3K`).
 * `fmtUsd` rounds small values to whole dollars, which hides a paper PnL of a few dollars.
 */
export function fmtUsdFine(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e4 ? 1 : 2)}K`;
  return `${sign}$${a.toFixed(2)}`;
}

/** Signed USD: `+$42.00` / `-$3.10` (zero reads `+$0.00`). */
export function signedUsd(n: number): string {
  return `${n >= 0 ? '+' : '-'}${fmtUsdFine(Math.abs(n))}`;
}

/** Signed percent of a fraction: 0.28 → `+28.0%`, -0.082 → `-8.2%`. */
export function signedPctOf(frac: number, digits = 1): string {
  const p = frac * 100;
  const a = Math.abs(p);
  return `${p >= 0 ? '+' : '-'}${a.toFixed(a >= 1000 ? 0 : digits)}%`;
}

export function renderPositions(c: Canvas, state: AppState): void {
  const t = c.theme;
  header(c, headerModel(state));
  const bp = breakpoint(c.w);
  const v: PositionsView | null = (state.live ? state.live.positions.view() : state.positions) ?? null;
  const top = 2;

  c.fill(0, top, c.w, 1, ' ', { bg: mix(t.bg, t.warn, 0.16) });
  c.text(2, top, ' ◈ PAPER PORTFOLIO — simulated wallet · no real funds, keys or signing ', { fg: t.warn, bg: mix(t.bg, t.warn, 0.16), b: true });
  const linked = state.live?.linkedWallet;
  if (linked) c.textR(2, top, c.w - 3, `linked: ${linked.publicKey.slice(0, 4)}…${linked.publicKey.slice(-4)} `, { fg: t.muted, bg: mix(t.bg, t.warn, 0.16) });
  c.noRain(0, top, c.w, 1);

  if (!v) {
    c.text(2, 4, 'No paper wallet in this mode. Run live to paper-trade (B/S on a token).', { fg: t.muted, bg: t.bg });
    footer(c, [['esc', 'back'], ['q', 'quit']], t.name, isCalm(state.vfx));
    return;
  }

  // summary strip
  let y = 4;
  const totalColor = v.totalPct === null ? t.muted : v.totalPct >= 0 ? t.up : t.down;
  let x = c.text(2, y, 'Equity', { fg: t.dim, bg: t.bg });
  x = c.text(x + 1, y, `${sol(v.equitySol)} SOL`, { fg: t.text, bg: t.bg, b: true });
  x = c.text(x + 3, y, 'Cash', { fg: t.dim, bg: t.bg });
  x = c.text(x + 1, y, `${sol(v.balanceSol)} SOL`, { fg: t.muted, bg: t.bg });
  x = c.text(x + 3, y, 'Start', { fg: t.dim, bg: t.bg });
  x = c.text(x + 1, y, `${sol(v.startSol)} SOL`, { fg: t.muted, bg: t.bg });
  x = c.text(x + 3, y, 'Total PnL', { fg: t.dim, bg: t.bg });
  x = c.text(x + 1, y, `${signedSol(v.equitySol - v.startSol)} SOL${v.totalPct !== null ? ` (${fmtPct(v.totalPct * 100)})` : ''}`, { fg: totalColor, bg: t.bg, b: true });
  if (v.solPriceUsd) c.textR(2, y, c.w - 3, `SOL $${v.solPriceUsd.toFixed(2)}${v.loading ? ' · marking…' : ''}`, { fg: t.dim, bg: t.bg });
  y += 1;
  c.text(2, y, `realized ${signedSol(v.totalRealizedSol)} · unrealized ${signedSol(v.totalUnrealizedSol)} SOL`, { fg: t.dim, bg: t.bg });
  y += 2;

  // positions table
  const bottom = c.h - 1;
  const half = Math.max(8, Math.floor((bottom - y) * 0.5));
  // task-1366: mcap mode reads AVG / PRICE as market cap = SOL price × SOL/USD × the token's CURRENT supply (from the
  // screener rows); a token without a supply (or no SOL/USD yet) keeps its SOL price, marked ᵖ. PnL stays SOL.
  const mode = priceModeOf(state);
  const supplyOf = (mint: string): number | null => { const row = state.screener.rows.find((x) => x.mint === mint); return row ? supplyRatio(row.price, row.mcap) : null; };
  const mcCell = (pSol: number | null, mint: string): string => {
    if (pSol === null) return '—';
    if (mode !== 'mcap') return fmtPriceBare(pSol);
    const s = supplyOf(mint);
    return s !== null && v.solPriceUsd ? fmtMcap(pSol * v.solPriceUsd * s) : fmtPriceBare(pSol) + FALLBACK_MARK;
  };
  const pb = c.box(0, y, c.w, half, { title: 'POSITIONS', caption: mode === 'mcap' ? 'marked from keyless price feed · mcap at current supply' : 'marked from keyless price feed' });
  let py = pb.y;
  const cols: readonly [string, number][] = bp === 'compact'
    ? [['TOKEN', 16], ['AMOUNT', 16], ['VALUE', 14], ['uPnL', 16]]
    : [['TOKEN', 20], ['AMOUNT', 18], [mode === 'mcap' ? 'AVG MC' : 'AVG', 14], [mode === 'mcap' ? 'MCAP' : 'PRICE', 14], ['VALUE', 14], ['uPnL SOL', 18], ['REALIZED', 14]];
  let hx = pb.x + 1;
  for (const [label, wdt] of cols) { c.text(hx, py, label, { fg: t.dim, bg: pb.bg }, wdt); hx += wdt; }
  py += 1;
  const open = v.rows.filter((r) => r.tokens > 0);
  if (open.length === 0) {
    c.text(pb.x + 1, py, 'no open positions — B paper-buy on a token', { fg: t.dim, bg: pb.bg });
  }
  for (const r of open) {
    if (py >= pb.y + pb.h - 1) break;
    const uColor = r.unrealizedSol === null ? t.muted : r.unrealizedSol >= 0 ? t.up : t.down;
    let cx = pb.x + 1;
    cx = c.text(cx, py, `$${r.symbol}`, { fg: t.text, bg: pb.bg, b: true }, cols[0][1]);
    cx = pb.x + 1 + cols[0][1];
    c.text(cx, py, fmtNum(r.tokens), { fg: t.muted, bg: pb.bg }, cols[1][1] - 1); cx += cols[1][1];
    if (!bp || bp !== 'compact') {
      c.text(cx, py, mcCell(r.avgEntrySol, r.mint), { fg: t.dim, bg: pb.bg }, cols[2][1] - 1); cx += cols[2][1];
      c.text(cx, py, mcCell(r.priceSol, r.mint), { fg: t.muted, bg: pb.bg }, cols[3][1] - 1); cx += cols[3][1];
      c.text(cx, py, r.valueSol !== null ? sol(r.valueSol) : '—', { fg: t.text, bg: pb.bg }, cols[4][1] - 1); cx += cols[4][1];
      c.text(cx, py, r.unrealizedSol !== null ? `${signedSol(r.unrealizedSol)}${r.unrealizedPct !== null ? ` ${fmtPct(r.unrealizedPct * 100)}` : ''}` : '—', { fg: uColor, bg: pb.bg, b: true }, cols[5][1] - 1); cx += cols[5][1];
      c.text(cx, py, signedSol(r.realizedSol), { fg: r.realizedSol >= 0 ? t.muted : t.down, bg: pb.bg }, cols[6][1] - 1);
    } else {
      c.text(cx, py, r.valueSol !== null ? sol(r.valueSol) : '—', { fg: t.text, bg: pb.bg }, cols[2][1] - 1); cx += cols[2][1];
      c.text(cx, py, r.unrealizedSol !== null ? signedSol(r.unrealizedSol) : '—', { fg: uColor, bg: pb.bg, b: true }, cols[3][1] - 1);
    }
    py += 1;
  }

  // task-1328: LIVE positions (the signer's ledger file, read-only), only when there are any.
  const liveSrc = state.live?.livePositions ?? null;
  const livePos = liveSrc ? liveSrc.positions().filter((p) => p.tokensRaw > 0n) : [];
  y += half;
  if (livePos.length > 0) {
    const lh = Math.min(livePos.length + 3, Math.max(5, Math.floor((bottom - y) * 0.4)));
    const lb = c.box(0, y, c.w, lh, { title: '◉ LIVE POSITIONS', titleFg: t.up, caption: 'confirmed on-chain fills · signer ledger' });
    let ly = lb.y;
    for (const p of livePos) {
      if (ly >= lb.y + lb.h) break;
      const mark = liveSrc?.held(p.mint)?.markSol ?? null;
      const pnl = positionPnl(p, mark);
      let cx = c.text(lb.x + 1, ly, `$${p.symbol}`, { fg: t.text, bg: lb.bg, b: true });
      cx = c.text(cx + 2, ly, fmtNum(rawToTokens(p.tokensRaw, p.decimals)), { fg: t.muted, bg: lb.bg });
      cx = c.text(cx + 2, ly, `cost ${sol(pnl.costSol)} SOL`, { fg: t.dim, bg: lb.bg });
      if (pnl.avgEntrySol !== null) cx = c.text(cx + 2, ly, `avg ${fmtPriceBare(pnl.avgEntrySol)}`, { fg: t.dim, bg: lb.bg });
      if (pnl.unrealizedSol !== null) c.text(cx + 2, ly, `uPnL ${signedSol(pnl.unrealizedSol)} SOL${pnl.unrealizedPct !== null ? ` ${fmtPct(pnl.unrealizedPct * 100)}` : ''}`, { fg: pnl.unrealizedSol >= 0 ? t.up : t.down, bg: lb.bg, b: true });
      c.textR(lb.x + 1, ly, lb.w - 2, `${shortAddr(p.mint, 4)} · LIVE`, { fg: t.up, bg: lb.bg });
      ly += 1;
    }
    y += lh;
  }

  // history
  const hb = c.box(0, y, c.w, bottom - y, { title: 'TRADE HISTORY', caption: `${v.history.length} paper fills${liveSrc ? ` · ${liveSrc.records(50).length} live` : ''}` });
  let yy = hb.y;
  for (const h of v.history) {
    if (yy >= hb.y + hb.h) break;
    const sideColor = h.side === 'buy' ? t.up : t.down;
    const gotTokens = h.side === 'buy' ? rawToTokens(h.tokenDelta, h.decimals) : rawToTokens(-h.tokenDelta, h.decimals);
    const solAmt = lamportsToSol(h.solDelta);
    let cx = c.text(hb.x + 1, yy, fmtAgeSec(Math.max(0, Math.round((state.now.getTime() - h.t) / 1000))).padStart(4), { fg: t.dim, bg: hb.bg });
    cx = c.text(cx + 1, yy, h.side === 'buy' ? '▲ BUY ' : '▼ SELL', { fg: sideColor, bg: hb.bg, b: true });
    cx = c.text(cx + 1, yy, `$${h.symbol}`, { fg: t.text, bg: hb.bg, b: true });
    cx = c.text(cx + 1, yy, `${fmtNum(gotTokens)} @ ${fmtPriceBare(h.priceSol)} SOL`, { fg: t.muted, bg: hb.bg });
    cx = c.text(cx + 2, yy, `${signedSol(solAmt)} SOL`, { fg: solAmt >= 0 ? t.up : t.muted, bg: hb.bg });
    if (h.side === 'sell') c.text(cx + 2, yy, `pnl ${signedSol(lamportsToSol(h.realizedLamports))}`, { fg: h.realizedLamports >= 0n ? t.up : t.down, bg: hb.bg });
    c.textR(hb.x + 1, yy, hb.w - 2, `${shortAddr(h.mint, 4)} · PAPER`, { fg: t.dim, bg: hb.bg });
    yy += 1;
  }
  if (v.history.length === 0) c.text(hb.x + 1, hb.y, 'no paper trades yet', { fg: t.dim, bg: hb.bg });

  footer(c, [['esc', 'back'], ['r', 'refresh'], ['H', 'PnL card'], ['1-4', 'screens'], ['q', 'quit']], t.name, isCalm(state.vfx));
}
