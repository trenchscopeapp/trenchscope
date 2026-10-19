// trenchscope — shared renderer for a live Claude analyst session (task-1302). Used by the full Analyst
// screen and the token ANALYST panel. Cyberspace styling: the verdict and the tool-call lines are
// coral, the answer decrypts in through code glyphs, and a cost/latency footer sits on the caption.
import {
  Canvas, badge, spinnerGlyph, decryptText, wrap, mix, fmtUsd, fmtPrice, fmtPctDir, type Style,
} from '@dexterm/tui';
import type { AnalystSession } from '../analyst/session.ts';

/** A list-of-coins answer row with its numbers resolved from LIVE data (task-1313 part F). */
export interface ResolvedResultRow {
  mint: string; symbol: string; reason: string;
  price: number | null; chg24: number | null; liq: number | null; vol24: number | null; mcap: number | null; ageMin: number | null;
}

export interface AnalystRenderOpts {
  frame: number;
  code: string;
  calm: boolean;
  /** Extra context chips (e.g. holders:20, rugcheck). */
  chips?: string[];
  /** Placeholder shown in the input line when nothing is typed. */
  inputHint?: string;
  /** The live text the user is typing into the chat input (task-1303). */
  input?: string;
  /** True when keystrokes route to this input (draws a cursor). */
  inputFocused?: boolean;
  /** Panel title (default `✦ ANALYST · claude`). */
  title?: string;
  /** Scroll offset (wrapped lines) into a long answer body (task-1311, QA M12). */
  scroll?: number;
  /** Reveal the answer in full, skipping the decrypt animation (task-1311, QA M12). */
  revealAll?: boolean;
  /** A list-of-coins answer resolved against live data (task-1313 part F); rendered as a real table. */
  results?: ResolvedResultRow[];
  /** The highlighted results row (↑↓); Enter jumps to that coin. */
  resultsCursor?: number;
  /** True when the results table (not the chat input) has the keyboard focus. */
  resultsActive?: boolean;
}

const verdictColor = (c: Canvas, v: string | null): string => {
  const t = c.theme;
  if (v === 'WATCH') return t.up;
  if (v === 'AVOID') return t.down;
  if (v === 'SPECULATIVE' || v === 'AMBIGUOUS') return t.warn;
  return t.muted;
};

/** Draw the session inside a box at (x,y,w,h). Pure: reads only the session + opts. */
export function renderAnalystSession(c: Canvas, x: number, y: number, w: number, h: number, s: AnalystSession, opts: AnalystRenderOpts): void {
  const t = c.theme;
  const bc = mix(t.border, t.ai, 0.55);
  // Narrow panels (token screen) drop the model so cost · latency · tools still fits beside the title.
  const full = s.status === 'error' ? 'analyst unavailable' : s.footer;
  // 0.1.5: a codex conversation says so in the title; claude panels keep the original default.
  const title = opts.title ?? (s.engine === 'codex' ? '✦ ANALYST · codex' : '✦ ANALYST · claude');
  const caption = title.length + full.length + 10 <= w ? full : full.split(' · ').slice(0, 3).join(' · ');
  const capFg = s.status === 'error' ? t.warn : t.dim;
  const box = c.box(x, y, w, h, { title, titleFg: t.ai, caption, captionFg: capFg, border: bc });
  const bg = box.bg;
  const inner = box.w - 2;
  const frame = opts.frame;
  const inputY = box.y + box.h - 2;
  let cy = box.y;

  // context chips
  if (opts.chips?.length) {
    let cx = box.x + 1;
    for (const chip of opts.chips) {
      if (cx + chip.length + 3 > box.x + box.w - 1) break;
      cx = badge(c, cx, cy, chip, t.ai, { on: bg }) + 1;
    }
    cy += 2;
  }

  const line = (str: string, st: Style, indent = 1): void => {
    for (const w2 of wrap(str, inner - indent)) { if (cy >= inputY - 1) return; c.text(box.x + indent, cy, w2, st, inner - indent); cy += 1; }
  };

  const drawTail = () => drawInput(c, box, bc, inputY, opts, s);

  // earlier exchanges on this warm session (compact marker; the current turn is drawn in full below)
  if (s.history.length && cy < inputY - 1) {
    c.text(box.x + 1, cy, `⟲ ${s.history.length} earlier ${s.history.length === 1 ? 'exchange' : 'exchanges'} · one warm ${s.engine} session`, { fg: t.dim, bg, i: true }, inner - 1);
    cy += 1;
    const last = s.history[s.history.length - 1];
    const prev = last.error ? `last: ${last.error}` : last.verdict ? `last: ${last.verdict}` : last.summary[0] ? `last: ${last.summary[0]}` : '';
    if (prev && cy < inputY - 1) { c.text(box.x + 3, cy, prev, { fg: t.dim, bg, i: true }, inner - 3); cy += 1; }
    cy += 1;
  }

  // ---- the question
  if (cy < inputY - 1) {
    c.text(box.x + 1, cy, '›', { fg: t.accent, bg, b: true });
    line(s.question, { fg: t.text, bg, b: true }, 3);
    cy += 1;
  }

  // ---- interrupted (Esc during a run): soft note, input stays usable for the next question
  if (s.status === 'interrupted') {
    c.text(box.x + 1, cy, '○', { fg: t.warn, bg, b: true });
    line(s.error?.message ?? 'interrupted', { fg: t.warn, bg, b: true }, 3);
    if (s.error?.detail) line(s.error.detail, { fg: t.dim, bg, i: true }, 3);
    drawTail();
    return;
  }

  // ---- error (clean one-liner, app keeps working)
  if (s.status === 'error' && s.error) {
    c.text(box.x + 1, cy, '○', { fg: t.warn, bg, b: true });
    line(s.error.message, { fg: t.warn, bg, b: true }, 3);
    if (s.error.detail) line(s.error.detail, { fg: t.dim, bg, i: true }, 3);
    cy += 1;
    line('The rest of trenchscope keeps working; this panel is read-only and never trades.', { fg: t.dim, bg, i: true }, 1);
    drawTail();
    return;
  }

  // ---- tool-call lines (coral), newest reasoning visible
  for (const tl of s.toolLines) {
    if (cy >= inputY - 1) break;
    c.text(box.x + 3, cy, '↳ ' + tl, { fg: t.ai, bg, i: true }, inner - 3);
    cy += 1;
  }

  // ---- spinner while thinking / running
  if (s.status === 'thinking' || s.status === 'running') {
    if (cy < inputY - 1) {
      c.text(box.x + 2, cy, spinnerGlyph(frame), { fg: t.ai, bg, b: true });
      const status = s.status === 'thinking'
        ? ['Thinking', 'Loading skill', 'Connecting tools'][Math.floor(frame / 24) % 3]
        : ['Querying tools', 'Reading chain', 'Weighing risk'][Math.floor(frame / 24) % 3];
      c.text(box.x + 4, cy, `${status}…`, { fg: t.ai, bg, b: true });
      const secs = ((Date.now() - s.startedAt) / 1000).toFixed(1);
      c.text(box.x + 5 + status.length, cy, `(esc to interrupt · ${secs}s)`, { fg: t.dim, bg }, Math.max(0, inner - status.length - 6));
      cy += 1;
    }
    // stream any natural-language text the model emitted before the structured answer
    if (s.text && cy < inputY - 1) { cy += 1; line(s.text.slice(-400), { fg: t.muted, bg, i: true }, 2); }
    drawTail();
    return;
  }

  // ---- done: verdict (pinned) + scrollable summary (decrypts in), invalidation, flags, proposals
  cy += 1;
  // task-1311 (QA M12): the decrypt reveals fast (~600 chars/s) and any key reveals it in full, so a
  // finished answer is never hidden; `revealAll` also skips it on demand / in calm mode.
  const revealAll = opts.revealAll || opts.calm;
  if (s.verdict && cy < inputY - 1) {
    const vc = verdictColor(c, s.verdict);
    c.fill(box.x + 1, cy, inner, 1, ' ', { bg: mix(bg, vc, 0.18) });
    c.text(box.x + 2, cy, `● ${s.verdict}`, { fg: vc, bg: mix(bg, vc, 0.18), b: true });
    const right = s.rugProbability !== null ? `rug ${(s.rugProbability * 100).toFixed(0)}% ` : s.confidence !== null ? `conf ${s.confidence.toFixed(2)} ` : '';
    if (right) c.textR(box.x + 1, cy, inner - 1, right, { fg: t.muted, bg: mix(bg, vc, 0.18) });
    cy += 1;
  }
  // task-1313 trading view: the directional bias + setup quality, drawn under the risk verdict.
  if (s.bias && cy < inputY - 1) {
    const bc2 = s.bias === 'long' ? t.up : s.bias === 'short' || s.bias === 'avoid' ? t.down : t.warn;
    c.text(box.x + 2, cy, `▸ bias ${s.bias.toUpperCase()}`, { fg: bc2, bg, b: true });
    if (s.setupQuality) c.text(box.x + 2 + 7 + s.bias.length + 1, cy, `· setup ${s.setupQuality}`, { fg: t.muted, bg }, inner - 10 - s.bias.length);
    cy += 1;
  }
  if (s.injection && cy < inputY - 1) { c.text(box.x + 2, cy, '⚠ prompt injection in token text — ignored', { fg: t.warn, bg, b: true }, inner - 2); cy += 1; }
  // task-1313 part E: the structured filter the analyst applied for a plain-language request, so the
  // user sees the numbers it chose and can correct them ("tighter", "only locked LP", …).
  if (s.filterApplied && cy < inputY - 1) {
    c.text(box.x + 2, cy, `applied filter: ${s.filterApplied.query}`, { fg: t.accent, bg, b: true }, inner - 2);
    cy += 1;
    if (s.filterApplied.notes) { line(s.filterApplied.notes, { fg: t.dim, bg, i: true }, 4); }
  }

  // task-1311 (QA M12): the answer body scrolls (j/k, PgUp/Dn) instead of truncating at 16 lines.
  const sumLines = s.summary.flatMap((ln) => wrap(ln, inner - 2));
  let capacity = Math.max(1, inputY - 1 - cy);
  const overflow = sumLines.length > capacity;
  if (overflow) capacity -= 1; // reserve a row for the scroll marker
  const maxScroll = Math.max(0, sumLines.length - capacity);
  const scroll = Math.max(0, Math.min(opts.scroll ?? 0, maxScroll));
  let revealLeft = revealAll ? 1e9 : s.doneAt ? Math.floor(((Date.now() - s.doneAt) / 1000) * 600) : 1e9;
  for (let i = 0; i < scroll; i++) revealLeft -= (sumLines[i]?.length ?? 0) + 1; // spend the budget on hidden lines first
  for (const w2 of sumLines.slice(scroll, scroll + capacity)) {
    if (cy >= inputY - 1) break;
    const n = Math.min(revealLeft, w2.length);
    if (revealAll || n >= w2.length) c.text(box.x + 2, cy, w2, { fg: t.text, bg }, inner - 2);
    else decryptText(c, box.x + 2, cy, w2, Math.max(0, n), frame, { fg: t.text, bg }, inner - 2, opts.code);
    revealLeft -= w2.length + 1;
    cy += 1;
  }
  if (overflow && cy < inputY - 1) {
    const above = scroll, below = Math.max(0, sumLines.length - (scroll + capacity));
    const marker = `${above ? `↑${above} ` : ''}${below ? `↓${below} more ` : ''}· j/k · PgUp/Dn`;
    c.text(box.x + 2, cy, marker, { fg: t.dim, bg, i: true }, inner - 2);
    cy += 1;
  }
  // task-1313 part F: a list-of-coins answer, rendered as a REAL table (symbol/price/change/liq/vol/
  // mcap/age + the analyst's one-line reason), navigable with ↑↓ and ⏎-to-jump. The numbers come from
  // live data (resolved by the caller from the app's data layer, never from the model's text).
  if (opts.results?.length && cy < inputY - 1) {
    cy = renderResultsTable(c, box, bg, cy, inputY, inner, opts.results, opts.resultsCursor ?? 0, opts.resultsActive ?? false);
  }
  if (s.candidates.length && cy < inputY - 1) {
    cy += 1;
    line('ambiguous — pick a mint:', { fg: t.warn, bg, b: true }, 2);
    for (const cand of s.candidates.slice(0, 3)) { if (cy >= inputY - 1) break; c.text(box.x + 2, cy, `· ${String(cand.mint).slice(0, 10)}… ${cand.launchpad ?? ''}`, { fg: t.muted, bg }, inner - 2); cy += 1; }
  }
  if (s.keyLevels.length && cy < inputY - 1) {
    cy += 1;
    c.text(box.x + 2, cy, 'key levels:', { fg: t.dim, bg, i: true });
    cy += 1;
    for (const lv of s.keyLevels.slice(0, 6)) {
      if (cy >= inputY - 1) break;
      const val = lv.value !== undefined && lv.value !== null ? ` ${lv.value}` : '';
      const note = lv.note ? ` — ${lv.note}` : '';
      c.text(box.x + 2, cy, `· ${lv.label}${val}${note}`, { fg: t.muted, bg }, inner - 2);
      cy += 1;
    }
  }
  if (s.invalidation && cy < inputY - 1) {
    cy += 1;
    c.text(box.x + 2, cy, 'invalidates if:', { fg: t.dim, bg, i: true });
    cy += 1;
    line(s.invalidation, { fg: t.muted, bg }, 2);
  }
  if (s.sizeHint && cy < inputY - 1) {
    cy += 1;
    c.text(box.x + 2, cy, 'size:', { fg: t.dim, bg, i: true });
    cy += 1;
    line(s.sizeHint, { fg: t.muted, bg }, 2);
  }
  if (s.proposals.length && cy < inputY - 1) {
    cy += 1;
    for (const p of s.proposals) {
      if (cy >= inputY - 1) break;
      c.text(box.x + 2, cy, `+ ${p.type}: ${p.text}`, { fg: t.accent, bg }, inner - 2);
      cy += 1;
    }
    if (cy < inputY - 1) { c.text(box.x + 2, cy, 'proposals only — confirm with a keypress', { fg: t.dim, bg, i: true }, inner - 2); cy += 1; }
  }

  drawTail();
}

/** Compact age label from minutes: 45m, 3h, 2d, — when unknown (task-1313 part F table). */
function fmtAge(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

/**
 * Draw a list-of-coins answer as a real table (task-1313 part F). Columns adapt to width: at ≥96 inner
 * cols the full set (symbol/price/24h/liq/vol/mcap/age + reason); narrower drops columns right-to-left
 * so it stays legible instead of wrapping into prose. The highlighted row (cursor) is tinted; when the
 * table is active a `▸` marks it and the footer hint changes. Returns the new y.
 */
function renderResultsTable(
  c: Canvas, box: { x: number; y: number; w: number; h: number; bg: string }, bg: string,
  startY: number, inputY: number, inner: number,
  rows: ResolvedResultRow[], cursor: number, active: boolean,
): number {
  const t = c.theme;
  let cy = startY + 1;
  if (cy >= inputY - 1) return cy;
  // Column plan: [symbol, price, 24h, liq, vol, mcap, age] then the reason fills the rest. Drop from
  // the right as width shrinks so a narrow panel still shows symbol + price + change + a reason.
  const full: Array<[string, number]> = [['SYMBOL', 10], ['PRICE', 9], ['24H', 8], ['LIQ', 8], ['VOL', 8], ['MCAP', 8], ['AGE', 5]];
  let cols = full.slice();
  // keep trimming trailing columns until the header + a minimal reason (12) fits
  while (cols.length > 3 && cols.reduce((a, [, w]) => a + w + 1, 0) + 12 > inner - 2) cols.pop();
  const reasonX = cols.reduce((a, [, w]) => a + w + 1, 0) + box.x + 3;
  const reasonW = Math.max(0, box.x + box.w - 1 - reasonX);

  // header
  c.text(box.x + 2, cy, `◆ ${rows.length} coin${rows.length === 1 ? '' : 's'}${active ? '  ↑↓ pick · ⏎ open · o ticket · esc back' : '  (↑↓ to browse)'}`, { fg: t.ai, bg, b: true }, inner - 2);
  cy += 1;
  if (cy >= inputY - 1) return cy;
  let hx = box.x + 3;
  for (const [lab, w] of cols) { c.textR(hx, cy, w, lab, { fg: t.dim, bg }); hx += w + 1; }
  if (reasonW >= 6) c.text(reasonX, cy, 'WHY', { fg: t.dim, bg });
  cy += 1;

  const cap = Math.max(1, inputY - 1 - cy);
  const startIdx = Math.max(0, Math.min(cursor - Math.floor(cap / 2), Math.max(0, rows.length - cap)));
  for (let i = startIdx; i < rows.length && cy < inputY - 1; i++) {
    const r = rows[i];
    const on = active && i === cursor;
    const rowBg = on ? mix(bg, t.accent, 0.3) : i % 2 ? mix(bg, t.panelAlt, 1) : bg;
    c.fill(box.x + 1, cy, inner, 1, ' ', { bg: rowBg });
    let rx = box.x + 1;
    c.text(rx, cy, on ? '▸' : ' ', { fg: t.accent, bg: rowBg, b: true }); rx += 2;
    for (const [lab, w] of cols) {
      if (lab === 'SYMBOL') c.text(rx, cy, r.symbol || r.mint.slice(0, 4), { fg: t.text, bg: rowBg, b: on }, w);
      else if (lab === 'PRICE') c.textR(rx, cy, w, r.price !== null ? fmtPrice(r.price) : '—', { fg: t.text, bg: rowBg });
      else if (lab === '24H') c.textR(rx, cy, w, r.chg24 !== null ? fmtPctDir(r.chg24) : '—', { fg: (r.chg24 ?? 0) >= 0 ? t.up : t.down, bg: rowBg });
      else if (lab === 'LIQ') c.textR(rx, cy, w, r.liq !== null ? fmtUsd(r.liq, { digits: 0 }) : '—', { fg: t.text, bg: rowBg });
      else if (lab === 'VOL') c.textR(rx, cy, w, r.vol24 !== null ? fmtUsd(r.vol24, { digits: 0 }) : '—', { fg: t.text, bg: rowBg });
      else if (lab === 'MCAP') c.textR(rx, cy, w, r.mcap !== null ? fmtUsd(r.mcap, { digits: 0 }) : '—', { fg: t.text, bg: rowBg });
      else if (lab === 'AGE') c.textR(rx, cy, w, fmtAge(r.ageMin), { fg: t.dim, bg: rowBg });
      rx += w + 1;
    }
    if (reasonW >= 6 && r.reason) c.text(reasonX, cy, r.reason, { fg: on ? t.text : t.muted, bg: rowBg }, reasonW);
    cy += 1;
  }
  if (rows.length > startIdx + cap && cy < inputY - 1) { c.text(box.x + 2, cy, `↓ ${rows.length - (startIdx + cap)} more`, { fg: t.dim, bg, i: true }, inner - 2); cy += 1; }
  return cy;
}

/**
 * The chat input line (task-1303): the live buffer with a cursor when focused, a "queued" banner
 * when a follow-up is waiting on an in-flight run, else the placeholder hint. Always usable.
 */
function drawInput(c: Canvas, box: { x: number; y: number; w: number; h: number; bg: string }, bc: string, inputY: number, opts: AnalystRenderOpts, s: AnalystSession): void {
  const t = c.theme;
  const bg = box.bg;
  c.hline(box.x, inputY - 1, box.w, { fg: bc, bg, soft: true });
  c.put(box.x, inputY - 1, '├', { fg: bc, bg, soft: true });
  c.put(box.x + box.w - 1, inputY - 1, '┤', { fg: bc, bg, soft: true });
  const promptFg = s.busy ? t.dim : t.ai;
  c.text(box.x + 1, inputY, '▌', { fg: promptFg, bg, b: true, soft: true });
  const avail = box.w - 4;
  const typed = opts.input ?? '';
  if (typed) {
    // Show the tail of what is typed so the caret stays visible, with a block cursor when focused.
    const caret = opts.inputFocused ? '█' : '';
    const shown = typed.length + caret.length > avail ? typed.slice(typed.length - (avail - caret.length)) : typed;
    const x = c.text(box.x + 2, inputY, shown, { fg: t.text, bg }, avail);
    if (caret) c.text(x, inputY, caret, { fg: t.accent, bg, b: true });
  } else {
    const hint = s.queued
      ? `queued: ${s.queued}  ·  will ask when the run finishes`
      : s.busy
        ? 'streaming… type a follow-up (it queues) · esc interrupts'
        : (opts.inputHint ?? 'ask a follow-up…  ⏎ send · read-only · never trades');
    const fg = s.queued ? t.warn : t.dim;
    c.text(box.x + 2, inputY, (opts.inputFocused ? '█ ' : '') + hint, { fg, bg, i: true }, avail);
  }
}
