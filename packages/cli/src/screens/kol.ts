// trenchscope — KOL LISTS screen (key K, task-1330; INTEGRATIONS-DESIGN §5.4). Own lists, manual handles and
// signed packs: list, enable/disable per list (space), mute/unmute a handle (m), remove a handle from a manual
// list (d), add a handle by typing (i … ⏎). Packs are read-only here (`trenchscope kol import <dir>`). Credibility
// is never shown as a property of a list: a pack grants membership, the user's own observations grant trust.
import { Canvas, header, footer, badge, breakpoint, type Hex } from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { kolOf, kolRows, type KolRow } from '../social/view.ts';

export function renderKol(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const kol = kolOf(state);
  const top = 2, bottom = c.h - 1;
  const rows: KolRow[] = kol ? kolRows(kol) : [];
  const sel = Math.max(0, Math.min(rows.length - 1, state.kolSelected ?? 0));
  const title = `KOL LISTS · ${kol ? kol.summary() : 'unavailable'}`;
  const box = c.box(0, top, c.w, bottom - top, { title, caption: bp === 'compact' ? undefined : 'packs carry handles, never posts · a list grants membership, never credibility', focus: true });
  const bg: Hex = box.bg;
  let cy = box.y;
  if (!kol) { c.textC(box.x, cy + 1, box.w, 'KOL lists need live, replay or fixture mode', { fg: t.muted, bg, i: true }); footer(c, [['esc', 'back'], ['q', 'quit']], t.name); return; }
  if (rows.length === 0) {
    c.text(box.x + 1, cy, 'no KOL lists yet.', { fg: t.muted, bg }); cy += 2;
    c.text(box.x + 1, cy, 'trenchscope kol create <name>            make a manual list', { fg: t.dim, bg }); cy += 1;
    c.text(box.x + 1, cy, 'trenchscope kol add <list> @handle        add a handle (or press i here once a list exists)', { fg: t.dim, bg }); cy += 1;
    c.text(box.x + 1, cy, 'trenchscope kol import <dir>              import a hash-locked pack (pack.json + pack.lock[.sig])', { fg: t.dim, bg }); cy += 1;
    c.text(box.x + 1, cy, 'X (here) or trenchscope kol import-x      import your OWN X lists after `trenchscope x login` (handles only, never posts)', { fg: t.dim, bg }); cy += 1;
  }
  const scroll = Math.max(0, sel - (box.h - 3));
  const typing = state.kolInput !== null && state.kolInput !== undefined;
  for (let i = scroll; i < rows.length; i++) {
    if (cy >= box.y + box.h - (typing ? 2 : 0)) break;
    const r = rows[i];
    const selected = i === sel;
    const rb = selected ? t.selBg : bg;
    c.fill(box.x, cy, box.w, 1, ' ', { bg: rb });
    if (selected) c.put(box.x, cy, '▎', { fg: t.accent, bg: rb, soft: true });
    if (r.kind === 'list') {
      const l = r.list;
      let cx = c.text(box.x + 1, cy, l.enabled ? '◉' : '◌', { fg: l.enabled ? t.up : t.dim, bg: rb, b: true });
      cx = c.text(cx + 1, cy, l.name, { fg: selected ? t.borderFocus : t.text, bg: rb, b: true }, 32);
      cx = badge(c, cx + 1, cy, l.source === 'pack' ? 'PACK' : l.source === 'own-x-list' ? 'X LIST' : 'MANUAL', l.source === 'pack' ? t.accent : t.muted, { on: rb }) + 1;
      cx = badge(c, cx, cy, l.tier === 'kol-a' ? 'KOL·A' : 'KOL·B', t.muted, { on: rb }) + 1;
      if (l.signed) cx = badge(c, cx, cy, l.signed.verified ? 'SIGNED ✓' : 'UNSIGNED', l.signed.verified ? t.up : t.warn, { on: rb }) + 1;
      const tail = `${l.handles.length} handle${l.handles.length === 1 ? '' : 's'}${l.wallets.length ? ` · ${l.wallets.length} wallets` : ''}${l.signed ? ` · publisher ${l.signed.publisher} · ${l.signed.hash.slice(0, 8)}` : ''}${l.enabled ? '' : ' · OFF for trending'}`;
      c.textR(box.x + 1, cy, box.w - 2, tail, { fg: t.dim, bg: rb });
    } else if (r.kind === 'empty') {
      c.text(box.x + 4, cy, 'empty · press i to add a handle', { fg: t.dim, bg: rb, i: true });
    } else {
      const muted = kol.isMuted(r.handle);
      let cx = c.text(box.x + 4, cy, `@${r.handle}`, { fg: muted ? t.dim : selected ? t.borderFocus : t.text, bg: rb, d: muted });
      if (muted) cx = badge(c, cx + 1, cy, 'MUTED', t.warn, { on: rb }) + 1;
      if (r.list.source === 'pack' && r.list.handles.indexOf(r.handle) === 11 && r.list.handles.length > 12) c.textR(box.x + 1, cy, box.w - 2, `… ${r.list.handles.length - 12} more in the pack`, { fg: t.dim, bg: rb, i: true });
    }
    cy += 1;
  }
  if (typing) {
    const iy = box.y + box.h - 1;
    const list = rows[sel]?.list;
    c.hline(box.x, iy - 1, box.w, { fg: t.border, bg });
    c.text(box.x + 1, iy, `add to ${list?.name ?? '?'}: @`, { fg: t.accent, bg, b: true });
    const px = box.x + 1 + `add to ${list?.name ?? '?'}: @`.length;
    c.text(px, iy, `${state.kolInput}█`, { fg: t.text, bg }, box.w - (px - box.x) - 2);
    c.textR(box.x + 1, iy, box.w - 2, '⏎ add · esc cancel', { fg: t.dim, bg });
  } else if (cy + 1 < box.y + box.h) c.rainZone(box.x + 1, cy + 1, box.w - 2, box.y + box.h - cy - 1, 2);
  if (state.kolNotice && !typing) { c.textR(box.x + 1, box.y + box.h - 1, box.w - 2, state.kolNotice, { fg: t.warn, bg, i: true }); }
  else if (state.kolImporting && !typing) { c.textR(box.x + 1, box.y + box.h - 1, box.w - 2, 'importing your X lists… (owned_lists + members; handles only)', { fg: t.accent, bg, i: true }); }
  footer(c, [['j/k', 'move'], ['space', 'enable/disable'], ['m', 'mute'], ['d', 'remove'], ['i', 'add handle'], ['o', state.socialAuthor ? `only @${state.socialAuthor} (clear)` : 'only this handle'], ['X', 'import X lists'], ['T', 'trending'], ['esc', 'back'], ['q', 'quit']], t.name);
}
