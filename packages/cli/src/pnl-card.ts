// trenchscope — PNL CARDS (task-1407). One key (`H` on the positions, token and followed-wallets screens) turns a coin's
// RECORDED fills into a shareable result card: a 1200×675 (X card, 16:9) and a 1080×1080 (1:1) PNG plus a plain-text
// version, saved to ~/.dexterm/exports. Share to X = save + copy the image to the OS clipboard + open X's compose
// intent in the user's own browser with neutral text; the user pastes the image and posts. trenchscope never posts,
// never holds X credentials and makes no network call here.
//
// Honesty rules, enforced by construction:
//   - The stamp (PAPER / LIVE / TRACKED WALLET) comes from `CardInput.source` and is drawn by the renderer in three
//     places (the stamp block, the frame colour, the stamp strip). No option turns it off; an unknown source throws.
//   - Numbers come only from fills (the paper ledger, the signer's live ledger, a tracked wallet's decoded history).
//     There is no API that takes a PnL, a price or a size; every figure is computed here from those fills, with
//     the time window, the fee basis, what was excluded and the data ages printed on the card.
//   - Wallet addresses (and LIVE tx signatures, which point at the wallet) are hidden unless `showWallet`; size is a
//     band unless `exactSize`; no balance, no key, no file path is ever drawn.
//   - Footer: "not financial advice" and the trenchscope URL. No performance claims beyond this one position's fills.
//
// Rendering reuses the task-1401 exporter stack: a cell Canvas rasterized by @dexterm/tui (the 5×9 bitmap font) and
// encoded by @dexterm/data. Big type (the stamp, the ticker, the PnL %) is the same font rasterized at a larger
// scale and pasted into reserved cell rects, auto-fitted so it can never clip.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Canvas, THEMES, rasterizeCanvas, fmtPriceBare, mix, type Hex, type Theme } from '@dexterm/tui';
import { encodePng, lamportsToSol, type TradeRecord, type LiveFillRow } from '@dexterm/data';
import type { WalletTrade } from '@dexterm/data/copy';
import { exportsDir, fmtAge } from './export.ts';
import { cleanText } from './screener/rows.ts';

export type CardSource = 'paper' | 'live' | 'tracked';
export type CardAspect = 'wide' | 'square';

/** The URL on every card footer and in the default share text. One place, so it can change in one place. */
export const DEXTERM_URL = 'dexterm.xyz';

/** One recorded fill of the coin, normalised from whichever ledger it came from. */
export interface CardFill {
  t: number;
  side: 'buy' | 'sell';
  /** Signed SOL change of this coin's leg, net of fees (buy < 0, sell > 0). */
  solDelta: number;
  /** Signed raw token change (buy > 0, sell < 0). */
  tokenDelta: bigint;
  /** Fee of this fill in SOL when the ledger records it. */
  feeSol: number | null;
  /** On-chain signature (LIVE, TRACKED); null for paper fills. */
  sig: string | null;
}

/** What a card is made of. Built only by the ledger adapters below (paperCardInput / liveCardInput / trackedCardInput). */
export interface CardInput {
  source: CardSource;
  /** LIVE only: the network of the fills ('mixed' when the ledger holds both). */
  network?: 'mainnet' | 'devnet' | 'mixed' | null;
  mint: string;
  symbol: string;
  name?: string | null;
  /** Token decimals (prices per whole token); null = unknown (prices are then not shown). */
  decimals: number | null;
  fills: CardFill[];
  /** Where the fills came from, in words. */
  ledger: string;
  /** The wallet that made the fills (LIVE, TRACKED); hidden on the card unless showWallet. */
  wallet?: string | null;
  /** The price mark used for an open position (SOL per whole token) and when it was taken. */
  mark?: { priceSol: number; at: number; via: string } | null;
  /** TRACKED: when the wallet history was fetched. */
  historyAt?: number | null;
  /** Fills or effects left out of the numbers, in words (never silently dropped). */
  excluded: string[];
  /** The fee basis in words. */
  fees: string;
  /** Coin image pixels (straight-alpha RGBA), when the image service already has it. */
  image?: { w: number; h: number; rgba: Uint8Array } | null;
}

export interface CardOptions {
  aspect?: CardAspect;
  /** Show the wallet address (and LIVE tx signatures). Default false. */
  showWallet?: boolean;
  /** Show the exact SOL size and absolute PnL instead of the size band. Default false. */
  exactSize?: boolean;
}

/** Refusal to build a card, with the reason the UI shows. */
export class CardError extends Error {
  constructor(message: string) { super(message); this.name = 'CardError'; }
}

// ------------------------------------------------------------------------------------------------ ledger adapters

/** PAPER: the paper wallet's TradeRecords for one mint (the positions screen's history). */
export function paperCardInput(records: TradeRecord[], o: { mint: string; symbol?: string; name?: string | null; mark?: CardInput['mark']; image?: CardInput['image'] }): CardInput {
  const rs = records.filter((r) => r.mint === o.mint);
  return {
    source: 'paper', mint: o.mint, symbol: o.symbol ?? rs[0]?.symbol ?? '?', name: o.name ?? null, decimals: rs[0]?.decimals ?? null,
    fills: rs.map((r) => ({ t: r.t, side: r.side, solDelta: lamportsToSol(r.solDelta), tokenDelta: r.tokenDelta, feeSol: lamportsToSol(r.feeLamports), sig: null })),
    ledger: 'trenchscope paper ledger', wallet: null, mark: o.mark ?? null,
    excluded: [], fees: 'simulated network fee included', image: o.image ?? null,
  };
}

/** LIVE: the signer's ledger rows (confirmed on-chain fills, swaps only) for one mint. */
export function liveCardInput(rows: LiveFillRow[], o: { mint: string; symbol?: string; name?: string | null; wallet?: string | null; mark?: CardInput['mark']; image?: CardInput['image'] }): CardInput {
  const rs = rows.filter((r) => r.mint === o.mint && r.kind === 'swap');
  const nets = new Set(rs.map((r) => r.network));
  const network = nets.size > 1 ? 'mixed' : rs[0]?.network === 'devnet' ? 'devnet' : 'mainnet';
  return {
    source: 'live', network, mint: o.mint, symbol: o.symbol ?? rs[0]?.symbol ?? '?', name: o.name ?? null, decimals: rs[0]?.decimals ?? null,
    fills: rs.map((r) => ({ t: r.t, side: r.side === 'sell' ? 'sell' : 'buy', solDelta: lamportsToSol(BigInt(r.solDelta)), tokenDelta: BigInt(r.tokenDelta), feeSol: lamportsToSol(BigInt(r.feeLamports)), sig: r.signature })),
    ledger: 'signer live ledger', wallet: o.wallet ?? null, mark: o.mark ?? null,
    excluded: network === 'mixed' ? ['devnet and mainnet fills are both in the ledger for this coin'] : [], fees: 'network + priority fees included', image: o.image ?? null,
  };
}

/** TRACKED: a followed wallet's decoded swaps for one mint (read-only public history). */
export function trackedCardInput(trades: WalletTrade[], o: { wallet: string; mint: string; symbol?: string; name?: string | null; decimals?: number | null; mark?: CardInput['mark']; historyAt?: number | null; complete?: boolean; image?: CardInput['image'] }): CardInput {
  const all = trades.filter((t) => t.mint === o.mint && t.wallet === o.wallet);
  const kept: CardFill[] = [];
  let noSol = 0, transfers = 0, lp = 0, airdrop = 0, timeUnknown = 0;
  for (const t of all) {
    if (t.side === 'transfer') { transfers++; continue; }
    if (t.note === 'lp-like') { lp++; continue; }
    if (t.note === 'airdrop') { airdrop++; continue; }
    if (t.solDelta === null || t.note === 'token-swap') { noSol++; continue; }
    if (!t.tKnown) timeUnknown++;
    kept.push({ t: t.t, side: t.side, solDelta: t.solDelta, tokenDelta: BigInt(t.tokenDelta), feeSol: null, sig: t.sig });
  }
  const excluded: string[] = [];
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  if (noSol) excluded.push(`${n(noSol, 'token-to-token swap')} (no SOL leg)`);
  if (transfers) excluded.push(n(transfers, 'transfer'));
  if (airdrop) excluded.push(`${n(airdrop, 'airdrop')} (no cost)`);
  if (lp) excluded.push(`${n(lp, 'LP-like move')}`);
  if (timeUnknown) excluded.push(`${n(timeUnknown, 'fill')} without a block time (fetch time used)`);
  if (o.complete === false) excluded.push('wallet history older than the fetched pages');
  return {
    source: 'tracked', mint: o.mint, symbol: o.symbol ?? o.mint.slice(0, 4), name: o.name ?? null, decimals: o.decimals ?? null,
    fills: kept, ledger: 'tracked wallet history', wallet: o.wallet, mark: o.mark ?? null, historyAt: o.historyAt ?? null,
    excluded, fees: 'network fees + tips included (balance deltas)', image: o.image ?? null,
  };
}

// ------------------------------------------------------------------------------------------------ the numbers

export type PnlKind = 'realized' | 'unrealized' | 'realized + unrealized';

export interface CardStats {
  input: CardInput;
  buys: number;
  sells: number;
  firstT: number;
  lastT: number;
  /** Still holding more than dust (1 % of the peak holding). */
  open: boolean;
  /** SOL spent on buys (net, fees included). */
  costInSol: number;
  /** SOL received from matched sells (net). */
  proceedsSol: number;
  realizedSol: number;
  unrealizedSol: number | null;
  pnlSol: number;
  /** pnlSol ÷ costInSol (0.284 = +28.4 %). */
  pnlPct: number;
  kind: PnlKind;
  /** Average entry / exit price, SOL per whole token (null when decimals are unknown or there is no exit). */
  entryAvg: number | null;
  exitAvg: number | null;
  holdMs: number;
  /** Sum of fees the ledger recorded (SOL), null when it records none. */
  feesSol: number | null;
  now: number;
}

/** Cost-basis maths over the fills (average cost, the paper and live ledgers' own rule). Throws CardError when a card would mislead. */
export function computeCard(input: CardInput, now: number): CardStats {
  if (input.source !== 'paper' && input.source !== 'live' && input.source !== 'tracked') throw new CardError('a PnL card needs a source stamp: paper, live or tracked');
  const fills = [...input.fills].sort((a, b) => a.t - b.t);
  if (!fills.length) throw new CardError(`no recorded fills for $${cleanText(input.symbol, 12)} in the ${input.ledger}`);
  if (!fills.some((f) => f.side === 'buy')) throw new CardError('no recorded buy for this coin, so there is no cost basis to measure against');
  let held = 0n, peak = 0n, cost = 0, costIn = 0, proceeds = 0, realized = 0, boughtRaw = 0n, soldRaw = 0n, buys = 0, sells = 0, unmatched = 0;
  let fees = 0, feesKnown = false, firstBuy = Infinity, lastSell = -Infinity;
  for (const f of fills) {
    if (f.feeSol !== null) { fees += f.feeSol; feesKnown = true; }
    if (f.side === 'buy') {
      if (f.tokenDelta <= 0n || f.solDelta >= 0) continue; // not a priced buy
      buys++; firstBuy = Math.min(firstBuy, f.t);
      held += f.tokenDelta; boughtRaw += f.tokenDelta; if (held > peak) peak = held;
      cost += -f.solDelta; costIn += -f.solDelta;
    } else {
      const sold = -f.tokenDelta;
      if (sold <= 0n || f.solDelta <= 0) continue;
      sells++; lastSell = Math.max(lastSell, f.t);
      // tokens sold beyond what the recorded buys hold have no cost basis: only the matched share counts
      const matched = sold > held ? held : sold;
      if (matched < sold) unmatched++;
      if (matched <= 0n) continue;
      const share = Number(matched) / Number(sold);
      const removed = held > 0n ? cost * (Number(matched) / Number(held)) : 0;
      const got = f.solDelta * share;
      proceeds += got; realized += got - removed; cost -= removed; held -= matched; soldRaw += matched;
    }
  }
  if (!buys) throw new CardError('no priced buy for this coin, so there is no cost basis to measure against');
  if (unmatched) input = { ...input, excluded: [...input.excluded, `${unmatched} sell${unmatched === 1 ? '' : 's'} beyond the recorded buys (only the matched part counts)`] };
  const dust = peak > 0n && held * 100n <= peak;
  const open = held > 0n && !dust;
  if (held > 0n && dust) input = { ...input, excluded: [...input.excluded, 'dust under 1 % of the peak holding'] };
  let unrealized: number | null = null;
  if (open) {
    const m = input.mark;
    if (!m || !Number.isFinite(m.priceSol) || m.priceSol <= 0) throw new CardError('the position is still open and has no price mark yet (positions mark every 10 s); try again in a moment');
    if (input.decimals === null) throw new CardError('the position is still open and the token decimals are unknown, so it cannot be marked');
    const value = (Number(held) / 10 ** input.decimals) * m.priceSol;
    unrealized = value - cost;
  }
  const pnl = realized + (unrealized ?? 0);
  const whole = (raw: bigint) => (input.decimals === null ? null : Number(raw) / 10 ** input.decimals);
  const boughtW = whole(boughtRaw), soldW = whole(soldRaw);
  return {
    input, buys, sells, firstT: fills[0].t, lastT: fills[fills.length - 1].t, open,
    costInSol: costIn, proceedsSol: proceeds, realizedSol: realized, unrealizedSol: unrealized, pnlSol: pnl, pnlPct: costIn > 0 ? pnl / costIn : 0,
    kind: !open ? 'realized' : sells ? 'realized + unrealized' : 'unrealized',
    entryAvg: boughtW ? costIn / boughtW : null, exitAvg: soldW ? proceeds / soldW : null,
    holdMs: Math.max(0, (open ? now : lastSell === -Infinity ? now : lastSell) - (firstBuy === Infinity ? fills[0].t : firstBuy)),
    feesSol: feesKnown ? fees : null, now,
  };
}

// ------------------------------------------------------------------------------------------------ formatting

/** Size bands (SOL spent on buys). The default card shows the band, never the amount. */
export const SIZE_BANDS: readonly number[] = [0.1, 0.5, 1, 5, 10, 50, 100];
export function sizeBand(sol: number): string {
  if (sol < SIZE_BANDS[0]) return `under ${SIZE_BANDS[0]} SOL`;
  for (let i = 1; i < SIZE_BANDS.length; i++) if (sol < SIZE_BANDS[i]) return `${SIZE_BANDS[i - 1]}-${SIZE_BANDS[i]} SOL`;
  return `${SIZE_BANDS[SIZE_BANDS.length - 1]}+ SOL`;
}

/** `+28.4%` / `-7.1%` / `+1,284%`. */
export function fmtPnlPct(frac: number): string {
  const p = frac * 100, a = Math.abs(p);
  const body = a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toFixed(1);
  return `${p >= 0 ? '+' : '-'}${body}%`;
}

/** `38s` / `45m` / `3h 12m` / `9d 4h`. */
export function fmtHold(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Local `2026-10-16 01:23`. */
export function fmtWhen(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const signedSol = (n: number): string => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(4)} SOL`;
const short = (a: string): string => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

interface Stamp { big: string; line: string; strip: string; color: Hex; note: string }

/** The stamp of a source. Exhaustive: anything else throws, so a card can never be drawn without one. */
export function stampOf(s: CardStats, t: Theme): Stamp {
  const src = s.input.source;
  if (src === 'paper') return { big: 'PAPER', line: 'SIMULATED TRADE · NO REAL FUNDS', strip: 'PAPER · SIMULATED', color: t.warn, note: 'PAPER: simulated in dexterm\'s paper wallet against live quotes; no real funds moved.' };
  if (src === 'live') {
    const net = s.input.network;
    const sigs = s.input.fills.filter((f) => f.sig).length;
    return {
      big: 'LIVE', line: net === 'devnet' ? 'ON-CHAIN · DEVNET TEST FUNDS' : net === 'mixed' ? 'ON-CHAIN · DEVNET + MAINNET' : 'ON-CHAIN · WALLET-SIGNED', strip: net === 'devnet' ? 'LIVE · DEVNET' : 'LIVE · WALLET-SIGNED', color: t.up,
      note: `LIVE: ${sigs} wallet-signed tx${sigs === 1 ? '' : 's'} confirmed on ${net === 'devnet' ? 'devnet (test funds, not real money)' : net === 'mixed' ? 'devnet and mainnet' : 'Solana mainnet'}, verifiable on-chain.`,
    };
  }
  if (src === 'tracked') return { big: 'TRACKED', line: 'WALLET · READ-ONLY OBSERVATION', strip: 'TRACKED WALLET · READ-ONLY', color: t.accent, note: 'TRACKED: a read-only view of a public wallet\'s decoded history. Not a recommendation.' };
  throw new CardError('a PnL card needs a source stamp: paper, live or tracked');
}

/**
 * The provenance lines (window, fees, exclusions, data ages; the wallet and LIVE tx signatures only when shown).
 * `card` keeps signatures short to fit the PNG; `text` prints them in full so they can be checked on an explorer.
 */
export function provenance(s: CardStats, o: CardOptions, mode: 'card' | 'text' = 'text'): string[] {
  const i = s.input;
  const n = i.fills.length;
  const L: string[] = [];
  L.push(`window: ${fmtWhen(s.firstT)} to ${s.open ? `now (${fmtWhen(s.now)})` : fmtWhen(s.lastT)} local · ${n} recorded fill${n === 1 ? '' : 's'} · ${i.ledger}`);
  L.push(`fees: ${i.fees}${s.feesSol !== null && o.exactSize ? ` (${s.feesSol.toFixed(6)} SOL)` : ''} · excluded: ${i.excluded.length ? i.excluded.join('; ') : 'nothing'}`);
  const ages = [`last fill ${fmtAge((s.now - s.lastT) / 1000)} ago`];
  if (i.historyAt) ages.push(`history fetched ${fmtAge((s.now - i.historyAt) / 1000)} ago`);
  ages.push(s.open && i.mark ? `mark ${fmtAge((s.now - i.mark.at) / 1000)} old (${i.mark.via})` : 'no mark needed (closed)');
  if (mode === 'text') ages.push(`card made ${fmtWhen(s.now)}`);
  L.push(`data ages: ${ages.join(' · ')}`);
  if (o.showWallet && i.wallet) L.push(`wallet: ${i.wallet}`);
  if (i.source === 'live' && o.showWallet) {
    const sigs = i.fills.map((f) => f.sig).filter((x): x is string => !!x);
    const fmt = (x: string) => (mode === 'card' ? `${x.slice(0, 8)}…${x.slice(-6)}` : x);
    const k = mode === 'card' ? 3 : sigs.length;
    if (sigs.length) L.push(`tx: ${sigs.slice(0, k).map(fmt).join(' ')}${sigs.length > k ? ` +${sigs.length - k} more` : ''}`);
  }
  return L;
}

// ------------------------------------------------------------------------------------------------ the card canvas

/** Pixel geometry per aspect: cols × rows cells of cellW × cellH px = exactly the X card / square sizes. */
export const CARD_GEOMETRY: Record<CardAspect, { w: number; h: number; cols: number; rows: number; cellW: number; cellH: number }> = {
  wide: { w: 1200, h: 675, cols: 100, rows: 27, cellW: 12, cellH: 25 },
  square: { w: 1080, h: 1080, cols: 90, rows: 45, cellW: 12, cellH: 24 },
};

/** Text drawn large into a reserved cell rect (auto-fitted at render time). */
export interface BigText { x: number; y: number; w: number; h: number; text: string; fg: Hex; bg: Hex; align: 'left' | 'center' }

export interface CardRender {
  aspect: CardAspect;
  canvas: Canvas;
  big: BigText[];
  /** Every string that did not fit its space (must be empty; the tests and the visual review check it). */
  clipped: string[];
  /** The stamp block's cell rect. */
  stampRect: { x: number; y: number; w: number; h: number };
  stamp: Stamp;
}

/** Deterministic hash for the background code sprinkle (same card → same pixels). */
function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function renderCard(s: CardStats, o: CardOptions = {}): CardRender {
  const aspect: CardAspect = o.aspect ?? 'wide';
  const g = CARD_GEOMETRY[aspect];
  const t = THEMES.cyberspace;
  const stamp = stampOf(s, t);
  const c = new Canvas(g.cols, g.rows, t);
  const big: BigText[] = [];
  const clipped: string[] = [];
  const W = g.cols, H = g.rows;
  const panel = t.panel;
  const put = (x: number, y: number, str: string, st: { fg: Hex; bg?: Hex; b?: boolean }, maxW: number): number => {
    if ([...str].length > maxW) clipped.push(str);
    return c.text(x, y, str, { fg: st.fg, bg: st.bg ?? panel, b: st.b }, maxW);
  };
  const putR = (xRight: number, y: number, str: string, st: { fg: Hex; bg?: Hex; b?: boolean }): void => {
    const len = [...str].length;
    put(xRight - len + 1, y, str, st, len);
  };
  const wrap = (x: number, y: number, w: number, maxLines: number, lines: string[], fg: Hex): number => {
    const out: string[] = [];
    for (const line of lines) {
      let cur = '';
      for (const word of line.split(' ')) {
        const next = cur ? `${cur} ${word}` : word;
        if ([...next].length > w && cur) { out.push(cur); cur = `  ${word}`; } else cur = next;
      }
      out.push(cur);
    }
    if (out.length > maxLines) clipped.push(...out.slice(maxLines));
    out.slice(0, maxLines).forEach((l, k) => put(x, y + k, l, { fg }, w));
    return y + Math.min(out.length, maxLines);
  };

  c.fill(0, 0, W, H, ' ', { bg: t.bg });
  c.fill(1, 2, W - 2, H - 4, ' ', { bg: panel });

  // header band (outside the frame) and footer band
  c.fill(0, 0, W, 1, ' ', { bg: t.headBg });
  let hx = put(2, 0, '◆ dexterm', { fg: t.borderFocus, bg: t.headBg, b: true }, 12);
  put(hx + 1, 0, '· PnL card', { fg: t.muted, bg: t.headBg }, 12);
  putR(W - 3, 0, fmtWhen(s.now), { fg: t.dim, bg: t.headBg });
  c.fill(0, H - 1, W, 1, ' ', { bg: t.headBg });
  put(2, H - 1, aspect === 'wide' ? 'not financial advice · trading in trenchscope is experimental · from recorded fills' : 'not financial advice · trading in trenchscope is experimental', { fg: t.muted, bg: t.headBg }, W - 16);
  putR(W - 3, H - 1, DEXTERM_URL, { fg: t.borderFocus, bg: t.headBg, b: true });

  // frame in the stamp colour (rows 1 .. H-2)
  const fc = mix(t.bg, stamp.color, 0.6);
  for (let x = 0; x < W; x++) { c.put(x, 1, '━', { fg: fc, bg: t.bg }); c.put(x, H - 2, '━', { fg: fc, bg: t.bg }); }
  for (let y = 1; y < H - 1; y++) { c.put(0, y, '┃', { fg: fc, bg: t.bg }); c.put(W - 1, y, '┃', { fg: fc, bg: t.bg }); }
  c.put(0, 1, '┏', { fg: fc, bg: t.bg }); c.put(W - 1, 1, '┓', { fg: fc, bg: t.bg }); c.put(0, H - 2, '┗', { fg: fc, bg: t.bg }); c.put(W - 1, H - 2, '┛', { fg: fc, bg: t.bg });

  const up = s.pnlSol >= 0;
  const pnlColor = up ? t.up : t.down;
  const sym = `$${cleanText(s.input.symbol, 12) || '?'}`;
  const name = cleanText(s.input.name ?? '', 40);
  const walletLine = s.input.wallet
    ? (o.showWallet ? `wallet ${short(s.input.wallet)}` : 'wallet hidden')
    : s.input.source === 'paper' ? 'paper wallet (simulated)' : 'wallet hidden';
  const idLine = `mint ${short(s.input.mint)} · ${walletLine}`;
  const label = `${up ? '▲' : '▼'} ${s.kind.toUpperCase()} PnL`;
  const sub = o.exactSize
    ? `${signedSol(s.pnlSol)} on ${s.costInSol.toFixed(4)} SOL in${s.unrealizedSol !== null ? ` (realized ${signedSol(s.realizedSol)})` : ''}`
    : 'return on SOL spent · net of fees · size shown as a band';
  const dec = s.input.decimals !== null;
  const px = (p: number | null) => (p === null ? (dec ? '—' : 'n/a (decimals unknown)') : `${fmtPriceBare(p)} SOL`);
  const stats: [string, string][] = [
    ['ENTRY avg', px(s.entryAvg)],
    s.open ? ['MARK', px(s.input.mark?.priceSol ?? null)] : ['EXIT avg', px(s.exitAvg)],
    ['HOLD', `${fmtHold(s.holdMs)}${s.open ? ' (open)' : ''}`],
    ['SIZE', o.exactSize ? `${s.costInSol.toFixed(4)} SOL in` : `${sizeBand(s.costInSol)} (band)`],
    ['FILLS', `${s.buys} buy${s.buys === 1 ? '' : 's'} · ${s.sells} sell${s.sells === 1 ? '' : 's'}`],
    ['OPENED', fmtWhen(s.firstT)],
    ['CLOSED', s.open ? 'still open' : fmtWhen(s.lastT)],
  ];
  const prov = [...provenance(s, o, 'card'), stamp.note];

  const coinTile = (x: number, y: number, w: number, h: number): void => {
    if (s.input.image && s.input.image.w > 0 && s.input.image.h > 0) {
      c.fill(x, y, w, h, ' ', { bg: panel });
      c.images.push({ x, y, w, h, key: 'pnl-coin', img: s.input.image });
    } else {
      const tile = mix(panel, t.accent, 0.16);
      c.fill(x, y, w, h, ' ', { bg: tile });
      big.push({ x, y, w, h, text: (cleanText(s.input.symbol, 2) || '?').slice(0, 1).toUpperCase(), fg: t.accent, bg: tile, align: 'center' });
    }
  };
  const stampBlock = (x: number, y: number, w: number, h: number): void => {
    c.fill(x, y, w, h, ' ', { bg: stamp.color });
    big.push({ x: x + 2, y, w: w - 4, h: h - 1, text: stamp.big, fg: '#000000', bg: stamp.color, align: 'center' });
    const len = [...stamp.line].length;
    put(x + Math.max(0, Math.floor((w - len) / 2)), y + h - 1, stamp.line, { fg: '#000000', bg: stamp.color, b: true }, w);
  };
  const strip = (y: number): void => {
    const bg = mix(panel, stamp.color, 0.2);
    c.fill(1, y, W - 2, 1, ' ', { bg });
    const unit = `◈ ${stamp.strip}  `;
    let x = 2;
    while (x + [...unit].length <= W - 2) { c.text(x, y, unit, { fg: stamp.color, bg, b: true }); x += [...unit].length; }
  };
  const statRows = (x: number, y: number, rows: [string, string][], w: number): void => {
    rows.forEach(([k, v], i) => { put(x, y + i, k.padEnd(11), { fg: t.dim }, 11); put(x + 11, y + i, v, { fg: t.text, b: true }, w - 11); });
  };

  let stampRect: CardRender['stampRect'];
  if (aspect === 'wide') {
    stampRect = { x: 62, y: 3, w: 35, h: 5 };
    stampBlock(stampRect.x, stampRect.y, stampRect.w, stampRect.h);
    coinTile(3, 3, 8, 4);
    c.fill(13, 3, 47, 2, ' ', { bg: panel });
    big.push({ x: 13, y: 3, w: 47, h: 2, text: sym, fg: t.text, bg: panel, align: 'left' });
    put(13, 5, name || ' ', { fg: t.muted }, 47);
    put(13, 6, idLine, { fg: t.dim }, 47);
    c.hline(2, 8, W - 4, { fg: t.border, bg: panel });
    put(3, 9, label, { fg: pnlColor, b: true }, 56);
    c.fill(3, 10, 56, 6, ' ', { bg: panel });
    big.push({ x: 3, y: 10, w: 56, h: 6, text: fmtPnlPct(s.pnlPct), fg: pnlColor, bg: panel, align: 'left' });
    put(3, 16, sub, { fg: t.muted }, 56);
    statRows(62, 9, stats, 35);
    c.hline(2, 17, W - 4, { fg: t.border, bg: panel });
    wrap(3, 18, W - 6, 6, prov, t.muted);
    strip(H - 3);
  } else {
    stampRect = { x: 3, y: 3, w: W - 6, h: 6 };
    stampBlock(stampRect.x, stampRect.y, stampRect.w, stampRect.h);
    coinTile(3, 11, 8, 4);
    c.fill(13, 11, W - 16, 2, ' ', { bg: panel });
    big.push({ x: 13, y: 11, w: W - 16, h: 2, text: sym, fg: t.text, bg: panel, align: 'left' });
    put(13, 13, name || ' ', { fg: t.muted }, W - 16);
    put(13, 14, idLine, { fg: t.dim }, W - 16);
    c.hline(2, 16, W - 4, { fg: t.border, bg: panel });
    put(3, 17, label, { fg: pnlColor, b: true }, W - 6);
    c.fill(3, 18, W - 6, 7, ' ', { bg: panel });
    big.push({ x: 3, y: 18, w: W - 6, h: 7, text: fmtPnlPct(s.pnlPct), fg: pnlColor, bg: panel, align: 'center' });
    put(3 + Math.max(0, Math.floor((W - 6 - [...sub].length) / 2)), 25, sub, { fg: t.muted }, W - 6);
    c.hline(2, 27, W - 4, { fg: t.border, bg: panel });
    statRows(3, 28, stats.slice(0, 4), 41);
    statRows(46, 28, stats.slice(4), 41);
    c.hline(2, 33, W - 4, { fg: t.border, bg: panel });
    wrap(3, 34, W - 6, 7, prov, t.muted);
    strip(H - 3);
  }
  // texture last: a sparse, dim code sprinkle (the cyberspace look) only in cells with blank neighbours, never in a
  // big-text rect, so it can never touch or be read as part of a label or a number
  const inBig = (x: number, y: number) => big.some((b) => x >= b.x - 1 && x < b.x + b.w + 1 && y >= b.y && y < b.y + b.h);
  const blank = (x: number, y: number) => x < 1 || x >= W - 1 || c.ch[c.idx(x, y)] === ' ';
  const code = `${s.input.mint}0123456789abcdef`;
  const fx = mix(panel, t.rain[1], 0.55);
  for (let y = 2; y < H - 2; y++) for (let x = 1; x < W - 1; x++) {
    if (hash(x, y, 1407) >= 0.045 || c.bg[c.idx(x, y)] !== panel || inBig(x, y)) continue;
    let clear = true;
    for (let dx = -2; dx <= 2 && clear; dx++) if (!blank(x + dx, y)) clear = false;
    if (clear) c.put(x, y, code[Math.floor(hash(y, x, 7) * code.length)], { fg: fx, bg: panel, soft: true });
  }
  return { aspect, canvas: c, big, clipped, stampRect, stamp };
}

/** The largest integer font scale at which `text` fits a w×h px box (glyph cell 6s × 10s); 0 = does not fit. */
export function fitScale(text: string, wPx: number, hPx: number): number {
  const n = Math.max(1, [...text].length);
  return Math.max(0, Math.min(Math.floor(wPx / (6 * n)), Math.floor(hPx / 10)));
}

/** Rasterize a card render to exact-size RGBA: the cell canvas, then each big text pasted at its fitted scale. */
export function cardPixels(r: CardRender): { w: number; h: number; rgba: Uint8Array; scales: number[] } {
  const g = CARD_GEOMETRY[r.aspect];
  const base = rasterizeCanvas(r.canvas, { cellW: g.cellW, cellH: g.cellH, scale: 2 });
  const scales: number[] = [];
  for (const b of r.big) {
    const rw = b.w * g.cellW, rh = b.h * g.cellH;
    const s = fitScale(b.text, rw, rh);
    scales.push(s);
    if (s < 1) { r.clipped.push(b.text); continue; }
    const n = [...b.text].length;
    const mini = new Canvas(n, 1, r.canvas.theme);
    mini.fill(0, 0, n, 1, ' ', { bg: b.bg });
    mini.text(0, 0, b.text, { fg: b.fg, bg: b.bg, b: true });
    const img = rasterizeCanvas(mini, { cellW: 6 * s, cellH: 10 * s, scale: s });
    const ox = b.x * g.cellW + (b.align === 'center' ? Math.floor((rw - img.w) / 2) : 0);
    const oy = b.y * g.cellH + Math.floor((rh - img.h) / 2);
    for (let y = 0; y < img.h; y++) {
      const dy = oy + y;
      if (dy < 0 || dy >= base.h) continue;
      const src = y * img.w * 4, dst = (dy * base.w + ox) * 4;
      base.rgba.set(img.rgba.subarray(src, src + Math.min(img.w, base.w - ox) * 4), dst);
    }
  }
  return { w: base.w, h: base.h, rgba: base.rgba, scales };
}

export function cardPng(s: CardStats, o: CardOptions = {}): Buffer {
  const px = cardPixels(renderCard(s, o));
  return encodePng({ w: px.w, h: px.h, rgba: px.rgba } as Parameters<typeof encodePng>[0]);
}

/** The terminal preview: the card canvas with the big texts written at cell size (bold), centred in their rects. */
export function previewCanvas(r: CardRender): Canvas {
  const c = new Canvas(r.canvas.w, r.canvas.h, r.canvas.theme);
  c.copyFrom(r.canvas);
  c.images.length = 0;
  for (const b of r.big) {
    const len = [...b.text].length;
    const x = b.align === 'center' ? b.x + Math.max(0, Math.floor((b.w - len) / 2)) : b.x;
    c.text(x, b.y + Math.floor((b.h - 1) / 2), b.text, { fg: b.fg, bg: b.bg, b: true }, b.w);
  }
  return c;
}

// ------------------------------------------------------------------------------------------------ text + share text

/** "Copy as text": the same facts as the PNG, plain. */
export function cardText(s: CardStats, o: CardOptions = {}): string {
  const st = stampOf(s, THEMES.cyberspace);
  const L: string[] = [];
  L.push(`trenchscope PnL card · ${st.big}${s.input.source === 'tracked' ? ' WALLET' : ''} (${st.line.toLowerCase()})`);
  L.push(`$${cleanText(s.input.symbol, 12)}${s.input.name ? ` · ${cleanText(s.input.name, 40)}` : ''} · mint ${short(s.input.mint)}${s.input.wallet ? ` · ${o.showWallet ? `wallet ${s.input.wallet}` : 'wallet hidden'}` : ''}`);
  L.push(`${s.kind} PnL ${fmtPnlPct(s.pnlPct)} (net of fees)${o.exactSize ? ` · ${signedSol(s.pnlSol)} on ${s.costInSol.toFixed(4)} SOL in` : ` · size ${sizeBand(s.costInSol)} (band)`}`);
  const dec = s.input.decimals !== null;
  const p = (v: number | null) => (v === null ? (dec ? '—' : 'n/a') : `${fmtPriceBare(v)} SOL`);
  L.push(`entry avg ${p(s.entryAvg)} · ${s.open ? `mark ${p(s.input.mark?.priceSol ?? null)}` : `exit avg ${p(s.exitAvg)}`} · hold ${fmtHold(s.holdMs)}${s.open ? ' (open)' : ''} · ${s.buys} buys · ${s.sells} sells`);
  L.push(...provenance(s, o));
  L.push(st.note + ' Trading in trenchscope is experimental.');
  L.push(`not financial advice · ${DEXTERM_URL}`);
  return L.join('\n') + '\n';
}

/**
 * The default X compose text. Neutral by rule (dexterm/marketing/GUARDRAILS.md): no coin, ticker or address, no
 * price, PnL or return talk, no performance claim, and the stamp in words. The user can edit it in X before posting.
 */
export function shareText(source: CardSource): string {
  const what = source === 'paper' ? 'PAPER: simulated, no real funds.' : source === 'live' ? 'LIVE: from my own wallet-signed transactions.' : 'TRACKED WALLET: a read-only view of a public wallet.';
  return `Made this card in dexterm, a terminal for Solana. ${what} Not financial advice. https://${DEXTERM_URL}`;
}

/** X's compose intent for the user's own browser. Only the text parameter; nothing is posted by dexterm. */
export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

// ------------------------------------------------------------------------------------------------ save + share

export type ShareAction = 'x' | 'text' | 'save';

export interface ShareDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Run a local command (no shell); resolves true on exit 0. `stdinFile` is piped in when given. */
  run: (cmd: string, args: string[], stdinFile?: string) => Promise<boolean>;
  /** Open a URL in the user's browser (main.ts openInBrowser: http/https only). */
  openUrl: (url: string) => boolean;
  /** Copy text to the clipboard (main.ts copyToClipboard). */
  copyText: (text: string) => void;
  now?: number;
  dir?: string;
}

export interface ShareResult {
  files: { wide: string; square: string; txt: string };
  clipboard: 'image' | 'text' | 'unsupported' | 'failed' | null;
  opened: string | null;
  message: string;
}

/** The OS command that puts a PNG file on the clipboard, or null where trenchscope has none (then the file is the way). */
export function imageClipboardCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, path: string): { cmd: string; args: string[]; stdinFile?: string } | null {
  if (platform === 'darwin') {
    // the path is an argv item, never interpolated into the AppleScript source
    return { cmd: 'osascript', args: ['-e', 'on run argv', '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)', '-e', 'end run', path] };
  }
  if (platform === 'linux') {
    if (env.WAYLAND_DISPLAY) return { cmd: 'wl-copy', args: ['--type', 'image/png'], stdinFile: path };
    if (env.DISPLAY) return { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-i', path] };
  }
  return null;
}

/** Default `run`: spawn without a shell, 5 s cap, true on exit 0. */
export function runLocal(cmd: string, args: string[], stdinFile?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const p = spawn(cmd, args, { stdio: [stdinFile ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } done(false); }, 5000);
      timer.unref?.();
      p.on('error', () => { clearTimeout(timer); done(false); });
      p.on('exit', (code) => { clearTimeout(timer); done(code === 0); });
      if (stdinFile && p.stdin) {
        p.stdin.on('error', () => {});
        import('node:fs').then(({ createReadStream }) => createReadStream(stdinFile).on('error', () => done(false)).pipe(p.stdin!));
      }
    } catch { done(false); }
  });
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 16) || 'coin';
function stampOfNow(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write both PNGs and the text card to ~/.dexterm/exports (dir 0700, files 0600). Local files only. */
export function saveCard(s: CardStats, o: CardOptions, opts: { dir?: string; env?: NodeJS.ProcessEnv; now?: number } = {}): ShareResult['files'] {
  const dir = opts.dir ?? exportsDir(opts.env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = join(dir, `dexterm-pnl-${s.input.source}-${slug(s.input.symbol)}-${stampOfNow(opts.now ?? s.now)}`);
  const files = { wide: `${base}-16x9.png`, square: `${base}-1x1.png`, txt: `${base}.txt` };
  writeFileSync(files.wide, cardPng(s, { ...o, aspect: 'wide' }), { mode: 0o600 });
  writeFileSync(files.square, cardPng(s, { ...o, aspect: 'square' }), { mode: 0o600 });
  writeFileSync(files.txt, cardText(s, o), { mode: 0o600 });
  return files;
}

/**
 * The three share actions. `save` writes the files. `text` also copies the text card. `x` also copies the 16:9 image
 * to the clipboard (where the OS allows) and opens X's compose intent with the neutral text in the user's browser.
 * Nothing is posted, uploaded or sent by dexterm; the user attaches the image and posts it themselves.
 */
export async function shareCard(s: CardStats, o: CardOptions, action: ShareAction, deps: ShareDeps): Promise<ShareResult> {
  const files = saveCard(s, o, { dir: deps.dir, env: deps.env, now: deps.now });
  const home = deps.env.HOME;
  const shown = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  if (action === 'save') return { files, clipboard: null, opened: null, message: `saved ${shown(files.wide)} (+1:1, +.txt) · local only, nothing uploaded` };
  if (action === 'text') {
    deps.copyText(cardText(s, o));
    return { files, clipboard: 'text', opened: null, message: `card text copied · saved ${shown(files.wide)} · nothing uploaded` };
  }
  const cmd = imageClipboardCommand(deps.platform, deps.env, files.wide);
  let clipboard: ShareResult['clipboard'] = 'unsupported';
  if (cmd) clipboard = (await deps.run(cmd.cmd, cmd.args, cmd.stdinFile)) ? 'image' : 'failed';
  const url = xIntentUrl(shareText(s.input.source));
  const opened = deps.openUrl(url) ? url : null;
  const how = clipboard === 'image' ? 'image copied: paste it into the post' : `attach ${shown(files.wide)}`;
  return {
    files, clipboard, opened,
    message: opened ? `X compose opened in your browser · ${how} · you post it, trenchscope posts nothing` : `could not open the browser · ${how} · compose: ${url}`,
  };
}
