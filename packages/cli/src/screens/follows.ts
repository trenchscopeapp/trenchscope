// trenchscope — FOLLOWED WALLETS screen (key U, task-1360 copy trading Tier 1). The user's own follow list with each
// wallet's decoded activity (trades, FIFO realised PnL in SOL with a USD view at today's rate, win rate with its n,
// early-entry score when a launch window was scanned, open positions) and the live ALERTS tape (a followed
// wallet's buys and sells as the tracker saw them, with the lag). Every figure prints its sample. Labels are the
// user's own words, never inferred. Nothing on this screen trades, signs or proposes: Tier 2 adds the one-key
// mirror PROPOSAL and Tier 3 the capped auto-mirror, both behind the plan engine's own keypress gates.
import { Canvas, header, footer, breakpoint, fmtAgeSec, type Hex } from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { shortAddr, autoSizeCap, fmtHoldMs, type CopyAlert, type FollowRecord, type WalletStats, type WalletTrade } from '@dexterm/data/copy';

function fmtSol(n: number): string { const s = n >= 0 ? '+' : '−'; return `${s}${Math.abs(n).toFixed(Math.abs(n) >= 10 ? 1 : 3)} SOL`; }
function fmtUsdSigned(n: number): string { const s = n >= 0 ? '+' : '−'; const a = Math.abs(n); return `${s}$${a >= 1000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(a >= 100 ? 0 : 2)}`; }
function fmtUsdAbs(n: number | null): string { if (n === null) return '—'; return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(n >= 100 ? 0 : 2)}`; }

export const FOLLOW_INPUT_MAX = 80;

export function renderFollows(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const ui = state.copyUi ?? null;
  const svc = state.copy ?? null;
  const follows: FollowRecord[] = svc ? svc.follows() : [];
  const status = svc ? svc.status() : null;
  const now = state.now.getTime();
  const top = 2, bottom = c.h - 1;
  const stLabel = !status ? 'no binding' : status.state === 'ok' ? `polling · ${status.polls} polls` : status.state === 'idle' ? 'idle' : status.state.toUpperCase();
  const title = `FOLLOWED WALLETS · ${follows.length} · ${stLabel} · ${status?.alerts ?? 0} alerts`;
  const caption = bp === 'compact' ? undefined : 'your own list, your own wallet · labels are yours, never inferred · PnL = FIFO over fetched history · not a recommendation';
  const alertsH = Math.max(5, Math.min(12, Math.floor((bottom - top) / 3)));
  const typing = ui?.input !== null && ui?.input !== undefined;
  const listH = bottom - top - alertsH;
  const box = c.box(0, top, c.w, listH, { title, caption, focus: !typing });
  const bg: Hex = box.bg;
  let cy = box.y;

  if (status && status.state !== 'ok' && status.state !== 'idle' && status.why) {
    c.text(box.x + 1, cy, `⚠ ${status.why}`, { fg: status.state === 'unavailable' ? t.warn : t.down, bg }, box.w - 2); cy += 1;
  }
  if (!follows.length) {
    c.text(box.x + 1, cy + 1, 'no wallets followed yet.', { fg: t.muted, bg }); cy += 3;
    c.text(box.x + 1, cy, 'i                                     type a wallet address (and an optional label) to follow it', { fg: t.dim, bg }); cy += 1;
    c.text(box.x + 1, cy, 'trenchscope follow add <addr> --name x    the same from a shell · follow list | stats <addr> | purge', { fg: t.dim, bg }); cy += 1;
    c.text(box.x + 1, cy, 'alerts on its buys/sells appear as toasts anywhere · the tracker polls Helius history (free key)', { fg: t.dim, bg }); cy += 2;
    c.text(box.x + 1, cy, 'self-directed only: you pick the wallet, your caps, your keys · no pooled copy, no leader lists, no fees', { fg: t.dim, bg, i: true });
  } else {
    const wide = bp !== 'compact';
    const cols = wide ? ['WALLET', 'LABEL', 'AUTO', 'TRADES', 'REALISED', 'WIN RATE', 'EES', 'OPEN', 'LAST', 'SAMPLE'] : ['WALLET', 'LABEL', 'AUTO', 'TRADES', 'REALISED', 'WIN', 'LAST'];
    const xs = wide ? [1, 13, 26, 34, 43, 62, 76, 83, 89, 97] : [1, 13, 24, 30, 38, 52, 60];
    const autoOf = (addr: string) => svc?.auto?.policy(addr) ?? null;
    cols.forEach((h, i) => c.text(box.x + xs[i], cy, h, { fg: t.dim, bg }));
    cy += 1;
    const sel = Math.max(0, Math.min(follows.length - 1, ui?.selected ?? 0));
    const scroll = Math.max(0, sel - (box.h - 4));
    for (let i = scroll; i < follows.length; i++) {
      if (cy >= box.y + box.h - 1) break;
      const f = follows[i];
      const s: WalletStats | null = svc ? svc.stats(f.addr) : null;
      const selected = i === sel;
      const rb = selected ? t.selBg : bg;
      c.fill(box.x, cy, box.w, 1, ' ', { bg: rb });
      if (selected) c.put(box.x, cy, '▎', { fg: t.accent, bg: rb, soft: true });
      c.text(box.x + xs[0], cy, shortAddr(f.addr), { fg: selected ? t.borderFocus : t.text, bg: rb });
      c.text(box.x + xs[1], cy, f.name ?? '—', { fg: f.name ? t.accent : t.dim, bg: rb }, xs[2] - xs[1] - 1);
      const ap = autoOf(f.addr);
      c.text(box.x + xs[2], cy, ap?.enabled ? 'ON' : 'off', { fg: ap?.enabled ? t.warn : t.dim, bg: rb, b: !!ap?.enabled });
      const err = svc?.tracker.walletError(f.addr) ?? null;
      if (!s || (s.trades === 0 && !err)) { c.text(box.x + xs[3], cy, status?.state === 'unavailable' ? 'needs a free Helius key' : status?.polls ? 'no swaps in fetched history' : 'loading…', { fg: t.dim, bg: rb, i: true }); cy += 1; continue; }
      if (err) { c.text(box.x + xs[3], cy, `poll failed: ${err}`, { fg: t.down, bg: rb }, box.w - xs[3] - 2); cy += 1; continue; }
      c.text(box.x + xs[3], cy, `${s.buys}b/${s.sells}s`, { fg: t.text, bg: rb });
      const pnlFg = s.realisedSol > 0 ? t.up : s.realisedSol < 0 ? t.down : t.muted;
      c.text(box.x + xs[4], cy, `${fmtSol(s.realisedSol)}${s.realisedUsd !== null ? ` ${fmtUsdSigned(s.realisedUsd)}` : ''}`, { fg: pnlFg, bg: rb }, xs[5] - xs[4] - 1);
      const wr = s.winRate === null ? `n<10 (${s.wins}/${s.closed})` : `${Math.round(s.winRate * 100)}% (${s.wins}/${s.closed})`;
      c.text(box.x + xs[5], cy, wr, { fg: s.winRate === null ? t.dim : t.text, bg: rb }, (xs[6] ?? box.w) - xs[5] - 1);
      if (wide) {
        c.text(box.x + xs[6], cy, s.earlyEntry.score === null ? '—' : s.earlyEntry.score.toFixed(2), { fg: s.earlyEntry.score === null ? t.dim : t.text, bg: rb });
        c.text(box.x + xs[7], cy, String(s.open), { fg: t.text, bg: rb });
        c.text(box.x + xs[8], cy, s.lastT ? fmtAgeSec(Math.max(0, Math.round((now - s.lastT) / 1000))) : '—', { fg: t.muted, bg: rb });
        c.text(box.x + xs[9], cy, s.sample.note, { fg: t.dim, bg: rb }, box.w - xs[9] - 1);
      } else {
        c.text(box.x + xs[6], cy, s.lastT ? fmtAgeSec(Math.max(0, Math.round((now - s.lastT) / 1000))) : '—', { fg: t.muted, bg: rb });
      }
      cy += 1;
    }
  }
  if (ui?.notice && !typing) c.textR(box.x + 1, box.y + box.h - 1, box.w - 2, ui.notice, { fg: t.warn, bg, i: true });

  // ALERTS tape
  const abox = c.box(0, top + listH, c.w, alertsH, { title: `ALERTS · a followed wallet bought or sold · ${status ? `${status.alerts} seen` : ''}`, caption: bp === 'compact' ? undefined : 'information only · lag = seen − block time · USD at the SOL price when seen', focus: false });
  const abg: Hex = abox.bg;
  const alerts: CopyAlert[] = svc ? svc.alerts(alertsH - 1) : [];
  if (!alerts.length) c.text(abox.x + 1, abox.y, status?.state === 'ok' ? 'nothing new since the first look (history is not news)' : 'no alerts yet', { fg: t.dim, bg: abg, i: true });
  let ay = abox.y;
  for (const a of alerts) {
    if (ay >= abox.y + abox.h - (typing ? 1 : 0)) break;
    const tr = a.trade;
    const sideFg = tr.side === 'buy' ? t.up : t.down;
    let cx = c.text(abox.x + 1, ay, fmtAgeSec(Math.max(0, Math.round((now - a.t) / 1000))).padEnd(5), { fg: t.dim, bg: abg });
    cx = c.text(cx + 1, ay, (a.name ?? shortAddr(a.wallet)).padEnd(12).slice(0, 12), { fg: t.accent, bg: abg });
    cx = c.text(cx + 1, ay, tr.side.toUpperCase().padEnd(4), { fg: sideFg, bg: abg, b: true });
    cx = c.text(cx + 1, ay, shortAddr(tr.mint), { fg: t.text, bg: abg });
    cx = c.text(cx + 1, ay, fmtUsdAbs(tr.usd).padStart(7), { fg: t.text, bg: abg });
    cx = c.text(cx + 1, ay, tr.solDelta !== null ? `${Math.abs(tr.solDelta).toFixed(3)} SOL` : 'unpriced', { fg: t.muted, bg: abg });
    c.text(cx + 1, ay, a.lagMs === null ? 'lag ?' : `lag ${(a.lagMs / 1000).toFixed(0)}s`, { fg: a.lagMs !== null && a.lagMs > 30_000 ? t.warn : t.dim, bg: abg });
    ay += 1;
  }
  if (typing) {
    const iy = abox.y + abox.h - 1;
    c.hline(abox.x, iy - 1, abox.w, { fg: t.border, bg: abg });
    const label = 'follow: ';
    c.text(abox.x + 1, iy, label, { fg: t.accent, bg: abg, b: true });
    c.text(abox.x + 1 + label.length, iy, `${ui!.input}█`, { fg: t.text, bg: abg }, abox.w - label.length - 3);
    c.textR(abox.x + 1, iy, abox.w - 2, '<address> [label] ⏎ · esc cancel', { fg: t.dim, bg: abg });
  }
  // Tier 2: the MIRROR TICKET preview (proposal only — nothing here arms; the O screen's keypress gate does).
  if (ui?.mirror) {
    const mr = ui.mirror;
    const mw = Math.min(c.w - 4, 96), mh = 15;
    const mx = Math.floor((c.w - mw) / 2), my = top + Math.max(1, Math.floor((bottom - top - mh) / 2));
    c.noRain(mx, my, mw, mh);
    const mbox = c.box(mx, my, mw, mh, { title: 'MIRROR TICKET — proposal only', caption: 'sized by YOUR cap · armed only on the O screen by keypress / Phantom · not a recommendation', focus: true, bg: t.panelAlt });
    const mbg: Hex = mbox.bg;
    const tr = mr.alert.trade;
    let y = mbox.y;
    c.text(mbox.x + 1, y, `${mr.alert.name ?? shortAddr(mr.alert.wallet)} BOUGHT ${mr.market?.symbol ?? shortAddr(tr.mint)} (${shortAddr(tr.mint)}) for ${fmtUsdAbs(tr.usd)}${tr.solDelta !== null ? ` · ${Math.abs(tr.solDelta).toFixed(3)} SOL` : ''}`, { fg: t.text, bg: mbg, b: true }, mbox.w - 2); y += 2;
    if (mr.pending || !mr.result) { c.text(mbox.x + 1, y, 'resolving price, liquidity, decimals and age…', { fg: t.muted, bg: mbg, i: true }); }
    else {
      for (const ck of mr.result.checks) {
        const mark = ck.ok === true ? '✓' : ck.ok === false ? '✗' : '?';
        const fg = ck.ok === true ? t.up : ck.ok === false ? t.down : t.warn;
        let cx = c.text(mbox.x + 1, y, mark, { fg, bg: mbg, b: true });
        cx = c.text(cx + 1, y, ck.name.padEnd(12), { fg: t.text, bg: mbg });
        c.text(cx + 1, y, ck.detail, { fg: ck.ok === null ? t.warn : t.muted, bg: mbg }, mbox.w - (cx + 1 - mbox.x) - 1);
        y += 1;
      }
      y += 1;
      if (mr.result.ok) {
        c.text(mbox.x + 1, y, `size ${fmtUsdAbs(mr.result.sizeUsd)} = ${mr.result.sizeWhy}`, { fg: t.accent, bg: mbg, b: true }, mbox.w - 2); y += 1;
        c.text(mbox.x + 1, y, 'buy now · no ladder · 3% slippage · expires in 10 min · the mandate\'s per-trade cap applies at arming', { fg: t.muted, bg: mbg }, mbox.w - 2); y += 1;
        c.text(mbox.x + 1, y, 'm again = PROPOSE (inert order plan on the O screen) · esc = close', { fg: t.accent, bg: mbg }, mbox.w - 2);
      } else {
        c.text(mbox.x + 1, y, `REFUSED: ${mr.result.message}`, { fg: t.down, bg: mbg, b: true }, mbox.w - 2); y += 1;
        c.text(mbox.x + 1, y, 'm or esc = close · nothing was proposed', { fg: t.muted, bg: mbg }, mbox.w - 2);
      }
    }
  }
  // Tier 3: the AUTO-MIRROR modal (enable = captured physical keypress in the loop; this only paints it).
  if (ui?.autoModal) {
    const w = ui.autoModal.wallet;
    const pol = svc?.auto?.policy(w) ?? null;
    const st = svc?.auto?.status(w) ?? null;
    const mw = Math.min(c.w - 4, 92), mh = 14;
    const mx = Math.floor((c.w - mw) / 2), my = top + Math.max(1, Math.floor((bottom - top - mh) / 2));
    c.noRain(mx, my, mw, mh);
    const mbox = c.box(mx, my, mw, mh, { title: '⚠ AUTO-MIRROR — capped, default OFF, less safe', caption: 'your wallet, your caps, your keys · paper/devnet only · not a recommendation', focus: true, bg: t.panelAlt });
    const mbg: Hex = mbox.bg;
    let y = mbox.y;
    const name = follows.find((f) => f.addr === w)?.name ?? null;
    c.text(mbox.x + 1, y, `Mirror every BUY by ${name ?? shortAddr(w)} (${shortAddr(w)}) automatically?`, { fg: t.text, bg: mbg, b: true }, mbox.w - 2); y += 2;
    if (pol) {
      c.text(mbox.x + 1, y, `per mirror ≤ $${autoSizeCap(pol).toFixed(2)} (¼ of the $${Math.min(pol.perTradeUsd, pol.dailyUsd)} per-trade cap: auto fires at the hands-free tier) · $${pol.dailyUsd}/day · max ${pol.maxOpen} open · ${Math.round(pol.cooldownMs / 1000)} s cooldown`, { fg: t.muted, bg: mbg }, mbox.w - 2); y += 1;
      c.text(mbox.x + 1, y, `size factor ${pol.k}× the leader · auto-disarm after ${pol.autoDisarmStreak} refused/failed mirrors · caps expire in ${Math.round(pol.ttlMs / 3600_000)} h · change caps: trenchscope follow auto <addr> …`, { fg: t.muted, bg: mbg }, mbox.w - 2); y += 2;
    }
    c.text(mbox.x + 1, y, 'every mirror still passes the lag / drift / liquidity / age / leader checks, and the plan engine re-checks every cap signer-side', { fg: t.muted, bg: mbg }, mbox.w - 2); y += 1;
    c.text(mbox.x + 1, y, 'mirror-SELL is not built: you close every mirror yourself · auto is OFF again after every restart', { fg: t.warn, bg: mbg }, mbox.w - 2); y += 2;
    const gateOk = st?.gateActive ?? false;
    c.text(mbox.x + 1, y, gateOk ? '✓ the "less safe" hands-free popup is accepted (O screen, G)' : '✗ needs the "less safe" hands-free popup first: O screen, then G (keypress only, expires in 24 h)', { fg: gateOk ? t.up : t.down, bg: mbg }, mbox.w - 2); y += 2;
    c.text(mbox.x + 1, y, gateOk ? 'Hold and release [enter] or [y] to turn auto ON (physical keypress) · [esc] leaves it OFF · a pipe/agent cannot' : '[esc] closes · accept the popup, then A again', { fg: t.accent, bg: mbg }, mbox.w - 2);
  }
  // task-1399: the per-wallet DETAIL view (its own trades + positions + metrics, each with source + data age).
  if (ui?.detail) renderWalletDetail(c, state, now);
  const autoHint = (() => { const f = follows[Math.max(0, Math.min(follows.length - 1, ui?.selected ?? 0))]; const p = f ? svc?.auto?.policy(f.addr) : null; return p?.enabled ? 'auto OFF' : 'auto-mirror'; })();
  const foot: Array<[string, string]> = ui?.detail
    ? [['↑↓', 'scroll'], ['enter/esc', 'close'], ['q', 'quit']]
    : [['↑↓', 'move'], ['enter', 'wallet view'], ['i', 'follow a wallet'], ['d', 'unfollow'], ['m', ui?.mirror ? (ui.mirror.result?.ok ? 'PROPOSE mirror' : 'close') : 'mirror ticket'], ['A', autoHint], ['r', 'poll now'], ['esc', 'back'], ['q', 'quit']];
  footer(c, foot, t.name);
}

/**
 * task-1399 — one followed wallet's DETAIL view: its own recent decoded trades and positions, plus the full metric
 * set (realised PnL, win rate with n, median hold time, early-entry score, open), each labelled with its source
 * (Helius history) and data age (time since the last poll). Read-only: nothing here trades, arms, proposes or signs.
 */
function renderWalletDetail(c: Canvas, state: AppState, now: number): void {
  const t = c.theme;
  const ui = state.copyUi;
  const svc = state.copy;
  if (!ui?.detail || !svc) return;
  const addr = ui.detail.wallet;
  const f: FollowRecord | undefined = svc.follows().find((x) => x.addr === addr);
  const s: WalletStats = svc.stats(addr);
  const trades: WalletTrade[] = svc.trades(addr); // newest first
  const top = 2, bottom = c.h - 1;
  const mw = Math.min(c.w - 2, 104);
  const mh = Math.max(10, bottom - top - 1);
  const mx = Math.floor((c.w - mw) / 2), my = top + 1;
  c.noRain(mx, my, mw, mh);
  const label = f?.name ? ` · ${f.name}` : '';
  const box = c.box(mx, my, mw, mh, { title: `WALLET${label} — read-only`, caption: 'its own trades + positions · every number: source + data age · not a recommendation', focus: true, bg: t.panelAlt });
  const bg: Hex = box.bg;
  let y = box.y;
  c.text(box.x + 1, y, addr, { fg: t.text, bg }, box.w - 2); y += 1;
  const age = s.sample.asOf ? `${Math.max(0, Math.round((now - s.sample.asOf) / 1000))}s ago` : 'not fetched yet';
  c.text(box.x + 1, y, `source ${s.sample.source} · ${age} · ${s.sample.note}`, { fg: t.dim, bg }, box.w - 2); y += 1;
  const pnl = `${fmtSol(s.realisedSol)}${s.realisedUsd !== null ? ` ${fmtUsdSigned(s.realisedUsd)}` : ''}`;
  const wr = s.winRate === null ? `win rate n<10 (${s.wins}/${s.closed})` : `win rate ${Math.round(s.winRate * 100)}% (${s.wins}/${s.closed})`;
  c.text(box.x + 1, y, `realised ${pnl} · ${wr} · hold ${fmtHoldMs(s.holdMedianMs)} · EES ${s.earlyEntry.score === null ? '—' : s.earlyEntry.score.toFixed(2)} · open ${s.open} · ${s.buys}b/${s.sells}s`, { fg: t.text, bg }, box.w - 2); y += 1;
  c.text(box.x + 1, y, `hold: ${s.holdNote} · EES: ${s.earlyEntry.note}`, { fg: t.dim, bg }, box.w - 2); y += 2;

  const footerY = box.y + box.h - 1;
  const posCount = Math.min(s.positions.length, 6);
  const posHeaderY = posCount ? footerY - posCount - 1 : footerY;
  // RECENT TRADES (scrollable) fill the space above the positions block.
  c.text(box.x + 1, y, 'RECENT TRADES', { fg: t.dim, bg }); y += 1;
  if (!trades.length) {
    c.text(box.x + 1, y, svc.status().state === 'unavailable' ? 'needs a free Helius key' : 'no swaps in fetched history', { fg: t.dim, bg, i: true }); y += 1;
  } else {
    const roomRows = Math.max(1, posHeaderY - 1 - y);
    const scroll = Math.max(0, Math.min(Math.max(0, trades.length - roomRows), ui.detail.scroll));
    for (let i = scroll; i < trades.length && y < posHeaderY - 1; i++) {
      const tr = trades[i];
      const sideFg = tr.side === 'buy' ? t.up : tr.side === 'sell' ? t.down : t.muted;
      let cx = c.text(box.x + 1, y, (tr.tKnown ? new Date(tr.t).toISOString().replace('T', ' ').slice(5, 19) : 'time unknown ').padEnd(15), { fg: t.dim, bg });
      cx = c.text(cx + 1, y, tr.side.toUpperCase().padEnd(9), { fg: sideFg, bg, b: true });
      cx = c.text(cx + 1, y, shortAddr(tr.mint).padEnd(11), { fg: t.text, bg });
      cx = c.text(cx + 1, y, (tr.solDelta !== null ? `${Math.abs(tr.solDelta).toFixed(3)} SOL` : 'unpriced').padStart(11), { fg: t.muted, bg });
      cx = c.text(cx + 1, y, fmtUsdAbs(tr.usd).padStart(8), { fg: t.text, bg });
      if (tr.note) c.text(cx + 1, y, `(${tr.note})`, { fg: t.dim, bg }, box.w - (cx + 1 - box.x) - 1);
      y += 1;
    }
    const older = trades.length - scroll - roomRows;
    if (older > 0) c.textR(box.x + 1, posHeaderY - 1, box.w - 2, `… ${older} older (↑↓)`, { fg: t.dim, bg, i: true });
  }
  // POSITIONS block (fixed, bottom).
  if (posCount) {
    c.text(box.x + 1, posHeaderY, `POSITIONS · ${s.positions.length}`, { fg: t.dim, bg });
    let py = posHeaderY + 1;
    for (const p of s.positions.slice(0, posCount)) {
      if (py >= footerY) break;
      let cx = c.text(box.x + 1, py, shortAddr(p.mint).padEnd(11), { fg: t.text, bg });
      cx = c.text(cx + 1, py, (p.closed ? 'closed' : 'open').padEnd(7), { fg: p.closed ? t.muted : t.accent, bg });
      cx = c.text(cx + 1, py, fmtSol(p.realisedSol).padStart(11), { fg: p.realisedSol > 0 ? t.up : p.realisedSol < 0 ? t.down : t.muted, bg });
      cx = c.text(cx + 1, py, `${p.buys}b/${p.sells}s`.padEnd(8), { fg: t.dim, bg });
      cx = c.text(cx + 1, py, `hold ${fmtHoldMs(p.holdMs)}`.padEnd(12), { fg: t.dim, bg });
      if (p.flagged) c.text(cx + 1, py, '(cost-0 lot: airdrop/transfer/unpriced)', { fg: t.dim, bg }, box.w - (cx + 1 - box.x) - 1);
      py += 1;
    }
  }
  c.textR(box.x + 1, footerY, box.w - 2, 'not a recommendation · a wallet\'s past fills say nothing about its next one', { fg: t.dim, bg, i: true });
}
