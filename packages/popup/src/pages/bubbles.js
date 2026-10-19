// dexterm popup — BUBBLE MAP HUD (task-1340, wallet intel W5). The same engine output as the terminal's bubble
// screen, drawn as real circles on a canvas: area ∝ share, colour = rule, dotted ring + tag per linked cluster,
// hover shows the rule text behind a colour, click selects (the terminal hears `holder.selected`), `m` treemap,
// `z` zooms the selected cluster. Inlined after common.js + bubbles-lib.js under a CSP nonce. No remote content,
// no innerHTML: every untrusted string (addresses, rule text, symbol) goes through textContent / fillText.
// Data is a BubbleVM over the WS; an `unavailable` VM draws a banner and nothing else — never a fake map.
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'bubbles'; DT.rainEvery = 2;
  const B = window.DTBubbles;
  const $ = (id) => document.getElementById(id);
  const titleEl = $('title'), depthEl = $('depth'), bannerEl = $('banner'), tipEl = $('tip'), insightsEl = $('insights'), whyEl = $('why'), legendEl = $('legend');
  const cv = $('map'); const ctx = cv.getContext('2d');
  const rain = DT.mountRain('rain');
  let vm = null, lay = null, view = 'bubbles', focus = null, hover = -1, selected = null, W = 0, H = 0, DPR = 1, dirty = true;

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height)); DPR = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * DPR; cv.height = H * DPR; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (rain) rain.resize(W, H);
    lay = null; dirty = true;
  }
  window.addEventListener('resize', resize);
  // the insights / WHY panels change height with the data and the hover, which resizes the stage: re-fit the canvas
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { const r = cv.parentElement.getBoundingClientRect(); if (Math.floor(r.width) !== W || Math.floor(r.height) !== H) resize(); }).observe(cv.parentElement);

  function relayout() {
    if (!vm || vm.state !== 'ok') { lay = null; return; }
    lay = B.layout(vm.holders, vm.clusters, W - 16, H - 16, { focus });
  }

  // ---- legend (glyph + word, colour-blind second encoding)
  function renderLegend() {
    clear(legendEl);
    const t = DT.theme;
    for (const [kind, word] of B.LEGEND) {
      const s = el('span'); const dot = el('i'); dot.style.background = B.kindColor(t, kind); if (kind === 'plain') dot.style.opacity = '.6';
      s.appendChild(dot); s.appendChild(document.createTextNode(word)); legendEl.appendChild(s);
    }
  }

  // ---- insights strip (sample-captioned)
  function renderInsights() {
    clear(insightsEl);
    if (!vm || vm.state !== 'ok' || !vm.insights) return;
    const I = vm.insights;
    const pct = (v) => (v == null ? 'n/a' : `${Number(v).toFixed(1)}%`);
    const cells = [
      ['top10 raw', pct(I.top10Raw), 'by token acct'],
      I.top10ExPool != null ? ['top10 ex-pool', pct(I.top10ExPool), `adj ${pct(I.top10Adjusted)} · -${I.exPoolDropped || 0} venue`] : ['top10 adj', pct(I.top10Adjusted), `excl ${I.excludedCount} labelled`],
      ['snipers', I.snipers ? String(I.snipers.count) : 'n/a', I.snipers && I.snipers.count ? `${pct(I.snipers.launchSharePct)} at launch` : 'first 3 slots'],
      ['bundled', pct(I.bundlePct), `${I.cohorts == null ? '—' : I.cohorts} cohorts`],
      ['dev', I.devPct != null ? pct(I.devPct) : I.devUpperBoundPct != null ? `≤${pct(I.devUpperBoundPct)}` : 'n/a', I.devPct == null ? 'not in sample' : 'now'],
      ['fresh', pct(I.freshPct), `of ${pct(I.freshMeasuredPct)} meas.`],
    ];
    for (const [l, v, s] of cells) { const c = el('div', 'cell'); c.appendChild(el('div', 'l', l)); c.appendChild(el('div', 'v', v)); c.appendChild(el('div', 's', s)); insightsEl.appendChild(c); }
    if (I.bigHolder) { const r = el('div', 'sample', `⚠ main risk: ${I.bigHolder.tag} ${B.shortAddr(I.bigHolder.owner, 4)} holds ${pct(I.bigHolder.pct)} of supply`); r.style.color = DT.theme.down; r.style.fontWeight = 'bold'; insightsEl.appendChild(r); }
    insightsEl.appendChild(el('div', 'sample', I.sample));
  }

  // ---- WHY THIS LABEL panel for the selected (or hovered) holder
  function renderWhy() {
    clear(whyEl);
    if (!vm || vm.state !== 'ok') return;
    const idx = hover >= 0 ? hover : selected;
    const h = idx != null && idx >= 0 ? vm.holders[idx] : null;
    if (!h) { whyEl.appendChild(el('div', 'muted', 'hover or click a bubble to see the rules behind its colour')); return; }
    const cluster = h.cluster ? vm.clusters.find((c) => c.name === h.cluster) : null;
    for (const ln of B.whyLines(h, cluster)) {
      if (ln.kind === 'label') { const row = el('div', 'label'); const left = el('span', null, ln.text); left.style.color = B.kindColor(DT.theme, ln.label === 'LP' || ln.label === 'contract' ? 'pool' : ln.label === 'multi-token-top20' ? 'whale' : ln.label); row.appendChild(left); row.appendChild(el('span', 'conf', ln.right)); whyEl.appendChild(row); }
      else whyEl.appendChild(el('div', ln.kind, ln.text));
    }
  }

  function banner(text, bad) { if (!text) { bannerEl.hidden = true; return; } bannerEl.hidden = false; bannerEl.textContent = text; bannerEl.className = 'banner' + (bad ? ' bad' : ''); }

  // ---- drawing
  function rgba(hex, a) { return DT.rgba(hex, a); }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (!vm) return;
    const t = DT.theme;
    if (vm.state !== 'ok') { ctx.font = '13px ui-monospace, Menlo, monospace'; ctx.fillStyle = t.muted; ctx.textAlign = 'center'; ctx.fillText(vm.state === 'loading' ? 'scanning holders…' : 'bubble map unavailable', W / 2, H / 2); return; }
    if (!lay) relayout();
    if (!lay) return;
    const ox = 8, oy = 8;
    if (view === 'treemap') return drawTreemap(ox, oy, W - 16, H - 16);
    ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // rings + tags
    for (const cl of lay.clusters) {
      if (!cl.multi) continue;
      const col = B.kindColor(t, cl.kind);
      ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = rgba(col, 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(ox + cl.cx, oy + cl.cy, cl.R + 2, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      ctx.fillStyle = col; ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
      ctx.fillText(`${B.KIND_LETTER[cl.kind] || '·'}·${cl.name} ${cl.members.length}w ${cl.pct.toFixed(1)}%`, ox + cl.cx, Math.max(8, oy + cl.cy - cl.R - 9));
    }
    // dotted edges from the selected holder to its mates
    const sel = selected != null ? lay.bubbles.find((b) => b.idx === selected) : null;
    if (sel) {
      const cl = lay.clusters.find((c) => c.members.includes(selected));
      if (cl && cl.multi) { ctx.save(); ctx.setLineDash([2, 4]); ctx.strokeStyle = rgba(t.accent, 0.7); for (const m of cl.members) { if (m === selected) continue; const mb = lay.bubbles.find((b) => b.idx === m); ctx.beginPath(); ctx.moveTo(ox + sel.cx, oy + sel.cy); ctx.lineTo(ox + mb.cx, oy + mb.cy); ctx.stroke(); } ctx.restore(); }
    }
    // discs
    for (const b of lay.bubbles) {
      const h = vm.holders[b.idx];
      const isSel = b.idx === selected, isHover = b.idx === hover;
      const col = isSel ? t.borderFocus : B.kindColor(t, h.kind);
      const g = ctx.createRadialGradient(ox + b.cx - b.r * 0.3, oy + b.cy - b.r * 0.3, b.r * 0.1, ox + b.cx, oy + b.cy, b.r);
      g.addColorStop(0, rgba(col, h.kind === 'plain' && !isSel ? 0.55 : 0.95)); g.addColorStop(1, rgba(col, h.kind === 'plain' && !isSel ? 0.3 : 0.7));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox + b.cx, oy + b.cy, b.r, 0, Math.PI * 2); ctx.fill();
      if (isHover || isSel) { ctx.strokeStyle = isSel ? t.borderFocus : t.text; ctx.lineWidth = isSel ? 2 : 1.5; ctx.stroke(); }
      if (b.r >= 14) {
        ctx.fillStyle = '#031008'; ctx.font = `${isSel ? 'bold ' : ''}${b.r >= 30 ? 12 : 10}px ui-monospace, Menlo, monospace`;
        const addr = B.shortAddr(h.owner, 4), pct = B.pctText(h.pct);
        if (b.r >= 24) { ctx.fillText(addr, ox + b.cx, oy + b.cy - 7); ctx.fillText(pct, ox + b.cx, oy + b.cy + 6); if (b.r >= 36 && h.kind !== 'plain') ctx.fillText(h.kind.toUpperCase(), ox + b.cx, oy + b.cy + 19); }
        else ctx.fillText(pct, ox + b.cx, oy + b.cy);
      }
    }
    if (lay.overflow) { ctx.fillStyle = t.warn; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.fillText('window too small to pack the map: grid view', ox + 4, oy + 10); }
  }

  function drawTreemap(x, y, w, h) {
    const t = DT.theme;
    const items = vm.clusters.slice().sort((a, b) => b.pct - a.pct).map((cl) => ({ cl, v: Math.max(0.05, cl.pct) }));
    const total = items.reduce((s, it) => s + it.v, 0) || 1;
    // simple slice-and-dice rows (the terminal keeps the squarified version; this view is the share reading)
    let cy = y, remain = h;
    let i = 0;
    while (i < items.length && remain > 2) {
      let rowV = 0, j = i;
      const target = Math.max(items[i].v, total * (remain / h) * 0.28);
      while (j < items.length && rowV < target) rowV += items[j++].v;
      const rh = Math.max(14, Math.round((rowV / total) * h));
      let cx = x;
      for (let k = i; k < j; k++) {
        const cl = items[k].cl;
        const rw = Math.round((items[k].v / rowV) * w);
        const col = selected != null && cl.members.includes(vm.holders[selected] && vm.holders[selected].owner) ? t.borderFocus : B.kindColor(t, cl.kind);
        ctx.fillStyle = rgba(col, 0.22); ctx.fillRect(cx, cy, rw - 1, rh - 1);
        ctx.fillStyle = col; ctx.fillRect(cx, cy, 2, rh - 1);
        if (rw > 44) { ctx.fillStyle = col; ctx.font = 'bold 11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(cl.members.length > 1 ? `${B.KIND_LETTER[cl.kind] || '·'}·${cl.name}` : B.shortAddr(cl.members[0], 3), cx + 6, cy + 3); ctx.fillStyle = t.text; ctx.font = '11px ui-monospace, Menlo, monospace'; if (rh > 28) ctx.fillText(`${cl.pct.toFixed(1)}%${cl.members.length > 1 ? ` ${cl.members.length}w` : ''}`, cx + 6, cy + 16); }
        cx += rw;
      }
      cy += rh; remain -= rh; i = j;
    }
  }

  // ---- hover / click
  function hitAt(e) {
    if (!lay || view !== 'bubbles') return -1;
    const r = cv.getBoundingClientRect();
    return B.hit(lay, e.clientX - r.left - 8, e.clientY - r.top - 8);
  }
  cv.addEventListener('mousemove', (e) => {
    const idx = hitAt(e);
    if (idx !== hover) { hover = idx; dirty = true; renderWhy(); }
    if (idx >= 0) {
      const h = vm.holders[idx];
      clear(tipEl);
      tipEl.appendChild(el('div', 'k', `${B.shortAddr(h.owner, 6)} · ${B.pctText(h.pct)} · ${h.kind}${h.cluster ? ` · ${h.cluster}` : ''}`));
      const first = h.labels && h.labels[0];
      const cl0 = h.cluster ? (vm.clusters || []).find((c) => c.name === h.cluster) : null;
      const ev0 = cl0 ? (cl0.evidence || []).find((e) => e.linked !== false && (e.a === h.owner || e.b === h.owner)) : null;
      tipEl.appendChild(el('div', null, first ? `${first.label}: ${first.rule}` : ev0 ? `linked: ${ev0.rule}` : 'no rule matched · unlinked wallet'));
      tipEl.hidden = false;
      const r = cv.getBoundingClientRect();
      const tx = Math.min(e.clientX - r.left + 14, W - 370), ty = Math.min(e.clientY - r.top + 14, H - 60);
      tipEl.style.left = `${Math.max(4, tx)}px`; tipEl.style.top = `${Math.max(4, ty)}px`;
    } else tipEl.hidden = true;
  });
  cv.addEventListener('mouseleave', () => { hover = -1; tipEl.hidden = true; dirty = true; renderWhy(); });
  cv.addEventListener('click', (e) => {
    const idx = hitAt(e);
    if (idx < 0) return;
    selected = idx; dirty = true; renderWhy();
    const owner = vm.holders[idx] && vm.holders[idx].owner;
    if (owner && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) DT.send({ type: 'event', name: 'holder.selected', payload: { address: owner } });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'm') { view = view === 'treemap' ? 'bubbles' : 'treemap'; dirty = true; }
    else if (e.key === 'z') { if (focus) focus = null; else if (selected != null && vm && vm.holders[selected] && vm.holders[selected].cluster) focus = vm.holders[selected].cluster; lay = null; dirty = true; }
    else return;
    e.preventDefault();
  });

  function setData(a) {
    vm = a;
    const sym = String(vm.symbol || '?').replace(/^\$/, '');
    titleEl.textContent = `trenchscope · $${sym} · BUBBLE MAP`;
    document.title = `trenchscope · ${sym} bubbles`;
    depthEl.textContent = vm.state === 'ok' ? `${vm.depth || 'light'} scan${vm.via ? ` · ${vm.via}` : ''}` : '';
    if (vm.state === 'unavailable') banner(`bubble map unavailable: ${vm.reason || 'no holder source answered'}${vm.fix ? ` — ${vm.fix}` : ''}`, true);
    else if (vm.state === 'loading') banner('scanning holders…', false);
    else banner(vm.degraded ? `partial: ${vm.degraded}` : null, false);
    if (vm.selected != null && vm.selected !== selected) selected = vm.selected;
    if (focus && !(vm.clusters || []).some((c) => c.name === focus)) focus = null;
    if (rain) rain.setSources([sym, String(vm.mint || '').slice(0, 6), ...((vm.holders || []).slice(0, 6).map((h) => String(h.owner).slice(-6)))]);
    DT.status(vm.state === 'ok' ? `${vm.holders.length} holders` : vm.state, vm.state === 'ok' ? 'up' : vm.state === 'loading' ? 'warn' : 'down');
    renderInsights(); renderWhy();
    resize(); // the panels just changed height; fit the canvas to what is left before laying out
  }

  DT.onData(setData);
  DT.onTheme(() => { renderLegend(); renderWhy(); dirty = true; });
  DT.wireChrome();
  resize(); renderLegend(); renderWhy();
  DT.connect();
  DT.loop(() => { if (dirty) { dirty = false; draw(); } });
})();
