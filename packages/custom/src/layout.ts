// @dexterm/custom — layout engine (task-1358, from the task-1288 design): a pane tree (splits + widget panes)
// solved into integer rects for a screen size and breakpoint. Deterministic, pure, no canvas dependency.
//
// Rules (they mirror the SPEC §7.4 column-drop rule so users get one mental model):
//   * breakpoints: compact < 100 cols, standard < 140, wide ≥ 140 (same as @dexterm/tui);
//   * a pane with collapseBelow: 'wide' is dropped at standard/compact, etc.;
//   * every widget has a minimum size; when a split cannot give every child its minimum, the LEAF with the
//     highest priority number among the overflowing children is dropped and the split re-solved (priority 0
//     never drops: it is solved anyway and the renderer clips);
//   * fixed sizes come first, the remainder is shared by weight with largest-remainder rounding so the
//     rects tile exactly (no 1-cell seams); an optional 1-cell gutter between children rains.
import { BUILTIN_WIDGETS, type WidgetSpec } from './schema.ts';

export type Breakpoint = 'compact' | 'standard' | 'wide';
export function breakpoint(w: number): Breakpoint { return w < 100 ? 'compact' : w < 140 ? 'standard' : 'wide'; }
const BP_RANK: Record<Breakpoint, number> = { compact: 0, standard: 1, wide: 2 };

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pane { kind: 'pane'; widget: string; priority?: number; collapseBelow?: Breakpoint; title?: string; settings?: Record<string, unknown> }
export interface SplitChild { node: Tree; weight?: number; fixed?: number }
export interface Split { kind: 'split'; dir: 'row' | 'col'; children: SplitChild[]; gutter?: boolean }
export type Tree = Pane | Split;
export type ScreenLayout = Tree | { wide?: Tree; standard?: Tree; compact?: Tree };

export interface SolvedPane { widget: string; rect: Rect; node: Pane; clipped?: boolean }
export interface Solved { panes: SolvedPane[]; dropped: Array<{ widget: string; reason: string }>; gutters: Rect[]; breakpoint: Breakpoint }

export function widgetSpec(id: string, registry: Record<string, WidgetSpec> = {}): WidgetSpec | null {
  return BUILTIN_WIDGETS[id] ?? registry[id] ?? null;
}

/** Pick the tree for this breakpoint: per-breakpoint object (nearest smaller defined, else larger) or the single tree. */
export function treeFor(layout: ScreenLayout | undefined | null, bp: Breakpoint): Tree | null {
  if (!layout) return null;
  if ('kind' in layout) return layout;
  const order: Breakpoint[] = ['wide', 'standard', 'compact'];
  const start = order.indexOf(bp);
  for (let i = start; i < order.length; i++) { const t = layout[order[i]]; if (t) return t; }
  for (let i = start - 1; i >= 0; i--) { const t = layout[order[i]]; if (t) return t; }
  return null;
}

function visible(node: Tree, bp: Breakpoint): boolean {
  if (node.kind === 'pane') return !node.collapseBelow || BP_RANK[bp] >= BP_RANK[node.collapseBelow];
  return node.children.some((c) => visible(c.node, bp));
}

/** Minimum size a node needs (sum along its axis, max across), ignoring collapsed children. */
function minSize(node: Tree, bp: Breakpoint, registry: Record<string, WidgetSpec>): { w: number; h: number } {
  if (node.kind === 'pane') {
    const spec = widgetSpec(node.widget, registry);
    return spec ? { ...spec.min } : { w: 10, h: 3 };
  }
  const kids = node.children.filter((c) => visible(c.node, bp));
  const g = node.gutter ? Math.max(0, kids.length - 1) : 0;
  let along = g, across = 0;
  for (const c of kids) {
    const m = minSize(c.node, bp, registry);
    if (node.dir === 'row') { along += c.fixed ?? m.w; across = Math.max(across, m.h); }
    else { along += c.fixed ?? m.h; across = Math.max(across, m.w); }
  }
  return node.dir === 'row' ? { w: along, h: across } : { w: across, h: along };
}

/** Largest-remainder share of `total` by weights after fixed sizes; integer sizes that sum to total. */
function share(children: SplitChild[], total: number): number[] {
  const fixedSum = children.reduce((s, c) => s + (c.fixed ?? 0), 0);
  const flex = children.filter((c) => c.fixed === undefined);
  const wsum = flex.reduce((s, c) => s + (c.weight ?? 1), 0) || 1;
  const remain = Math.max(0, total - fixedSum);
  const sizes = children.map((c) => (c.fixed !== undefined ? Math.min(c.fixed, total) : 0));
  const raw = flex.map((c) => (remain * (c.weight ?? 1)) / wsum);
  const floors = raw.map(Math.floor);
  let left = remain - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - floors[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; floors[i] += 1; left -= 1; }
  let fi = 0;
  for (let i = 0; i < children.length; i++) if (children[i].fixed === undefined) sizes[i] = floors[fi++];
  // if fixed sizes overflow, trim from the last fixed child
  let over = sizes.reduce((a, b) => a + b, 0) - total;
  for (let i = children.length - 1; i >= 0 && over > 0; i--) { const cut = Math.min(over, sizes[i]); sizes[i] -= cut; over -= cut; }
  return sizes;
}

/** Solve a tree into panes for `rect`. */
export function solve(tree: Tree, rect: Rect, opts: { breakpoint?: Breakpoint; registry?: Record<string, WidgetSpec> } = {}): Solved {
  const bp = opts.breakpoint ?? breakpoint(rect.w);
  const registry = opts.registry ?? {};
  const out: Solved = { panes: [], dropped: [], gutters: [], breakpoint: bp };
  solveNode(tree, rect, bp, registry, out);
  return out;
}

function solveNode(node: Tree, rect: Rect, bp: Breakpoint, registry: Record<string, WidgetSpec>, out: Solved): void {
  if (!visible(node, bp)) { collect(node, (p) => out.dropped.push({ widget: p.widget, reason: `collapsed below ${p.collapseBelow}` })); return; }
  if (node.kind === 'pane') {
    const m = minSize(node, bp, registry);
    if (rect.w < m.w || rect.h < m.h) {
      if ((node.priority ?? 1) === 0) out.panes.push({ widget: node.widget, rect, node, clipped: true });
      else out.dropped.push({ widget: node.widget, reason: `needs ${m.w}×${m.h}, has ${rect.w}×${rect.h}` });
      return;
    }
    out.panes.push({ widget: node.widget, rect, node });
    return;
  }
  for (const c of node.children) if (!visible(c.node, bp)) collect(c.node, (p) => out.dropped.push({ widget: p.widget, reason: `collapsed below ${p.collapseBelow}` }));
  let kids = node.children.filter((c) => visible(c.node, bp));
  // Drop the highest-priority LEAF among the children that actually overflow (never an innocent sibling)
  // until the minimums fit. Across-axis overflow (a child too tall for a row) is resolved inside that child;
  // along-axis overflow (the sum too wide) may take a leaf from any child.
  for (;;) {
    const need = minSize({ ...node, children: kids }, bp, registry);
    const fits = need.w <= rect.w && need.h <= rect.h;
    if (fits || kids.length === 0) break;
    const across = node.dir === 'row' ? 'h' : 'w';
    const over = kids.filter((c) => minSize(c.node, bp, registry)[across] > rect[across]);
    const victim = highestLeaf({ ...node, children: over.length ? over : kids });
    if (!victim || (victim.priority ?? 1) === 0) break;
    out.dropped.push({ widget: victim.widget, reason: `no room at ${rect.w}×${rect.h} (priority ${victim.priority ?? 1})` });
    kids = kids.map((c) => ({ ...c, node: removeLeaf(c.node, victim) })).filter((c): c is SplitChild => c.node !== null);
  }
  if (!kids.length) return;
  const g = node.gutter ? 1 : 0;
  const along = node.dir === 'row' ? rect.w : rect.h;
  const sizes = share(kids, along - g * (kids.length - 1));
  let pos = node.dir === 'row' ? rect.x : rect.y;
  kids.forEach((c, i) => {
    const r: Rect = node.dir === 'row' ? { x: pos, y: rect.y, w: sizes[i], h: rect.h } : { x: rect.x, y: pos, w: rect.w, h: sizes[i] };
    if (r.w > 0 && r.h > 0) solveNode(c.node, r, bp, registry, out);
    pos += sizes[i];
    if (g && i < kids.length - 1) { out.gutters.push(node.dir === 'row' ? { x: pos, y: rect.y, w: 1, h: rect.h } : { x: rect.x, y: pos, w: rect.w, h: 1 }); pos += 1; }
  });
}

/** The pane with the highest priority number in a subtree (ties: the later one in document order). */
function highestLeaf(node: Tree): Pane | null {
  let best: Pane | null = null;
  collect(node, (p) => { if (!best || (p.priority ?? 1) >= (best.priority ?? 1)) best = p; });
  return best;
}
/** Remove one pane (by identity) from a subtree; splits left with no children collapse to null. */
function removeLeaf(node: Tree, leaf: Pane): Tree | null {
  if (node.kind === 'pane') return node === leaf ? null : node;
  const children = node.children.map((c) => ({ ...c, node: removeLeaf(c.node, leaf) })).filter((c): c is SplitChild => c.node !== null);
  return children.length ? { ...node, children } : null;
}
function collect(node: Tree, fn: (p: Pane) => void): void { if (node.kind === 'pane') fn(node); else node.children.forEach((c) => collect(c.node, fn)); }

/** Every widget id a tree references (for validation against the registry). */
export function widgetsIn(node: Tree): string[] { const ids: string[] = []; collect(node, (p) => ids.push(p.widget)); return ids; }

// ------------------------------------------------------------------ plain-text render (previews, tests, proposal cards)
export function renderPlain(solved: Solved, w: number, h: number, opts: { registry?: Record<string, WidgetSpec> } = {}): string {
  const grid: string[][] = Array.from({ length: h }, () => Array<string>(w).fill(' '));
  const put = (x: number, y: number, s: string): void => { for (let i = 0; i < s.length; i++) if (x + i >= 0 && x + i < w && y >= 0 && y < h) grid[y][x + i] = s[i]; };
  for (const gt of solved.gutters) for (let y = gt.y; y < gt.y + gt.h; y++) for (let x = gt.x; x < gt.x + gt.w; x++) if (x < w && y < h) grid[y][x] = '·';
  for (const p of solved.panes) {
    const { x, y, w: pw, h: ph } = p.rect;
    if (pw < 2 || ph < 2) continue;
    put(x, y, '╭' + '─'.repeat(pw - 2) + '╮');
    for (let yy = y + 1; yy < y + ph - 1; yy++) { put(x, yy, '│'); put(x + pw - 1, yy, '│'); }
    put(x, y + ph - 1, '╰' + '─'.repeat(pw - 2) + '╯');
    const spec = widgetSpec(p.widget, opts.registry ?? {});
    const title = ` ${(p.node.title ?? spec?.title ?? p.widget).toUpperCase()} `;
    if (title.trim()) put(x + 2, y, title.slice(0, Math.max(0, pw - 4)));
    const info = `${p.widget} ${pw}×${ph}${p.clipped ? ' (clipped)' : ''}`;
    put(x + 2, y + 1, info.slice(0, Math.max(0, pw - 4)));
  }
  return grid.map((r) => r.join('')).join('\n');
}

/** The app's shipped screens expressed as trees (so "default" is a workspace too, and the numbers are the renderers'). */
export function builtinScreens(): Record<string, ScreenLayout> {
  return {
    screener: { kind: 'split', dir: 'row', gutter: true, children: [
      { node: { kind: 'pane', widget: 'screener.table', priority: 0 } },
      { node: { kind: 'pane', widget: 'screener.spotlight', priority: 2, collapseBelow: 'wide' }, fixed: 44 },
    ] },
    token: { kind: 'split', dir: 'row', children: [
      { node: { kind: 'split', dir: 'col', children: [
        { node: { kind: 'pane', widget: 'token.chart', priority: 0 }, weight: 46 },
        { node: { kind: 'split', dir: 'row', children: [
          { node: { kind: 'pane', widget: 'token.onchain', priority: 1 }, weight: 40 },
          { node: { kind: 'pane', widget: 'token.flow', priority: 2 }, weight: 60 },
        ] }, weight: 54 },
      ] } },
      { node: { kind: 'pane', widget: 'analyst.panel', priority: 3, collapseBelow: 'standard' }, fixed: 46 },
    ] },
    newpairs: { kind: 'split', dir: 'row', gutter: true, children: [
      { node: { kind: 'pane', widget: 'newpairs.table', priority: 0 } },
      { node: { kind: 'pane', widget: 'newpairs.spotlight', priority: 2, collapseBelow: 'wide' }, fixed: 46 },
    ] },
    watchlist: { kind: 'pane', widget: 'watchlist.table', priority: 0 },
    analyst: { kind: 'split', dir: 'row', children: [
      { node: { kind: 'pane', widget: 'analyst.panel', priority: 0 } },
      { node: { kind: 'pane', widget: 'analyst.context', priority: 2, collapseBelow: 'wide' }, fixed: 36 },
    ] },
    positions: { kind: 'pane', widget: 'positions.table', priority: 0 },
  };
}
