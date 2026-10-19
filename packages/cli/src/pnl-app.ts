// trenchscope — PNL CARD glue for the app (task-1407). `H` on the token, positions and followed-wallets screens opens a
// preview of the coin's PnL card built from dexterm's own records:
//   token      → that coin: LIVE when the signer's ledger has fills for it, else PAPER
//   positions  → every coin with fills (newest activity first; ← → cycle), LIVE or PAPER as above
//   follows    → the selected followed wallet's coins (TRACKED), newest first
// In the preview: x share to X · t copy as text · s save only · a show/hide wallet · z exact size/band ·
// f 16:9 ⇄ 1:1 · ← → other coin · esc close. Share = save + clipboard image + X compose intent in the user's own
// browser (pnl-card.ts shareCard); trenchscope posts nothing. Nothing here trades, signs or edits a number.
import { type Canvas, mix } from '@dexterm/tui';
import type { AppState } from './state.ts';
import {
  computeCard, renderCard, previewCanvas, cardText, paperCardInput, liveCardInput, trackedCardInput, CardError,
  type CardInput, type CardOptions, type CardStats,
} from './pnl-card.ts';

export type PnlOrigin = 'token' | 'positions' | 'follows';

export interface PnlUi {
  origin: PnlOrigin;
  /** Coins this screen can card (newest activity first); ← → cycle. */
  choices: { mint: string; symbol: string }[];
  idx: number;
  /** follows: the followed wallet whose history is carded. */
  wallet: string | null;
  opts: Required<CardOptions>;
  stats: CardStats | null;
  error: string | null;
  /** A share/save is running (keys other than esc are ignored meanwhile). */
  busy: boolean;
  notice: string | null;
}

const MARK_VIA = 'dexscreener';

function coinMeta(state: AppState, mint: string): { symbol: string | null; name: string | null; image: string | null } {
  const tv = state.live?.token?.view;
  if (tv && tv.mint === mint) return { symbol: tv.symbol, name: tv.name, image: tv.image };
  const row = state.screener.rows.find((r) => r.mint === mint);
  return { symbol: row?.symbol ?? null, name: row?.name ?? null, image: row?.image ?? null };
}

function imageOf(state: AppState, url: string | null): CardInput['image'] {
  if (!url || !state.images) return null;
  const st = state.images.get(url, 2);
  return st.state === 'ready' ? st.img : null;
}

/** The newest price mark for a mint: the positions mark pass, else the open token's market panel ÷ SOL/USD. */
export function markFor(state: AppState, mint: string): CardInput['mark'] {
  const pos = state.live?.positions;
  const p = pos?.markOf(mint) ?? null, at = pos?.markAt(mint) ?? null;
  if (p !== null && at !== null) return { priceSol: p, at, via: MARK_VIA };
  const tv = state.live?.token?.view;
  const solUsd = pos?.solUsd() ?? null;
  const m = tv?.panels.market;
  if (tv && tv.mint === mint && tv.price && solUsd && m?.fetchedAt) return { priceSol: tv.price / solUsd, at: m.fetchedAt, via: `${m.via ?? 'market'} ÷ SOL/USD` };
  return null;
}

/** Coins with paper or live fills, newest activity first. */
function tradedCoins(state: AppState): { mint: string; symbol: string }[] {
  const live = state.live;
  if (!live) return [];
  const last = new Map<string, { t: number; symbol: string }>();
  const see = (mint: string, t: number, symbol: string) => { const e = last.get(mint); if (!e || t > e.t) last.set(mint, { t, symbol }); };
  for (const r of live.wallet.trades(1000)) see(r.mint, r.t, r.symbol);
  for (const r of live.livePositions?.records(1000) ?? []) see(r.mint, r.t, r.symbol);
  return [...last.entries()].sort((a, b) => b[1].t - a[1].t).map(([mint, v]) => ({ mint, symbol: v.symbol }));
}

/** Open the preview for the current screen. Returns a reason when there is nothing to card. */
export function openPnl(state: AppState): string | null {
  if (!state.live) return 'PnL cards are made from recorded fills: run trenchscope live (not --fixtures / --replay)';
  const base = { idx: 0, stats: null, error: null, busy: false, notice: null, opts: { aspect: 'wide' as const, showWallet: false, exactSize: false } };
  if (state.screen === 'follows') {
    const follows = state.copy?.follows() ?? [];
    const f = follows[Math.max(0, Math.min(follows.length - 1, state.copyUi?.selected ?? 0))];
    if (!f) return 'follow a wallet first (i), then H cards its coins';
    const seen = new Set<string>();
    const choices: PnlUi['choices'] = [];
    for (const tr of [...(state.copy?.trades(f.addr) ?? [])].sort((a, b) => b.t - a.t)) {
      if (seen.has(tr.mint) || tr.side === 'transfer') continue;
      seen.add(tr.mint);
      choices.push({ mint: tr.mint, symbol: coinMeta(state, tr.mint).symbol ?? tr.mint.slice(0, 4) });
    }
    if (!choices.length) return 'no decoded swaps for this wallet yet (r polls now)';
    state.pnl = { origin: 'follows', choices, wallet: f.addr, ...base };
  } else if (state.screen === 'token') {
    const mint = state.live.token?.view?.mint ?? state.token?.mint ?? null;
    if (!mint) return 'open a coin first';
    const has = (state.live.livePositions?.records(1, mint).length ?? 0) > 0 || state.live.wallet.trades(1000).some((r) => r.mint === mint);
    if (!has) return 'no paper or live fills for this coin yet: PnL cards come from your own recorded trades';
    state.pnl = { origin: 'token', choices: [{ mint, symbol: coinMeta(state, mint).symbol ?? mint.slice(0, 4) }], wallet: null, ...base };
  } else if (state.screen === 'positions') {
    const choices = tradedCoins(state);
    if (!choices.length) return 'no paper or live fills yet: B / S on a token to trade, then H here';
    state.pnl = { origin: 'positions', choices, wallet: null, ...base };
  } else return 'PnL cards open from the token, positions (P) or followed wallets (U) screens';
  state.overlay = 'pnl';
  return null;
}

/** The card input for the current choice, from the right ledger. Async only for a tracked coin that needs decimals / a price. */
export async function pnlInput(state: AppState, ui: PnlUi): Promise<CardInput> {
  const live = state.live;
  if (!live) throw new CardError('no live context');
  const ch = ui.choices[ui.idx];
  const meta = coinMeta(state, ch.mint);
  const image = imageOf(state, meta.image);
  if (ui.origin === 'follows' && ui.wallet && state.copy) {
    const copy = state.copy;
    const st = copy.status();
    const stats = copy.stats(ui.wallet);
    let mark = markFor(state, ch.mint);
    let decimals: number | null = null;
    // decimals + a price for a public mint: the same keyless reads the mirror checks make (no wallet, no user data)
    const m = await copy.mirrorMarket(ch.mint, { symbol: meta.symbol });
    decimals = m.decimals;
    const solUsd = live.positions.solUsd();
    if (!mark && m.priceUsd && m.priceAt && solUsd) mark = { priceSol: m.priceUsd / solUsd, at: m.priceAt, via: `${MARK_VIA} ÷ SOL/USD` };
    return trackedCardInput(copy.trades(ui.wallet), {
      wallet: ui.wallet, mint: ch.mint, symbol: meta.symbol ?? m.symbol ?? ch.symbol, name: meta.name, decimals, mark,
      historyAt: st.lastPollAt, complete: stats.sample.complete, image,
    });
  }
  const liveRows = live.livePositions?.fills(ch.mint) ?? [];
  if (liveRows.length) {
    return liveCardInput(liveRows, { mint: ch.mint, symbol: meta.symbol ?? undefined, name: meta.name, wallet: live.linkedWallet?.publicKey ?? null, mark: markFor(state, ch.mint), image });
  }
  return paperCardInput(live.wallet.trades(1000), { mint: ch.mint, symbol: meta.symbol ?? undefined, name: meta.name, mark: markFor(state, ch.mint), image });
}

/** (Re)build the card for the current choice; on refusal the preview shows the reason instead of a card. */
export async function loadPnl(state: AppState, now: number = Date.now()): Promise<void> {
  const ui = state.pnl;
  if (!ui) return;
  try {
    ui.stats = computeCard(await pnlInput(state, ui), now);
    ui.error = null;
  } catch (e) {
    ui.stats = null;
    ui.error = e instanceof Error ? e.message : String(e);
  }
}

export type PnlKeyEffect = { kind: 'none' } | { kind: 'close' } | { kind: 'reload' } | { kind: 'share'; action: 'x' | 'text' | 'save' };

/** Keys while the preview is open. Pure: the loop performs reload / share. */
export function pnlKey(ui: PnlUi, key: { name: string; ch?: string; ctrl?: boolean }): PnlKeyEffect {
  if (key.name === 'esc' || (key.name === 'char' && key.ch === 'q')) return { kind: 'close' };
  if (ui.busy) return { kind: 'none' };
  const ch = key.name === 'char' && !key.ctrl ? key.ch : undefined;
  if (key.name === 'right' || ch === ']' || ch === 'l') { if (ui.choices.length > 1) { ui.idx = (ui.idx + 1) % ui.choices.length; return { kind: 'reload' }; } return { kind: 'none' }; }
  if (key.name === 'left' || ch === '[' || ch === 'h') { if (ui.choices.length > 1) { ui.idx = (ui.idx - 1 + ui.choices.length) % ui.choices.length; return { kind: 'reload' }; } return { kind: 'none' }; }
  if (ch === 'a') { ui.opts.showWallet = !ui.opts.showWallet; ui.notice = ui.opts.showWallet ? 'wallet + tx signatures SHOWN on the card' : 'wallet hidden'; return { kind: 'none' }; }
  if (ch === 'z') { ui.opts.exactSize = !ui.opts.exactSize; ui.notice = ui.opts.exactSize ? 'exact SOL size SHOWN on the card' : 'size shown as a band'; return { kind: 'none' }; }
  if (ch === 'f') { ui.opts.aspect = ui.opts.aspect === 'wide' ? 'square' : 'wide'; return { kind: 'none' }; }
  if (!ui.stats) return { kind: 'none' };
  if (ch === 'x') return { kind: 'share', action: 'x' };
  if (ch === 't') return { kind: 'share', action: 'text' };
  if (ch === 's') return { kind: 'share', action: 'save' };
  return { kind: 'none' };
}

const HINTS = 'x share to X · t copy text · s save · a wallet · z size · f 16:9/1:1 · ←→ coin · esc';

/** The preview overlay: the card itself at cell size when the terminal fits it, else its text; then the keys. */
export function renderPnlOverlay(c: Canvas, state: AppState): void {
  const ui = state.pnl;
  if (!ui) return;
  const t = c.theme;
  c.noRain(0, 0, c.w, c.h);
  c.fill(0, 0, c.w, c.h, ' ', { bg: mix(t.bg, '#000000', 0.5) });
  const ch = ui.choices[ui.idx];
  const head = `PnL CARD · $${ch?.symbol ?? '?'}${ui.choices.length > 1 ? ` (${ui.idx + 1}/${ui.choices.length})` : ''} · ${ui.opts.aspect === 'wide' ? '16:9' : '1:1'} · wallet ${ui.opts.showWallet ? 'SHOWN' : 'hidden'} · size ${ui.opts.exactSize ? 'EXACT' : 'band'}`;
  c.text(1, 0, head, { fg: t.text, bg: t.headBg, b: true }, c.w - 2);
  c.fill(0, c.h - 1, c.w, 1, ' ', { bg: t.headBg });
  c.text(1, c.h - 1, ui.busy ? 'working… (esc closes)' : (ui.notice ?? HINTS), { fg: ui.notice ? t.warn : t.muted, bg: t.headBg }, c.w - 2);
  const area = { x: 0, y: 1, w: c.w, h: c.h - 2 };
  if (!ui.stats) {
    c.text(2, 3, ui.error ? `no card: ${ui.error}` : 'building the card…', { fg: ui.error ? t.warn : t.muted, bg: c.bg[c.idx(2, 3)] }, c.w - 4);
    return;
  }
  const r = renderCard(ui.stats, ui.opts);
  const pv = previewCanvas(r);
  if (pv.w <= area.w && pv.h <= area.h) {
    const ox = area.x + Math.floor((area.w - pv.w) / 2), oy = area.y + Math.floor((area.h - pv.h) / 2);
    for (let y = 0; y < pv.h; y++) for (let x = 0; x < pv.w; x++) {
      const i = pv.idx(x, y), j = c.idx(ox + x, oy + y);
      c.ch[j] = pv.ch[i]; c.fg[j] = pv.fg[i]; c.bg[j] = pv.bg[i]; c.at[j] = pv.at[i];
    }
    return;
  }
  // too small for the card grid: the same facts as text (the PNG is still full size)
  const lines = cardText(ui.stats, ui.opts).trimEnd().split('\n');
  lines.forEach((l, k) => { if (2 + k < c.h - 1) c.text(2, 2 + k, l, { fg: k === 0 ? t.warn : t.text, bg: c.bg[c.idx(2, 2 + k)] }, c.w - 4); });
}
