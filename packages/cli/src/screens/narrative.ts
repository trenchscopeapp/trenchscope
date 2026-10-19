// trenchscope — NARRATIVE BOARD screen (key N, task-1356; AI-SUITE-DESIGN §7). What is running and what is
// working across the tokens trenchscope has recorded: deterministic lexicon clustering, per-narrative volume /
// new launches / runners / pace / "what is working" score. No model in the hot path; the board carries
// its own limits (name-based, X/TG-only narratives missed, honest unclassified share). w flips 1h/24h,
// M opens the HUD popup. The board is computed in state.ts (computeNarrativeView) on entry and the tick.
import { Canvas, header, footer, badge, breakpoint, type Hex } from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import type { NarrativeBoard, NarrativeStat } from '@dexterm/packs';

const fmtUsd = (v: number | null): string => { if (v == null) return '—'; const a = Math.abs(v); if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return v.toFixed(0); };
const fmtPct = (v: number | null): string => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');

export function renderNarrative(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const view = state.narrative ?? null;
  const board: NarrativeBoard | null = view?.board ?? null;
  const top = 2, bottom = c.h - 1;
  const win = view?.window ?? '1h';
  const srcLabel = view?.source === 'recorded' ? 'recorded history' : view?.source === 'screen' ? 'visible rows' : 'no data';
  const title = `NARRATIVE BOARD · ${win} · ${board ? `${board.meta.tokens_total} tokens · ${(100 * board.meta.unclassified_share).toFixed(0)}% unclassified` : srcLabel}`;
  const caption = bp === 'compact' ? undefined : `model output: none (deterministic lexicon v${board?.meta.lexicon_version ?? '—'}) · name-based · source: ${srcLabel}`;
  const box = c.box(0, top, c.w, bottom - top, { title, caption, focus: true });
  const bg: Hex = box.bg;

  if (!board || board.narratives.every((n) => n.tokens === 0)) {
    c.textC(box.x, box.y + 1, box.w, 'collecting narratives — run the app with the recorder on, or open the screener first', { fg: t.muted, bg, i: true });
    c.textC(box.x, box.y + 3, box.w, view?.error ? `(${view.error})` : 'clusters come from token names against a lexicon (owner: maintainers); X/Telegram-only narratives are missed', { fg: t.dim, bg });
    footer(c, [['w', '1h/24h'], ['esc', 'back'], ['q', 'quit']], t.name);
    return;
  }

  const shown = board.narratives.filter((n) => n.tokens > 0);
  const sel = Math.max(0, Math.min(shown.length - 1, state.selected ?? 0));
  // column header
  let cy = box.y;
  const wide = bp !== 'compact';
  c.text(box.x + 1, cy, '#', { fg: t.dim, bg });
  c.text(box.x + 4, cy, 'NARRATIVE', { fg: t.dim, bg });
  c.text(box.x + 22, cy, 'TOK', { fg: t.dim, bg });
  c.text(box.x + 28, cy, 'NEW 1h/24h', { fg: t.dim, bg });
  c.text(box.x + 40, cy, `VOL ${win}`, { fg: t.dim, bg });
  c.text(box.x + 50, cy, 'PACE', { fg: t.dim, bg });
  c.text(box.x + 57, cy, 'MED1h', { fg: t.dim, bg });
  c.text(box.x + 65, cy, 'SCORE', { fg: t.dim, bg });
  if (wide) c.text(box.x + 72, cy, 'TOP RUNNER (liq≥$10K)', { fg: t.dim, bg });
  cy += 1;
  c.hline(box.x, cy, box.w, { fg: t.border, bg }); cy += 1;

  let rank = 0;
  const scroll = Math.max(0, sel - (box.h - 6));
  for (let i = scroll; i < shown.length; i++) {
    if (cy >= box.y + box.h - 2) break;
    const n: NarrativeStat = shown[i];
    if (n.score != null) rank++;
    const selected = i === sel;
    const rb = selected ? t.selBg : bg;
    c.fill(box.x, cy, box.w, 1, ' ', { bg: rb });
    if (selected) c.put(box.x, cy, '▎', { fg: t.accent, bg: rb, soft: true });
    c.text(box.x + 1, cy, n.score == null ? '·' : String(rank), { fg: n.score == null ? t.dim : t.accent, bg: rb, b: true });
    c.text(box.x + 4, cy, n.narrative, { fg: n.narrative === 'unclassified' ? t.dim : selected ? t.borderFocus : t.text, bg: rb, b: n.score != null }, 17);
    c.text(box.x + 22, cy, String(n.tokens), { fg: t.text, bg: rb });
    c.text(box.x + 28, cy, `${n.new_1h}/${n.new_24h}`, { fg: t.muted, bg: rb });
    c.text(box.x + 40, cy, fmtUsd(win === '24h' ? n.vol_h24 : n.vol_h1), { fg: t.text, bg: rb });
    c.text(box.x + 50, cy, n.pace_mature != null ? n.pace_mature.toFixed(1) + 'x' : n.pace == null ? '—' : n.pace.toFixed(1) + '*', { fg: t.muted, bg: rb });
    const med = win === '24h' ? n.med_chg_h24 : n.med_chg_h1;
    c.text(box.x + 57, cy, fmtPct(med), { fg: med == null ? t.dim : med >= 0 ? t.up : t.down, bg: rb });
    c.text(box.x + 65, cy, n.score == null ? '—' : n.score.toFixed(0), { fg: n.score == null ? t.dim : t.accent, bg: rb, b: true });
    if (wide) {
      const r = n.runners[0];
      if (r) {
        let cx = c.text(box.x + 72, cy, r.symbol, { fg: t.text, bg: rb }, 12);
        cx = c.text(cx + 1, cy, fmtPct(r.chg_h1), { fg: (r.chg_h1 ?? 0) >= 0 ? t.up : t.down, bg: rb });
        c.text(cx + 1, cy, fmtUsd(r.mcap), { fg: t.muted, bg: rb });
      } else c.text(box.x + 72, cy, '—', { fg: t.dim, bg: rb });
    }
    cy += 1;
  }
  // limits line
  const ly = box.y + box.h - 1;
  if (wide) c.textC(box.x, ly, box.w, `model output: none (deterministic lexicon v${board.meta.lexicon_version}) · ${board.meta.copycat_tokens} copycat symbols · name-based · pace '*' = all tokens · compute ${board.meta.compute_ms}ms`, { fg: t.dim, bg });

  footer(c, [['↑↓', 'move'], ['w', win === '1h' ? '→24h' : '→1h'], ['M', 'popup'], ['esc', 'back'], ['q', 'quit']], t.name);
}
