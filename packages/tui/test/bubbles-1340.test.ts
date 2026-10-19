// task-1340 bubble map renderer: deterministic layout, discs inside the panel and non-overlapping, labels are hard
// cells inside their disc, colour = rule, the treemap and legend render, and the fixture from the approved mocks
// lays out at 176 / 120 / 90 columns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas, THEMES, bubbleVM, layoutBubbles, drawBubbles, drawTreemap, legendRow, kindColor, holderKind, sampleCaption, holderAt, fmtNum } from '../src/index.ts';
import { addr, fixture } from './bubbles-fixture.ts';

const T = THEMES.cyberspace;
const VM = () => bubbleVM(fixture(), { symbol: 'VOID', name: 'void protocol', mint: '7VoiDfix7ureMint000000000000000000000pump', holderCount: 1842 });

test('bubbleVM: holder kinds follow the cluster when linked, else the strongest own label; seed labels keep their text', () => {
  const vm = VM();
  const kindOf = (o: string) => vm.holders.find((h) => h.owner === o)!.kind;
  assert.equal(kindOf(addr(3)), 'pool');
  assert.equal(kindOf(addr(1)), 'dev-linked', 'the dev sits in the dev-linked cluster');
  assert.equal(kindOf(addr(10)), 'bundle');
  assert.equal(kindOf(addr(5)), 'sniper');
  assert.equal(kindOf(addr(4)), 'cex');
  assert.equal(kindOf(addr(22)), 'whale');
  assert.equal(kindOf(addr(16)), 'funder');
  assert.equal(kindOf(addr(18)), 'transfer');
  assert.equal(kindOf(addr(20)), 'plain');
  assert.match(vm.holders.find((h) => h.owner === addr(4))!.labels[0].rule, /unverified/);
  assert.equal(holderKind([{ label: 'LP' }], null), 'pool');
  assert.equal(holderKind([], { members: ['a'], kind: 'single' }), 'plain');
  assert.equal(sampleCaption(vm, fmtNum), 'sample top 32 accts of 1.84K holders · 68.4% supply · funders 18/32 · launch 300 txs');
});

for (const [W, H] of [[176, 48], [120, 42], [90, 36]] as const) {
  test(`layout ${W}×${H}: every holder gets a disc inside the panel, discs never overlap, linked members sit inside their ring, deterministic`, () => {
    const vm = VM();
    const w = W - (W >= 140 ? 46 : W >= 100 ? 38 : 0) - 2, h = H - 8;
    const lay = layoutBubbles(vm, w, h);
    assert.equal(lay.overflow, undefined, 'packed without the grid fallback');
    assert.equal(lay.bubbles.length, vm.holders.length);
    for (const b of lay.bubbles) {
      assert.ok(b.cx - b.r >= -1e-6 && b.cx + b.r <= lay.W + 1e-6, `x inside ${b.idx}`);
      assert.ok(b.cy - b.r >= -1e-6 && b.cy + b.r <= lay.H2 + 1e-6, `y inside ${b.idx}`);
      assert.ok(b.r >= 1);
    }
    for (let i = 0; i < lay.bubbles.length; i++) for (let j = i + 1; j < lay.bubbles.length; j++) {
      const a = lay.bubbles[i], b = lay.bubbles[j];
      assert.ok(Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.r + b.r - 0.4, `discs ${a.idx} and ${b.idx} overlap`);
    }
    for (const cl of lay.clusters) for (const m of cl.members) { const b = lay.bubbles.find((x) => x.idx === m)!; assert.ok(Math.hypot(b.cx - cl.cx, b.cy - cl.cy) + b.r <= cl.R + 1e-6, 'member inside its ring'); }
    // area ∝ share: the pool (21.8 %) is the biggest disc but capped at ~1/5 of the width
    const pool = lay.bubbles.find((b) => vm.holders[b.idx].owner === addr(3))!;
    assert.ok(lay.bubbles.every((b) => b.r <= pool.r + 1e-9));
    assert.ok(pool.r <= Math.min(w / 5.2, (h * 2) / 2.5) + 1e-9);
    assert.deepEqual(layoutBubbles(vm, w, h), lay, 'deterministic');
    const zoom = layoutBubbles(vm, w, h, { focus: 'C1' });
    assert.equal(zoom.bubbles.length, 6, 'zoom shows one cluster');
  });
}

test('draw: ▀▄█ discs, hard labels only inside their own disc, colour = rule, rings + tags on blank cells, selection turns phosphor', () => {
  const vm = VM();
  const w = 128, h = 40;
  const c = new Canvas(w + 2, h + 2, T);
  c.fill(0, 0, c.w, c.h, ' ', { bg: T.panel });
  const lay = layoutBubbles(vm, w, h);
  const sel = vm.holders.findIndex((hd) => hd.owner === addr(10));
  const pix = drawBubbles(c, 1, 1, w, h, vm, lay, { bg: T.panel, selected: sel });
  let discCells = 0, hardCells = 0;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const i = c.idx(1 + col, 1 + row);
    const ch = c.ch[i];
    const owner = holderAt(pix, lay.W, col, row);
    if (ch === '▀' || ch === '▄' || ch === '█') { discCells++; assert.ok(owner >= 0, 'a block glyph sits on a disc'); assert.equal(c.hard[i], 0, 'disc glyphs are soft'); }
    if (c.hard[i]) {
      if (owner >= 0) {
        hardCells++;
        const kind = vm.holders[owner].kind;
        const expect = owner === sel ? T.borderFocus : kindColor(T, kind);
        assert.equal(c.bg[i], expect, 'label bg is the disc colour (= the rule)');
      } else {
        assert.equal(c.bg[i], T.panel, `a hard cell outside every disc (${col},${row}) is a cluster tag on a blank cell`);
      }
    }
  }
  assert.ok(discCells > w * h * 0.3, `≈50 % ink target, got ${(discCells / (w * h) * 100).toFixed(0)} %`);
  assert.ok(hardCells > 20, 'labels drawn');
  const plain = c.toPlain();
  // cluster tags land only where a whole row is blank (above or below the ring); at this size at least two fit
  const tags = plain.match(/[BDFT]·C\d \dw \d+\.\d%/g) ?? [];
  assert.ok(tags.length >= 2, `cluster tags drawn: ${tags.join(' | ')}`);
  assert.ok(tags.some((t) => /^[FT]·C[34] 2w 2\.[01]%$/.test(t)), 'the small linked pairs get their tag');
  assert.match(plain, /∙/, 'dotted edges from the selected holder to its mates');
  // the selected bubble's cells are phosphor
  const sb = lay.bubbles.find((b) => b.idx === sel)!;
  const i = c.idx(1 + Math.floor(sb.cx), 1 + Math.floor(sb.cy / 2));
  assert.ok(c.fg[i] === T.borderFocus || c.bg[i] === T.borderFocus);
  // legend + treemap render without throwing and name the rules
  const lx = legendRow(c, 1, c.h - 1, c.w - 2, T.panel);
  assert.ok(lx > 40);
  assert.match(c.rowPlain(c.h - 1), /● dev {2}● bundle {2}● linked {2}● sniper {2}● pool\/LP {2}● exchange {2}○ unlinked/);
  const tm = new Canvas(120, 40, T);
  drawTreemap(tm, 0, 0, 120, 40, vm, { selected: sel });
  assert.match(tm.toPlain(), /B·C1/);
  assert.match(tm.toPlain(), /21\.8%/);
});

test('degenerate inputs never throw: no holders, a 1-holder token, a tiny panel', () => {
  const empty = bubbleVM({ holders: [], clusters: [] }, { symbol: 'X', mint: 'm' });
  assert.deepEqual(layoutBubbles(empty, 50, 20).bubbles, []);
  const one = bubbleVM({ holders: [{ owner: addr(1), pct: 99, labels: [], funder: null, walletFirstSeen: null }], clusters: [{ name: 'C1', kind: 'single', members: [addr(1)], pct: 99, labels: [], evidence: [] }] }, { symbol: 'X', mint: 'm' });
  const l1 = layoutBubbles(one, 50, 20);
  assert.equal(l1.bubbles.length, 1);
  const c = new Canvas(52, 22, T);
  drawBubbles(c, 1, 1, 50, 20, one, l1);
  const tiny = layoutBubbles(VM(), 6, 3);
  assert.equal(tiny.bubbles.length, VM().holders.length, 'grid fallback keeps every holder');
  assert.equal(tiny.overflow, true);
});
