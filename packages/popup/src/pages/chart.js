// dexterm popup — CHART v2 (task-1325): TradingView Lightweight Charts™ 5.2.1 (Apache-2.0, vendored and served
// by our own loopback server — never a CDN) driven ONLY by our data: the ChartVM the terminal pushes over the
// WS (its cached/derived candles, its trade tape, its position ledger). Inlined after common.js + chart-lib.js
// under the page's CSP nonce. No innerHTML anywhere in this file: every untrusted string (symbol, name) goes
// through textContent or the chart's canvas text. The page can only REQUEST things (interval, indicator, style,
// scale) through allow-listed events; the server validates every payload against closed sets.
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'chart';
  const C = window.DTChart;
  const L = window.LightweightCharts;
  const $ = (id) => document.getElementById(id);
  const titleEl = $('title'), legendEl = $('legend'), liveEl = $('live'), bannerEl = $('banner'), hintEl = $('hint');
  const posEl = $('pos'), posTitleEl = $('pos-title'), posCapEl = $('pos-cap'), posCellsEl = $('pos-cells');
  const imgSlot = $('coin-img-slot');
  const chartEl = $('chart'), drawCv = $('draw'), dctx = drawCv.getContext('2d');
  const STALE_MS = 20_000;
  const DEFAULT_IND = ['volume', 'tape', 'ema9', 'ema21'];
  /** Exposed for the headless harness (measure/popup-v2-1325): first paint + setData → repaint latency. */
  const perf = window.__dtPerf = { firstPaintMs: null, firstPaintWall: null, dataLatencies: [], intervalLatencies: [], vmCount: 0 };

  const S = {
    vm: null, bars: [], key: null, interval: null, pendingInterval: null, mint: null,
    style: 'candles', scale: 'auto', ind: new Set(DEFAULT_IND), prefsApplied: false,
    draw: null, tPending: null, hover: null, drawings: [], lastDataAt: 0, firstPainted: false, fitNext: true,
    banners: { fallback: null, data: null },
    display: C.displayOf(null), // task-1366: price | mcap (from the VM's priceMode + supply)
  };

  const banner = () => {
    const lines = [S.banners.fallback, S.banners.data].filter(Boolean);
    bannerEl.hidden = lines.length === 0;
    bannerEl.textContent = lines.join('  ·  ');
  };

  // The page is useless without the vendored library: say so plainly instead of drawing a fake chart.
  if (!L || !C || typeof L.createChart !== 'function') {
    S.banners.data = 'chart library failed to load (the vendored Lightweight Charts route did not answer)';
    banner(); DT.wireChrome(); DT.connect(); return;
  }

  const rain = DT.mountRain('rain');
  DT.rainEvery = 2; // rain at half the frame rate behind the chart: atmosphere, not a CPU cost
  let T = DT.theme;

  // ---------------------------------------------------------------- time labels in the viewer's local time zone
  // Bar times are shifted by the page's current UTC offset (chart-lib setTzOffset), so formatting them with the
  // UTC getters prints local wall time and LWC's day/month tick marks fall on LOCAL boundaries.
  C.setTzOffset(-new Date().getTimezoneOffset() * 60);
  const pad = (n) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtTime(t) { const d = new Date(t * 1000); return `${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  function tickMark(t, type) {
    const d = new Date(t * 1000);
    if (type === 0) return String(d.getUTCFullYear());
    if (type === 1) return MON[d.getUTCMonth()];
    if (type === 2) return String(d.getUTCDate());
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  const volFmt = (v) => C.fmtUsd(v);

  // ---------------------------------------------------------------- chart + series
  const chart = L.createChart(chartEl, {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: 'rgba(0,0,0,0)' }, textColor: T.muted, fontSize: 11,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      attributionLogo: true, // REQUIRED attribution (license): TradingView logo link on the chart
      panes: { separatorColor: T.border, separatorHoverColor: DT.rgba(T.accent, 0.25), enableResize: true },
    },
    grid: { vertLines: { color: DT.rgba(T.border, 0.45) }, horzLines: { color: DT.rgba(T.border, 0.45) } },
    crosshair: {
      mode: L.CrosshairMode.Normal,
      vertLine: { color: DT.rgba(T.accent, 0.45), labelBackgroundColor: T.panel, width: 1, style: L.LineStyle.Dashed },
      horzLine: { color: DT.rgba(T.accent, 0.45), labelBackgroundColor: T.panel, width: 1, style: L.LineStyle.Dashed },
    },
    rightPriceScale: { borderColor: T.border, scaleMargins: { top: 0.1, bottom: 0.08 } },
    timeScale: { borderColor: T.border, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7, minBarSpacing: 0.5, tickMarkFormatter: tickMark },
    localization: { timeFormatter: fmtTime, locale: 'en-US' },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
  });
  // task-1366: the axis formatter follows the terminal's price mode (mcap = price × the current supply, K/M/B)
  const pricePF = (p) => ({ type: 'custom', formatter: C.axisFormatter(S.display), minMove: C.priceFormatFor(p).minMove });
  // Keep the position levels (entry / stop / target) and the live price in view: autoscale widens to include them
  // when they are within 3× of the last close (a far-away level would squash the candles; its row cell still shows it).
  function levels() {
    const vm = S.vm || {}, pos = vm.position || null, out = [];
    const last = S.bars.length ? S.bars[S.bars.length - 1].close : null;
    for (const v of [pos && pos.avgEntryUsd, pos && pos.stopUsd, pos && pos.targetUsd, vm.feed === 'LIVE' ? vm.livePrice : null]) {
      if (typeof v === 'number' && v > 0 && last && v / last < 3 && last / v < 3) out.push(v);
    }
    return out;
  }
  const autoscaleInfoProvider = (original) => {
    const res = original();
    const lv = levels();
    if (!res || !res.priceRange || !lv.length) return res;
    return { ...res, priceRange: { minValue: Math.min(res.priceRange.minValue, ...lv), maxValue: Math.max(res.priceRange.maxValue, ...lv) } };
  };
  const lineOpts = (color, w = 1) => ({ color, lineWidth: w, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, priceFormat: pricePF(1) });
  const main = {
    candles: chart.addSeries(L.CandlestickSeries, { upColor: T.up, downColor: T.down, borderUpColor: T.up, borderDownColor: T.down, wickUpColor: T.up, wickDownColor: T.down, priceLineColor: T.accent, priceLineStyle: L.LineStyle.Dashed, priceFormat: pricePF(1), autoscaleInfoProvider }, 0),
    line: chart.addSeries(L.LineSeries, { color: T.accent, lineWidth: 2, visible: false, priceLineColor: T.accent, priceLineStyle: L.LineStyle.Dashed, priceFormat: pricePF(1), autoscaleInfoProvider }, 0),
    area: chart.addSeries(L.AreaSeries, { lineColor: T.accent, topColor: DT.rgba(T.accent, 0.28), bottomColor: DT.rgba(T.accent, 0.0), lineWidth: 2, visible: false, priceLineColor: T.accent, priceLineStyle: L.LineStyle.Dashed, priceFormat: pricePF(1), autoscaleInfoProvider }, 0),
  };
  const markers = { candles: L.createSeriesMarkers(main.candles, []), line: L.createSeriesMarkers(main.line, []), area: L.createSeriesMarkers(main.area, []) };
  const IND_COLORS = () => ({ ema9: T.warn, ema21: T.pump || '#ff2bd6', vwap: T.dbc || '#ff8a3d', volma: DT.rgba(T.accent, 0.8) });
  const ind = {
    ema9: chart.addSeries(L.LineSeries, lineOpts(IND_COLORS().ema9), 0),
    ema21: chart.addSeries(L.LineSeries, lineOpts(IND_COLORS().ema21), 0),
    vwap: chart.addSeries(L.LineSeries, { ...lineOpts(IND_COLORS().vwap, 1), lineStyle: L.LineStyle.Dotted }, 0),
  };
  let vol = null, volMa = null;
  const watermark = L.createTextWatermark(chart.panes()[0], { horzAlign: 'center', vertAlign: 'center', lines: [] });
  const active = () => main[S.style];

  function ensureVolume(on) {
    if (on && !vol) {
      vol = chart.addSeries(L.HistogramSeries, { priceFormat: { type: 'custom', formatter: volFmt, minMove: 1 }, lastValueVisible: false, priceLineVisible: false }, 1);
      volMa = chart.addSeries(L.LineSeries, { ...lineOpts(IND_COLORS().volma, 1), priceFormat: { type: 'custom', formatter: volFmt, minMove: 1 } }, 1);
      sizePanes();
    } else if (!on && vol) {
      chart.removeSeries(volMa); chart.removeSeries(vol); vol = null; volMa = null;
    }
  }
  function sizePanes() {
    const panes = chart.panes();
    if (panes.length > 1) { const h = chartEl.clientHeight; panes[1].setHeight(Math.max(48, Math.round(h * 0.2))); }
  }

  // ---------------------------------------------------------------- price lines on the active series (entry/stop/target/live/drawn)
  const plines = new Map(); // name → { series, line }
  function setLine(name, opts) {
    const s = active(); const cur = plines.get(name);
    if (!opts) { if (cur) { try { cur.series.removePriceLine(cur.line); } catch { /* gone */ } plines.delete(name); } return; }
    if (cur && cur.series === s) { cur.line.applyOptions(opts); return; }
    if (cur) { try { cur.series.removePriceLine(cur.line); } catch { /* gone */ } }
    plines.set(name, { series: s, line: s.createPriceLine(opts) });
  }
  function rebindLines() { const saved = [...plines.entries()].map(([k, v]) => [k, v.line.options()]); for (const [k] of saved) setLine(k, null); for (const [k, o] of saved) setLine(k, o); }

  // ---------------------------------------------------------------- theme
  function applyChartTheme() {
    T = DT.theme;
    chart.applyOptions({
      layout: { textColor: T.muted, panes: { separatorColor: T.border, separatorHoverColor: DT.rgba(T.accent, 0.25) } },
      grid: { vertLines: { color: DT.rgba(T.border, 0.45) }, horzLines: { color: DT.rgba(T.border, 0.45) } },
      crosshair: { vertLine: { color: DT.rgba(T.accent, 0.45), labelBackgroundColor: T.panel }, horzLine: { color: DT.rgba(T.accent, 0.45), labelBackgroundColor: T.panel } },
      rightPriceScale: { borderColor: T.border }, timeScale: { borderColor: T.border },
    });
    main.candles.applyOptions({ upColor: T.up, downColor: T.down, borderUpColor: T.up, borderDownColor: T.down, wickUpColor: T.up, wickDownColor: T.down, priceLineColor: T.accent });
    main.line.applyOptions({ color: T.accent, priceLineColor: T.accent });
    main.area.applyOptions({ lineColor: T.accent, topColor: DT.rgba(T.accent, 0.28), bottomColor: DT.rgba(T.accent, 0), priceLineColor: T.accent });
    const ic = IND_COLORS(); ind.ema9.applyOptions({ color: ic.ema9 }); ind.ema21.applyOptions({ color: ic.ema21 }); ind.vwap.applyOptions({ color: ic.vwap });
    if (volMa) volMa.applyOptions({ color: ic.volma });
    if (S.bars.length) renderFull();
  }
  DT.onTheme(applyChartTheme);

  // ---------------------------------------------------------------- toolbar (buttons built with textContent only)
  const btns = { tf: new Map(), styles: new Map(), scales: new Map(), inds: new Map(), draws: new Map() };
  function mkBtn(group, id, label, title, onClick) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tb'; b.textContent = label; b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    $(group).appendChild(b); btns[group].set(id, b); return b;
  }
  C.INTERVALS.forEach((iv, i) => mkBtn('tf', iv, iv, `timeframe ${iv} (${i + 1})`, () => requestInterval(iv)));
  mkBtn('styles', 'candles', 'candles', 'candlesticks (c cycles)', () => setStyle('candles', true));
  mkBtn('styles', 'line', 'line', 'line (c cycles)', () => setStyle('line', true));
  mkBtn('styles', 'area', 'area', 'area (c cycles)', () => setStyle('area', true));
  mkBtn('scales', 'auto', 'auto', 'auto-scaled price axis (a)', () => setScale('auto', true));
  mkBtn('scales', 'log', 'log', 'logarithmic price axis (l)', () => setScale('log', true));
  mkBtn('scales', 'percent', '%', 'percent from the first visible bar (p)', () => setScale('percent', true));
  mkBtn('inds', 'ema9', 'EMA9', 'EMA 9 (e toggles 9+21)', () => toggleInd('ema9'));
  mkBtn('inds', 'ema21', 'EMA21', 'EMA 21 (e toggles 9+21)', () => toggleInd('ema21'));
  mkBtn('inds', 'vwap', 'VWAP', 'VWAP, UTC-day anchored (w)', () => toggleInd('vwap'));
  mkBtn('inds', 'volume', 'VOL', 'volume pane (v)', () => toggleInd('volume'));
  mkBtn('inds', 'volma', 'VOL·MA', 'volume 20-bar MA (m)', () => toggleInd('volma'));
  mkBtn('inds', 'tape', 'TAPE', 'buy/sell markers from the trade tape (b)', () => toggleInd('tape'));
  mkBtn('draws', 'h', '─ hline', 'horizontal line: click a price (h)', () => armDraw('h'));
  mkBtn('draws', 't', '╱ trend', 'trend line: click two points (t)', () => armDraw('t'));
  mkBtn('draws', 'x', '✕ clear', 'clear drawings (x; backspace = undo last)', () => clearDrawings());
  function syncToolbar() {
    for (const [iv, b] of btns.tf) { b.classList.toggle('on', iv === S.interval); b.classList.toggle('pending', iv === S.pendingInterval && iv !== S.interval); }
    for (const [k, b] of btns.styles) b.classList.toggle('on', k === S.style);
    for (const [k, b] of btns.scales) b.classList.toggle('on', k === S.scale);
    for (const [k, b] of btns.inds) b.classList.toggle('on', S.ind.has(k));
    for (const [k, b] of btns.draws) b.classList.toggle('on', k === S.draw);
  }

  // ---------------------------------------------------------------- requests to the TUI (validated server-side)
  function requestInterval(iv) {
    if (!C.INTERVALS.includes(iv)) return;
    if (iv === S.interval && !S.pendingInterval) return;
    S.pendingInterval = iv; S.reqAt = performance.now(); syncToolbar();
    DT.send({ type: 'event', name: 'chart.interval', payload: { interval: iv } });
  }
  function setStyle(st, user) {
    if (!C.STYLES.includes(st) || st === S.style) return;
    S.style = st;
    for (const k of C.STYLES) main[k].applyOptions({ visible: k === st });
    for (const k of C.STYLES) if (k !== st) { main[k].setData([]); markers[k].setMarkers([]); }
    rebindLines();
    if (S.bars.length) renderFull();
    syncToolbar();
    if (user) DT.send({ type: 'event', name: 'chart.style', payload: { style: st } });
  }
  function setScale(sc, user) {
    if (!C.SCALES.includes(sc)) return;
    S.scale = sc;
    chart.priceScale('right', 0).applyOptions({ mode: sc === 'log' ? L.PriceScaleMode.Logarithmic : sc === 'percent' ? L.PriceScaleMode.Percentage : L.PriceScaleMode.Normal, autoScale: true });
    syncToolbar();
    if (user) DT.send({ type: 'event', name: 'chart.scale', payload: { scale: sc } });
  }
  function toggleInd(id, force) {
    if (!C.INDICATORS.includes(id)) return;
    const on = force === undefined ? !S.ind.has(id) : force;
    if (on) S.ind.add(id); else S.ind.delete(id);
    if (id === 'volume') ensureVolume(on);
    if (S.bars.length) renderFull();
    syncToolbar();
    DT.send({ type: 'event', name: 'chart.indicator', payload: { id, on } });
  }
  function applyPrefs(p) {
    if (!p) return;
    if (Array.isArray(p.indicators)) S.ind = new Set(p.indicators.filter((x) => C.INDICATORS.includes(x)));
    ensureVolume(S.ind.has('volume'));
    if (p.style && p.style !== S.style) setStyle(p.style, false);
    if (p.scale) setScale(p.scale, false);
    S.prefsApplied = true; syncToolbar();
  }

  // ---------------------------------------------------------------- data → chart
  const periodMs = () => C.PERIOD_MS[S.interval] || 3_600_000;
  let indCache = { ema9: new Map(), ema21: new Map(), vwap: new Map() };
  const mapOf = (pts) => new Map(pts.map((p) => [p.time, p.value]));
  function seriesData(st) { return st === 'candles' ? S.bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })) : S.bars.map((b) => ({ time: b.time, value: b.close })); }
  function safeUpdate(series, point, fallback) { try { series.update(point); } catch { fallback(); } }

  function renderIndicators(tailOnly) {
    const out = { ema9: S.ind.has('ema9') ? C.ema(S.bars, 9) : [], ema21: S.ind.has('ema21') ? C.ema(S.bars, 21) : [], vwap: S.ind.has('vwap') ? C.vwap(S.bars) : [] };
    for (const k of ['ema9', 'ema21', 'vwap']) {
      indCache[k] = mapOf(out[k]);
      if (tailOnly && out[k].length) { for (const p of out[k].slice(-2)) safeUpdate(ind[k], p, () => ind[k].setData(out[k])); }
      else ind[k].setData(out[k]);
    }
    if (vol) {
      const v = C.volumes(S.bars, DT.rgba(T.up, 0.45), DT.rgba(T.down, 0.45));
      const ma = S.ind.has('volma') ? C.sma(v, 20) : [];
      if (tailOnly && v.length) {
        for (const p of v.slice(-2)) safeUpdate(vol, p, () => vol.setData(v));
        if (ma.length) for (const p of ma.slice(-2)) safeUpdate(volMa, p, () => volMa.setData(ma)); else volMa.setData([]);
      } else { vol.setData(v); volMa.setData(ma); }
    }
  }

  function renderMarkers() {
    const vm = S.vm || {};
    const times = new Set(S.bars.map((b) => b.time));
    const list = [];
    if (S.ind.has('tape')) list.push(...C.tapeMarkers(vm.trades, periodMs(), times, { up: DT.rgba(T.up, 0.85), down: DT.rgba(T.down, 0.85) }));
    if (vm.position && vm.position.fills) list.push(...C.fillMarkers(vm.position.fills, periodMs(), times, { buy: T.accent, sell: T.warn }));
    list.sort((a, b) => a.time - b.time);
    markers[S.style].setMarkers(list);
  }

  function renderOverlays() {
    const vm = S.vm || {};
    const pos = vm.position || null;
    if (pos && typeof pos.avgEntryUsd === 'number' && pos.avgEntryUsd > 0) {
      const pct = typeof pos.unrealizedPct === 'number' ? ` ${C.fmtPct(pos.unrealizedPct, 1)}` : '';
      setLine('entry', { price: pos.avgEntryUsd, color: T.warn, lineWidth: 1, lineStyle: L.LineStyle.Solid, axisLabelVisible: true, axisLabelColor: T.warn, axisLabelTextColor: T.bg, title: `ENTRY ${pos.sizeLabel}${pct}` });
    } else setLine('entry', null);
    setLine('stop', pos && typeof pos.stopUsd === 'number' && pos.stopUsd > 0 ? { price: pos.stopUsd, color: T.down, lineWidth: 1, lineStyle: L.LineStyle.Dashed, axisLabelVisible: true, title: 'STOP' } : null);
    setLine('target', pos && typeof pos.targetUsd === 'number' && pos.targetUsd > 0 ? { price: pos.targetUsd, color: T.up, lineWidth: 1, lineStyle: L.LineStyle.Dashed, axisLabelVisible: true, title: 'TARGET' } : null);
    const lastClose = S.bars.length ? S.bars[S.bars.length - 1].close : null;
    const lp = vm.feed === 'LIVE' && typeof vm.livePrice === 'number' && vm.livePrice > 0 && vm.livePrice !== lastClose ? vm.livePrice : null;
    setLine('live', lp ? { price: lp, color: T.accent, lineWidth: 1, lineStyle: L.LineStyle.Dotted, axisLabelVisible: true, axisLabelColor: T.accent, axisLabelTextColor: T.bg, title: 'LIVE' } : null);
    for (const d of S.drawings) if (d.kind === 'h') setLine(`hline-${d.id}`, { price: d.price, color: DT.rgba(T.accent, 0.85), lineWidth: 1, lineStyle: L.LineStyle.LargeDashed, axisLabelVisible: true, title: '' });
  }

  function applyPriceFormat() {
    const last = S.bars.length ? S.bars[S.bars.length - 1].close : 1;
    const pf = pricePF(last);
    for (const k of C.STYLES) main[k].applyOptions({ priceFormat: pf });
    for (const k of ['ema9', 'ema21', 'vwap']) ind[k].applyOptions({ priceFormat: pf });
  }
  function renderFull() {
    applyPriceFormat();
    active().setData(seriesData(S.style));
    renderIndicators(false);
    renderMarkers();
    renderOverlays();
    if (S.fitNext && S.bars.length) {
      const n = S.bars.length;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n - 140), to: n + 5 });
      S.fitNext = false;
    }
    renderLegend(S.hover); // indicator toggles change the legend's second row
  }
  function renderTail(tailBars) {
    const s = active();
    for (const b of tailBars) {
      const pt = S.style === 'candles' ? { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close } : { time: b.time, value: b.close };
      safeUpdate(s, pt, () => s.setData(seriesData(S.style)));
    }
    renderIndicators(true);
    renderMarkers();
    renderOverlays();
  }

  // ---------------------------------------------------------------- legend (crosshair OHLCV + indicator values)
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function renderLegend(time) {
    while (legendEl.firstChild) legendEl.removeChild(legendEl.firstChild);
    if (!S.bars.length) return;
    let i = time == null ? S.bars.length - 1 : C.indexOfTime(S.bars, time);
    if (i < 0) i = S.bars.length - 1;
    const b = S.bars[i], lg = C.legendFor(b, i > 0 ? S.bars[i - 1].close : null, S.display);
    const r1 = el('div', 'row1');
    for (const [k, v] of [['O', lg.o], ['H', lg.h], ['L', lg.l], ['C', lg.c]]) { r1.appendChild(el('b', null, k)); r1.appendChild(el('span', lg.up ? 'up' : 'down', ` ${v}`)); }
    r1.appendChild(el('span', lg.up ? 'up' : 'down', `  ${lg.chg}`));
    r1.appendChild(el('b', null, 'V')); r1.appendChild(el('span', null, ` ${lg.v}`));
    legendEl.appendChild(r1);
    const r2 = el('div', 'row2'); const ic = IND_COLORS();
    for (const k of ['ema9', 'ema21', 'vwap']) {
      if (!S.ind.has(k)) continue;
      const v = indCache[k].get(b.time);
      const s = el('span', 'ind', `${k === 'vwap' ? 'VWAP' : k === 'ema9' ? 'EMA 9' : 'EMA 21'} ${v == null ? '—' : C.axisFormatter(S.display)(v)}`); s.style.color = ic[k];
      r2.appendChild(s);
    }
    if (r2.firstChild) legendEl.appendChild(r2);
  }
  chart.subscribeCrosshairMove((p) => { S.hover = p && p.time != null ? p.time : null; renderLegend(S.hover); });

  // ---------------------------------------------------------------- header, LIVE badge, banner, position row
  function renderHeader() {
    const vm = S.vm; if (!vm) return;
    const sym = String(vm.symbol || '?').replace(/^\$/, '');
    // task-1366: the title says when the axis is market cap (history scaled by the CURRENT supply) or why it is not
    titleEl.textContent = `$${sym} · ${S.interval || vm.interval || ''}${S.display.label ? ' · ' + S.display.label : ''}${vm.name ? ' · ' + String(vm.name).slice(0, 32) : ''}`;
    document.title = `trenchscope · ${sym} · ${S.interval || ''}`;
    renderCoinImage(vm.image);
    const px = typeof vm.livePrice === 'number' && vm.livePrice > 0 ? vm.livePrice : vm.price;
    const ch = vm.chg && typeof vm.chg.h24 === 'number' ? vm.chg.h24 : null;
    // TokenView.chg is already in PERCENT (DexScreener priceChange: 42 = +42 %), same as the terminal header.
    const head = S.display.mode === 'mcap' && typeof px === 'number' ? `$${C.fmtMcapAxis(px * S.display.supply)} (${C.fmtPrice(px)})` : C.fmtPrice(px);
    DT.status(`${head}${ch == null ? '' : `  ${ch >= 0 ? '+' : '-'}${Math.abs(ch).toFixed(Math.abs(ch) >= 1000 ? 0 : 1)}% 24h`}`, ch == null ? null : ch >= 0 ? 'up' : 'down');
    watermark.applyOptions({ lines: [{ text: `${sym} · ${S.interval || ''}`, color: DT.rgba(T.accent, 0.06), fontSize: 46, fontStyle: 'bold', fontFamily: 'ui-monospace, Menlo, monospace' }] });
  }
  // task-1326: the coin image comes from OUR loopback server only (`/img/<32 hex>.png`); anything else is ignored,
  // so a hostile VM can never make the page load a remote URL (the CSP would refuse it too).
  let imgShown = null;
  function renderCoinImage(path) {
    const ok = typeof path === 'string' && /^\/img\/[0-9a-f]{32}\.png$/.test(path);
    if (!ok) { if (imgShown !== null) { imgShown = null; while (imgSlot.firstChild) imgSlot.removeChild(imgSlot.firstChild); imgSlot.hidden = true; } return; }
    if (imgShown === path) return;
    imgShown = path;
    while (imgSlot.firstChild) imgSlot.removeChild(imgSlot.firstChild);
    const im = document.createElement('img');
    im.width = 16; im.height = 16; im.alt = ''; im.decoding = 'async'; im.referrerPolicy = 'no-referrer';
    im.src = path; // same-origin path: resolves against this loopback origin
    im.onerror = () => { imgSlot.hidden = true; };
    imgSlot.appendChild(im);
    imgSlot.hidden = false;
  }
  function renderLive() {
    if (!S.lastDataAt) { liveEl.className = 'live wait'; liveEl.textContent = '● …'; return; }
    const age = performance.now() - S.lastDataAt;
    const feed = S.vm && S.vm.feed === 'LIVE' ? 'stream' : 'poll';
    if (age > STALE_MS) { liveEl.className = 'live stale'; liveEl.textContent = `◌ STALE ${Math.round(age / 1000)}s`; liveEl.title = 'no tick from the terminal recently'; }
    else { liveEl.className = 'live on'; liveEl.textContent = '● LIVE'; liveEl.title = `ticks from the terminal (${feed})`; }
  }
  setInterval(renderLive, 1000);
  function renderDataBanner() {
    const vm = S.vm || {};
    if (vm.cold) S.banners.data = `warming ${vm.interval} from the terminal's candle cache — appears as soon as the terminal has it (no extra requests)`;
    else if (!S.bars.length && vm.source && vm.source.state === 'loading') S.banners.data = 'loading candles…';
    else if (!S.bars.length) S.banners.data = `no candles for ${vm.interval || 'this timeframe'}${vm.source && vm.source.reason ? ` · ${vm.source.reason}` : ''}`;
    else if (vm.source && (vm.source.stale || vm.source.state === 'error')) S.banners.data = `candles stale${vm.source.reason ? ` · ${vm.source.reason}` : ''}`;
    else S.banners.data = null;
    banner();
  }
  function renderPosition() {
    const pos = S.vm && S.vm.position;
    if (!pos) { posEl.hidden = true; return; }
    posEl.hidden = false;
    posTitleEl.textContent = pos.kind === 'paper' ? '◈ POSITION · PAPER' : '◈ POSITION';
    posTitleEl.classList.toggle('live-ledger', pos.kind !== 'paper');
    posCapEl.textContent = pos.caption || '';
    while (posCellsEl.firstChild) posCellsEl.removeChild(posCellsEl.firstChild);
    for (const c of pos.cells || []) {
      const d = el('div', 'pos-cell'); d.appendChild(el('span', 'k', c.label));
      d.appendChild(el('span', `v ${['up', 'down', 'muted', 'warn'].includes(c.tone) ? c.tone : ''}`, c.value));
      posCellsEl.appendChild(d);
    }
  }

  // ---------------------------------------------------------------- incoming view models
  function onData(vm) {
    if (!vm || typeof vm !== 'object') return;
    perf.vmCount++;
    S.lastDataAt = performance.now();
    if (vm.mint !== S.mint) { S.mint = vm.mint; S.fitNext = true; clearDrawings(true); }
    if (!S.prefsApplied) applyPrefs(vm.prefs || { indicators: DEFAULT_IND, style: 'candles', scale: 'auto' });
    const prevKey = S.key;
    const tail = vm.mode === 'tail';
    // task-1366: a mode / supply change re-labels the axis in place (the bars are prices either way)
    const disp = C.displayOf(vm);
    if (disp.key !== S.display.key) { S.display = disp; applyPriceFormat(); }
    if (tail && (!vm.seriesKey || vm.seriesKey !== S.key)) { S.vm = { ...vm, candles: [] }; renderHeader(); renderPosition(); renderOverlays(); return; }
    const intervalChanged = vm.interval !== S.interval;
    S.interval = vm.interval;
    const answered = S.pendingInterval === vm.interval ? S.reqAt : null;
    if (S.pendingInterval === vm.interval) S.pendingInterval = null;
    S.vm = vm;
    if (tail) {
      const before = S.bars.length;
      S.bars = C.mergeTail(S.bars, vm.candles);
      renderTail(S.bars.slice(Math.max(0, before - 1)));
    } else {
      S.bars = C.toBars(vm.candles);
      S.key = vm.seriesKey || null;
      if (intervalChanged || S.key !== prevKey) S.fitNext = true;
      renderFull();
    }
    renderHeader(); renderLegend(S.hover); renderDataBanner(); renderPosition(); syncToolbar(); renderLive();
    // rain mood follows direction (gold on a pump, red-shift on a dump), as in the v1 HUD; chg is in percent
    const dir = vm.chg ? (vm.chg.h24 ?? vm.chg.h1 ?? 0) : 0;
    if (rain) { rain.setMood(dir > 1 ? 'rainPump' : dir < -1 ? 'rainDump' : 'rain'); rain.setActivity(Math.min(1, 0.4 + Math.abs(dir) / 100)); rain.setSources([String(vm.symbol || ''), String(vm.mint || '').slice(0, 6)]); }
    // paint measurement: the frame after next has the chart's render committed
    const sentAt = typeof vm.sentAt === 'number' ? vm.sentAt : null;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const wall = Date.now();
      if (answered != null) perf.intervalLatencies.push(+(performance.now() - answered).toFixed(1)); // request → repainted, in-page
      if (!S.firstPainted && S.bars.length) {
        S.firstPainted = true; perf.firstPaintMs = +performance.now().toFixed(1); perf.firstPaintWall = wall;
        DT.send({ type: 'event', name: 'chart.painted', payload: { kind: 'first', ms: perf.firstPaintMs, sentAt: sentAt ?? 0 } });
      } else if (sentAt) {
        const ms = Math.max(0, wall - sentAt); perf.dataLatencies.push(ms);
        if (perf.dataLatencies.length <= 20 || perf.dataLatencies.length % 20 === 0) DT.send({ type: 'event', name: 'chart.painted', payload: { kind: 'data', ms, sentAt } });
      }
    }));
  }
  DT.onData(onData);
  DT.onHello((m) => {
    const p = (m && m.popup && m.popup.params) || {};
    // Browser fallback: say WHY on the page itself (the terminal shows the same reason as a toast).
    if (!DT.native) S.banners.fallback = `opened in your browser, not the dexterm window: ${typeof p.fallback === 'string' ? p.fallback : 'the native popup shell is unavailable'}`;
    banner();
  });

  // ---------------------------------------------------------------- drawing tools: horizontal line + trend line
  let drawId = 0, mouse = null;
  function armDraw(kind) {
    S.draw = kind && S.draw !== kind ? kind : null; S.tPending = null; mouse = null;
    drawCv.classList.toggle('armed', !!S.draw);
    hintEl.hidden = !S.draw;
    hintEl.textContent = S.draw === 'h' ? 'click a price for a horizontal line · esc cancel' : S.draw === 't' ? 'click the first point · esc cancel' : '';
    syncToolbar();
  }
  function clearDrawings(silent) {
    for (const d of S.drawings) if (d.kind === 'h') setLine(`hline-${d.id}`, null);
    S.drawings = []; if (!silent) armDraw(null);
  }
  function undoDrawing() { const d = S.drawings.pop(); if (d && d.kind === 'h') setLine(`hline-${d.id}`, null); }
  function pointAt(e) {
    const r = chartEl.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
    const logical = chart.timeScale().coordinateToLogical(x); const price = active().coordinateToPrice(y);
    if (logical == null || price == null) return null;
    return { time: C.timeOfLogical(S.bars, logical, periodMs() / 1000), price };
  }
  drawCv.addEventListener('mousedown', (e) => {
    if (!S.draw || e.button !== 0 || !S.bars.length) return;
    e.preventDefault();
    const pt = pointAt(e); if (!pt) return;
    if (S.draw === 'h') { S.drawings.push({ kind: 'h', id: ++drawId, price: pt.price }); renderOverlays(); armDraw(null); return; }
    if (!S.tPending) { S.tPending = pt; hintEl.textContent = 'click the second point · esc cancel'; return; }
    S.drawings.push({ kind: 't', id: ++drawId, a: S.tPending, b: pt }); armDraw(null);
  });
  drawCv.addEventListener('mousemove', (e) => { mouse = S.draw === 't' && S.tPending ? pointAt(e) : null; });
  function resizeDraw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1); const w = chartEl.clientWidth, h = chartEl.clientHeight;
    if (drawCv.width !== Math.floor(w * dpr) || drawCv.height !== Math.floor(h * dpr)) { drawCv.width = Math.floor(w * dpr); drawCv.height = Math.floor(h * dpr); }
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  /** Trend lines live in (time, price) space and are re-projected every frame, so they pan/zoom with the chart. */
  function drawOverlay() {
    resizeDraw();
    const w = chartEl.clientWidth, h = chartEl.clientHeight;
    dctx.clearRect(0, 0, w, h);
    const segs = S.drawings.filter((d) => d.kind === 't').map((d) => [d.a, d.b]);
    if (S.tPending && mouse) segs.push([S.tPending, mouse]);
    if (!segs.length || !S.bars.length) return;
    const ts = chart.timeScale(), s = active(), pS = periodMs() / 1000;
    const paneH = chart.panes()[0] ? chart.panes()[0].getHeight() : h;
    dctx.save(); dctx.beginPath(); dctx.rect(0, 0, ts.width(), paneH); dctx.clip();
    dctx.strokeStyle = T.accent; dctx.fillStyle = T.accent; dctx.lineWidth = 1.5;
    for (const [a, b] of segs) {
      const xa = ts.logicalToCoordinate(C.logicalOf(S.bars, a.time, pS)), xb = ts.logicalToCoordinate(C.logicalOf(S.bars, b.time, pS));
      const ya = s.priceToCoordinate(a.price), yb = s.priceToCoordinate(b.price);
      if ([xa, xb, ya, yb].some((v) => v == null)) continue;
      dctx.beginPath(); dctx.moveTo(xa, ya); dctx.lineTo(xb, yb); dctx.stroke();
      for (const [x, y] of [[xa, ya], [xb, yb]]) { dctx.beginPath(); dctx.arc(x, y, 2.5, 0, Math.PI * 2); dctx.fill(); }
    }
    dctx.restore();
  }

  // ---------------------------------------------------------------- keyboard (terminal-style, single keys)
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const n = parseInt(k, 10);
    if (n >= 1 && n <= 6) { requestInterval(C.INTERVALS[n - 1]); return; }
    switch (k) {
      case 'c': setStyle(C.STYLES[(C.STYLES.indexOf(S.style) + 1) % C.STYLES.length], true); break;
      case 'a': setScale('auto', true); break;
      case 'l': setScale(S.scale === 'log' ? 'auto' : 'log', true); break;
      case 'p': case '%': setScale(S.scale === 'percent' ? 'auto' : 'percent', true); break;
      case 'e': { const on = !(S.ind.has('ema9') && S.ind.has('ema21')); toggleInd('ema9', on); toggleInd('ema21', on); break; }
      case 'w': toggleInd('vwap'); break;
      case 'm': toggleInd('volma'); break;
      case 'v': toggleInd('volume'); break;
      case 'b': toggleInd('tape'); break;
      case 'h': armDraw('h'); break;
      case 't': armDraw('t'); break;
      case 'x': clearDrawings(); break;
      case 'Backspace': undoDrawing(); renderOverlays(); break;
      case 'f': chart.timeScale().fitContent(); break;
      case 'r': chart.timeScale().scrollToRealTime(); break;
      case 'q': DT.requestClose(); break;
      default: return;
    }
    e.preventDefault();
  });
  // Esc cancels an armed drawing tool first; otherwise common.js closes the popup.
  DT.onEscape = () => { if (S.draw) { armDraw(null); return true; } return false; };

  // In the native window the attribution links must not navigate the HUD (the shell refuses off-origin
  // navigation anyway); in the browser fallback they open normally in a new tab (target=_blank, noopener).
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && DT.native) e.preventDefault();
  }, true);

  window.addEventListener('resize', () => { sizePanes(); });
  ensureVolume(S.ind.has('volume'));
  syncToolbar();
  DT.wireChrome();
  DT.connect();
  DT.loop(drawOverlay);
  window.__dtChart = { chart, S, main, ind, get vol() { return vol; } }; // harness hook (read-only use)
})();
