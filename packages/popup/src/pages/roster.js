// dexterm popup — agent roster page (task-1345). Renders the RosterVM: connected agents with tier, last
// activity, reads/proposals, rate usage, and the audit log, with per-agent pause and kick. Every untrusted
// string (agent name, client label, audit detail) is rendered with textContent only — never innerHTML. The
// only messages this page sends are the allow-listed roster.pause / roster.resume / roster.kick events; the
// page can never arm, sign, change a cap, or touch a wallet (no such control exists and the server drops
// anything off the allow-list).
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'roster';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const ago = (t) => { if (!t) return '—'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
  const TIER_LABEL = { observe: 'observe', annotate: 'annotate', propose: 'propose' };

  let vm = null;

  function render() {
    if (!vm) return;
    const sum = $('summary'); sum.textContent = '';
    const live = vm.agents.length;
    sum.appendChild(el('span', 'roster-k', `${live} connected`));
    sum.appendChild(el('span', 'roster-dim', ` · bus ws://127.0.0.1:${Number(vm.busPort) || 0} · untrusted by default`));

    const host = $('agents'); host.textContent = '';
    if (!vm.agents.length) host.appendChild(el('div', 'roster-dim', 'no agents connected. register one: dexterm agent add <name> --tier observe'));
    for (const a of vm.agents) {
      const row = el('div', 'roster-row' + (a.paused ? ' paused' : ''));
      const head = el('div', 'roster-row-head');
      head.appendChild(el('span', 'roster-name', a.name));           // textContent — untrusted name is safe
      head.appendChild(el('span', 'roster-tier tier-' + a.tier, TIER_LABEL[a.tier] || a.tier));
      if (a.paused) head.appendChild(el('span', 'roster-badge', a.floodPausedUntil ? 'flood-paused' : 'paused'));
      head.appendChild(el('span', 'roster-dim', ` ${a.sessions} session${a.sessions === 1 ? '' : 's'} · ${a.client || 'unknown'} · active ${ago(a.lastActivity)}`));
      row.appendChild(head);

      const stats = el('div', 'roster-stats');
      stats.appendChild(el('span', 'roster-stat', `reads ${a.reads}/${a.readsLimit}·min`));
      stats.appendChild(el('span', 'roster-stat', `proposals ${a.proposals}/${a.proposalsLimit}·h`));
      stats.appendChild(el('span', 'roster-stat' + (a.refused ? ' bad' : ''), `refused ${a.refused}`));
      if (a.topics && a.topics.length) stats.appendChild(el('span', 'roster-stat', `subs: ${a.topics.join(',')}`));
      row.appendChild(stats);

      const ctl = el('div', 'roster-ctl');
      const pause = el('button', 'roster-btn', a.paused ? 'resume' : 'pause'); pause.type = 'button';
      pause.addEventListener('click', () => DT.send({ type: 'event', name: a.paused ? 'roster.resume' : 'roster.pause', payload: { agent: a.name } }));
      const kick = el('button', 'roster-btn danger', 'kick'); kick.type = 'button';
      kick.addEventListener('click', () => DT.send({ type: 'event', name: 'roster.kick', payload: { agent: a.name } }));
      ctl.appendChild(pause); ctl.appendChild(kick);
      row.appendChild(ctl);
      host.appendChild(row);
    }

    const audit = $('audit'); audit.textContent = '';
    for (const r of (vm.audit || []).slice(0, 80)) {
      const line = el('div', 'roster-audit-row' + (r.ok ? '' : ' bad'));
      line.appendChild(el('span', 'roster-audit-t', ago(r.t)));
      line.appendChild(el('span', 'roster-audit-agent', r.agent));
      line.appendChild(el('span', 'roster-audit-kind', r.kind));
      line.appendChild(el('span', 'roster-audit-tool', r.tool));
      line.appendChild(el('span', 'roster-audit-detail', r.detail));  // textContent — firewalled upstream, safe here
      audit.appendChild(line);
    }
    DT.status(`${live} agent${live === 1 ? '' : 's'}`, live ? 'up' : 'muted');
  }

  DT.onHello(() => { DT.mountRain('rain'); const r = DT.rain(); if (r) { r.setActivity(0.25); r.setMood('rain'); } });
  DT.onData((payload) => { vm = payload; render(); });
  DT.onUpdate(() => { /* roster is pushed as full `data` frames; nothing incremental */ });
  DT.wireChrome();
  // A slow rAF loop keeps the rain alive and refreshes relative times once a second; the roster content
  // itself only changes when a new `data` frame arrives.
  let lastTick = 0;
  DT.rainEvery = 2; DT.fpsCap = 30;
  DT.loop((now) => { if (now - lastTick > 1000) { lastTick = now; if (vm) render(); } });
  DT.connect();
})();
