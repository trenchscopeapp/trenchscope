// dexterm popup — bubble map pure helpers (task-1340). No DOM, no network, no globals besides the export.
// The SAME layout algorithm as @dexterm/tui bubbles.ts (packed circles per cluster, members radial around their
// hub, area ∝ share with a per-bubble cap), in plain JS so the page can inline it under its CSP nonce and
// test/bubbles-lib.test.ts can load it through node:vm. Pixel space here is real pixels (W × H), not half-rows.
(function (root) {
  'use strict';
  const KIND_LETTER = { 'dev-linked': 'D', dev: 'D', bundle: 'B', funder: 'F', transfer: 'T', sniper: 'S', pool: 'P', cex: 'X', whale: 'W', plain: '·' };
  const LEGEND = [['dev', 'dev'], ['bundle', 'bundle'], ['funder', 'linked'], ['sniper', 'sniper'], ['pool', 'pool/LP'], ['cex', 'exchange'], ['plain', 'unlinked']];

  /** Colour = rule; `t` is the popup theme tokens. */
  function kindColor(t, kind) {
    switch (kind) {
      case 'dev': case 'dev-linked': return t.warn;
      case 'bundle': return t.pump || t.accent;
      case 'funder': return t.up;
      case 'transfer': return t.dbc || t.warn;
      case 'sniper': return t.down;
      case 'pool': return t.accent;
      case 'cex': case 'whale': return t.muted;
      default: return t.dim;
    }
  }

  function placeCluster(members) {
    const hub = members[0];
    const out = [{ i: hub.i, r: hub.r, dx: 0, dy: 0 }];
    if (members.length === 1) return { items: out, R: hub.r + 1.5 };
    let ringR = hub.r, k = 1, maxReach = hub.r;
    while (k < members.length) {
      const ring = [];
      const d0 = ringR + 2;
      let angleUsed = 0, biggest = 0;
      while (k < members.length) {
        const m = members[k];
        const d = d0 + m.r;
        const need = 2 * Math.asin(Math.min(1, (m.r + 1) / d));
        if (ring.length && angleUsed + need > 2 * Math.PI) break;
        ring.push({ m, d, need });
        angleUsed += need; biggest = Math.max(biggest, m.r); k++;
      }
      const slack = Math.max(0, 2 * Math.PI - angleUsed) / ring.length;
      let a = -Math.PI / 2 + (ring.length % 2 ? 0 : slack / 2) + out.length * 0.37;
      for (const { m, d, need } of ring) {
        a += need / 2 + slack / 2;
        out.push({ i: m.i, r: m.r, dx: Math.cos(a) * d, dy: Math.sin(a) * d });
        maxReach = Math.max(maxReach, d + m.r);
        a += need / 2 + slack / 2;
      }
      ringR = d0 + 2 * biggest;
    }
    return { items: out, R: maxReach + 1.5 };
  }

  function packClusters(cls, W, H, gap) {
    const placed = [];
    const cx0 = W / 2, cy0 = H / 2;
    const inside = (x, y, R) => x - R >= 0 && x + R <= W && y - R >= 0 && y + R <= H;
    const free = (x, y, R) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.R + R + gap - 1e-6);
    for (const c of cls) {
      if (!placed.length) { if (!inside(cx0, cy0, c.R)) return null; placed.push(Object.assign({}, c, { x: cx0, y: cy0 })); continue; }
      let best = null, bestD = Infinity;
      for (const p of placed) {
        for (let s = 0; s < 48; s++) {
          const th = (s / 48) * 2 * Math.PI;
          const d = p.R + c.R + gap;
          const x = p.x + Math.cos(th) * d, y = p.y + Math.sin(th) * d;
          if (!inside(x, y, c.R) || !free(x, y, c.R)) continue;
          const dd = (x - cx0) ** 2 + ((y - cy0) * 1.15) ** 2;
          if (dd < bestD) { bestD = dd; best = { x, y }; }
        }
      }
      if (!best) return null;
      placed.push(Object.assign({}, c, { x: best.x, y: best.y }));
    }
    return placed;
  }

  /**
   * Lay out holders in a W×H pixel area. Returns { bubbles:[{idx,cx,cy,r}], clusters:[{name,kind,pct,cx,cy,R,members,multi}], k }.
   * `focus` = a cluster name → only that cluster (zoom). Deterministic. Never throws (grid fallback).
   */
  function layout(holders, clusters, W, H, opts) {
    opts = opts || {};
    const idxs = holders.map((_, i) => i).filter((i) => !opts.focus || holders[i].cluster === opts.focus);
    if (!idxs.length || W < 20 || H < 20) return { bubbles: [], clusters: [], k: 0, W, H };
    const total = idxs.reduce((s, i) => s + Math.max(0.01, holders[i].pct), 0);
    const fill = opts.fill != null ? opts.fill : opts.focus ? 0.6 : 0.5;
    let k = Math.sqrt((fill * W * H) / (Math.PI * total));
    const rMax = Math.min(W / 5.2, H / 2.6);
    const gap = Math.max(2, Math.min(W, H) * 0.01);
    for (let iter = 0; iter < 14; iter++) {
      const byCluster = new Map();
      for (const i of idxs) {
        const h = holders[i];
        const r = Math.max(3, Math.min(rMax, k * Math.sqrt(Math.max(0.01, h.pct))));
        const key = h.cluster || `single:${i}`;
        const arr = byCluster.get(key) || []; arr.push({ i, r }); byCluster.set(key, arr);
      }
      const cls = [];
      for (const [key, members] of byCluster) {
        members.sort((a, b) => b.r - a.r);
        const pc = placeCluster(members);
        const c = clusters.find((x) => x.name === key) || null;
        cls.push({ key, name: c ? c.name : null, kind: c ? c.kind : holders[members[0].i].kind, pct: c ? c.pct : holders[members[0].i].pct, items: pc.items, R: pc.R, multi: members.length > 1 });
      }
      cls.sort((a, b) => b.R - a.R);
      const placed = packClusters(cls, W, H, gap);
      if (placed) {
        const bubbles = [], out = [];
        for (const p of placed) {
          for (const it of p.items) bubbles.push({ idx: it.i, cx: p.x + it.dx, cy: p.y + it.dy, r: it.r });
          out.push({ name: p.name, kind: p.kind, pct: p.pct, cx: p.x, cy: p.y, R: p.R, members: p.items.map((it) => it.i), multi: p.multi });
        }
        return { bubbles, clusters: out, k, W, H };
      }
      k *= 0.86;
    }
    const cols = Math.max(1, Math.floor(W / 24));
    return { bubbles: idxs.map((i, n) => ({ idx: i, cx: 12 + (n % cols) * 24, cy: 12 + Math.floor(n / cols) * 24, r: 8 })), clusters: [], k, W, H, overflow: true };
  }

  /** Holder index under a point, or -1. */
  function hit(lay, x, y) {
    let best = -1, bestD = Infinity;
    for (const b of lay.bubbles) { const d = Math.hypot(b.cx - x, b.cy - y); if (d <= b.r && d < bestD) { bestD = d; best = b.idx; } }
    return best;
  }

  const shortAddr = (s, n) => { n = n || 4; s = String(s || ''); return s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s; };
  const pctText = (p) => `${p.toFixed(p >= 10 ? 1 : 2)}%`;
  const fmtNum = (n) => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));

  /** The rule panel lines for one holder: label · confidence, then the rule text, then up to 3 evidence lines. */
  function whyLines(h, cluster) {
    const lines = [];
    if (!h) return lines;
    lines.push({ kind: 'head', text: `${shortAddr(h.owner, 6)}  ${pctText(h.pct)}  ${h.kind.toUpperCase()}${h.cluster ? `  ${h.cluster}` : ''}` });
    // task-1367: the holder class + its on-chain reason (absent from older terminals)
    if (h.cls) {
      lines.push({ kind: 'label', text: `■ ${h.cls.tag}`, right: 'on-chain', label: h.cls.tag === 'UNLABELLED' ? 'plain' : h.cls.tag === 'DEV' ? 'dev' : h.cls.tag === 'LINKED' ? 'dev-linked' : h.cls.tag === 'CEX' ? 'cex' : 'pool' });
      lines.push({ kind: 'rule', text: h.cls.reason });
      if (h.cls.lock) lines.push({ kind: 'muted', text: `${h.cls.lock.program} escrow ${shortAddr(h.cls.lock.escrow, 4)} · ${h.cls.lock.unlock || h.cls.lock.note}` });
    }
    if (h.funder) lines.push({ kind: 'muted', text: `funded by ${shortAddr(h.funder.address, 4)}${h.funder.label ? ` (${h.funder.label})` : ''}${h.funder.blockTime ? ` · ${new Date(h.funder.blockTime * 1000).toISOString().slice(0, 10)}` : ''}` });
    else if (h.walletFirstSeen) lines.push({ kind: 'muted', text: `first seen ${new Date(h.walletFirstSeen * 1000).toISOString().slice(0, 10)} · funder not found in first txs` });
    else lines.push({ kind: 'muted', text: 'funding not looked up (outside the funded sample)' });
    const linked = cluster && cluster.members && cluster.members.length > 1;
    const rules = h.labels && h.labels.length ? h.labels : linked
      ? [{ label: `linked · ${cluster.kind}`, rule: `no label of its own; linked into ${cluster.name} (${cluster.members.length} wallets, ${Number(cluster.pct).toFixed(1)}%) by the evidence below`, confidence: 'on-chain' }]
      : [{ label: 'unlinked', rule: 'no rule matched: no shared funder, same-slot buy, transfer or creator link found in the sample', confidence: 'n/a' }];
    for (const r of rules) { lines.push({ kind: 'label', text: `● ${r.label}`, right: r.confidence || '', label: r.label }); lines.push({ kind: 'rule', text: r.rule }); }
    const ev = cluster ? cluster.evidence.filter((e) => e.linked !== false && (e.a === h.owner || e.b === h.owner)).slice(0, 3) : [];
    for (const e of ev) lines.push({ kind: 'evidence', text: `↳ ${shortAddr(e.a, 4)} ↔ ${shortAddr(e.b, 4)}: ${e.rule}` });
    lines.push({ kind: 'foot', text: 'labels are heuristics (rule + evidence) · never asserted as fact' });
    return lines;
  }

  const api = { KIND_LETTER, LEGEND, kindColor, layout, hit, shortAddr, pctText, fmtNum, whyLines };
  root.DTBubbles = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
