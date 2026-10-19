// dexterm popup — order plans & standing mandates page (task-1355). Renders the PlansVM: the conditional
// order plans and the standing mandates with their status and ledgers, plus the journal-integrity note. This
// popup is the read-only HUD of the signer trust domain: it receives VIEW MODELS only, never a key, a
// signature, a mandate secret or trade capability. The ONLY message it can send is `plan.cancel` (cancel a
// plan by id), which the terminal re-validates against its own live list before acting. There is deliberately
// NO control here to arm, raise a cap, widen or arm a mandate, resume a paused plan, or sign — arming is a
// physical keypress at the terminal, and the server drops anything off the event allow-list. Every untrusted
// string (a coin symbol) is rendered with textContent only — never innerHTML.
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'plans';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const usd = (n) => { const x = Number(n); if (!Number.isFinite(x)) return '—'; const a = Math.abs(x); if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`; if (a >= 1e3) return `$${(x / 1e3).toFixed(1)}k`; return `$${x.toFixed(2)}`; };
  const ttl = (expiresAt, now) => { const ms = Number(expiresAt) - Number(now); if (!Number.isFinite(ms) || ms <= 0) return 'expired'; const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); return h > 0 ? `${h}h${m}m` : `${m}m`; };
  // Status tone: armed / filling = up, cancelled/failed/expired/revoked = dim, else muted.
  const tone = (status, paused) => paused ? 'bad' : /^(armed|filled)/.test(status) ? 'up' : /^(cancel|fail|expir|revok|done)/.test(status) ? 'dim' : 'muted';

  let vm = null;

  function render() {
    if (!vm) return;
    const sum = $('summary'); sum.textContent = '';
    sum.appendChild(el('span', 'roster-k', vm.mode || 'PAPER'));
    // Gate state is read-only here: turning hands-free on/off is a physical keypress at the terminal (G).
    sum.appendChild(el('span', vm.handsFree ? 'roster-k tier-bad' : 'roster-k', vm.handsFree ? ' · HANDS-FREE' : ' · GATE ON'));
    sum.appendChild(el('span', 'roster-dim', ` · ${vm.plans.length} plan${vm.plans.length === 1 ? '' : 's'} · ${vm.mandates.length} mandate${vm.mandates.length === 1 ? '' : 's'} · ${vm.journal || 'journal —'}`));

    const ph = $('plans'); ph.textContent = '';
    if (!vm.plans.length) ph.appendChild(el('div', 'roster-dim', 'no order plans. propose one: dexterm plan propose  (or by voice — a proposal is inert until you arm it with a keypress)'));
    for (const p of vm.plans) {
      const row = el('div', 'roster-row' + (p.paused ? ' paused' : ''));
      const head = el('div', 'roster-row-head');
      head.appendChild(el('span', 'roster-name', p.symbol));          // textContent — untrusted symbol is safe
      head.appendChild(el('span', 'roster-tier tier-' + tone(p.status, p.paused), p.status + (p.paused ? ' · paused' : '')));
      head.appendChild(el('span', 'roster-dim', ` ${p.side} · ${usd(p.sizeUsd)}${p.tier ? ' · ' + p.tier : ''}${p.mandateId ? ' · ' + p.mandateId : ''}`));
      row.appendChild(head);
      row.appendChild(el('div', 'roster-stats', p.readBack));         // textContent — the signer's read-back line
      if (typeof p.levels === 'string' && p.levels) row.appendChild(el('div', 'roster-dim', p.levels)); // task-1366: mc + price per level
      // Cancel is the only write; proposed/armed plans can be cancelled, terminal ones cannot.
      if (!/^(cancel|fail|expir|done)/.test(p.status)) {
        const ctl = el('div', 'roster-ctl');
        const cancel = el('button', 'roster-btn danger', 'cancel'); cancel.type = 'button';
        cancel.addEventListener('click', () => DT.send({ type: 'event', name: 'plan.cancel', payload: { id: p.id } }));
        ctl.appendChild(cancel);
        row.appendChild(ctl);
      }
      ph.appendChild(row);
    }

    const mh = $('mandates'); mh.textContent = '';
    if (!vm.mandates.length) mh.appendChild(el('div', 'roster-dim', 'no standing mandates. draft one: dexterm mandate draft  (arming is a keypress; caps are signer-side and can never be raised)'));
    for (const m of vm.mandates) {
      const row = el('div', 'roster-row');
      const head = el('div', 'roster-row-head');
      head.appendChild(el('span', 'roster-name', m.id));
      head.appendChild(el('span', 'roster-tier tier-' + tone(m.status, false), m.status));
      head.appendChild(el('span', 'roster-dim', ` ${m.maxTier} · ${ttl(m.expiresAt, vm.now)}`));
      row.appendChild(head);
      const stats = el('div', 'roster-stats');
      stats.appendChild(el('span', 'roster-stat', `budget ${usd(m.totalUsd)}`));
      stats.appendChild(el('span', 'roster-stat', `reserved ${usd(m.reservedUsd)}`));
      stats.appendChild(el('span', 'roster-stat', `spent ${usd(m.spentUsd)}`));
      stats.appendChild(el('span', 'roster-stat', `pnl ${usd(m.realizedUsd)}`));
      stats.appendChild(el('span', 'roster-stat' + (m.lossUsd ? ' bad' : ''), `loss ${usd(m.lossUsd)}`));
      stats.appendChild(el('span', 'roster-stat', `/trade ${usd(m.perTradeUsd)} · /coin ${usd(m.perCoinUsd)}`));
      row.appendChild(stats);
      mh.appendChild(row);
    }
    const armed = vm.plans.filter((p) => /^armed/.test(p.status)).length;
    DT.status(`${vm.plans.length} plan${vm.plans.length === 1 ? '' : 's'}${armed ? ` · ${armed} armed` : ''}`, armed ? 'up' : 'muted');
  }

  DT.onHello(() => { DT.mountRain('rain'); const r = DT.rain(); if (r) { r.setActivity(0.2); r.setMood('rain'); } });
  DT.onData((payload) => { vm = payload; render(); });
  DT.onUpdate(() => { /* plans are pushed as full `data` frames; nothing incremental */ });
  DT.wireChrome();
  let lastTick = 0;
  DT.rainEvery = 2; DT.fpsCap = 30;
  DT.loop((now) => { if (now - lastTick > 1000) { lastTick = now; if (vm) render(); } });
  DT.connect();
})();
