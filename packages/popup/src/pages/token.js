// dexterm popup — TOKEN DETAIL HUD (key/value table over full-panel rain; task-1290).
// Inlined after common.js under a CSP nonce. No remote content, no innerHTML: every untrusted string
// (symbol, name, mint, risk/flag text) is rendered with textContent only. Data is a TokenDetailVM over the WS.
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'token';
  const $ = (id) => document.getElementById(id);
  const titleEl = $('title'), rowsEl = $('rows');
  const rain = DT.mountRain('rain');
  let vm = null;

  function fmtPrice(p) {
    if (p == null) return '—';
    if (p >= 1) return '$' + p.toFixed(3);
    if (p >= 0.0001) return '$' + p.toFixed(6);
    return '$' + p.toExponential(2);
  }
  // task-1325 fix: TokenView.chg is already in percent (DexScreener priceChange), not a fraction.
  function fmtPct(x) { return x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(Math.abs(x) >= 1000 ? 0 : 1) + '%'; }
  function fmtUsd(x) {
    if (x == null) return '—';
    const a = Math.abs(x);
    if (a >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + (x / 1e3).toFixed(1) + 'K';
    return '$' + x.toFixed(0);
  }
  const fmtNum = (x) => x == null ? '—' : x.toLocaleString('en-US');
  const fmtPctRaw = (x) => x == null ? '—' : x.toFixed(1) + '%';

  function resize() { if (rain) rain.resize(window.innerWidth, window.innerHeight); }
  window.addEventListener('resize', resize);

  // ---- row builders: every value is textContent only.
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function addRow(label, value, cls) {
    const row = document.createElement('div'); row.className = 'row';
    const k = document.createElement('div'); k.className = 'k'; k.textContent = label;
    const v = document.createElement('div'); v.className = 'v' + (cls ? ' ' + cls : ''); v.textContent = value == null ? '—' : String(value);
    row.appendChild(k); row.appendChild(v); rowsEl.appendChild(row);
  }
  const chgCls = (x) => x == null ? 'muted' : x >= 0 ? 'up' : 'down';
  const yesNoCls = (b) => b === true ? 'warn' : b === false ? 'up' : 'muted';
  const yesNo = (b) => b == null ? '—' : b ? 'yes' : 'no';

  function render() {
    clear(rowsEl);
    if (!vm) { addRow('', 'waiting for data…', 'muted'); return; }
    const chg = vm.chg || {};
    addRow('token', `${vm.symbol ? '$' + String(vm.symbol).replace(/^\$/, '') : '?'}  ${vm.name || ''}`.trim());
    if (vm.launchpad) addRow('launchpad', vm.launchpad, 'muted');
    if (vm.mint) addRow('mint', DT.shortAddr(vm.mint, 6), 'muted');
    if (vm.mint) addRow('', vm.mint, 'muted');
    addRow('price', fmtPrice(vm.price));
    addRow('24h', fmtPct(chg.h24), chgCls(chg.h24));
    addRow('6h', fmtPct(chg.h6), chgCls(chg.h6));
    addRow('1h', fmtPct(chg.h1), chgCls(chg.h1));
    addRow('5m', fmtPct(chg.m5), chgCls(chg.m5));
    addRow('mcap', fmtUsd(vm.mcap));
    addRow('fdv', fmtUsd(vm.fdv));
    addRow('liq', fmtUsd(vm.liq));
    addRow('vol 24h', fmtUsd(vm.vol24));
    addRow('holders', fmtNum(vm.holders));
    if (vm.holdersSample) addRow('', vm.holdersSample, 'muted');
    addRow('top 10', fmtPctRaw(vm.top10), vm.top10 != null && vm.top10 >= 40 ? 'warn' : null);
    addRow('dev', fmtPctRaw(vm.dev), vm.dev != null && vm.dev >= 10 ? 'warn' : null);
    addRow('lp locked', fmtPctRaw(vm.lpLocked), vm.lpLocked != null && vm.lpLocked < 50 ? 'warn' : 'up');
    addRow('mint auth', yesNo(vm.mintAuth), yesNoCls(vm.mintAuth));
    addRow('freeze auth', yesNo(vm.freezeAuth), yesNoCls(vm.freezeAuth));
    // task-1359: snipers / bundled from the wallet-intel scan (a reason instead of a number when not measured)
    if (vm.intel) {
      const lv = (l) => l === 'bad' ? 'down' : l === 'warn' ? 'warn' : l === 'ok' ? 'up' : 'muted';
      addRow('snipers', vm.intel.snipers, lv(vm.intel.snipersLevel));
      addRow('bundled', vm.intel.bundle, lv(vm.intel.bundleLevel));
    }
    addRow('rug score', vm.rugScore == null ? '—' : String(vm.rugScore), vm.rugScore != null && vm.rugScore >= 50 ? 'warn' : vm.rugScore != null ? 'up' : 'muted');
    if (Array.isArray(vm.risks) && vm.risks.length) {
      for (const r of vm.risks) {
        const lvl = r && r.level ? String(r.level) : '';
        const cls = /high|danger|crit/i.test(lvl) ? 'down' : /med|warn/i.test(lvl) ? 'warn' : 'muted';
        addRow('risk', `${r && r.name ? r.name : ''}${lvl ? '  (' + lvl + ')' : ''}`.trim(), cls);
      }
    }
    if (Array.isArray(vm.flags) && vm.flags.length) {
      for (const f of vm.flags) addRow('flag', String(f), 'muted');
    }
    if (vm.updatedAt) addRow('updated', new Date(vm.updatedAt).toISOString().slice(11, 19), 'muted');
  }

  function setData(a) {
    vm = a;
    const sym = String(vm.symbol || '?').replace(/^\$/, '');
    titleEl.textContent = `trenchscope · $${sym} · TOKEN`;
    document.title = `trenchscope · ${sym}`;
    const dir = (vm.chg && (vm.chg.h24 ?? vm.chg.h1)) || 0;
    if (rain) {
      rain.setMood(dir > 0.01 ? 'rainPump' : dir < -0.01 ? 'rainDump' : 'rain');
      rain.setActivity(Math.min(1, 0.4 + Math.abs(dir)));
      rain.setSources([sym, String(vm.mint || '').slice(0, 6)]);
    }
    DT.status(vm.price != null ? fmtPrice(vm.price) : 'no price', dir >= 0 ? 'up' : 'down');
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
