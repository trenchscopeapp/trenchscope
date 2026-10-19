// task-1340: the bubble-map page's pure helpers (src/pages/bubbles-lib.js) loaded exactly as the page gets them
// (one script, attaches window.DTBubbles) through node:vm; plus the server serves the new page kind.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { createPopupServer, POPUP_EVENTS } from '../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src', 'pages', 'bubbles-lib.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(): any { const win: Record<string, unknown> = {}; vm.runInNewContext(src, { window: win }); return win.DTBubbles; }
const B = load();
const T = { bg: '#020507', panel: '#03090c', border: '#0c3a24', borderFocus: '#39ff14', text: '#eafff0', muted: '#62c98a', dim: '#3aa866', accent: '#00f0ff', up: '#5dff6e', down: '#ff3b6b', warn: '#f5ff2d', ai: '#d97757', pump: '#ff2bd6', dbc: '#ff8a3d' };

const holders = [
  { owner: 'P'.repeat(44), pct: 21.8, kind: 'pool', labels: [{ label: 'pool', rule: 'P1', confidence: 'on-chain' }], funder: null, walletFirstSeen: null, cluster: null },
  { owner: 'D'.repeat(44), pct: 4.1, kind: 'dev-linked', labels: [{ label: 'dev', rule: 'D1', confidence: 'on-chain' }], funder: null, walletFirstSeen: null, cluster: 'C2' },
  { owner: 'E'.repeat(44), pct: 2.2, kind: 'dev-linked', labels: [], funder: { address: 'D'.repeat(44), label: null, blockTime: 1_700_000_000 }, walletFirstSeen: 1_700_000_000, cluster: 'C2' },
  ...[2.6, 2.4, 2.1, 1.8].map((pct, i) => ({ owner: `B${i}`.padEnd(44, 'b'), pct, kind: 'bundle', labels: [{ label: 'sniper', rule: 'S1', confidence: 'on-chain' }], funder: { address: 'F'.repeat(44), label: null, blockTime: 1 }, walletFirstSeen: 1, cluster: 'C1' })),
  { owner: 'X'.repeat(44), pct: 2.8, kind: 'cex', labels: [{ label: 'cex', rule: 'exchange hot wallet: Binance (seed list, unverified by a second source)', confidence: 'seed' }], funder: null, walletFirstSeen: null, cluster: null },
  ...Array.from({ length: 10 }, (_, i) => ({ owner: `Q${i}`.padEnd(44, 'q'), pct: 1.5 - i * 0.1, kind: 'plain', labels: [], funder: null, walletFirstSeen: null, cluster: null })),
];
const clusters = [
  { name: 'C1', kind: 'bundle', members: holders.filter((h) => h.cluster === 'C1').map((h) => h.owner), pct: 8.9, evidence: [{ a: holders[3].owner, b: holders[4].owner, rule: 'same-slot buy AND shared funder (R2 bundle)', linked: true }] },
  { name: 'C2', kind: 'dev-linked', members: [holders[1].owner, holders[2].owner], pct: 6.3, evidence: [{ a: holders[1].owner, b: holders[2].owner, rule: 'funded by the creator wallet (R4 dev-linked)', linked: true }] },
];

test('layout: discs inside the area, no overlaps, members inside rings, deterministic, zoom + hit test', () => {
  const lay = B.layout(holders, clusters, 640, 360);
  assert.equal(lay.bubbles.length, holders.length);
  assert.equal(lay.overflow, undefined);
  for (const b of lay.bubbles) { assert.ok(b.cx - b.r >= -1e-6 && b.cx + b.r <= 640 + 1e-6); assert.ok(b.cy - b.r >= -1e-6 && b.cy + b.r <= 360 + 1e-6); assert.ok(b.r >= 3); }
  for (let i = 0; i < lay.bubbles.length; i++) for (let j = i + 1; j < lay.bubbles.length; j++) { const a = lay.bubbles[i], b = lay.bubbles[j]; assert.ok(Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.r + b.r - 0.5, `${a.idx}/${b.idx} overlap`); }
  for (const cl of lay.clusters) for (const m of cl.members) { const b = lay.bubbles.find((x: { idx: number }) => x.idx === m); assert.ok(Math.hypot(b.cx - cl.cx, b.cy - cl.cy) + b.r <= cl.R + 1e-6); }
  assert.deepEqual(JSON.parse(JSON.stringify(B.layout(holders, clusters, 640, 360))), JSON.parse(JSON.stringify(lay)));
  const pool = lay.bubbles.find((b: { idx: number }) => b.idx === 0);
  assert.ok(lay.bubbles.every((b: { r: number }) => b.r <= pool.r + 1e-9), 'the pool is the biggest disc');
  assert.ok(pool.r <= 640 / 5.2 + 1e-9, 'capped at ~1/5 of the width');
  assert.equal(B.hit(lay, pool.cx, pool.cy), 0);
  assert.equal(B.hit(lay, -50, -50), -1);
  const zoom = B.layout(holders, clusters, 640, 360, { focus: 'C1' });
  assert.equal(zoom.bubbles.length, 4);
  const tiny = B.layout(holders, clusters, 60, 40);
  assert.equal(tiny.bubbles.length, holders.length, 'grid fallback keeps every holder');
  assert.equal(tiny.overflow, true);
  assert.equal(B.layout([], [], 640, 360).bubbles.length, 0);
});

test('kindColor = rule; whyLines prints rule + confidence + evidence and the seed wording; helpers', () => {
  assert.equal(B.kindColor(T, 'dev'), T.warn);
  assert.equal(B.kindColor(T, 'bundle'), T.pump);
  assert.equal(B.kindColor(T, 'sniper'), T.down);
  assert.equal(B.kindColor(T, 'pool'), T.accent);
  assert.equal(B.kindColor(T, 'cex'), T.muted);
  assert.equal(B.kindColor(T, 'plain'), T.dim);
  const lines = B.whyLines(holders[7], null);
  assert.equal(lines[0].kind, 'head');
  assert.match(lines[0].text, /2\.80%\s+CEX/);
  assert.ok(lines.some((l: { kind: string; text: string }) => l.kind === 'rule' && /seed list, unverified/.test(l.text)));
  assert.ok(lines.some((l: { kind: string; right?: string }) => l.kind === 'label' && l.right === 'seed'));
  assert.equal(lines[lines.length - 1].kind, 'foot');
  const ev = B.whyLines(holders[3], clusters[0]);
  assert.ok(ev.some((l: { kind: string; text: string }) => l.kind === 'evidence' && /R2 bundle/.test(l.text)));
  const none = B.whyLines(holders[9], null);
  assert.ok(none.some((l: { text: string }) => /no rule matched/.test(l.text)));
  assert.equal(B.shortAddr('ABCDEFGHIJKLMNOP', 4), 'ABCD…MNOP');
  assert.equal(B.pctText(12.345), '12.3%');
  assert.equal(B.pctText(1.2345), '1.23%');
  assert.equal(B.fmtNum(191400), '191.4K');
});

test('server: the bubbles page kind is served under a ticket with the lib + css inlined, and holder.selected stays allow-listed', async () => {
  const events: unknown[] = [];
  const server = await createPopupServer({ onEvent: (e) => events.push(e) });
  try {
    const url = server.issueTicket('bubbles', 'p_test', { data: { symbol: 'VOID', state: 'ok' } });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/popup\/bubbles\?p=/);
    const res = await fetch(url, { headers: { host: `127.0.0.1:${server.port}` } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /BUBBLE MAP/);
    assert.match(html, /DTBubbles/, 'bubbles-lib.js inlined');
    assert.match(html, /hud\.bubbles #map/, 'bubbles.css inlined');
    assert.ok(!/\/\*__LIB_JS__\*\//.test(html) && !/\/\*__JS__\*\//.test(html));
    assert.ok(POPUP_EVENTS.has('event:holder.selected'));
    // a second use of the same ticket is refused
    const again = await fetch(url, { headers: { host: `127.0.0.1:${server.port}` } });
    assert.equal(again.status, 404);
  } finally { await server.close(); }
});

test('task-1367: whyLines leads with the holder class + its on-chain reason, and a lock line with the escrow (never an invented unlock)', () => {
  const h = { owner: 'L'.repeat(44), pct: 8, kind: 'plain', labels: [], funder: null, walletFirstSeen: null, cluster: null, cls: { tag: 'LOCK', reason: 'owner LLLL…LLLL is an account of the Jupiter Lock program: vesting / lock escrow', lock: { escrow: 'L'.repeat(44), program: 'Jupiter Lock', unlock: null, note: 'unlock schedule not decoded: open escrow LLLL…LLLL on Jupiter Lock to read it' } } };
  const lines = B.whyLines(h, null);
  assert.equal(lines[1].kind, 'label');
  assert.equal(lines[1].text, '■ LOCK');
  assert.equal(lines[1].right, 'on-chain');
  assert.match(lines[2].text, /Jupiter Lock program/);
  assert.match(lines[3].text, /^Jupiter Lock escrow LLLL…LLLL · unlock schedule not decoded/);
  const u = B.whyLines({ ...h, cls: { tag: 'UNLABELLED', reason: 'plain wallet (System-owned, a keypair address): no pool, lock, exchange or launch rule matched', lock: null } }, null);
  assert.equal(u[1].text, '■ UNLABELLED');
  assert.equal(u[1].label, 'plain');
  // an older terminal without classes: unchanged lines
  const old = B.whyLines(holders[7], null);
  assert.ok(!old.some((l: { text: string }) => /^■ /.test(l.text)));
});
