// trenchscope — BUBBLE MAP screen (task-1340, wallet intel W3/W4). The terminal rendering of the holder graph the
// approved mocks showed (research/wallet-intel/mock/out): packed half-row discs (area ∝ share, colour = rule),
// a CLUSTERS table, sample-captioned HOLDER INSIGHTS and the WHY THIS LABEL panel that prints every rule with
// its confidence and evidence. Three honest states: loading, unavailable (reason + fix), ok (possibly degraded:
// keyless runs show holders + static labels and say what a free Helius key adds). Pure renderer.
import {
  Canvas, badge, statGrid, header, footer, breakpoint, isCalm, fmtNum, shortAddr, wrap,
  layoutBubbles, drawBubbles, drawTreemap, legendRow, kindColor, sampleCaption, type BubbleVM, type BubbleLayout, type Hex,
} from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { unavailableText, type IntelEntry } from '../live/intel.ts';

/** UI state of the bubble screen (lives on AppState.intelUi). */
export interface IntelUi {
  mint: string;
  symbol: string;
  name: string;
  /** Selected holder index into the VM's holders, or null. */
  selected: number | null;
  view: 'bubbles' | 'treemap';
  /** Zoomed cluster name, or null. */
  focus: string | null;
  /** Cached layout for the current (vm, size, focus); rebuilt when any of them changes. */
  layout?: { key: string; lay: BubbleLayout } | null;
}

export function renderBubbles(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const ui = state.intelUi ?? null;
  const entry: IntelEntry | null = ui && state.live?.intel ? state.live.intel.entry(ui.mint) : null;
  const top = 2, bottom = c.h - 1;
  // ---- title strip
  let y = top;
  c.fill(0, y, c.w, 1, ' ', { bg: t.bg });
  let x = c.text(1, y, '‹ ', { fg: t.muted, bg: t.bg });
  const symbol = ui?.symbol ?? '?';
  x = c.text(x, y, `$${symbol}`, { fg: t.borderFocus, bg: t.bg, b: true });
  c.heading(3, y, symbol.length + 1);
  if (ui?.name && bp !== 'compact') x = c.text(x + 1, y, ui.name.slice(0, 28), { fg: t.muted, bg: t.bg });
  x = badge(c, x + 2, y, 'BUBBLE MAP', t.accent, { on: t.bg, bold: true });
  if (ui?.mint) x = c.text(x + 2, y, shortAddr(ui.mint, 6), { fg: t.dim, bg: t.bg });
  const vm = entry?.state === 'ok' ? entry.bubbles : null;
  const r = entry?.result?.state === 'ok' ? entry.result : null;
  const right = vm && r ? `${r.depth} scan · ${r.via.history ? `${r.via.holders} + helius history` : `${r.via.holders} only`}${r.fromCache ? ' · cached' : ''} ` : entry?.state === 'loading' ? 'scanning… ' : '';
  if (right && c.w - right.length - 1 > x + 2) { c.text(c.w - 1 - right.length, y, right, { fg: t.dim, bg: t.bg }); c.rainZone(x + 1, y, c.w - right.length - x - 3, 1, 1); } else c.rainZone(x + 1, y, Math.max(0, c.w - x - 2), 1, 1);
  y += 1;

  const sideW = bp === 'compact' ? 0 : bp === 'wide' ? 46 : 38;
  const mapW = c.w - sideW;
  const mapH = bottom - y;
  const view = ui?.view ?? 'bubbles';
  const title = `${symbol} · ${view === 'treemap' ? 'TREEMAP' : 'BUBBLES'}${ui?.focus ? ` · zoom ${ui.focus}` : ''}`;
  const mb = c.box(0, y, mapW, mapH, { title, caption: view === 'treemap' ? 'area ∝ share · colour = rule' : 'area ∝ share · colour = rule · ring = linked cluster', focus: true });
  const legendH = bp === 'compact' ? 2 : 1;
  const innerH = mb.h - legendH - 1;

  if (!vm) {
    // loading / unavailable: say so, never draw a fake map
    const lines: Array<[string, Hex]> = [];
    if (!ui) {
      lines.push(['no token: open a token and press M for its bubble map', t.muted]);
    } else if (!entry || entry.state === 'loading') {
      lines.push(['scanning holders…', t.accent]);
      lines.push(['top accounts → owners → owner kinds, then funders + the launch window (Helius)', t.dim]);
    } else {
      const u = unavailableText(entry);
      lines.push([`bubble map unavailable: ${u.reason}`, t.warn]);
      if (u.fix) lines.push([`fix: ${u.fix}`, t.muted]);
      lines.push(['r rescans · esc back', t.dim]);
    }
    let ly = mb.y + Math.max(1, Math.floor(innerH / 2) - lines.length);
    for (const [s, fg] of lines) for (const ln of wrap(s, mb.w - 4)) { if (ly >= mb.y + innerH) break; c.textC(mb.x, ly, mb.w, ln, { fg, bg: mb.bg, i: true }); ly += 1; }
    c.rainZone(mb.x + 1, mb.y, mb.w - 2, Math.max(0, ly - mb.y - lines.length - 1), 2);
  } else if (view === 'treemap') {
    drawTreemap(c, mb.x + 1, mb.y, mb.w - 2, innerH, vm, { bg: mb.bg, selected: ui?.selected ?? null });
  } else {
    const key = `${entry?.at}|${mb.w}|${innerH}|${ui?.focus ?? ''}|${vm.holders.length}`;
    let lay = ui?.layout && ui.layout.key === key ? ui.layout.lay : null;
    if (!lay) { lay = layoutBubbles(vm, mb.w - 2, innerH, { focus: ui?.focus ?? null }); if (ui) ui.layout = { key, lay }; }
    drawBubbles(c, mb.x + 1, mb.y, mb.w - 2, innerH, vm, lay, { bg: mb.bg, selected: ui?.selected ?? null });
    if (lay.overflow) c.text(mb.x + 1, mb.y, 'terminal too small to pack the map: grid view', { fg: t.warn, bg: mb.bg, i: true }, mb.w - 2);
  }
  const ly = mb.y + mb.h - legendH;
  c.hline(mb.x, ly - 1, mb.w, { fg: t.border, bg: mb.bg, soft: true });
  legendRow(c, mb.x + 1, ly, mb.w - 2, mb.bg);
  if (bp === 'compact' && vm && ui?.selected != null && vm.holders[ui.selected]) {
    const hd = vm.holders[ui.selected];
    const first = hd.labels[0];
    const cl0 = hd.cluster ? vm.clusters.find((k) => k.name === hd.cluster) : null;
    const ev0 = cl0 ? cl0.evidence.find((e) => e.linked !== false && (e.a === hd.owner || e.b === hd.owner)) : null;
    let sx = c.text(mb.x + 1, ly + 1, `${shortAddr(hd.owner, 4)} ${hd.pct.toFixed(2)}%`, { fg: t.borderFocus, bg: mb.bg, b: true });
    sx = badge(c, sx + 1, ly + 1, hd.kind.toUpperCase(), kindColor(t, hd.kind), { on: mb.bg });
    c.text(sx + 1, ly + 1, first ? `${first.label}: ${first.rule}` : ev0 ? `linked: ${ev0.rule}` : 'no rule matched · unlinked wallet', { fg: t.muted, bg: mb.bg }, mb.x + mb.w - 2 - sx - 1);
  }

  if (sideW) sidePanels(c, mapW, y, sideW, mapH, vm, entry, ui);
  const hints: Array<[string, string]> = [['esc', 'back'], ['j/k', 'select'], ['m', view === 'treemap' ? 'bubbles' : 'treemap'], ['z', ui?.focus ? 'unzoom' : 'zoom'], ['M', state.popups?.bubblesOpen?.() ? 'close popup' : 'popup'], ['D', 'deep scan'], ['r', 'rescan'], ['q', 'quit']];
  footer(c, hints, t.name, isCalm(state.vfx));
}

function sidePanels(c: Canvas, x: number, y: number, w: number, h: number, vm: BubbleVM | null, entry: IntelEntry | null, ui: IntelUi | null): void {
  const t = c.theme;
  const r = entry?.result?.state === 'ok' ? entry.result : null;
  const clH = Math.max(7, Math.min(12, Math.floor(h * 0.3)));
  const insH = r?.degraded ? 13 : 11; // a degraded (keyless) scan prints its honest note inside the insights panel
  const whyH = h - clH - insH;
  // CLUSTERS
  const cb = c.box(x, y, w, clH, { title: 'CLUSTERS', caption: vm ? `${vm.clusters.length} · ${vm.holders.length} wallets` : '' });
  let cy = cb.y;
  c.text(cb.x + 1, cy, 'ID   KIND        W     %  TOP WALLET', { fg: t.dim, bg: cb.bg }, cb.w - 2);
  cy += 1;
  const selOwner = vm && ui?.selected != null ? vm.holders[ui.selected]?.owner : null;
  const sorted = vm ? vm.clusters.slice().sort((a, b) => b.pct - a.pct) : [];
  for (const cl of sorted) {
    if (cy >= cb.y + cb.h) break;
    const sel = !!selOwner && cl.members.includes(selOwner);
    const rowBg = sel ? t.selBg : cb.bg;
    c.fill(cb.x, cy, cb.w, 1, ' ', { bg: rowBg });
    const color = kindColor(t, cl.kind);
    let cx = c.text(cb.x + 1, cy, cl.name.padEnd(4), { fg: sel ? t.borderFocus : t.text, bg: rowBg, b: sel });
    cx = c.text(cx + 1, cy, `${cl.members.length > 1 ? '●' : '○'} ${cl.kind}`.padEnd(11), { fg: color, bg: rowBg });
    cx = c.textR(cx, cy, 3, String(cl.members.length), { fg: t.muted, bg: rowBg });
    cx = c.textR(cx, cy, 6, `${cl.pct.toFixed(1)}`, { fg: cl.pct >= 10 ? t.warn : t.text, bg: rowBg });
    c.text(cx + 2, cy, shortAddr(cl.members[0], 4), { fg: t.dim, bg: rowBg }, cb.w - (cx + 2 - cb.x) - 1);
    cy += 1;
  }
  if (cy < cb.y + cb.h) c.rainZone(cb.x + 1, cy, cb.w - 2, cb.y + cb.h - cy, 2);
  // HOLDER INSIGHTS (sample-captioned; nulls when the history leg did not run)
  const ib = c.box(x, y + clH, w, insH, { title: 'HOLDER INSIGHTS', caption: 'sample-bounded' });
  let iy = ib.y;
  if (r && vm) {
    const I = r.analysis.insights;
    const hist = I.coverage.launchTxs > 0;
    const fund = I.coverage.fundingLookups > 0;
    const pctS = (v: number | null | undefined) => (v == null ? 'n/a' : `${Number(v).toFixed(1)}%`);
    iy += statGrid(c, ib.x + 1, iy, ib.w - 2, [
      { label: 'top10 raw', value: pctS(I.top10.byTokenAccount), sub: 'by token acct' },
      // task-1367: ex-pool (no POOL/CURVE/VAULT/LOCK/BURN owners) is the headline; the cluster-adjusted figure rides in the sub
      typeof I.top10.exPool === 'number'
        ? { label: 'top10 ex-pool', value: pctS(I.top10.exPool), sub: `adj ${pctS(I.top10.clusterAdjusted)} · -${I.top10.exPoolDropped ?? 0} venue`, style: { fg: I.top10.exPool >= 35 ? t.down : t.accent, b: true } }
        : { label: 'top10 adj', value: pctS(I.top10.clusterAdjusted), sub: `excl ${I.top10.excludedCount} lbl`, style: { fg: t.accent, b: true } },
      { label: 'snipers', value: hist ? String(I.snipers.count) : 'n/a', sub: hist && I.snipers.count ? `${pctS(I.snipers.launchWindowSharePct)} at launch` : hist ? 'first 3 slots' : 'needs history' },
      { label: 'bundled', value: hist ? pctS(I.bundle.bundlePctOfTopSample) : 'n/a', sub: hist ? `${I.bundle.sameSlotCohorts} cohorts` : 'needs history' },
      { label: 'dev', value: I.dev.creatorPctNow != null ? pctS(I.dev.creatorPctNow) : I.dev.creatorUpperBoundPct != null ? `≤${pctS(I.dev.creatorUpperBoundPct)}` : 'n/a', sub: !hist ? 'needs history' : I.dev.creatorPctNow == null ? 'not in sample' : 'now', style: { fg: t.warn, b: true } },
      { label: 'fresh', value: fund ? pctS(I.fresh.freshAtBuyPctOfTopSample) : 'n/a', sub: fund ? `of ${pctS(I.fresh.measuredPct)} meas.` : 'needs history' },
    ], { bg: ib.bg, cols: 2 });
    const big = I.bigHolder;
    if (big) for (const ln of wrap(`⚠ main risk: ${big.tag} ${shortAddr(big.owner, 4)} holds ${big.pct.toFixed(1)}%`, ib.w - 2)) { if (iy >= ib.y + ib.h) break; c.text(ib.x + 1, iy, ln, { fg: t.down, bg: ib.bg, b: true }); iy += 1; }
    if (r.degraded) for (const ln of wrap(`partial: ${r.degraded}`, ib.w - 2)) { if (iy >= ib.y + ib.h) break; c.text(ib.x + 1, iy, ln, { fg: t.warn, bg: ib.bg, i: true }); iy += 1; }
    for (const ln of wrap(sampleCaption(vm, fmtNum), ib.w - 2)) { if (iy >= ib.y + ib.h) break; c.text(ib.x + 1, iy, ln, { fg: t.dim, bg: ib.bg }); iy += 1; }
  } else {
    c.text(ib.x + 1, iy, entry?.state === 'loading' ? 'scanning…' : 'no insights without a holder list', { fg: t.dim, bg: ib.bg, i: true }, ib.w - 2); iy += 1;
  }
  if (iy < ib.y + ib.h) c.rainZone(ib.x + 1, iy, ib.w - 2, ib.y + ib.h - iy, 2);
  // WHY THIS LABEL
  const wb = c.box(x, y + clH + insH, w, whyH, { title: '? WHY THIS LABEL', caption: 'rules, not facts' });
  let wy = wb.y;
  const hd = vm && ui?.selected != null ? vm.holders[ui.selected] ?? null : null;
  if (!hd) { c.text(wb.x + 1, wy, 'select a bubble (j/k) to see the rules behind its colour', { fg: t.dim, bg: wb.bg }, wb.w - 2); return; }
  let hx = c.text(wb.x + 1, wy, shortAddr(hd.owner, 6), { fg: t.borderFocus, bg: wb.bg, b: true });
  hx = c.text(hx + 1, wy, `${hd.pct.toFixed(2)}%`, { fg: t.text, bg: wb.bg, b: true });
  hx = badge(c, hx + 1, wy, hd.kind.toUpperCase(), kindColor(t, hd.kind), { on: wb.bg });
  if (hd.cluster) c.textR(wb.x + 1, wy, wb.w - 2, hd.cluster, { fg: t.muted, bg: wb.bg });
  wy += 1;
  // task-1367: the holder's class (POOL / CURVE / … / UNLABELLED) and the on-chain reason, first
  const cls = r?.analysis.holders.find((h) => h.owner === hd.owner)?.cls ?? null;
  if (cls) {
    const cx2 = badge(c, wb.x + 1, wy, cls.tag, cls.tag === 'UNLABELLED' ? t.muted : cls.tag === 'DEV' || cls.tag === 'LINKED' ? t.warn : t.accent, { on: wb.bg, bold: true });
    const lines = wrap(cls.reason + (cls.lock ? ` · ${cls.lock.unlock ?? cls.lock.note}` : ''), Math.max(8, wb.w - (cx2 - wb.x) - 2));
    for (const [i, ln] of lines.entries()) { if (wy >= wb.y + wb.h) break; c.text(i === 0 ? cx2 + 1 : wb.x + 3, wy, ln, { fg: t.muted, bg: wb.bg }, wb.w - 3); wy += 1; }
  }
  if (hd.funder) { c.text(wb.x + 1, wy, `funded by ${shortAddr(hd.funder.address, 4)}${hd.funder.label ? ` (${hd.funder.label})` : ''}${hd.funder.blockTime ? ` · ${new Date(hd.funder.blockTime * 1000).toISOString().slice(0, 10)}` : ''}`, { fg: t.muted, bg: wb.bg }, wb.w - 2); wy += 1; }
  else if (hd.walletFirstSeen) { c.text(wb.x + 1, wy, `first seen ${new Date(hd.walletFirstSeen * 1000).toISOString().slice(0, 10)} · funder not found in first txs`, { fg: t.muted, bg: wb.bg }, wb.w - 2); wy += 1; }
  else { c.text(wb.x + 1, wy, 'funding not looked up (outside the funded sample)', { fg: t.dim, bg: wb.bg }, wb.w - 2); wy += 1; }
  wy += 1;
  const cl = hd.cluster && vm ? vm.clusters.find((k) => k.name === hd.cluster) : null;
  // a linked holder with no label of its own is explained by its cluster's rule (the evidence lines below say which)
  const rules = hd.labels.length ? hd.labels : cl && cl.members.length > 1
    ? [{ label: `linked · ${cl.kind}`, rule: `no label of its own; linked into ${cl.name} (${cl.members.length} wallets, ${cl.pct.toFixed(1)}%) by the evidence below`, confidence: 'on-chain' }]
    : [{ label: 'unlinked', rule: 'no rule matched: no shared funder, same-slot buy, transfer or creator link found in the sample', confidence: 'n/a' }];
  const ev = cl ? cl.evidence.filter((e) => e.linked !== false && (e.a === hd.owner || e.b === hd.owner)) : [];
  for (const rl of rules) {
    if (wy >= wb.y + wb.h) break;
    c.text(wb.x + 1, wy, '●', { fg: kindColor(t, rl.label === 'LP' || rl.label === 'contract' ? 'pool' : rl.label === 'multi-token-top20' ? 'whale' : rl.label === 'fresh-at-buy' || rl.label === 'same-slot-created' ? 'plain' : rl.label), bg: wb.bg });
    c.text(wb.x + 3, wy, rl.label, { fg: t.text, bg: wb.bg, b: true });
    c.textR(wb.x + 1, wy, wb.w - 2, rl.confidence || '', { fg: rl.confidence === 'seed' ? t.warn : t.dim, bg: wb.bg });
    wy += 1;
    for (const ln of wrap(rl.rule, wb.w - 5)) { if (wy >= wb.y + wb.h) break; c.text(wb.x + 3, wy, ln, { fg: t.muted, bg: wb.bg }); wy += 1; }
  }
  for (const e of ev.slice(0, 3)) {
    if (wy >= wb.y + wb.h) break;
    for (const ln of wrap(`↳ ${shortAddr(e.a, 4)} ↔ ${shortAddr(e.b, 4)}: ${e.rule}`, wb.w - 3)) { if (wy >= wb.y + wb.h) break; c.text(wb.x + 2, wy, ln, { fg: t.dim, bg: wb.bg, i: true }); wy += 1; }
  }
  if (wy + 1 < wb.y + wb.h) {
    c.text(wb.x + 1, wb.y + wb.h - 1, 'labels are heuristics (rule + evidence) · never asserted as fact', { fg: t.dim, bg: wb.bg }, wb.w - 2);
    if (wy < wb.y + wb.h - 2) c.rainZone(wb.x + 1, wy + 1, wb.w - 2, wb.y + wb.h - 2 - wy, 2);
  }
}
