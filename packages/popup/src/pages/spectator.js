// dexterm popup — spectator page (task-1406, "watch the agent cook"). Renders the SpectatorPopupVM: the
// screen the agent moved to, the connected agents with an 'agent' badge and status, and an activity feed
// with timing and data ages. Every string is already REDACTED TUI-side (wallet addresses/keys masked) and
// is rendered with textContent only — never innerHTML. The ONLY messages this page sends are the
// allow-listed spectator.pause / resume / takeover / kill events (by agent name); it can never arm, sign,
// raise a cap or touch a wallet (no such control exists and the server drops anything off the allow-list).
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'spectator';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const ago = (t) => { if (!t) return '—'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
  const age = (s) => (s == null ? '' : s < 60 ? `${Math.round(s)}s old` : s < 3600 ? `${Math.floor(s / 60)}m old` : `${Math.floor(s / 3600)}h old`);

  let vm = null;

  function render() {
    if (!vm) return;

    const scr = $('screen'); scr.textContent = '';
    const s = vm.screen || {};
    scr.appendChild(el('span', 'spec-screen-k', `screen: ${s.screen || '—'}`));
    if (s.selectedMint) scr.appendChild(el('span', 'spec-screen-dim', ` · token ${s.selectedMint}`));
    if (s.feed) scr.appendChild(el('span', 'spec-screen-dim', ` · feed ${s.feed}`));
    if (s.filter) scr.appendChild(el('span', 'spec-screen-dim', ` · filter ${s.filter}`));
    if (s.highlight) scr.appendChild(el('span', 'spec-screen-dim', ` · ★ ${s.highlight}`));
    if (vm.control === 'user') scr.appendChild(el('span', 'spec-takeover', ' · YOU HAVE TAKEN OVER'));

    const host = $('agents'); host.textContent = '';
    if (!vm.agents || !vm.agents.length) host.appendChild(el('div', 'spec-dim', 'no agents connected yet'));
    for (const a of (vm.agents || [])) {
      const row = el('div', 'spec-agent' + (a.status !== 'active' ? ' off' : ''));
      row.appendChild(el('span', 'spec-badge', 'agent'));           // the 'agent' badge
      row.appendChild(el('span', 'spec-name', a.name));             // textContent — redacted/firewalled, safe
      if (a.tier) row.appendChild(el('span', 'spec-tier tier-' + a.tier, a.tier));
      row.appendChild(el('span', 'spec-status status-' + a.status, a.status));
      row.appendChild(el('span', 'spec-dim', ` · ${ago(a.lastAt)}`));
      const ctl = el('div', 'spec-ctl');
      const mk = (label, name, danger) => { const b = el('button', 'spec-btn' + (danger ? ' danger' : ''), label); b.type = 'button'; b.addEventListener('click', () => DT.send({ type: 'event', name, payload: { agent: a.name } })); return b; };
      if (a.status === 'active') { ctl.appendChild(mk('pause', 'spectator.pause')); ctl.appendChild(mk('take over', 'spectator.takeover')); }
      else ctl.appendChild(mk('resume', 'spectator.resume'));
      ctl.appendChild(mk('kill', 'spectator.kill', true));          // panic
      row.appendChild(ctl);
      host.appendChild(row);
    }

    const act = $('activity'); act.textContent = '';
    for (const r of (vm.activity || []).slice().reverse().slice(0, 80)) {
      const line = el('div', 'spec-act' + (r.ok ? '' : ' bad') + (r.phase === 'nav' ? ' nav' : ''));
      line.appendChild(el('span', 'spec-act-t', ago(r.t)));
      line.appendChild(el('span', 'spec-badge sm', 'agent'));
      line.appendChild(el('span', 'spec-act-agent', r.agent));
      line.appendChild(el('span', 'spec-act-phase', r.phase));
      if (r.tool) line.appendChild(el('span', 'spec-act-tool', r.tool));
      line.appendChild(el('span', 'spec-act-sum', r.summary || ''));  // textContent — redacted upstream
      if (r.ms != null) line.appendChild(el('span', 'spec-act-ms', `${Math.round(r.ms)}ms`));
      if (r.dataAgeSec != null) line.appendChild(el('span', 'spec-act-age', age(r.dataAgeSec)));
      act.appendChild(line);
    }

    $('redact').textContent = vm.redacted ? 'redacted' : 'local (full)';
    const live = (vm.agents || []).filter((a) => a.status === 'active').length;
    DT.status(`${live} cooking`, live ? 'up' : 'muted');
  }

  DT.onHello(() => { DT.mountRain('rain'); const r = DT.rain(); if (r) { r.setActivity(0.3); r.setMood('rain'); } });
  DT.onData((payload) => { vm = payload; render(); });
  DT.onUpdate(() => { /* spectator is pushed as full `data` frames */ });
  DT.wireChrome();
  let lastTick = 0;
  DT.rainEvery = 2; DT.fpsCap = 30;
  DT.loop((now) => { if (now - lastTick > 1000) { lastTick = now; if (vm) render(); } });
  DT.connect();
})();
