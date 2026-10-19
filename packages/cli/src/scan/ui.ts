// trenchscope AI SCAN MODE (task-1324) — per-run scan UI state and the two one-line strips it draws on
// row 1 (the blank band under the header, so no screen layout moves):
//   - list screens: the SCANNING ticker — state, coins scanned, the top scores with their triggers;
//   - the locked coin's token screen: WHY IT TRIGGERED — reasons, score, when, reads, next read, keys.
// Rendering only; the decisions live in engine.ts and the loop in main.ts.
import { clock, mix, type Canvas, type Hex, type ScreenKey } from '@dexterm/tui';
import { cleanText } from '../screener/rows.ts';
import { ScanEngine, type ScanConfig, type ScanMode, type TriggerId } from './engine.ts';

/** How often the loop runs a scan tick, and the forced recompute when inputs did not change. */
export const SCAN_TICK_MS = 2_000;
export const SCAN_RECOMPUTE_MS = 10_000;

/** The analyst UI actions a scan session may request: NONE (observe-only). */
export const SCAN_ACTION_TYPES: readonly string[] = Object.freeze([]);

/** The slice of an AnalystSession the scan needs (keeps this module free of the analyst runtime). */
export interface ScanSessionRef { readonly busy: boolean; interrupt(): boolean; cancel(): void; ask(question: string, screenState?: Record<string, unknown>, display?: string): void }

export interface ScanUi {
  engine: ScanEngine;
  /** Signature of the inputs at the last observe() (observe.ts observeSig). */
  sig: string;
  lastTickAt: number;
  lastComputeAt: number;
  /** The scan's analyst conversation for the locked coin. */
  session: ScanSessionRef | null;
  /** Analyst UI actions this scan refused (observe-only), newest last. */
  blocked: string[];
  /** The screen the lock pulled the user away from (resume returns there). */
  returnTo: ScreenKey | null;
}

export function makeScanUi(cfg: Partial<ScanConfig> = {}): ScanUi {
  return { engine: new ScanEngine(cfg), sig: '', lastTickAt: 0, lastComputeAt: 0, session: null, blocked: [], returnTo: null };
}

export const MODE_LABEL: Record<ScanMode, string> = { off: 'OFF', scanning: 'SCANNING', locked: 'LOCKED', paused: 'PAUSED' };
const SHORT: Record<TriggerId, string> = { vol: 'vol', flow: 'flow', fresh: 'fresh', breakout: 'brk', liq: 'liq', holders: 'hold' };

/** `◉ SCAN LOCKED $WIF` — the header's running indicator (state.ts headerModel). */
export function scanIndicator(scan: ScanUi): string {
  const e = scan.engine;
  const sym = e.lock ? ` $${cleanText(e.lock.symbol, 12)}` : '';
  return `◉ AI SCAN ${MODE_LABEL[e.mode]}${sym}`;
}

function band(c: Canvas): Hex {
  const t = c.theme;
  const bg = mix(t.bg, t.ai, 0.14);
  c.fill(0, 1, c.w, 1, ' ', { bg });
  c.noRain(0, 1, c.w, 1);
  return bg;
}

/** The SCANNING ticker on row 1 of the list screens. `ai` = the meter text (`ai 1/8 per h`). */
export function renderScanTicker(c: Canvas, scan: ScanUi, ai: string): void {
  const e = scan.engine;
  if (!e.on) return;
  const t = c.theme;
  const bg = band(c);
  const end = c.w - 1;
  let x = c.text(1, 1, '◉ AI SCAN ', { fg: t.ai, bg, b: true });
  x = c.text(x, 1, MODE_LABEL[e.mode], { fg: e.mode === 'scanning' ? t.up : t.warn, bg, b: true }, end - x);
  if (e.lock) x = c.text(x + 1, 1, `$${cleanText(e.lock.symbol, 12)} · read ${e.lock.reads}`, { fg: t.text, bg, b: true }, end - x - 1);
  x = c.text(x + 1, 1, `· ${e.scanned} coins`, { fg: t.muted, bg }, end - x - 1);
  const right = ` ${e.note ? e.note + ' · ' : ''}${ai} · ${e.mode === 'scanning' ? 'Z stop' : 'R resume · Z stop'} `;
  const rightX = Math.max(x + 2, end - right.length);
  if (!e.ticker.length) c.text(x + 2, 1, e.mode === 'scanning' ? 'watching… nothing scores yet' : '', { fg: t.dim, bg, i: true }, rightX - x - 3);
  for (const s of e.ticker) {
    if (x + 12 > rightX) break;
    x = c.text(x, 1, '  │ ', { fg: t.dim, bg }, rightX - x);
    x = c.text(x, 1, `$${cleanText(s.symbol, 10)} `, { fg: t.text, bg }, rightX - x);
    x = c.text(x, 1, String(s.score), { fg: s.exciting ? t.warn : t.muted, bg, b: s.exciting }, rightX - x);
    if (s.hits.length) x = c.text(x + 1, 1, s.hits.map((h) => SHORT[h.id]).join('·'), { fg: t.dim, bg }, rightX - x - 1);
  }
  c.text(rightX, 1, right, { fg: e.note && /cap/.test(e.note) ? t.warn : t.dim, bg }, end - rightX + 1);
}

/** WHY IT TRIGGERED on row 1 of the locked coin's token screen. */
export function renderScanWhy(c: Canvas, scan: ScanUi, _ai: string, now: number, timeZone?: string): void {
  const e = scan.engine;
  const lock = e.lock;
  if (!lock) return;
  const t = c.theme;
  const bg = band(c);
  const end = c.w - 1;
  let x = c.text(1, 1, '◉ AI SCAN ', { fg: t.ai, bg, b: true });
  x = c.text(x, 1, MODE_LABEL[e.mode], { fg: e.mode === 'locked' ? t.up : t.warn, bg, b: true });
  if (e.mode === 'paused') x = c.text(x + 1, 1, '· analysis cancelled', { fg: t.warn, bg });
  x = c.text(x + 1, 1, '· WHY IT TRIGGERED', { fg: t.ai, bg, b: true });
  x = c.text(x + 1, 1, clock(new Date(lock.at), timeZone), { fg: t.muted, bg });
  x = c.text(x + 1, 1, `· score ${lock.score}${lock.liveScore !== lock.score ? ` (now ${lock.liveScore})` : ''} ·`, { fg: t.warn, bg, b: true });
  const keys = e.mode === 'paused' ? 'R resume · Z stop' : 'esc cancel · R resume · Z stop';
  const sinceRead = Math.max(0, Math.round((now - lock.lastReadAt) / 1000));
  // The analyst meter is already in the header; the strip keeps the read status + keys short so the
  // reasons — the point of the strip — get the room.
  const right = `read ${lock.reads} (${sinceRead}s ago)${e.note ? ' · ' + e.note : ''} · ${keys}`;
  const room = Math.max(30, end - x - 3 - right.length);
  // Full reasons while they fit; the rest by trigger id so the user still sees every trigger that fired.
  let why = '';
  const rest: string[] = [];
  for (const h of lock.hits) {
    const next = why ? `${why} · ${h.reason}` : h.reason;
    if (!rest.length && next.length <= room) why = next; else rest.push(h.id);
  }
  if (rest.length) why = `${why}${why ? ' ' : ''}+ ${rest.join(', ')}`;
  const wx = c.text(x + 1, 1, why, { fg: t.text, bg }, room);
  const rx = Math.max(wx + 2, end - right.length);
  if (rx < end) c.text(rx, 1, right, { fg: t.dim, bg }, end - rx + 1);
}
