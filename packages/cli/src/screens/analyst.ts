// trenchscope — full-screen Analyst (chat with screener-aware Claude) + live context rail.
// Cyberspace styling (task-1297): Claude's verdict/answer lines and tool-call lines in coral, the
// streaming answer decrypts through code glyphs behind the Claude-Code spinner, rain zones under the
// transcript and the market pulse, ▲/▼ on every direction.
import {
  Canvas, sparkline, heatPct, decryptText, spinnerGlyph,
  fmtUsd, fmtPrice, fmtPctDir, fmtDeltaDir, wrap, header, footer, breakpoint, mix, isCalm,
} from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import type { FixtureToken } from '../fixtures.ts';
import { screenerView } from '../screener/view.ts';
import { renderAnalystSession } from './analyst-session.ts';
import { resolveAnalystResults } from '../analyst/results.ts';

type ConvoLine =
  | { role: 'user' | 'tool' | 'ai'; text: string }
  | { role: 'table'; rows: FixtureToken[] };

export function renderAnalyst(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const top = 2, bottom = c.h - 1;
  const railW = bp === 'compact' ? 0 : Math.min(48, Math.floor(c.w * 0.32));
  const chatW = c.w - railW;
  const bc = mix(t.border, t.ai, 0.55);
  // Live Claude session (task-1302): render it in the chat area, with the navigable coin list beside
  // it (task-1313) so the user can see and change the hovered coin while chatting.
  if (state.analyst) {
    const focused = state.aiFocused === true;
    // task-1313 part F: when the finished turn is a list-of-coins answer, resolve each mint against the
    // app's LIVE data layer (never the model's text) and render it as a real table inside the chat. The
    // table is "active" (↑↓ moves its cursor, ⏎ jumps, o opens a PAPER ticket) when the input is blurred.
    const results = state.analyst.hasResults ? resolveAnalystResults(state, state.analyst.results) : [];
    const resultsActive = results.length > 0 && !focused && state.aiResultsActive === true;
    renderAnalystSession(c, 0, top, chatW, bottom - top, state.analyst, {
      frame: state.vfx.frame, code: state.vfx.code, calm: isCalm(state.vfx),
      input: state.aiInput ?? '', inputFocused: focused,
      scroll: state.aiScroll, revealAll: state.aiRevealAll,
      results, resultsCursor: state.analyst.resultsCursor, resultsActive,
      inputHint: focused ? 'type your question…  ⏎ send · esc blur · analysis not advice'
        : results.length ? 'i ask · ↑↓ pick coin · ⏎ open · o ticket · esc back'
          : 'i ask · ⏎ focus · ↑↓ pick coin · PgUp/Dn scroll',
    });
    if (railW) renderCoinList(c, chatW, top, railW, bottom - top, state);
    footer(c, analystFooter(state, focused), state.theme.name, isCalm(state.vfx));
    return;
  }
  // task-1311 (QA M13): the canned SIGMA/GOAT/BOME conversation is seeded demo data. Never show it
  // next to live data — in live mode the empty tab says how to start a real conversation instead.
  if (state.screener.source !== 'fixtures') {
    const live = state.aiFocused === true;
    const eng = state.analystEngine ?? 'claude'; // 0.1.5: the user's own CLI that will answer (claude | codex)
    const b = c.box(0, top, chatW, bottom - top, { title: `✦ ANALYST · ${eng}`, titleFg: t.ai, caption: `read-only · local ${eng} CLI · on demand`, captionFg: t.dim, border: bc });
    const bbg = b.bg; const bin = b.w - 2; let by = b.y + 1;
    const say2 = (s: string): void => { for (const w2 of wrap(s, bin - 2)) { if (by >= b.y + b.h - 3) break; c.text(b.x + 2, by, w2, { fg: t.muted, bg: bbg }, bin - 2); by += 1; } };
    say2('No conversation yet.'); by += 1;
    say2(`Press  i  to ask ${eng} about the market, a token, or your watchlist. It can read the live screener, a token's holders / tape / RugCheck, and your watchlist — read-only, never trades.`);
    const iy = b.y + b.h - 2;
    c.hline(b.x, iy - 1, b.w, { fg: bc, bg: bbg, soft: true });
    c.put(b.x, iy - 1, '├', { fg: bc, bg: bbg, soft: true }); c.put(b.x + b.w - 1, iy - 1, '┤', { fg: bc, bg: bbg, soft: true });
    const typed = state.aiInput ?? '';
    c.text(b.x + 1, iy, '▌', { fg: t.ai, bg: bbg, b: true, soft: true });
    if (typed) c.text(b.x + 2, iy, typed + (live ? '█' : ''), { fg: t.text, bg: bbg }, bin - 2);
    else c.text(b.x + 2, iy, live ? '█ type your question…  ⏎ send · esc blur' : `press i to ask ${eng} · ⏎ to focus`, { fg: t.dim, bg: bbg, i: true }, bin - 2);
    if (railW) renderCoinList(c, chatW, top, railW, bottom - top, state);
    footer(c, analystFooter(state, live), state.theme.name, isCalm(state.vfx));
    return;
  }
  const cb = c.box(0, top, chatW, bottom - top, { title: '✦ ANALYST · claude', titleFg: t.ai, caption: 'session 14m · 11 tool calls · $0.00 (your CLI)', border: bc });
  const bg = cb.bg;
  const inner = cb.w - 2;
  const fx = state.fx;
  const picks = fx.tokens.filter((k) => k.org >= 55 && k.top10 < 30 && !k.mintAuth).slice(0, 5);
  const convo: ConvoLine[] = [
    { role: 'user', text: 'screen for tokens under $5M mcap with rising holders, organic score over 60, and no bundler footprint. rank them.' },
    { role: 'tool', text: 'screener_query(mcap<5M, org>60, bundled<10) 38ms · get_holders_delta(5 tokens, 6h) 212ms · get_dev_history(5) 540ms' },
    { role: 'table', rows: picks },
    { role: 'ai', text: `Ranked by holder velocity × organic volume. ${picks[0]?.symbol} leads because new wallets outpace sells 3:1 and the dev has no prior rugs; ${picks[1]?.symbol} has the better chart but 2 wallets took 11% in block 1, which I weight down. None are "safe", all are sub-$5M memes.` },
    { role: 'user', text: `what would make you flip bullish on ${picks[2]?.symbol}?` },
    { role: 'ai', text: `Three things, in order: liquidity above $150K (currently ${fmtUsd(picks[2]?.liq || 0, { digits: 0 })}), top-10 below 25%, and a 6h candle closing above ${fmtPrice((picks[2]?.price || 0) * 1.18)} on organic volume. I added those as a watch rule; you'll get an alert, not a trade.` },
    { role: 'user', text: 'draft the thesis as a note for my watchlist' },
    { role: 'ai', text: `Saved to watchlist note for ${picks[2]?.symbol}: "Range-bound memecoin with improving holder spread; entry only on liq > 150K + top10 < 25%; invalidate on dev sell or liq < 60K." Edit with n.` },
  ];
  const ai = state.ai ?? { phase: 'done' as const, cut: convo.length, revealed: 0 };
  const frame = state.vfx.frame;
  const code = state.vfx.code;
  const cut = ai.phase === 'done' ? convo.length : ai.cut;
  let revealedLeft = ai.revealed;
  let cy = cb.y;
  const inputY = cb.y + cb.h - 2;
  for (let li = 0; li < convo.length; li++) {
    const ln = convo[li];
    if (cy >= inputY - 1) break;
    if (li > cut && revealedLeft <= 0) break;
    const streaming = li >= cut;
    if (streaming && ai.phase === 'thinking') {
      c.text(cb.x + 2, cy, spinnerGlyph(frame), { fg: t.ai, bg, b: true });
      const status = ['Thinking', 'Querying screener', 'Reading dev history', 'Decrypting'][Math.floor(frame / 24) % 4];
      c.text(cb.x + 4, cy, `${status}…`, { fg: t.ai, bg, b: true });
      c.text(cb.x + 5 + status.length, cy, `(esc to interrupt · ${(frame / 30).toFixed(1)}s · ↓ ${Math.floor(frame * 11)} tokens)`, { fg: t.dim, bg }, inner - status.length - 6);
      cy += 1;
      break;
    }
    if (ln.role === 'user') {
      c.text(cb.x + 1, cy, '›', { fg: t.accent, bg, b: true });
      for (const w2 of wrap(ln.text, inner - 3)) { if (cy >= inputY - 1) break; c.text(cb.x + 3, cy, w2, { fg: t.text, bg, b: true }); cy += 1; }
      cy += 1;
    } else if (ln.role === 'tool') {
      for (const w2 of wrap('↳ ' + ln.text, inner - 3)) { if (cy >= inputY - 1) break; c.text(cb.x + 3, cy, w2, { fg: t.ai, bg, i: true }); cy += 1; }
    } else if (ln.role === 'table') {
      cy += 1;
      const cols: Array<[string, number, 'l' | 'r']> = [['#', 3, 'r'], ['TOKEN', 11, 'l'], ['MCAP', 8, 'r'], ['HLD 6H', 8, 'r'], ['ORG', 4, 'r'], ['1H', 7, 'r'], ['24H', 8, 'r'], ['LIQ', 8, 'r'], ['TREND', 14, 'l']];
      let hx = cb.x + 3;
      for (const [lab, w, al] of cols) { if (al === 'r') c.textR(hx, cy, w, lab, { fg: t.dim, bg }); else c.text(hx, cy, lab, { fg: t.dim, bg }); hx += w + 1; }
      cy += 1;
      ln.rows.forEach((k, i) => {
        if (cy >= inputY - 1) return;
        let rx = cb.x + 3;
        const rowBg = i % 2 ? mix(bg, t.panelAlt, 1) : bg;
        c.fill(cb.x + 2, cy, inner - 2, 1, ' ', { bg: rowBg });
        c.textR(rx, cy, 3, String(i + 1), { fg: t.dim, bg: rowBg }); rx += 4;
        c.text(rx, cy, k.symbol, { fg: t.text, bg: rowBg, b: true }, 11); rx += 12;
        c.textR(rx, cy, 8, fmtUsd(k.mcap, { digits: 1 }), { fg: t.text, bg: rowBg }); rx += 9;
        c.textR(rx, cy, 8, fmtDeltaDir(k.holders24), { fg: k.holders24 >= 0 ? t.up : t.down, bg: rowBg }); rx += 9;
        c.textR(rx, cy, 4, String(k.org), { fg: k.org >= 70 ? t.up : t.warn, bg: rowBg }); rx += 5;
        heatPct(c, rx, cy, 7, k.chg.h1, rowBg); rx += 8;
        heatPct(c, rx, cy, 8, k.chg.h24, rowBg); rx += 9;
        c.textR(rx, cy, 8, fmtUsd(k.liq, { digits: 1 }), { fg: t.text, bg: rowBg }); rx += 9;
        const sw = Math.min(14, cb.x + cb.w - 2 - rx);
        if (sw >= 4) sparkline(c, rx, cy, sw, k.spark, { bg: rowBg });
        cy += 1;
      });
      cy += 1;
    } else {
      // Claude speaks in coral; the streaming answer decrypts through code glyphs
      c.text(cb.x + 1, cy, '✦', { fg: t.ai, bg, b: true });
      for (const w2 of wrap(ln.text, inner - 3)) {
        if (cy >= inputY - 1) break;
        if (streaming) {
          const n = Math.min(revealedLeft, w2.length);
          decryptText(c, cb.x + 3, cy, w2, n, frame, { fg: t.ai, bg }, inner - 3, code);
          revealedLeft -= w2.length + 1;
          cy += 1;
          if (revealedLeft <= -6) break;
        } else { c.text(cb.x + 3, cy, w2, { fg: t.ai, bg }); cy += 1; }
      }
      cy += 1;
    }
  }
  if (inputY - 2 > cy) c.rainZone(cb.x + 1, cy, inner, inputY - 2 - cy, 2);
  c.hline(cb.x, inputY - 1, cb.w, { fg: bc, bg, soft: true });
  c.put(cb.x, inputY - 1, '├', { fg: bc, bg, soft: true }); c.put(cb.x + cb.w - 1, inputY - 1, '┤', { fg: bc, bg, soft: true });
  // task-1311 (QA B3): the input line captures typed text even before a session exists, with a cursor
  // when focused. Keystrokes reach here only while the box is focused, so nothing types by accident.
  // When idle (not focused, nothing typed) the line keeps its original placeholder so the demo render
  // is unchanged — the focus affordances only appear once the user engages.
  const focused = state.aiFocused === true;
  const typed = state.aiInput ?? '';
  c.text(cb.x + 1, inputY, '▌', { fg: t.ai, bg, b: true, soft: true });
  if (typed) c.text(cb.x + 2, inputY, typed + (focused ? '█' : ''), { fg: t.text, bg }, inner - 2);
  else if (focused) c.text(cb.x + 2, inputY, '█ type your question…  ⏎ send · esc blur', { fg: t.dim, bg, i: true }, inner - 2);
  else c.text(cb.x + 2, inputY, 'ask anything about the market, a token, or your watchlist… (/screen /explain /rank /thesis /backtest)', { fg: t.dim, bg, i: true }, inner - 2);

  if (railW) renderContextRail(c, chatW, top, railW, bottom - top, state);
  footer(c, analystFooter(state, focused), state.theme.name, isCalm(state.vfx));
}

/** Footer keys for the analyst screen — focus state decides whether `q`/screens show or `esc blur`. */
function analystFooter(state: AppState, focused: boolean): [string, string][] {
  if (state.analyst?.busy) return [['⏎', 'queue'], ['esc', 'interrupt'], ['ctrl+c', 'quit']];
  if (focused) return [['⏎', 'send'], ['esc', state.aiInput ? 'clear' : 'blur'], ['ctrl+c', 'quit']];
  if (state.analyst) return [['i', 'ask'], ['esc', 'back'], ['tab', 'screens'], ['q', 'quit']];
  // Idle demo tab (no session, not focused): the original footer, kept for prototype-v2 parity.
  return [['⏎', 'send'], ['↑↓', 'history'], ['ctrl+l', 'clear'], ['esc', 'back'], ['tab', 'screens'], ['q', 'quit']];
}

/**
 * The right-hand navigable COIN LIST beside the chat (task-1313): the live screener rows with the
 * hovered coin highlighted (↑↓ changes it, which updates the analyst's context), plus a short
 * "analyst did X" log of applied UI actions. Degrades to nothing when the panel is too narrow (the
 * caller passes w=0 in compact mode and the chat takes the full width).
 */
export function renderCoinList(c: Canvas, x: number, y: number, w: number, h: number, state: AppState): void {
  const t = c.theme;
  const live = state.screener.source !== 'fixtures';
  const rows = live ? screenerView(state.screener) : [];
  const sel = Math.max(0, Math.min(Math.max(0, rows.length - 1), state.selected || 0));
  const box = c.box(x, y, w, h, { title: 'COINS', titleFg: t.text, caption: live ? '↑↓ pick · ⏎ open' : 'live only', captionFg: t.dim });
  const bg = box.bg;
  const inner = box.w - 2;
  const log = state.analystActions ?? [];
  // Reserve a short footer for the "analyst did X" log: a divider, a label, up to two entries.
  const logRows = log.length ? 2 + Math.min(2, log.length) : 0;
  const listBottom = box.y + box.h - logRows;
  let ry = box.y;
  if (!rows.length) {
    c.text(box.x + 1, ry, live ? 'no rows yet…' : 'coin list is live-mode only', { fg: t.dim, bg, i: true }, inner);
  } else {
    const cap = Math.max(1, listBottom - box.y);
    const startIdx = Math.max(0, Math.min(sel - Math.floor(cap / 2), Math.max(0, rows.length - cap)));
    for (let i = startIdx; i < rows.length && ry < listBottom; i++) {
      const r = rows[i];
      const on = i === sel;
      const rowBg = on ? mix(bg, t.accent, 0.3) : i % 2 ? mix(bg, t.panelAlt, 1) : bg;
      c.fill(box.x + 1, ry, inner, 1, ' ', { bg: rowBg });
      let rx = box.x + 1;
      c.text(rx, ry, on ? '▸' : ' ', { fg: t.accent, bg: rowBg, b: true }); rx += 1;
      c.text(rx, ry, r.symbol, { fg: t.text, bg: rowBg, b: on }, 9); rx += 9;
      const chg = r.chg.h24 ?? 0;
      c.textR(rx, ry, 7, fmtPctDir(chg), { fg: chg >= 0 ? t.up : t.down, bg: rowBg }); rx += 8;
      const liqW = Math.max(0, box.x + box.w - 1 - rx);
      if (liqW >= 6) c.textR(rx, ry, liqW, 'L' + fmtUsd(r.liq || 0, { digits: 0 }), { fg: t.dim, bg: rowBg });
      ry += 1;
    }
  }
  if (log.length) {
    c.hline(box.x, listBottom, box.w, { fg: t.border, bg, soft: true });
    c.put(box.x, listBottom, '├', { fg: t.border, bg, soft: true });
    c.put(box.x + box.w - 1, listBottom, '┤', { fg: t.border, bg, soft: true });
    c.text(box.x + 1, listBottom, ' ANALYST DID ', { fg: t.ai, bg });
    let ly = listBottom + 1;
    for (const l of log.slice(-2)) { if (ly >= box.y + box.h) break; c.text(box.x + 1, ly, '✓ ' + l, { fg: t.ai, bg }, inner); ly += 1; }
  }
}

/** The right-hand "what claude can see" rail: tool list, firewall note, guard rail, and a market pulse. */
export function renderContextRail(c: Canvas, x: number, y: number, w: number, h: number, state: AppState): void {
  const t = c.theme;
  const fx = state.fx;
  const rb = c.box(x, y, w, h, { title: 'CONTEXT', caption: 'what claude can see' });
  let ry = rb.y;
  const items: Array<[string, string]> = [
    ['tools', 'screener_query · get_token · get_holders · get_trades · get_dev_history · rugcheck · watchlist_*'],
    ['firewall', 'token names, descriptions, socials wrapped as untrusted data; instructions inside them are ignored'],
    ['never', 'sign, send, or build a transaction. Trade panel requires your explicit confirm (v2).'],
    ['model', 'your local claude CLI · session kept warm · no keys shipped by trenchscope'],
  ];
  for (const [k, v] of items) {
    c.text(rb.x + 1, ry, k.toUpperCase(), { fg: k === 'never' ? t.warn : t.dim, bg: rb.bg });
    ry += 1;
    for (const w2 of wrap(v, rb.w - 2)) { if (ry >= rb.y + rb.h) break; c.text(rb.x + 1, ry, w2, { fg: k === 'never' ? t.warn : t.text, bg: rb.bg }); ry += 1; }
    ry += 1;
  }
  c.hline(rb.x, ry, rb.w, { fg: t.border, bg: rb.bg, soft: true });
  ry += 1;
  c.text(rb.x + 1, ry, 'MARKET PULSE', { fg: t.dim, bg: rb.bg });
  c.heading(rb.x + 1, ry, 12);
  ry += 1;
  // task-1311 (QA M13): in live mode the pulse is the live screener's top rows — never the 2024
  // fixture tickers (SIGMA/GOAT/…), which must not sit next to live data.
  const live = state.screener.source !== 'fixtures';
  const pulse = live
    ? state.screener.rows.slice(0, 8).map((r) => ({ symbol: r.symbol, spark: r.spark, chg24: r.chg.h24 ?? 0 }))
    : fx.tokens.slice(0, 8).map((k) => ({ symbol: k.symbol, spark: k.spark, chg24: k.chg.h24 }));
  for (const k of pulse) {
    if (ry >= rb.y + rb.h) break;
    c.text(rb.x + 1, ry, k.symbol, { fg: t.text, bg: rb.bg, b: true }, 9);
    sparkline(c, rb.x + 11, ry, rb.w - 22, k.spark, { bg: rb.bg });
    c.textR(rb.x + rb.w - 9, ry, 8, fmtPctDir(k.chg24), { fg: k.chg24 >= 0 ? t.up : t.down, bg: rb.bg });
    ry += 1;
  }
  if (ry + 1 < rb.y + rb.h) c.rainZone(rb.x + 1, ry + 1, rb.w - 2, rb.y + rb.h - ry - 1, 2);
}
