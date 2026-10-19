// trenchscope — RULES screen (ctrl+r, task-1358 Tier 3). The user's rules (`config.rules`): enabled, name, the
// condition, the actions, the source (user / pack / jarvis), fires in the last hour, last fired. Below it the
// PROPOSALS pane (ticket/ask cards a rule produced — inert until the user acts on them, and even then the paper
// ticket editor / the analyst is where anything happens) or the LOG of recent fires. Typing a rule shows a live
// dry-run against the rows on screen: "would match N of M rows right now". Nothing on this screen arms or signs.
import { Canvas, header, footer, breakpoint, fmtAgeSec, type Hex } from '@dexterm/tui';
import { describeActions } from '@dexterm/custom';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { describeCard, type RulesUi } from '../rules.ts';

function fit(s: string, w: number): string { return s.length > w ? (w > 1 ? s.slice(0, w - 1) + '…' : s.slice(0, w)) : s; }

export function renderRules(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const ui: RulesUi | null = state.rulesUi ?? null;
  const rules = ui?.engine.rules ?? [];
  const now = state.now.getTime();
  const top = 2, bottom = c.h - 1;
  const typing = ui?.input !== null && ui?.input !== undefined;
  const enabled = rules.filter((r) => r.enabled).length;
  const title = `RULES · ${rules.length} (${enabled} on) · ${ui?.fires ?? 0} fires this session · ${ui?.proposals.length ?? 0} proposal${(ui?.proposals.length ?? 0) === 1 ? '' : 's'}`;
  const caption = bp === 'compact' ? undefined : 'when <cond> [for n ticks] then alert|ticket|ask|popup|tag|sound|watch · parsed, never eval\'d · rules only alert or PROPOSE';
  const lowerH = Math.max(6, Math.min(14, Math.floor((bottom - top) * 0.4)));
  const listH = bottom - top - lowerH;
  const rulesFocus = !typing && (ui?.pane ?? 'rules') === 'rules';
  const box = c.box(0, top, c.w, listH, { title, caption, focus: rulesFocus });
  const bg: Hex = box.bg;
  let cy = box.y;

  if (ui?.errors.length) {
    for (const e of ui.errors.slice(0, 2)) { c.text(box.x + 1, cy, `⚠ ${e}`, { fg: t.warn, bg }, box.w - 2); cy += 1; }
  }
  if (!rules.length) {
    c.text(box.x + 1, cy + 1, 'no rules yet.', { fg: t.muted, bg }); cy += 3;
    c.text(box.x + 1, cy, 'i                                 type a rule, e.g.  vol5m.velocity > 3 and cluster < 20 and liq > 25K for 2 ticks then alert(up, "surge") popup(chart)', { fg: t.dim, bg }, box.w - 2); cy += 1;
    c.text(box.x + 1, cy, 'trenchscope rules add "<rule>"         the same from a shell · rules list | check | dry-run | remove | enable | disable', { fg: t.dim, bg }, box.w - 2); cy += 1;
    c.text(box.x + 1, cy, 'fields: price mcap fdv liq vol5m vol1h vol24 holders org top10 dev lplocked bundled snipers cluster fresh mintable freezable age m5 h1 h6 h24 buys sells bonding', { fg: t.dim, bg }, box.w - 2); cy += 1;
    c.text(box.x + 1, cy, 'signals: <field>.velocity (× its own pace) · <field>.delta (change in the window) · tags: launchpad: flag: verified: sus:', { fg: t.dim, bg }, box.w - 2); cy += 2;
    c.text(box.x + 1, cy, 'every rule has a cooldown (10m) and a max/h (12, cap 120) · ticket/ask make PROPOSAL cards: you still size + confirm in the paper ticket', { fg: t.dim, bg, i: true }, box.w - 2);
  } else {
    const wide = bp !== 'compact';
    const xs = wide ? [1, 5, 24, 0, 0, 0, 0] : [1, 5, 20, 0, 0, 0, 0];
    // right-anchored columns: LAST(6) F/H(4) SRC(9) THEN(28 wide / 18)
    const lastW = 6, fhW = 4, srcW = wide ? 9 : 6, thenW = wide ? 30 : 18;
    xs[6] = box.w - 1 - lastW; xs[5] = xs[6] - 1 - fhW; xs[4] = xs[5] - 1 - srcW; xs[3] = xs[4] - 1 - thenW;
    const whenW = Math.max(8, xs[3] - xs[2] - 1);
    const heads = ['ON', 'RULE', 'WHEN', 'THEN', 'SRC', 'F/H', 'LAST'];
    heads.forEach((h, i) => c.text(box.x + xs[i], cy, h, { fg: t.dim, bg }));
    cy += 1;
    const sel = Math.max(0, Math.min(rules.length - 1, ui?.selected ?? 0));
    const scroll = Math.max(0, sel - (box.h - 4));
    for (let i = scroll; i < rules.length; i++) {
      if (cy >= box.y + box.h - 1) break;
      const r = rules[i];
      const selected = i === sel && rulesFocus;
      const rb = selected ? t.selBg : bg;
      c.fill(box.x, cy, box.w, 1, ' ', { bg: rb });
      if (selected) c.put(box.x, cy, '▎', { fg: t.accent, bg: rb, soft: true });
      c.text(box.x + xs[0], cy, r.enabled ? 'on' : 'off', { fg: r.enabled ? t.up : t.dim, bg: rb, b: r.enabled });
      c.text(box.x + xs[1], cy, fit(r.name === r.id ? r.id : r.name, xs[2] - xs[1] - 1), { fg: selected ? t.borderFocus : t.text, bg: rb });
      c.text(box.x + xs[2], cy, fit(`${r.whenText}${r.for ? ` for ${'ticks' in r.for ? r.for.ticks + ' ticks' : Math.round(r.for.ms / 1000) + 's'}` : ''}`, whenW), { fg: r.enabled ? t.text : t.muted, bg: rb });
      c.text(box.x + xs[3], cy, fit(describeActions(r), thenW), { fg: t.accent, bg: rb });
      c.text(box.x + xs[4], cy, fit(r.source.replace(/^pack:/, 'pk:'), srcW), { fg: r.source === 'user' ? t.muted : t.warn, bg: rb });
      const fh = ui!.engine.firesLastHour(r.id, now);
      c.text(box.x + xs[5], cy, String(fh).padStart(3), { fg: fh ? t.text : t.dim, bg: rb });
      const last = ui!.engine.lastFiredAt(r.id);
      c.text(box.x + xs[6], cy, last ? fmtAgeSec(Math.max(0, Math.round((now - last) / 1000))) : '—', { fg: last ? t.muted : t.dim, bg: rb });
      cy += 1;
    }
  }
  if (ui?.notice && !typing) c.textR(box.x + 1, box.y + box.h - 1, box.w - 2, ui.notice, { fg: t.warn, bg, i: true });

  // lower pane: PROPOSALS or LOG
  const proposalsPane = (ui?.pane ?? 'rules') === 'proposals';
  const ltitle = proposalsPane
    ? `PROPOSALS · ${ui?.proposals.length ?? 0} pending · inert until you act`
    : `LOG · last ${Math.min(ui?.log.length ?? 0, lowerH - 2)} of ${ui?.log.length ?? 0} · tab for proposals`;
  const lcaption = bp === 'compact' ? undefined : proposalsPane
    ? '⏎ = open the PAPER ticket editor / ask the analyst (you confirm there) · x = dismiss · nothing here arms or signs'
    : 'alerts, proposals, watch/tag, popups as they fired · reasons carry each satisfied clause with its value';
  const lbox = c.box(0, top + listH, c.w, lowerH, { title: ltitle, caption: lcaption, focus: !typing && proposalsPane });
  const lbg: Hex = lbox.bg;
  let ly = lbox.y;
  const lrows = lbox.h - (typing ? 2 : 0);
  if (proposalsPane) {
    const cards = ui?.proposals ?? [];
    if (!cards.length) c.text(lbox.x + 1, ly, 'no proposals pending — a rule with ticket(...) or ask(...) puts its card here when it fires', { fg: t.dim, bg: lbg, i: true });
    const psel = Math.max(0, Math.min(cards.length - 1, ui?.selectedProposal ?? 0));
    const pscroll = Math.max(0, psel - (lrows - 1));
    for (let i = pscroll; i < cards.length; i++) {
      if (ly >= lbox.y + lrows) break;
      const p = cards[i];
      const selected = i === psel && !typing;
      const rb = selected ? t.selBg : lbg;
      c.fill(lbox.x, ly, lbox.w, 1, ' ', { bg: rb });
      if (selected) c.put(lbox.x, ly, '▎', { fg: t.accent, bg: rb, soft: true });
      let cx = c.text(lbox.x + 1, ly, fmtAgeSec(Math.max(0, Math.round((now - p.at) / 1000))).padEnd(5), { fg: t.dim, bg: rb });
      cx = c.text(cx + 1, ly, 'PROPOSAL', { fg: t.warn, bg: rb, b: true });
      cx = c.text(cx + 1, ly, fit(describeCard(p), 34).padEnd(34), { fg: p.type === 'ticket' ? (p.side === 'buy' ? t.up : t.down) : t.accent, bg: rb });
      cx = c.text(cx + 1, ly, fit(p.name, 14).padEnd(14), { fg: t.muted, bg: rb });
      c.text(cx + 1, ly, fit(p.why, lbox.w - (cx + 1 - lbox.x) - 1), { fg: t.dim, bg: rb });
      ly += 1;
    }
  } else {
    const log = ui?.log ?? [];
    if (!log.length) c.text(lbox.x + 1, ly, ui?.engine.rules.some((r) => r.enabled) ? 'nothing fired yet (rules evaluate the screener rows every few seconds)' : 'no enabled rules', { fg: t.dim, bg: lbg, i: true });
    for (const e of log) {
      if (ly >= lbox.y + lrows) break;
      const fg = e.kind === 'alert' ? (e.level === 'up' ? t.up : e.level === 'down' ? t.down : e.level === 'warn' ? t.warn : t.text) : e.kind === 'proposal' ? t.warn : t.muted;
      let cx = c.text(lbox.x + 1, ly, fmtAgeSec(Math.max(0, Math.round((now - e.at) / 1000))).padEnd(5), { fg: t.dim, bg: lbg });
      cx = c.text(cx + 1, ly, fit(e.symbol, 8).padEnd(8), { fg: t.accent, bg: lbg });
      cx = c.text(cx + 1, ly, fit(e.name, 14).padEnd(14), { fg: t.muted, bg: lbg });
      c.text(cx + 1, ly, fit(e.text, lbox.w - (cx + 1 - lbox.x) - 1), { fg, bg: lbg });
      ly += 1;
    }
  }
  if (typing && ui) {
    const iy = lbox.y + lbox.h - 1;
    c.hline(lbox.x, iy - 1, lbox.w, { fg: t.border, bg: lbg });
    const label = ui.editingId ? `edit ${ui.editingId}: ` : 'rule: ';
    c.text(lbox.x + 1, iy, label, { fg: t.accent, bg: lbg, b: true });
    const avail = lbox.w - label.length - 3;
    const txt = ui.input!;
    const shown = txt.length > avail ? '…' + txt.slice(txt.length - avail + 1) : txt;
    c.text(lbox.x + 1 + label.length, iy, `${shown}█`, { fg: t.text, bg: lbg }, avail + 1);
    // the live dry-run on the line above the input
    const d = ui.dry;
    let dryText: string; let dryFg: Hex;
    if (!txt.trim()) { dryText = 'type a rule · ⏎ save · esc cancel'; dryFg = t.dim; }
    else if (!d) { dryText = 'checking…'; dryFg = t.dim; }
    else if (d.error) { dryText = `✗ ${d.error}`; dryFg = t.down; }
    else {
      const names = d.matches.slice(0, 6).map((m) => m.symbol).join(' ');
      dryText = `✓ would match ${d.matches.length} of ${d.considered} rows right now${names ? ` (${names}${d.matches.length > 6 ? ' …' : ''})` : ''}${d.noHistory ? ` · ${d.noHistory} without history yet (velocity/delta need two earlier samples)` : ''} · ${describeActions(d.rule!)} · cooldown ${Math.round(d.rule!.cooldownMs / 60000)}m · max ${d.rule!.maxPerHour}/h`;
      dryFg = d.matches.length ? t.up : t.muted;
    }
    c.text(lbox.x + 1, iy - 1, ` ${fit(dryText, lbox.w - 4)} `, { fg: dryFg, bg: lbg });
    c.textR(lbox.x + 1, iy, lbox.w - 2, '⏎ save · esc cancel', { fg: t.dim, bg: lbg });
  }
  footer(c, [['↑↓', 'move'], ['i', 'new rule'], ['⏎', proposalsPane ? 'act on proposal' : 'edit rule'], ['space', 'on/off'], ['d', 'delete'], ['tab', proposalsPane ? 'log' : 'proposals'], ['x', 'dismiss'], ['esc', 'back'], ['q', 'quit']], t.name);
}
