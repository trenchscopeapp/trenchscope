// dexterm popup — NARRATIVE BOARD HUD (task-1356, AI-SUITE-DESIGN §7). What is running and what is
// working, over full-panel rain. Deterministic board (no model): every number is from the TUI's board VM.
// Inlined after common.js under a CSP nonce. No remote content, no innerHTML: every untrusted string
// (narrative name, runner symbol) is rendered with textContent only.
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'narrative';
  const $ = (id) => document.getElementById(id);
  const titleEl = $('title'), rowsEl = $('rows'), metaEl = $('meta'), limitsEl = $('limits');
  const rain = DT.mountRain('rain');
  let vm = null;

  function resize() { if (rain) rain.resize(window.innerWidth, window.innerHeight); }
  window.addEventListener('resize', resize);
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  const fmtUsd = (v) => { if (v == null) return '—'; const a = Math.abs(v); if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return String(Math.round(v)); };
  const fmtPct = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');

  function render() {
    clear(rowsEl);
    const rows = vm && Array.isArray(vm.rows) ? vm.rows : [];
    if (!rows.length) {
      const row = document.createElement('div'); row.className = 'row';
      const k = document.createElement('div'); k.className = 'k muted'; k.textContent = 'narrative';
      const v = document.createElement('div'); v.className = 'v muted'; v.textContent = 'collecting narratives…';
      row.appendChild(k); row.appendChild(v); rowsEl.appendChild(row);
      return;
    }
    for (const n of rows) {
      const row = document.createElement('div'); row.className = 'row';
      const k = document.createElement('div'); k.className = 'k';
      k.textContent = `${n.rank == null ? '·' : '#' + n.rank} ${n.narrative}`;
      const v = document.createElement('div'); v.className = 'v';
      const med = n.med_chg;
      const runner = n.runner ? ` · ${n.runner.symbol} ${fmtPct(n.runner.chg)} ${fmtUsd(n.runner.mcap)}` : '';
      v.textContent = `${n.score == null ? '—' : n.score} · ${n.tokens} tok · ${fmtUsd(n.vol)} · ${n.new_1h}/${n.new_24h} new · med ${fmtPct(med)}${runner}`;
      if (med != null) v.className = 'v ' + (med >= 0 ? 'up' : 'down');
      row.appendChild(k); row.appendChild(v); rowsEl.appendChild(row);
    }
  }

  function setData(next) {
    vm = next || {};
    titleEl.textContent = `trenchscope · NARRATIVE ${vm.window ? vm.window.toUpperCase() : ''}`;
    metaEl.textContent = `${vm.tokens_total ?? 0} tokens · ${vm.unclassified_pct ?? 0}% unclassified · ${vm.copycats ?? 0} copycats · age ${vm.data_age ?? '—'} · lex v${vm.lexicon_version ?? '—'}`;
    limitsEl.textContent = vm.limits || 'model output: none (deterministic). Name-based: X/TG-only narratives are missed.';
    const n = (vm.rows || []).length;
    if (rain) rain.setActivity(Math.min(1, 0.3 + n * 0.05));
    DT.status(n ? n + ' narratives' : 'collecting', n ? 'up' : 'warn');
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
