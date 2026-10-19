// dexterm popup — shared page harness (task-1290). Inlined BEFORE each page script under a CSP nonce.
// Provides the window.DT API the page scripts build on. No remote content, no innerHTML: every untrusted
// string (token name, symbol, address, feed text) is rendered with textContent / fillText only.
//
// Channels: a WebSocket to the TUI's loopback server (ticket → one-time token in the page's meta tags) and
// a native shell bridge (wry ipc) for drag / close. The page may ONLY send the allow-listed events in
// PopupToTui; the server drops anything else.
(() => {
  'use strict';
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || '';
  const WS_TOKEN = meta('dexterm-ws'), POPUP_ID = meta('dexterm-popup'), PORT = meta('dexterm-port');

  // ---------------------------------------------------------------- color helpers
  function hex(c) { const n = parseInt(String(c).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) { const A = hex(a), B = hex(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; }
  function rgba(c, a) { const [r, g, b] = hex(c); return `rgba(${r},${g},${b},${a})`; }
  const shortAddr = (s, n = 4) => { s = String(s); return s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s; };

  // ---------------------------------------------------------------- theme
  let T = { bg: '#020507', panel: '#03090c', border: '#0c3a24', borderFocus: '#39ff14', text: '#eafff0', muted: '#62c98a', dim: '#3aa866', accent: '#00f0ff', up: '#5dff6e', down: '#ff3b6b', warn: '#f5ff2d', ai: '#d97757', pump: '#ff2bd6', dbc: '#ff8a3d', rain: ['#06301a', '#0b5a2c', '#16a848', '#b8ffc8'], rainPump: ['#3a2a05', '#8a6410', '#f0b429', '#fff1b3'], rainDump: ['#3a0a12', '#7a1226', '#d12a4a', '#ffb3c1'], scan: '#000000' };
  const themeCbs = [];
  function applyTheme(t) {
    T = { ...T, ...t };
    const r = document.documentElement.style;
    for (const k of ['bg', 'panel', 'panelAlt', 'border', 'borderFocus', 'text', 'muted', 'dim', 'accent', 'up', 'down', 'warn', 'ai', 'pump', 'dbc']) if (T[k]) r.setProperty(`--${k}`, T[k]);
    if (rain) rain.invalidate();
    for (const cb of themeCbs) try { cb(T); } catch { /* page error reported separately */ }
  }

  // ---------------------------------------------------------------- matrix rain (full panel, glyph atlas → drawImage)
  const KATAKANA = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
  const HEX = '0123456789ABCDEF∷⋮⋯╳◇◆';
  const CELL = 14, CELL_H = 16;
  class Rain {
    constructor(canvas, cfg) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
      this.cfg = cfg || { enabled: true, speedScale: 1, density: 0.55 };
      this.atlas = null; this.drops = []; this.cols = 0; this.rows = 0; this.W = 0; this.H = 0; this.dpr = 1;
      this.mood = 'rain'; this.activity = this.cfg.density; this.sources = [];
    }
    invalidate() { this.atlas = null; }
    setSources(arr) { this.sources = (arr || []).filter(Boolean); this.atlas = null; }
    setActivity(a) { this.activity = Math.max(0.1, Math.min(1, a)); }
    setMood(m) { if (m && m !== this.mood) { this.mood = m; this.atlas = null; } }
    resize(W, H) {
      this.W = W; this.H = H; this.dpr = 1; // rain renders at 1x: phosphor can be soft, the viz above it cannot
      this.canvas.width = Math.max(1, Math.floor(W)); this.canvas.height = Math.max(1, Math.floor(H));
      this.cols = Math.floor(W / CELL); this.rows = Math.floor(H / CELL_H); this.drops = [];
      for (let c = 0; c < this.cols; c++) this.drops.push(this.newDrop(c, true));
      this.atlas = null;
    }
    randGlyph() { return Math.random() < 0.7 ? KATAKANA[Math.floor(Math.random() * KATAKANA.length)] : HEX[Math.floor(Math.random() * HEX.length)]; }
    newDrop(c, init) {
      const src = this.sources.length && Math.random() < 0.5 ? this.sources[Math.floor(Math.random() * this.sources.length)] : null;
      const len = 6 + Math.floor(Math.random() * 14);
      const cells = Array.from({ length: len }, (_, i) => (src && i < src.length ? src[src.length - 1 - i] : this.randGlyph()));
      const speed = (0.18 + 0.5 * this.activity) * (0.6 + Math.random() * 0.9) * (this.cfg.speedScale || 1);
      return { c, y: init ? Math.random() * this.rows * 2 - this.rows : -len - Math.random() * this.rows, speed, len, cells, period: 1 + Math.floor(Math.random() * 3), t: 0 };
    }
    buildAtlas() {
      const glyphs = [...KATAKANA, ...HEX, ...this.sources.join('')].filter((c, i, a) => a.indexOf(c) === i);
      const ramp = T[this.mood] || T.rain;
      const cv = document.createElement('canvas'); cv.width = Math.ceil(glyphs.length * CELL); cv.height = Math.ceil(4 * CELL_H);
      const g = cv.getContext('2d'); g.textBaseline = 'top'; g.textAlign = 'center';
      for (let tier = 0; tier < 4; tier++) { g.font = `${tier === 3 ? 'bold ' : ''}12px ui-monospace, Menlo, monospace`; g.fillStyle = ramp[tier]; for (let i = 0; i < glyphs.length; i++) g.fillText(glyphs[i], i * CELL + CELL / 2, tier * CELL_H + 1); }
      this.atlas = { cv, index: new Map(glyphs.map((c, i) => [c, i])) };
    }
    draw() {
      if (!this.cfg.enabled) return;
      if (!this.atlas) this.buildAtlas();
      const { cv, index } = this.atlas; const ctx = this.ctx;
      ctx.clearRect(0, 0, this.W, this.H);
      const density = 0.4 + 0.55 * this.activity;
      for (const d of this.drops) {
        if (++d.t % d.period === 0) d.y += d.speed * d.period;
        if (d.y - d.len > this.rows) { this.drops[d.c] = this.newDrop(d.c, false); continue; }
        if (Math.random() > density + 0.3) continue;
        for (let i = 0; i < d.len; i++) {
          const row = Math.floor(d.y) - i; if (row < 0 || row >= this.rows) continue;
          if (Math.random() < 0.04) d.cells[i] = this.randGlyph();
          const tier = i === 0 ? 3 : i < 3 ? 2 : i < d.len * 0.6 ? 1 : 0;
          const gi = index.get(d.cells[i]); if (gi == null) continue;
          ctx.drawImage(cv, gi * CELL, tier * CELL_H, CELL, CELL_H, d.c * CELL, row * CELL_H, CELL, CELL_H);
        }
      }
    }
  }
  let rain = null;

  // ---------------------------------------------------------------- shell bridge (wry ipc; Electron/WK kept for parity)
  function shellPost(obj) {
    const s = JSON.stringify(obj);
    if (window.ipc && window.ipc.postMessage) return window.ipc.postMessage(s);
    if (window.dextermShell && window.dextermShell.post) return window.dextermShell.post(s);
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dexterm) return window.webkit.messageHandlers.dexterm.postMessage(s);
  }

  // ---------------------------------------------------------------- WebSocket to the TUI's loopback server
  let ws = null, queue = [];
  const handlers = { hello: [], theme: [], data: [], update: [], pause: [], focus: [], close: [] };
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); else queue.push(o); }
  let rainCfg = { enabled: true, speedScale: 1, density: 0.55 };
  function connect() {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${encodeURIComponent(WS_TOKEN)}`);
    ws.onopen = () => { for (const q of queue) ws.send(JSON.stringify(q)); queue = []; send({ type: 'ready', page: DT.page, t: performance.now() }); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      switch (m.type) {
        case 'hello': if (m.rain) { rainCfg = m.rain; if (rain) rain.cfg = m.rain; } if (m.theme) applyTheme(m.theme); fire('hello', m); break;
        case 'theme': applyTheme(m.tokens || {}); break;
        case 'data': fire('data', m.payload, m.topic); break; // (task-1358 r3) the topic rides along for the widget wrapper
        case 'update': {
          const p = m.patch || {};
          if (rain) { if (p.activity != null) rain.setActivity(+p.activity); if (p.mood) rain.setMood(p.mood); if (p.rain != null) rain.cfg = { ...rain.cfg, enabled: !!p.rain }; }
          fire('update', p); break;
        }
        case 'pause': DT.paused = !!m.on; fire('pause', DT.paused); break;
        case 'focus': window.focus(); fire('focus', null); break;
        case 'close': fire('close', null); window.close && window.close(); break;
      }
    };
    ws.onclose = () => { const s = document.getElementById('status'); if (s) { s.textContent = 'disconnected'; s.style.color = T.down; } };
  }
  function fire(type, arg, extra) { for (const cb of handlers[type]) try { cb(arg, extra); } catch (err) { send({ type: 'log', msg: `handler ${type}: ${err && err.message}` }); } }

  // ---------------------------------------------------------------- chrome wiring (drag strip + close button + Escape)
  function wireChrome() {
    const drag = document.getElementById('drag'), close = document.getElementById('close');
    if (drag) drag.addEventListener('mousedown', (e) => { if (e.button === 0 && e.target.id !== 'close') { send({ type: 'event', name: 'popup.drag', payload: {} }); shellPost({ type: 'drag' }); } });
    if (close) close.addEventListener('click', requestClose);
    // task-1325: a page may consume Esc first (e.g. to cancel an armed drawing tool) via DT.onEscape.
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !(DT.onEscape && DT.onEscape())) requestClose(); });
  }
  // The TUI hears the request over the WS (and closes its handle); the native shell closes this window itself
  // on the ipc message (task-1325), so a close never depends on the TUI being responsive.
  function requestClose() { send({ type: 'event', name: 'popup.close-request', payload: {} }); shellPost({ type: 'close-request' }); }

  // ---------------------------------------------------------------- rAF loop + perf reporter (self-throttled to fpsCap)
  function loop(renderFn) {
    const frameTimes = []; let frames = 0, lastPerfT = performance.now(), lastT = performance.now(), longFrames = 0, lastFrameAt = 0;
    const minMs = 1000 / (DT.fpsCap || 60) - 0.5;
    const fpsEl = document.getElementById('fps');
    function frame(now) {
      requestAnimationFrame(frame);
      if (DT.paused) { lastT = now; return; }
      if (now - lastFrameAt < minMs) return;
      const dt = now - lastT; lastT = now; lastFrameAt = now; frames++; frameTimes.push(dt); if (dt > 20) longFrames++;
      if (rain && (DT.rainEvery <= 1 || frames % DT.rainEvery === 0)) rain.draw();
      try { renderFn(now, dt); } catch (err) { send({ type: 'log', msg: `render: ${err && err.message}` }); }
      if (now - lastPerfT >= 1000) {
        const fps = frames * 1000 / (now - lastPerfT);
        const sorted = frameTimes.slice().sort((a, b) => a - b); const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
        const mean = frameTimes.reduce((s, v) => s + v, 0) / (frameTimes.length || 1);
        if (fpsEl) fpsEl.textContent = `${fps.toFixed(0)} fps · ${mean.toFixed(1)} ms`;
        send({ type: 'perf', fps: +fps.toFixed(1), frameMs: +mean.toFixed(2), p95Ms: +p95.toFixed(2), long: longFrames, dpr: Math.min(2, window.devicePixelRatio || 1), w: innerWidth, h: innerHeight, pwned: typeof window.__pwned });
        frames = 0; frameTimes.length = 0; longFrames = 0; lastPerfT = now;
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- public API
  const DT = {
    page: 'popup', paused: false, fpsCap: 60,
    /** Draw the rain every Nth frame (task-1325: the chart page halves it; the chart itself renders on demand). */
    rainEvery: 1,
    /** True inside the native wry window (its ipc bridge exists), false in the browser fallback. */
    native: !!(window.ipc && window.ipc.postMessage),
    /** Optional page hook: return true to consume Escape before the default close. */
    onEscape: null,
    popupId: POPUP_ID,
    send, shellPost, requestClose, wireChrome, loop,
    hex, mix, rgba, shortAddr,
    get theme() { return T; },
    onData(fn) { handlers.data.push(fn); }, onUpdate(fn) { handlers.update.push(fn); }, onTheme(fn) { themeCbs.push(fn); },
    onHello(fn) { handlers.hello.push(fn); }, onPause(fn) { handlers.pause.push(fn); }, onClose(fn) { handlers.close.push(fn); }, onFocus(fn) { handlers.focus.push(fn); },
    status(text, kind) { const s = document.getElementById('status'); if (s) { s.textContent = text; s.style.color = kind === 'up' ? T.up : kind === 'down' ? T.down : kind === 'warn' ? T.warn : T.muted; } },
    /** Attach a full-panel rain canvas (by element id). Returns the Rain controller. */
    mountRain(canvasId) { const el = document.getElementById(canvasId); if (el) rain = new Rain(el, rainCfg); return rain; },
    rain() { return rain; },
    /** Start the WS connection; call once after handlers are registered. */
    connect,
  };
  window.addEventListener('error', (e) => send({ type: 'log', msg: `error: ${e.message} @${e.lineno}:${e.colno}` }));
  window.addEventListener('unhandledrejection', (e) => send({ type: 'log', msg: `rejection: ${e.reason && (e.reason.message || e.reason)}` }));
  window.DT = DT;
})();
