// dexterm popup — FEEDS HUD (newest-first list over full-panel rain; task-1290 stub but functional).
// Inlined after common.js under a CSP nonce. No remote content, no innerHTML: every untrusted string
// (feed text, source, title) is rendered with textContent only. Data is a FeedVM pushed over the WS.
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'feeds';
  const $ = (id) => document.getElementById(id);
  const titleEl = $('title'), rowsEl = $('rows');
  const rain = DT.mountRain('rain');
  let items = [], sel = 0;

  function relTime(t) {
    if (t == null) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function resize() { if (rain) rain.resize(window.innerWidth, window.innerHeight); }
  window.addEventListener('resize', resize);

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // newest-first; selection highlights a .row.sel; every value is textContent only.
  function render() {
    clear(rowsEl);
    if (!items.length) {
      const row = document.createElement('div'); row.className = 'row';
      const k = document.createElement('div'); k.className = 'k muted'; k.textContent = 'feed';
      const v = document.createElement('div'); v.className = 'v muted'; v.textContent = 'waiting for feed…';
      row.appendChild(k); row.appendChild(v); rowsEl.appendChild(row);
      return;
    }
    const ordered = items.slice().sort((a, b) => (b.t || 0) - (a.t || 0));
    for (let i = 0; i < ordered.length; i++) {
      const it = ordered[i];
      const row = document.createElement('div'); row.className = 'row' + (i === sel ? ' sel' : '');
      const k = document.createElement('div'); k.className = 'k';
      const rt = relTime(it.t);
      k.textContent = `${it.source || '—'}${rt ? ' · ' + rt : ''}`;
      const v = document.createElement('div'); v.className = 'v' + (it.kind ? ' ' + kindCls(it.kind) : '');
      v.textContent = it.text == null ? '' : String(it.text);
      row.appendChild(k); row.appendChild(v); rowsEl.appendChild(row);
    }
    const selRow = rowsEl.children[sel];
    if (selRow && selRow.scrollIntoView) selRow.scrollIntoView({ block: 'nearest' });
  }
  const kindCls = (k) => /up|buy|pump|good/i.test(k) ? 'up' : /down|sell|dump|rug|bad/i.test(k) ? 'down' : /warn|alert/i.test(k) ? 'warn' : 'muted';

  // arrows move the selection; Enter emits the allow-listed feed.selected event (payload index into newest-first list).
  window.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); e.preventDefault(); render(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); e.preventDefault(); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); DT.send({ type: 'event', name: 'feed.selected', payload: { i: sel } }); }
  });

  function setData(vm) {
    vm = vm || {};
    items = Array.isArray(vm.items) ? vm.items : [];
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
    titleEl.textContent = `trenchscope · ${vm.title == null ? 'FEEDS' : String(vm.title)}`;
    if (rain) { rain.setActivity(Math.min(1, 0.3 + items.length * 0.03)); rain.setSources(items.slice(0, 4).map((it) => String(it.source || ''))); }
    DT.status(items.length ? items.length + ' items' : 'no feed', items.length ? 'up' : 'warn');
    render();
  }

  DT.onData(setData);
  DT.onTheme(render);
  DT.wireChrome();
  resize();
  render();
  DT.connect();
  DT.loop(() => {});
})();
