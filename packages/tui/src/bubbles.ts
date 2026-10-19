// @dexterm/tui — terminal BUBBLE MAP (task-1340, lane W3; ported from research/wallet-intel/mock/bubblemap.mjs,
// the renderer behind the approved design mocks (not published)).
//
//   * geometry runs on a half-row PIXEL grid (W cols × 2H half-rows ≈ square pixels) and is drawn with ▀ ▄ █, so
//     bubbles are round at a 1:2 cell aspect without any image protocol; two bubbles sharing a cell = ▀ fg/bg;
//   * area ∝ share of supply (r = k·√pct, k fitted so ≈ 50 % of the panel is ink, lowered 14 % per failed packing,
//     one bubble capped at ~1/5 of the width so a pool vault cannot hide the people); clusters packed greedily
//     (largest first, candidate closest to the centre), members radial around their hub;
//   * colour = the RULE that produced the label, never a judgement: yellow dev, magenta bundle, green linked
//     (orange transfer), red sniper, cyan pool/LP/contract, grey exchange / multi-token whale, dim unlinked;
//   * labels inside bubbles are HARD cells (effects never touch them); bubbles and rings are soft but non-blank,
//     so effects cannot overdraw them either; the selected holder turns phosphor with dotted edges to its mates.
// Everything here is deterministic: the same view model lays out to the same cells.
import type { Canvas } from './canvas.ts';
import { mix, type Hex } from './color.ts';
import type { Theme } from './theme.ts';
import { shortAddr } from './fmt.ts';

export type BubbleKind = 'dev' | 'dev-linked' | 'bundle' | 'funder' | 'transfer' | 'sniper' | 'pool' | 'cex' | 'whale' | 'plain';

export interface BubbleLabel { label: string; rule: string; confidence: string }

export interface BubbleHolder {
  owner: string;
  pct: number;
  labels: BubbleLabel[];
  funder: { address: string; label: string | null; blockTime: number | null } | null;
  walletFirstSeen: number | null;
  /** Cluster name (C1…) when linked, else null. */
  cluster: string | null;
  kind: BubbleKind;
}

export interface BubbleCluster {
  name: string;
  kind: string;
  members: string[];
  pct: number;
  labels: string[];
  evidence: Array<{ a: string; b: string; rule: string; linked: boolean }>;
}

/** The renderer's view model (built by `bubbleVM` from an IntelAnalysis-shaped object). */
export interface BubbleVM {
  symbol: string;
  name: string;
  mint: string;
  holders: BubbleHolder[];
  clusters: BubbleCluster[];
  holderCount: number | null;
  /** Sample caption inputs. */
  coverage: { topHoldersFetched: number; supplyCoveredPct: number; fundingLookups: number; launchTxs: number } | null;
}

export const KIND_LETTER: Record<string, string> = { 'dev-linked': 'D', dev: 'D', bundle: 'B', funder: 'F', transfer: 'T', sniper: 'S', pool: 'P', cex: 'X', whale: 'W', plain: '·' };
export const LEGEND: Array<[BubbleKind, string]> = [['dev', 'dev'], ['bundle', 'bundle'], ['funder', 'linked'], ['sniper', 'sniper'], ['pool', 'pool/LP'], ['cex', 'exchange'], ['plain', 'unlinked']];

export function kindColor(t: Theme, kind: string): Hex {
  switch (kind) {
    case 'dev': case 'dev-linked': return t.warn;
    case 'bundle': return t.pump;
    case 'funder': return t.up;
    case 'transfer': return t.dbc;
    case 'sniper': return t.down;
    case 'pool': return t.accent;
    case 'cex': case 'whale': return t.muted;
    default: return mix(t.panel, t.up, 0.45);
  }
}

/** Display kind of one holder: its cluster's kind when linked, else the strongest of its own labels. */
export function holderKind(labels: readonly { label: string }[], cluster: { members: string[]; kind: string } | null): BubbleKind {
  if (cluster && cluster.members.length > 1 && cluster.kind !== 'single') return cluster.kind as BubbleKind;
  const ls = new Set(labels.map((l) => l.label));
  if (ls.has('dev')) return 'dev';
  if (ls.has('sniper')) return 'sniper';
  if (ls.has('pool') || ls.has('LP') || ls.has('contract') || ls.has('unfunded-authority?')) return 'pool';
  if (ls.has('cex')) return 'cex';
  if (ls.has('multi-token-top20')) return 'whale';
  return 'plain';
}

/** Minimal analysis shape the VM builder reads (IntelAnalysis from @dexterm/data satisfies it structurally). */
export interface AnalysisLike {
  holders: Array<{ owner: string; pct: number; labels: BubbleLabel[]; funder: { address: string; label: string | null; blockTime: number | null } | null; walletFirstSeen: number | null }>;
  clusters: Array<{ name: string; kind: string; members: string[]; pct: number; labels: string[]; evidence: Array<{ a: string; b: string; rule: string; linked: boolean }> }>;
  insights?: { coverage?: { topHoldersFetched: number; supplyCoveredPct: number; fundingLookups: number; launchTxs: number } };
}

export function bubbleVM(a: AnalysisLike, token: { symbol: string; name?: string; mint: string; holderCount?: number | null }): BubbleVM {
  const clusters: BubbleCluster[] = a.clusters.map((c) => ({ name: c.name, kind: c.kind, members: c.members.slice(), pct: c.pct, labels: c.labels ?? [], evidence: c.evidence ?? [] }));
  const byOwner = new Map<string, BubbleCluster>();
  for (const c of clusters) for (const m of c.members) byOwner.set(m, c);
  const holders: BubbleHolder[] = a.holders.map((h) => {
    const c = byOwner.get(h.owner) ?? null;
    return { owner: h.owner, pct: h.pct ?? 0, labels: h.labels ?? [], funder: h.funder ?? null, walletFirstSeen: h.walletFirstSeen ?? null, cluster: c && c.members.length > 1 ? c.name : null, kind: holderKind(h.labels ?? [], c) };
  });
  return { symbol: token.symbol.replace(/^\$/, ''), name: token.name ?? '', mint: token.mint, holders, clusters, holderCount: token.holderCount ?? null, coverage: a.insights?.coverage ?? null };
}

// ---------------------------------------------------------------- layout (pixel space: W × H2, H2 = 2 rows)

interface Member { i: number; r: number }
interface Placed extends Member { dx: number; dy: number }

function placeCluster(members: Member[]): { items: Placed[]; R: number } {
  const hub = members[0];
  const out: Placed[] = [{ ...hub, dx: 0, dy: 0 }];
  if (members.length === 1) return { items: out, R: hub.r + 0.6 };
  let ringR = hub.r;
  let k = 1;
  let maxReach = hub.r;
  while (k < members.length) {
    const ringMembers: Array<{ m: Member; d: number; need: number }> = [];
    const d0 = ringR + 0.8;
    let angleUsed = 0, biggest = 0;
    while (k < members.length) {
      const m = members[k];
      const d = d0 + m.r;
      const need = 2 * Math.asin(Math.min(1, (m.r + 0.35) / d));
      if (ringMembers.length && angleUsed + need > 2 * Math.PI) break;
      ringMembers.push({ m, d, need });
      angleUsed += need; biggest = Math.max(biggest, m.r); k++;
    }
    const slack = Math.max(0, 2 * Math.PI - angleUsed) / ringMembers.length;
    let a = -Math.PI / 2 + (ringMembers.length % 2 ? 0 : slack / 2) + (out.length * 0.37);
    for (const { m, d, need } of ringMembers) {
      a += need / 2 + slack / 2;
      out.push({ ...m, dx: Math.cos(a) * d, dy: Math.sin(a) * d });
      maxReach = Math.max(maxReach, d + m.r);
      a += need / 2 + slack / 2;
    }
    ringR = d0 + 2 * biggest;
  }
  return { items: out, R: maxReach + 0.6 };
}

interface ClusterGeom { key: string; name: string | null; kind: string; pct: number; items: Placed[]; R: number; multi: boolean }
interface PlacedCluster extends ClusterGeom { x: number; y: number }

function packClusters(cls: ClusterGeom[], W: number, H2: number, gap = 1.0): PlacedCluster[] | null {
  const placed: PlacedCluster[] = [];
  const cx0 = W / 2, cy0 = H2 / 2;
  const inside = (x: number, y: number, R: number) => x - R >= 0 && x + R <= W && y - R >= 0 && y + R <= H2;
  const free = (x: number, y: number, R: number) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.R + R + gap - 1e-6);
  for (const c of cls) {
    if (!placed.length) {
      if (!inside(cx0, cy0, c.R)) return null;
      placed.push({ ...c, x: cx0, y: cy0 });
      continue;
    }
    let best: { x: number; y: number } | null = null, bestD = Infinity;
    for (const p of placed) {
      const steps = 48;
      for (let s = 0; s < steps; s++) {
        const th = (s / steps) * 2 * Math.PI;
        const d = p.R + c.R + gap;
        const x = p.x + Math.cos(th) * d, y = p.y + Math.sin(th) * d;
        if (!inside(x, y, c.R) || !free(x, y, c.R)) continue;
        const dd = (x - cx0) ** 2 + ((y - cy0) * 1.15) ** 2;
        if (dd < bestD) { bestD = dd; best = { x, y }; }
      }
    }
    if (!best) return null;
    placed.push({ ...c, x: best.x, y: best.y });
  }
  return placed;
}

export interface Bubble { idx: number; cx: number; cy: number; r: number }
export interface LaidCluster { name: string | null; kind: string; pct: number; cx: number; cy: number; R: number; members: number[]; multi: boolean }
export interface BubbleLayout { bubbles: Bubble[]; clusters: LaidCluster[]; k: number; W: number; H2: number; overflow?: boolean }

/**
 * Lay out holders in a W×H cell area (pixel space W × 2H). `focus` = a cluster name → only that cluster, filling
 * the area (zoom). Falls back to a tiny grid when nothing packs (never throws).
 */
export function layoutBubbles(vm: BubbleVM, W: number, H: number, opts: { focus?: string | null; fill?: number } = {}): BubbleLayout {
  const H2 = H * 2;
  const idxs = vm.holders.map((_, i) => i).filter((i) => !opts.focus || vm.holders[i].cluster === opts.focus);
  if (!idxs.length || W < 4 || H < 2) return { bubbles: [], clusters: [], k: 0, W, H2 };
  const total = idxs.reduce((s, i) => s + Math.max(0.01, vm.holders[i].pct), 0);
  const fill = opts.fill ?? (opts.focus ? 0.62 : 0.5);
  let k = Math.sqrt((fill * W * H2) / (Math.PI * total));
  const rMax = Math.min(W / 5.2, H2 / 2.5);
  for (let iter = 0; iter < 14; iter++) {
    const byCluster = new Map<string, Member[]>();
    for (const i of idxs) {
      const h = vm.holders[i];
      const r = Math.max(1, Math.min(rMax, k * Math.sqrt(Math.max(0.01, h.pct))));
      const key = h.cluster || `single:${i}`;
      const arr = byCluster.get(key) || []; arr.push({ i, r }); byCluster.set(key, arr);
    }
    const cls: ClusterGeom[] = [];
    for (const [key, members] of byCluster) {
      members.sort((a, b) => b.r - a.r);
      const pc = placeCluster(members);
      const c = vm.clusters.find((x) => x.name === key) || null;
      cls.push({ key, name: c ? c.name : null, kind: c ? c.kind : vm.holders[members[0].i].kind, pct: c ? c.pct : vm.holders[members[0].i].pct, items: pc.items, R: pc.R, multi: members.length > 1 });
    }
    cls.sort((a, b) => b.R - a.R);
    const placed = packClusters(cls, W, H2);
    if (placed) {
      const bubbles: Bubble[] = [], clusters: LaidCluster[] = [];
      for (const p of placed) {
        for (const it of p.items) bubbles.push({ idx: it.i, cx: p.x + it.dx, cy: p.y + it.dy, r: it.r });
        clusters.push({ name: p.name, kind: p.kind, pct: p.pct, cx: p.x, cy: p.y, R: p.R, members: p.items.map((it) => it.i), multi: p.multi });
      }
      return { bubbles, clusters, k, W, H2 };
    }
    k *= 0.86;
  }
  const cols = Math.max(1, Math.floor(W / 4));
  const bubbles = idxs.map((i, n) => ({ idx: i, cx: 2 + (n % cols) * 4, cy: 2 + Math.floor(n / cols) * 4, r: 1 }));
  return { bubbles, clusters: [], k, W, H2, overflow: true };
}

// ---------------------------------------------------------------- drawing

const INK: Hex = '#031008';

export interface DrawOpts { bg?: Hex; selected?: number | null }

/** Draw the packed bubbles into the cell area (x, y, w, h). Returns the pixel ownership grid (for hit tests). */
export function drawBubbles(c: Canvas, x: number, y: number, w: number, h: number, vm: BubbleVM, layout: BubbleLayout, opts: DrawOpts = {}): Int16Array {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  const { W, H2 } = layout;
  const pix = new Int16Array(W * H2).fill(-1);
  const colorOf = (i: number): Hex => (i === opts.selected ? t.borderFocus : kindColor(t, vm.holders[i].kind));
  for (const b of layout.bubbles) {
    const r2 = b.r * b.r;
    for (let py = Math.max(0, Math.floor(b.cy - b.r)); py < Math.min(H2, Math.ceil(b.cy + b.r)); py++) {
      for (let px = Math.max(0, Math.floor(b.cx - b.r)); px < Math.min(W, Math.ceil(b.cx + b.r)); px++) {
        const dx = px + 0.5 - b.cx, dy = py + 0.5 - b.cy;
        if (dx * dx + dy * dy <= r2) pix[py * W + px] = b.idx;
      }
    }
  }
  // cluster rings (soft dots on blank cells), drawn before bubbles so bubbles win
  for (const cl of layout.clusters) {
    if (!cl.multi) continue;
    const col = mix(bg, kindColor(t, cl.kind), 0.75);
    for (let s = 0; s < 72; s++) {
      const th = (s / 72) * 2 * Math.PI;
      const px = Math.round(cl.cx + (cl.R + 0.4) * Math.cos(th) - 0.5);
      const py = cl.cy + (cl.R + 0.4) * Math.sin(th);
      if (px < 0 || px >= W || py < 0 || py >= H2) continue;
      const cx = x + px, cy = y + Math.floor(py / 2);
      if (cx >= c.w || cy >= c.h) continue;
      const i = c.idx(cx, cy);
      if (c.ch[i] === ' ' && pix[Math.floor(py) * W + px] === -1) c.put(cx, cy, '·', { fg: col, bg, soft: true });
    }
  }
  // bubbles: pairs of half-rows → ▀ ▄ █
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const top = pix[(2 * row) * W + col], bot = pix[(2 * row + 1) * W + col];
      if (top < 0 && bot < 0) continue;
      const cx = x + col, cy = y + row;
      if (top >= 0 && bot >= 0) {
        if (top === bot) c.put(cx, cy, '█', { fg: colorOf(top), bg, soft: true });
        else c.put(cx, cy, '▀', { fg: colorOf(top), bg: colorOf(bot), soft: true });
      } else if (top >= 0) c.put(cx, cy, '▀', { fg: colorOf(top), bg, soft: true });
      else c.put(cx, cy, '▄', { fg: colorOf(bot), bg, soft: true });
    }
  }
  // dotted edges from the selected holder to its cluster mates (blank cells only)
  if (opts.selected != null) {
    const sb = layout.bubbles.find((b) => b.idx === opts.selected);
    const cl = sb && layout.clusters.find((k) => k.members.includes(opts.selected as number));
    if (sb && cl && cl.multi) {
      for (const m of cl.members) {
        if (m === opts.selected) continue;
        const mb = layout.bubbles.find((b) => b.idx === m);
        if (mb) line(c, x, y, W, H2, pix, sb, mb, t.accent, bg);
      }
    }
  }
  // labels inside bubbles (hard cells)
  for (const b of layout.bubbles) {
    if (b.r < 2.5) continue;
    const hd = vm.holders[b.idx];
    const color = colorOf(b.idx);
    const widthAtCentre = Math.floor(2 * b.r) - 1;
    const row = Math.floor(b.cy / 2);
    const lines: string[] = [];
    const addr = shortAddr(hd.owner, 4);
    const pct = `${hd.pct.toFixed(hd.pct >= 10 ? 1 : 2)}%`;
    if (widthAtCentre >= addr.length) lines.push(addr); else if (widthAtCentre >= pct.length) lines.push(pct);
    if (b.r >= 4 && lines[0] === addr && widthAtCentre >= pct.length) lines.push(pct);
    if (b.r >= 6 && hd.kind !== 'plain') lines.push(hd.kind.toUpperCase().slice(0, widthAtCentre));
    const startRow = row - Math.floor((lines.length - 1) / 2);
    lines.forEach((s, li) => {
      const ry = startRow + li;
      if (ry < 0 || ry >= h) return;
      const x0 = Math.round(b.cx - s.length / 2);
      for (let k = 0; k < s.length; k++) {
        const px = x0 + k;
        if (px < 0 || px >= W) continue;
        if (pix[(2 * ry) * W + px] !== b.idx || pix[(2 * ry + 1) * W + px] !== b.idx) continue; // stay inside the disc
        c.put(x + px, y + ry, s[k], { fg: INK, bg: color, b: li === 0, hard: true });
      }
    });
  }
  // cluster tags (above the ring when there is room, else below), only on blank cells
  for (const cl of layout.clusters) {
    if (!cl.multi) continue;
    const color = kindColor(t, cl.kind);
    const tag = `${KIND_LETTER[cl.kind] || '·'}·${cl.name} ${cl.members.length}w ${cl.pct.toFixed(1)}%`;
    const x0 = Math.round(cl.cx - tag.length / 2);
    const above = Math.floor((cl.cy - cl.R) / 2) - 1, below = Math.floor((cl.cy + cl.R) / 2) + 1;
    for (const ry of [above, below]) {
      if (ry < 0 || ry >= h) continue;
      let ok = x0 >= 0 && x0 + tag.length <= W;
      for (let k = 0; ok && k < tag.length; k++) { const i = c.idx(x + x0 + k, y + ry); if (c.ch[i] !== ' ' && c.ch[i] !== '·') ok = false; }
      if (!ok) continue;
      c.text(x + x0, y + ry, tag, { fg: color, bg, b: true });
      break;
    }
  }
  return pix;
}

function line(c: Canvas, x: number, y: number, W: number, H2: number, pix: Int16Array, a: Bubble, b: Bubble, fg: Hex, bg: Hex): void {
  let x0 = Math.round(a.cx), y0 = Math.round(a.cy / 2);
  const x1 = Math.round(b.cx), y1 = Math.round(b.cy / 2);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; n < 400; n++) {
    if (x0 >= 0 && x0 < W && y0 >= 0 && y0 * 2 < H2) {
      const covered = pix[(2 * y0) * W + x0] !== -1 || pix[(2 * y0 + 1) * W + x0] !== -1;
      const i = c.idx(x + x0, y + y0);
      if (!covered && c.ch[i] === ' ') c.put(x + x0, y + y0, '∙', { fg, bg, soft: true });
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// ---------------------------------------------------------------- treemap (alternate view)

interface TreeItem<T> { item: T; value: number }
function squarify<T>(children: TreeItem<T>[], rect: { x: number; y: number; w: number; h: number }): Array<{ item: T; x: number; y: number; w: number; h: number }> {
  const out: Array<{ item: T; x: number; y: number; w: number; h: number }> = [];
  let i = 0;
  const rem = { ...rect };
  while (i < children.length && rem.w > 0 && rem.h > 0) {
    const vertical = rem.w >= rem.h;
    const side = vertical ? rem.h : rem.w;
    let row: TreeItem<T>[] = [], sum = 0, bestWorst = Infinity;
    while (i < children.length) {
      const v = children[i].value;
      const cand = [...row, children[i]], s = sum + v, thick = s / side;
      let worst = 0;
      for (const ch of cand) { const len = ch.value / thick; worst = Math.max(worst, len / thick, thick / len); }
      if (row.length && worst > bestWorst) break;
      row = cand; sum = s; bestWorst = worst; i++;
    }
    const thick = sum / side;
    let off = 0;
    for (const ch of row) {
      const len = ch.value / thick;
      out.push(vertical ? { item: ch.item, x: rem.x, y: rem.y + off, w: thick, h: len } : { item: ch.item, x: rem.x + off, y: rem.y, w: len, h: thick });
      off += len;
    }
    if (vertical) { rem.x += thick; rem.w -= thick; } else { rem.y += thick; rem.h -= thick; }
  }
  return out;
}

export function drawTreemap(c: Canvas, x: number, y: number, w: number, h: number, vm: BubbleVM, opts: DrawOpts = {}): void {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  const items = vm.clusters.slice().sort((a, b) => b.pct - a.pct).map((cl) => ({ item: cl, value: Math.max(0.05, cl.pct) }));
  const total = items.reduce((s, it) => s + it.value, 0);
  if (!total) return;
  const area = w * (h * 2);
  for (const it of items) it.value = (it.value / total) * area;
  const rects = squarify(items, { x: 0, y: 0, w, h: h * 2 });
  for (const r of rects) {
    const rx = Math.round(r.x), ry = Math.round(r.y / 2);
    const rw = Math.max(1, Math.round(r.x + r.w) - rx), rh = Math.max(1, Math.round((r.y + r.h) / 2) - ry);
    if (rx >= w || ry >= h) continue;
    const cl = r.item;
    const sel = opts.selected != null && cl.members.includes(vm.holders[opts.selected]?.owner);
    const color = sel ? t.borderFocus : kindColor(t, cl.kind);
    const fillBg = mix(bg, color, sel ? 0.4 : 0.22);
    c.fill(x + rx, y + ry, Math.min(rw, w - rx), Math.min(rh, h - ry), ' ', { bg: fillBg });
    for (let k = 0; k < Math.min(rh, h - ry); k++) c.put(x + rx, y + ry + k, '▌', { fg: color, bg: fillBg, soft: true });
    if (rw >= 6) {
      const head = cl.members.length > 1 ? `${KIND_LETTER[cl.kind] || '·'}·${cl.name}` : shortAddr(cl.members[0], 3);
      c.text(x + rx + 1, y + ry, head, { fg: color, bg: fillBg, b: true }, Math.min(rw, w - rx) - 1);
      if (rh >= 2) c.text(x + rx + 1, y + ry + 1, `${cl.pct.toFixed(1)}%${cl.members.length > 1 ? ` ${cl.members.length}w` : ''}`, { fg: t.text, bg: fillBg }, Math.min(rw, w - rx) - 1);
    }
  }
}

/** The legend row: glyph + word per kind (colour-blind second encoding). Returns the x after the last entry. */
export function legendRow(c: Canvas, x: number, y: number, w: number, bg: Hex): number {
  const t = c.theme;
  let cx = x;
  for (const [kind, word] of LEGEND) {
    const s = `${kind === 'plain' ? '○' : '●'} ${word}  `;
    if (cx + s.length > x + w) break;
    cx = c.text(cx, y, s, { fg: kindColor(t, kind), bg });
  }
  return cx;
}

/** "sample top 20 accts of 142.5K holders · 55 % supply · launch 300 txs" (every people-metric prints its sample). */
export function sampleCaption(vm: BubbleVM, fmtNum: (n: number) => string): string {
  const cov = vm.coverage;
  if (!cov) return 'sample unknown';
  return `sample top ${cov.topHoldersFetched} accts${vm.holderCount ? ` of ${fmtNum(vm.holderCount)} holders` : ''} · ${cov.supplyCoveredPct}% supply · funders ${cov.fundingLookups}/${cov.topHoldersFetched} · launch ${cov.launchTxs} txs`;
}

/** The holder index under a cell (x, y) of the drawn map, or -1 (hover / click hit test). */
export function holderAt(pix: Int16Array, W: number, col: number, row: number): number {
  const top = pix[(2 * row) * W + col], bot = pix[(2 * row + 1) * W + col];
  return top >= 0 ? top : bot >= 0 ? bot : -1;
}
