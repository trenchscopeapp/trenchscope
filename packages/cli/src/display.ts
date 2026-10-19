// trenchscope — the price display mode (task-1366): show USD price or MARKET CAP on every screen and both charts.
//
// A DISPLAY mode only. Market cap = price × supply, where the supply is what the data layer already reports
// (the row's mcap / price at the latest tick: the "supply ratio"). Historical candles are scaled by the CURRENT
// ratio, so every mcap axis says `mcap (current supply)`: a burn or a mint since that candle is not reflected,
// and nobody should read it as exact historical market cap. When a token has no usable supply (mcap or price
// missing / zero), the screen falls back to price and SAYS so; it never invents a number.
//
// No network calls, nothing here is read by the signer, the caps, tickets, plans or the confirm gate.
import { fmtMcap, fmtMcapBare, fmtPrice } from '@dexterm/tui';
import { applyAndJournal, configPath, dextermHome, loadConfig, DEFAULT_PRICE_MODE, PRICE_MODES, type PriceMode } from '@dexterm/custom';
import type { AppState } from './state.ts';
import type { OrderPlan, Trigger } from '@dexterm/data/plans';

export type { PriceMode };
export { PRICE_MODES, DEFAULT_PRICE_MODE };

/** Axis / caption label for an mcap chart: the history is scaled by today's supply, and says so. */
export const MCAP_AXIS_LABEL = 'mcap (current supply)';
/** Shown wherever mcap mode is on but a token's supply is unknown, so the number on screen is a price. */
export const MCAP_FALLBACK_NOTE = 'supply unknown · showing price';
/** Short per-cell marker for a price shown in an MCAP column (fallback). */
export const FALLBACK_MARK = 'ᵖ';

export function isPriceMode(v: unknown): v is PriceMode { return (PRICE_MODES as readonly unknown[]).includes(v); }

/**
 * Supply ratio = mcap / price at the latest tick (i.e. the circulating supply the source used). Null when either
 * side is missing, non-finite or ≤ 0: the caller must fall back to price and say so.
 */
export function supplyRatio(price: number | null | undefined, mcap: number | null | undefined): number | null {
  if (price == null || mcap == null || !Number.isFinite(price) || !Number.isFinite(mcap) || price <= 0 || mcap <= 0) return null;
  const r = mcap / price;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/** A price expressed as market cap with the given supply ratio (null ratio or price → null). */
export function mcapAt(price: number | null | undefined, ratio: number | null): number | null {
  if (price == null || ratio == null || !Number.isFinite(price)) return null;
  return price * ratio;
}

/** What one token shows in a price slot under the current mode. */
export interface PriceCell {
  /** The text to draw. */
  text: string;
  /** 'mcap' = a market cap; 'price' = a USD price (price mode, or the mcap-mode fallback). */
  kind: 'mcap' | 'price';
  /** true when mcap mode is on but this token had no supply, so `text` is a price. */
  fallback: boolean;
}

/** Format a token's price slot: market cap in mcap mode when known, otherwise the price (flagged as a fallback). */
export function priceCell(mode: PriceMode, price: number | null | undefined, mcap: number | null | undefined): PriceCell {
  if (mode === 'mcap') {
    if (mcap != null && Number.isFinite(mcap) && mcap > 0) return { text: fmtMcap(mcap), kind: 'mcap', fallback: false };
    return { text: price == null ? '—' : fmtPrice(price), kind: 'price', fallback: price != null };
  }
  return { text: fmtPrice(price), kind: 'price', fallback: false };
}

/** "mcap $1.2M ($0.0₄123)": both numbers, for headers, tickets and tooltips. Price only when the supply is unknown. */
export function mcapWithPrice(price: number | null | undefined, mcap: number | null | undefined): string {
  if (mcap != null && Number.isFinite(mcap) && mcap > 0) return price != null ? `mcap ${fmtMcap(mcap)} (${fmtPrice(price)})` : `mcap ${fmtMcap(mcap)}`;
  return price != null ? `${fmtPrice(price)} · ${MCAP_FALLBACK_NOTE}` : '—';
}

/**
 * mcap mode for a table: the MCAP column takes the PRICE column's place AND priority (it is the headline number now)
 * and PRICE moves to MCAP's old slot, so both stay on screen and every sort key keeps working. Price mode: unchanged.
 */
export function promoteMcap<C extends { key: string; prio: number }>(cols: C[], mode: PriceMode): C[] {
  if (mode !== 'mcap') return cols;
  const i = cols.findIndex((c) => c.key === 'price');
  const j = cols.findIndex((c) => c.key === 'mcap');
  if (i < 0 || j < 0) return cols;
  const out = cols.slice();
  out[i] = { ...cols[j], prio: cols[i].prio };
  out[j] = { ...cols[i], prio: cols[j].prio };
  return out;
}

/** How many rows show a price in the MCAP column because their supply is unknown (for the panel caption). */
export function fallbackCount<R>(rows: readonly R[], get: (r: R) => { price: number | null | undefined; mcap: number | null | undefined }): number {
  let n = 0;
  for (const r of rows) { const v = get(r); if (priceCell('mcap', v.price, v.mcap).fallback) n++; }
  return n;
}

/** Caption segment for a table in mcap mode with fallback rows (null when there are none). */
export function fallbackCaption(n: number): string | null {
  return n > 0 ? `${FALLBACK_MARK} ${n} price${n > 1 ? 's' : ''} (supply unknown)` : null;
}

/** How a chart draws under the mode: the candle multiplier, the axis formatter, and what the title must say. */
export interface ChartMode {
  /** Multiply o/h/l/c by this (null = draw prices). */
  scale: number | null;
  axisFmt: ((n: number) => string) | undefined;
  /** 'mcap' only when a supply is known. */
  kind: 'price' | 'mcap';
  /** Title fragment: `mcap (current supply)` in mcap mode, the fallback note when the supply is unknown, else null. */
  label: string | null;
}

/** The chart scale for a token: mcap mode with a known supply scales by the CURRENT supply ratio, else prices (+ a note). */
export function chartMode(mode: PriceMode, price: number | null | undefined, mcap: number | null | undefined): ChartMode {
  if (mode !== 'mcap') return { scale: null, axisFmt: undefined, kind: 'price', label: null };
  const ratio = supplyRatio(price, mcap);
  if (ratio === null) return { scale: null, axisFmt: undefined, kind: 'price', label: MCAP_FALLBACK_NOTE };
  return { scale: ratio, axisFmt: fmtMcapBare, kind: 'mcap', label: MCAP_AXIS_LABEL };
}

/**
 * One plan level with BOTH numbers, in the order the mode prefers: mcap mode `mc ≤ $300K ($0.0003)`, price mode
 * `≤ $0.0003 (mc $300K)`. The price of a market-cap trigger is mc / the plan's OWN supply snapshot (supplyAtProposal,
 * the supply its triggers were read back against), so the preview never re-derives what the plan means.
 */
export function triggerLevel(t: Trigger, supply: number, mode: PriceMode): string {
  if (t.kind === 'immediate') return 'now';
  const below = t.kind === 'mc-below' || t.kind === 'price-below';
  const op = below ? '≤' : '≥';
  const okSupply = Number.isFinite(supply) && supply > 0;
  const mc = t.kind.startsWith('mc-') ? t.value : okSupply ? t.value * supply : null;
  const px = t.kind.startsWith('price-') ? t.value : okSupply ? t.value / supply : null;
  if (mode === 'mcap') return `mc ${op} ${mc === null ? '—' : fmtMcap(mc)}${px === null ? '' : ` (${fmtPrice(px)})`}`;
  return `${op} ${px === null ? '—' : fmtPrice(px)}${mc === null ? '' : ` (mc ${fmtMcap(mc)})`}`;
}

/** The order-plan preview line: entry · each take-profit · stop, each with market cap AND price. Display only. */
export function planLevels(plan: Pick<OrderPlan, 'entry' | 'exits' | 'stop' | 'supplyAtProposal'>, mode: PriceMode): string {
  const s = plan.supplyAtProposal;
  const parts = [`entry ${triggerLevel(plan.entry, s, mode)}`];
  for (const e of plan.exits) parts.push(`TP ${Math.round(e.fraction * 100)}% ${triggerLevel(e.at, s, mode)}`);
  if (plan.stop) parts.push(`stop ${triggerLevel(plan.stop, s, mode)}`);
  return parts.join(' · ');
}

/**
 * A held position's AVG / PRICE cells: with a supply (mcap mode, supply known) they read market cap — `AVG MC` is the
 * average entry price × the CURRENT supply — else the existing price text (marked ᵖ when mcap mode had no supply).
 * PnL and value cells are not touched: they stay USD / SOL.
 */
export function positionPriceCells(mode: PriceMode, supply: number | null, avgUsd: number | null, priceUsd: number | null, avgText: string, priceText: string): { avg: { label: string; value: string }; price: { label: string; value: string } } {
  if (mode === 'mcap' && supply !== null && supply > 0) {
    return {
      avg: { label: 'AVG MC', value: avgUsd !== null ? fmtMcap(avgUsd * supply) : avgText === '—' ? '—' : avgText + FALLBACK_MARK },
      price: { label: 'MCAP', value: priceUsd !== null ? fmtMcap(priceUsd * supply) : priceText === '—' ? '—' : priceText + FALLBACK_MARK },
    };
  }
  const mark = mode === 'mcap' ? FALLBACK_MARK : '';
  return { avg: { label: 'AVG ENTRY', value: avgText === '—' ? avgText : avgText + mark }, price: { label: 'PRICE', value: priceText === '—' ? priceText : priceText + mark } };
}

/** The mode in effect: the state's (set from config, a workspace or `$`), default price. */
export function priceModeOf(state: Pick<AppState, 'priceMode'> | null | undefined): PriceMode {
  return state?.priceMode === 'mcap' ? 'mcap' : 'price';
}

/** The mode a run starts in: config.display.priceMode, else price. */
export function configPriceMode(cfg: { display?: { priceMode?: unknown } } | null | undefined): PriceMode {
  const m = cfg?.display?.priceMode;
  return isPriceMode(m) ? m : DEFAULT_PRICE_MODE;
}

/**
 * `$`: flip the mode and persist it to config.display.priceMode through the journal (actor user, so `undo` works).
 * Returns the notice for the toast. Persistence failure keeps the new mode for this run and says why.
 */
export function togglePriceMode(state: AppState): string {
  const next: PriceMode = priceModeOf(state) === 'mcap' ? 'price' : 'mcap';
  state.priceMode = next;
  const what = next === 'mcap' ? `showing MARKET CAP · charts: ${MCAP_AXIS_LABEL}` : 'showing USD PRICE';
  const ui = state.custom;
  if (!ui) return `${what} (not saved: no config on this run)`;
  try {
    const op = ui.config.display ? { op: 'add' as const, path: '/display/priceMode', value: next } : { op: 'add' as const, path: '/display', value: { priceMode: next } };
    const { config } = applyAndJournal(ui.home, [op], { actor: 'user', why: `$ price mode ${next}`, now: state.now.getTime() });
    ui.config = config;
    return `${what} · saved ($ to switch back)`;
  } catch (e) {
    return `${what} (not saved: ${(e as Error).message})`;
  }
}

export interface DisplayIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv }
export const DISPLAY_USAGE = 'usage: trenchscope display [price|mcap]   show or set display.priceMode in ~/.dexterm/config.json ($ in the app toggles it)';

/** `trenchscope display [price|mcap]`: print the saved price display mode, or set it (journaled, actor user). No network. */
export function displayCommand(argv: string[], io: DisplayIo): number {
  const home = dextermHome(io.env);
  const [arg] = argv;
  const loaded = loadConfig(home);
  if (arg === undefined) {
    if (!loaded.ok) { io.stderr.write(`trenchscope display: ${loaded.errors[0]}\n`); return 1; }
    const m = configPriceMode(loaded.config);
    io.stdout.write(`display.priceMode = ${m}${m === 'mcap' ? ` (tables show MCAP; charts: ${MCAP_AXIS_LABEL}; tokens without a supply fall back to price)` : ' (USD price per token)'}\n`);
    return 0;
  }
  if (!isPriceMode(arg)) { io.stderr.write(`trenchscope display: unknown mode ${JSON.stringify(arg.slice(0, 20))}\n${DISPLAY_USAGE}\n`); return 2; }
  try {
    const op = loaded.config.display ? { op: 'add' as const, path: '/display/priceMode', value: arg } : { op: 'add' as const, path: '/display', value: { priceMode: arg } };
    applyAndJournal(home, [op], { actor: 'user', why: `trenchscope display ${arg}` });
  } catch (e) { io.stderr.write(`trenchscope display: ${(e as Error).message}\n`); return 1; }
  io.stdout.write(`display.priceMode = ${arg} (saved to ${configPath(home)})\n`);
  return 0;
}
