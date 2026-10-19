// task-1358 Tier 1 — layout solver: exact tiling, priority drops, breakpoints, and the renderer numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, builtinScreens, treeFor, renderPlain, breakpoint, type Tree } from '../src/layout.ts';
import { layoutNumbers, defaultWorkspace, morningHudWorkspace, validateWorkspace, captureWorkspace } from '../src/workspace.ts';

function coverage(panesAndGutters: Array<{ x: number; y: number; w: number; h: number }>, w: number, h: number): { covered: number; overlaps: number } {
  const grid = new Uint8Array(w * h);
  let overlaps = 0;
  for (const r of panesAndGutters) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { if (grid[y * w + x]) overlaps++; grid[y * w + x] = 1; }
  return { covered: grid.reduce((a, b) => a + b, 0), overlaps };
}

test('the builtin screener tree tiles exactly at every size and drops the spotlight below wide', () => {
  const tree = treeFor(builtinScreens().screener, 'wide') as Tree;
  for (const [w, h] of [[176, 45], [121, 37], [97, 29], [80, 24], [200, 60]] as const) {
    const s = solve(tree, { x: 0, y: 0, w, h });
    const { covered, overlaps } = coverage([...s.panes.map((p) => p.rect), ...s.gutters], w, h);
    assert.equal(overlaps, 0, `${w}×${h} overlaps`);
    assert.equal(covered, w * h, `${w}×${h} covered ${covered}`);
    const spot = s.panes.find((p) => p.widget === 'screener.spotlight');
    if (breakpoint(w) === 'wide') { assert.ok(spot, 'spotlight present at wide'); assert.equal(spot!.rect.w, 44); }
    else { assert.equal(spot, undefined); assert.ok(s.dropped.some((d) => d.widget === 'screener.spotlight' && /collapsed/.test(d.reason))); }
  }
});

test('a split that cannot fit drops the highest-priority LEAF of the overflowing child, never an innocent sibling', () => {
  const tree: Tree = { kind: 'split', dir: 'row', children: [
    { node: { kind: 'pane', widget: 'screener.table', priority: 0 } },
    { node: { kind: 'split', dir: 'col', children: [
      { node: { kind: 'pane', widget: 'alerts.log', priority: 1 } },
      { node: { kind: 'pane', widget: 'analyst.digest', priority: 5 } },
    ] }, fixed: 42 },
  ] };
  // 42 wide × 9 tall: the right column needs 5 + 6 = 11 rows → the digest (priority 5) goes, the alerts log stays
  const s = solve(tree, { x: 0, y: 0, w: 110, h: 9 });
  assert.ok(s.panes.some((p) => p.widget === 'alerts.log'));
  assert.ok(!s.panes.some((p) => p.widget === 'analyst.digest'));
  assert.ok(s.panes.some((p) => p.widget === 'screener.table'), 'the table is never dropped for a sibling overflow');
  assert.ok(s.dropped.find((d) => d.widget === 'analyst.digest')?.reason.includes('priority 5'));
});

test('priority 0 never drops: it is solved clipped', () => {
  const s = solve({ kind: 'pane', widget: 'screener.table', priority: 0 }, { x: 0, y: 0, w: 20, h: 3 });
  assert.equal(s.panes.length, 1);
  assert.equal(s.panes[0].clipped, true);
});

test('weights share with largest-remainder rounding (no seam, sums exact)', () => {
  const tree: Tree = { kind: 'split', dir: 'col', children: [
    { node: { kind: 'pane', widget: 'rain.zone' }, weight: 1 }, { node: { kind: 'pane', widget: 'rain.zone' }, weight: 1 }, { node: { kind: 'pane', widget: 'rain.zone' }, weight: 1 },
  ] };
  const s = solve(tree, { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(s.panes.map((p) => p.rect.h), [4, 3, 3]);
  assert.equal(s.panes.map((p) => p.rect.h).reduce((a, b) => a + b, 0), 10);
});

test('renderPlain draws boxes with titles (used by previews and proposal cards)', () => {
  const s = solve(treeFor(builtinScreens().screener, 'wide') as Tree, { x: 0, y: 0, w: 176, h: 20 });
  const txt = renderPlain(s, 176, 20);
  assert.ok(txt.includes('SCREENER'));
  assert.ok(txt.includes('SPOTLIGHT'));
  assert.ok(txt.includes('·'), 'the gutter rains');
});

test('the default workspace yields the renderers\' historical numbers at every breakpoint', () => {
  const d = defaultWorkspace();
  assert.deepEqual(validateWorkspace(d), []);
  assert.deepEqual(layoutNumbers(d, 176, 45), { spotlightW: 44, pairSpotlightW: 46, chartFrac: 0.46, analystW: Math.max(46, Math.floor(176 * 0.34)) });
  assert.deepEqual(layoutNumbers(d, 120, 40), { spotlightW: 0, pairSpotlightW: 0, chartFrac: 0.46, analystW: 40 });
  assert.deepEqual(layoutNumbers(d, 90, 30), { spotlightW: 0, pairSpotlightW: 0, chartFrac: 0.46, analystW: 0 });
  assert.deepEqual(layoutNumbers(null, 176, 45), layoutNumbers(d, 176, 45));
});

test('a workspace with trees changes the numbers: wider spotlight, taller chart', () => {
  const ws = { name: 'big', screens: { ...builtinScreens() } };
  const scr = ws.screens.screener as Extract<Tree, { kind: 'split' }>;
  scr.children[1].fixed = 60;
  const tok = ws.screens.token as Extract<Tree, { kind: 'split' }>;
  ((tok.children[0].node as Extract<Tree, { kind: 'split' }>).children[0]).weight = 70;
  ((tok.children[0].node as Extract<Tree, { kind: 'split' }>).children[1]).weight = 30;
  assert.deepEqual(validateWorkspace(ws), []);
  const n = layoutNumbers(ws, 176, 45);
  assert.equal(n.spotlightW, 60);
  assert.ok(n.chartFrac > 0.6 && n.chartFrac <= 0.75, `chartFrac ${n.chartFrac}`);
  assert.equal(n.analystW, 46);
  // at 120 cols the spotlight collapses and the analyst panel (collapseBelow standard) still shows
  assert.equal(layoutNumbers(ws, 120, 40).spotlightW, 0);
  assert.equal(layoutNumbers(ws, 120, 40).analystW, 46);
});

test('the morning HUD validates, starts on the narrative board and opens narrative + plans + chart popups', () => {
  const m = morningHudWorkspace();
  assert.deepEqual(validateWorkspace(m), []);
  assert.equal(m.start, 'narrative');
  assert.deepEqual(m.popups?.map((p) => p.kind), ['narrative', 'feeds', 'plans', 'chart']);
  assert.equal(m.screener?.preset, 'trench');
});

test('captureWorkspace builds a valid document from the screen and refuses a bad name', () => {
  const ws = captureWorkspace('evening', { screen: 'token', theme: 'ember', intensity: 'normal', screener: { preset: 'trenches', filter: 'liq > 10K', sort: 'vol24:desc' }, token: { tape: true }, popups: ['chart', 'narrative'] });
  assert.deepEqual(validateWorkspace(ws), []);
  assert.equal(ws.start, 'token');
  assert.deepEqual(ws.popups, [{ kind: 'chart', mint: 'selected' }, { kind: 'narrative' }]);
  assert.throws(() => captureWorkspace('Bad Name!', { screen: 'screener', theme: 'cyberspace', intensity: 'fever' }), /name/);
});
