// trenchscope — EXPORT / SHARE (task-1401). One key (`E`) renders the current view to a PNG plus a plain-text report in
// ~/.dexterm/exports (DEXTERM_HOME overrides). Nothing is uploaded, posted or copied anywhere else.
//
// The renderer is reusable on purpose (task-1407 PNL cards build on it): give `renderExportPng` / `renderExportText`
// / `writeExport` an ExportView — any rendered Canvas plus its title, the data label (live / sample / replay) and the
// data ages — and it frames the view with a header band (title, the label, the export time) and a footer band (every
// data age, "nothing was uploaded"). The label is never optional: a sample-data frame always says SAMPLE DATA.
//
// The frame is rendered CALM (no rain, glitch or scanlines) with no toast, help card or prompt on top, so the PNG
// is the data, not an effect. PNGs are pure TypeScript (@dexterm/tui rasterize + @dexterm/data encodePng).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Canvas, rasterizeCanvas, fmtUsd, fmtPrice, fmtPct, type RasterOpts } from '@dexterm/tui';
import { encodePng } from '@dexterm/data';
import { dextermHome } from './boot-state.ts';
import { cleanText } from './screener/rows.ts';
import { rugP, fmtRugP, RUG_MODEL_LABEL } from './screener/rug.ts';
import { renderFrame, type AppState } from './state.ts';
import type { TokenView, Panel } from './live/token.ts';

export type DataLabel = 'live' | 'sample' | 'replay';

/** One data source's age on the exported view. `ageSec` null = no data (the `state` says why). */
export interface ExportAge { name: string; source: string | null; ageSec: number | null; state?: string | null }

/** Everything the exporter needs. `canvas` is any rendered frame (a screen, a card). */
export interface ExportView {
  /** Short kind for the filename: `token`, `screener`, `pnl`, ... */
  kind: string;
  /** Header title, e.g. `TOKEN · $ABC · Abc Coin`. Already firewalled/cleaned by the builder. */
  title: string;
  /** Full contract address when the view is about one coin. */
  mint?: string | null;
  label: DataLabel;
  canvas: Canvas;
  ages: ExportAge[];
  /** View-specific body lines of the text report. */
  report: string[];
}

export const LABEL_TEXT: Record<DataLabel, string> = {
  live: '● LIVE DATA',
  sample: '◌ SAMPLE DATA · not real prices',
  replay: '◌ REPLAY · recorded data',
};

/** `4s` / `3m` / `2h` / `5d`; `—` when unknown. */
export function fmtAge(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

const ageText = (a: ExportAge): string => (a.ageSec !== null ? `${a.name} ${fmtAge(a.ageSec)}` : `${a.name} ${a.state || 'n/a'}`);

/** Local timestamp `2026-10-16 01:23:45` (the machine's own clock; the report also carries the ISO time). */
function localStamp(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Wrap `parts` joined by ` · ` into lines of at most `w` columns. */
function wrapParts(prefix: string, parts: string[], w: number): string[] {
  const out: string[] = [];
  let line = prefix;
  for (const p of parts) {
    const add = line === prefix ? p : ` · ${p}`;
    if (line.length + add.length > w && line !== prefix) { out.push(line); line = ' '.repeat(prefix.length) + p; } else line += add;
  }
  out.push(line);
  return out;
}

/**
 * Frame a rendered view: a header band (title, label, export time), the view itself, and a footer band (every data
 * age, local-only note). Returns a new canvas; the view canvas is not changed.
 */
export function composeExportCanvas(v: ExportView, now: number): Canvas {
  const src = v.canvas;
  const w = Math.max(src.w, 60);
  const t = src.theme;
  const footer = [
    ...(v.mint ? [` contract ${v.mint}`] : []),
    ...wrapParts(v.label === 'replay' ? ' data ages (replay clock): ' : ' data ages: ', v.ages.length ? v.ages.map(ageText) : ['none reported for this view'], w - 1),
    ` exported locally by trenchscope ${localStamp(now)} · nothing was uploaded · not financial advice`,
  ];
  const c = new Canvas(w, src.h + 2 + footer.length, t);
  c.fill(0, 0, w, c.h, ' ', { bg: t.bg });
  // header band
  c.fill(0, 0, w, 1, ' ', { bg: t.headBg });
  const label = ` ${LABEL_TEXT[v.label]} `;
  const labelFg = v.label === 'live' ? t.up : t.warn;
  c.text(1, 0, `trenchscope export · ${v.title}`, { fg: t.text, bg: t.headBg, b: true }, Math.max(0, w - label.length - 3));
  c.textR(0, 0, w - 1, label, { fg: labelFg, bg: t.headBg, b: true });
  // the view
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const i = src.idx(x, y), j = c.idx(x, y + 1);
    c.ch[j] = src.ch[i]; c.fg[j] = src.fg[i]; c.bg[j] = src.bg[i]; c.at[j] = src.at[i]; c.hard[j] = src.hard[i];
  }
  for (const s of src.images) c.images.push({ ...s, y: s.y + 1 });
  c.imageMode = src.imageMode;
  // footer band
  const fy = src.h + 1;
  c.fill(0, fy, w, c.h - fy, ' ', { bg: t.headBg });
  footer.forEach((line, k) => c.text(0, fy + 1 + k, line, { fg: k === footer.length - 1 ? t.muted : t.text, bg: t.headBg }, w));
  c.text(0, fy, ` ${LABEL_TEXT[v.label]}`, { fg: labelFg, bg: t.headBg, b: true }, w);
  return c;
}

/** The PNG bytes of a framed view. */
export function renderExportPng(v: ExportView, now: number, opts: RasterOpts = {}): Buffer {
  const px = rasterizeCanvas(composeExportCanvas(v, now), opts);
  return encodePng({ w: px.w, h: px.h, rgba: px.rgba } as Parameters<typeof encodePng>[0]);
}

/** The plain-text report: header, label, ages, the view's own lines, the local-only note. */
export function renderExportText(v: ExportView, now: number): string {
  const L: string[] = [];
  L.push(`trenchscope export · ${v.title}`);
  if (v.mint) L.push(`contract    ${v.mint}`);
  L.push(`data        ${LABEL_TEXT[v.label]}`);
  L.push(`exported    ${localStamp(now)} (local time) · ${new Date(now).toISOString()}`);
  L.push(`data ages${v.label === 'replay' ? ' (on the replay clock)' : ''}`);
  if (!v.ages.length) L.push('  none reported for this view');
  for (const a of v.ages) L.push(`  ${a.name.padEnd(12)} ${(a.ageSec !== null ? fmtAge(a.ageSec) : a.state || 'n/a').padEnd(14)} ${a.source ?? ''}`.trimEnd());
  L.push('');
  L.push(...v.report);
  L.push('');
  L.push('Exported locally by dexterm. Nothing was uploaded. Model outputs are labelled as such. Not financial advice.');
  return L.join('\n') + '\n';
}

/** ~/.dexterm/exports (DEXTERM_HOME overrides). */
export function exportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dextermHome(env), 'exports');
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 16) || 'view';

/** Write `<dir>/dexterm-<kind>-<subject>-<stamp>.png` and `.txt` (dir 0700, files 0600). */
export function writeExport(v: ExportView, opts: { dir?: string; now?: number; env?: NodeJS.ProcessEnv; raster?: RasterOpts; subject?: string } = {}): { png: string; txt: string; bytes: number } {
  const now = opts.now ?? Date.now();
  const dir = opts.dir ?? exportsDir(opts.env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = localStamp(now).replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const base = join(dir, `dexterm-${slug(v.kind)}-${slug(opts.subject ?? v.mint?.slice(0, 6) ?? '')}-${stamp}`);
  const png = renderExportPng(v, now, opts.raster);
  writeFileSync(`${base}.png`, png, { mode: 0o600 });
  writeFileSync(`${base}.txt`, renderExportText(v, now), { mode: 0o600 });
  return { png: `${base}.png`, txt: `${base}.txt`, bytes: png.length };
}

// ------------------------------------------------------------------------------------------ view builders

const PANEL_NAMES: Record<Panel, string> = { market: 'market', candles: 'candles', authorities: 'authorities', holders: 'holders', rugcheck: 'rugcheck', goplus: 'goplus', trades: 'trades' };

/** Data ages of a live token view, one per panel, from each panel's own fetch time. */
export function tokenAges(v: TokenView, now: number): ExportAge[] {
  return (Object.keys(PANEL_NAMES) as Panel[]).map((p) => {
    const s = v.panels[p];
    const ok = s.fetchedAt !== null && (s.state === 'ok' || s.stale);
    return {
      name: PANEL_NAMES[p], source: s.via,
      ageSec: ok ? (now - (s.fetchedAt as number)) / 1000 : null,
      state: ok ? (s.stale ? 'stale' : null) : s.state === 'needs-key' ? 'needs key' : s.state === 'error' ? `unavailable${s.reason ? ` (${s.reason})` : ''}` : s.state,
    };
  });
}

const yesNo = (b: boolean | null): string => (b === null ? 'unknown' : b ? 'ENABLED' : 'revoked');

/** The text report body for a live token view: the numbers on screen, each from its panel. */
export function tokenReport(state: AppState, v: TokenView, now: number): string[] {
  const L: string[] = [];
  L.push(`coin        $${cleanText(v.symbol, 16)}${v.name ? ` · ${cleanText(v.name, 40)}` : ''} · ${v.launchpad}`);
  L.push(`price       ${fmtPrice(v.price)}   5m ${fmtPct(v.chg.m5)}   1h ${fmtPct(v.chg.h1)}   6h ${fmtPct(v.chg.h6)}   24h ${fmtPct(v.chg.h24)}`);
  L.push(`market cap  ${fmtUsd(v.mcap)}${v.mcapFlagged ? ' (flagged)' : ''}   liquidity ${fmtUsd(v.liq)}   vol 24h ${fmtUsd(v.vol24)}`);
  L.push(`holders     ${v.holders ?? '—'}   top-10 ${v.top10 === null ? '—' : `${v.top10.toFixed(1)}%`}   dev ${v.dev === null ? '—' : `${v.dev.toFixed(1)}%`}${v.holdersSample ? `   (${v.holdersSample})` : ''}`);
  L.push(`age         ${v.ageMin === null ? '—' : fmtAge(v.ageMin * 60)}`);
  L.push(`authorities mint ${yesNo(v.mintAuth)} · freeze ${yesNo(v.freezeAuth)}${v.riskyExtensions.length ? ` · risky extensions: ${v.riskyExtensions.join(', ')}` : ''}`);
  if (v.rug) L.push(`rugcheck    score ${v.rug.score ?? '—'} · ${v.rug.risks.length} risk${v.rug.risks.length === 1 ? '' : 's'}${v.rug.risks.length ? `: ${v.rug.risks.slice(0, 4).map((r) => cleanText(r.name, 40)).join('; ')}` : ''}${v.rug.lpLockedPct !== null ? ` · LP locked ${v.rug.lpLockedPct.toFixed(0)}%` : ''}`);
  if (v.flags.length) L.push(`flags       ${v.flags.join(', ')}`);
  const row = state.screener.rows.find((r) => r.mint === v.mint);
  const p = row ? rugP(row) : null;
  if (p !== null) L.push(`p(rug)      ${fmtRugP(p)} · model output: ${RUG_MODEL_LABEL} (a ranking, not a probability; see trenchscope backtest)`);
  const larp = state.larpByMint?.get(v.mint);
  if (larp) L.push(`LARP check  ${larp.verdict}${larp.confidence !== null ? ` · confidence ${larp.confidence.toFixed(2)}` : ''} · model output, ${fmtAge((now - larp.at) / 1000)} old · a risk flag, not a certificate`);
  const links = [v.socialLinks.web, v.socialLinks.x, v.socialLinks.tg].filter((x): x is string => !!x).map((u) => cleanText(u, 120));
  if (links.length) L.push(`links       ${links.join('  ')}  (advertised by the coin; unverified)`);
  return L;
}

/** Plain text of every row of a canvas (the generic report body for screens without a dedicated builder). */
export function canvasText(c: Canvas): string[] {
  const out: string[] = [];
  for (let y = 0; y < c.h; y++) out.push(c.ch.slice(y * c.w, (y + 1) * c.w).join('').trimEnd());
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Render the current screen for export: CALM (no rain / glitch / scanlines), and without the toast, help card or
 * GO-TO prompt on top. The state is restored afterwards, so the live loop is unaffected.
 */
export function renderCalmFrame(state: AppState, w: number, h: number): Canvas {
  const v = state.vfx;
  const saved = { intensity: v.intensity, toast: v.toast, overlay: state.overlay, goto: state.goto };
  try {
    v.intensity = 'off'; v.toast = null; state.overlay = null; state.goto = null;
    return renderFrame(state, w, h);
  } finally {
    v.intensity = saved.intensity; v.toast = saved.toast; state.overlay = saved.overlay; state.goto = saved.goto;
  }
}

/** The data label of what is on screen: seeded fixtures are SAMPLE, a `--replay` file is REPLAY, else LIVE. */
export function dataLabelOf(state: AppState): DataLabel {
  return state.screener.source === 'fixtures' ? 'sample' : state.screener.source === 'replay' ? 'replay' : 'live';
}

/** Build the ExportView for whatever screen is showing (the token screen gets the full per-panel report). */
export function exportViewFor(state: AppState, w: number, h: number, now: number): ExportView {
  const canvas = renderCalmFrame(state, w, h);
  const label = dataLabelOf(state);
  const tv = state.screen === 'token' && label !== 'sample' ? state.live?.token?.view ?? null : null;
  if (tv) {
    return {
      kind: 'token', title: `TOKEN · $${cleanText(tv.symbol, 16)}${tv.name ? ` · ${cleanText(tv.name, 32)}` : ''}`, mint: tv.mint,
      label, canvas, ages: tokenAges(tv, now), report: tokenReport(state, tv, now),
    };
  }
  const sample: ExportAge[] = label === 'sample' ? [{ name: 'all panels', source: 'seeded fixtures', ageSec: null, state: 'sample data' }] : [];
  if (state.screen === 'token') {
    const tk = state.token || state.fx.tokens[state.selected || 0];
    return { kind: 'token', title: `TOKEN · $${cleanText(tk?.symbol ?? '?', 16)}`, mint: tk?.mint ?? null, label, canvas, ages: sample, report: canvasText(canvas) };
  }
  const ages: ExportAge[] = [...sample];
  if (label !== 'sample' && state.screener.rows.length) {
    const ts = state.screener.rows.map((r) => r.fetchedAt).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
    if (ts.length) {
      ages.push({ name: 'rows newest', source: 'screener feed', ageSec: (now - Math.max(...ts)) / 1000 });
      ages.push({ name: 'rows oldest', source: 'screener feed', ageSec: (now - Math.min(...ts)) / 1000 });
    }
  }
  return { kind: state.screen, title: state.screen.toUpperCase(), mint: null, label, canvas, ages, report: canvasText(canvas) };
}
