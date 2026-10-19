// dexterm popup — chart v2 pure helpers (task-1325). No DOM, no network, no globals besides the export.
// Inlined into the chart page (before chart.js) under the page's CSP nonce; test/chart-lib.test.ts loads the
// same file through node:vm to unit-test the math. Everything here works on OUR data only: the ChartVM's
// candles (from the terminal's cached/derived series), its trade tape and its position fills.
(function (root) {
  'use strict';
  const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const PERIOD_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
  const INDICATORS = ['ema9', 'ema21', 'vwap', 'volma', 'volume', 'tape'];
  const STYLES = ['candles', 'line', 'area'];
  const SCALES = ['auto', 'log', 'percent'];
  const DAY_MS = 86400e3;
  const fin = (n) => typeof n === 'number' && Number.isFinite(n);
  const sec = (ms) => Math.floor(ms / 1000);
  // LWC lays out tick marks on UTC boundaries. To show the viewer's local wall time with correct day/month
  // ticks, every bar time is shifted by ONE fixed offset (the page's current UTC offset, set once at load).
  // A single offset (not per-timestamp) means a DST change can never make two bars collide.
  let OFFSET_S = 0;
  function setTzOffset(s) { OFFSET_S = fin(s) ? Math.trunc(s) : 0; }
  const chartTime = (ms) => sec(ms) + OFFSET_S;

  /** ChartVM candles (ms, OHLCV) → sorted, de-duplicated LWC bars. `t` keeps the real UTC ms; `time` is the
   *  chart time (UTC seconds + the fixed local offset). Non-finite bars are dropped. */
  function toBars(candles) {
    const byT = new Map();
    for (const c of candles || []) {
      if (!c || !fin(c.t) || !fin(c.o) || !fin(c.h) || !fin(c.l) || !fin(c.c)) continue;
      byT.set(chartTime(c.t), { t: c.t, time: chartTime(c.t), open: c.o, high: Math.max(c.h, c.o, c.c), low: Math.min(c.l, c.o, c.c), close: c.c, volume: fin(c.v) && c.v > 0 ? c.v : 0 });
    }
    return [...byT.values()].sort((a, b) => a.time - b.time);
  }

  /** Merge a 'tail' (the last ≤2 bars of the same series) into bars: same time replaces, newer appends. */
  function mergeTail(bars, tail) {
    const out = bars.slice();
    for (const b of toBars(tail)) {
      const last = out[out.length - 1];
      if (!last || b.time > last.time) out.push(b);
      else {
        // replace in place (usually the last or second-last bar); older-than-window tails are ignored
        for (let i = out.length - 1; i >= Math.max(0, out.length - 4); i--) if (out[i].time === b.time) { out[i] = b; break; }
      }
    }
    return out;
  }

  /** Exponential moving average of closes, seeded with the SMA of the first `period` closes. */
  function ema(bars, period) {
    const out = [];
    if (!(period >= 1) || bars.length < period) return out;
    const k = 2 / (period + 1);
    let seed = 0;
    for (let i = 0; i < period; i++) seed += bars[i].close;
    let v = seed / period;
    out.push({ time: bars[period - 1].time, value: v });
    for (let i = period; i < bars.length; i++) { v = bars[i].close * k + v * (1 - k); out.push({ time: bars[i].time, value: v }); }
    return out;
  }

  /** Simple moving average of `values` ({time, value}). */
  function sma(points, period) {
    const out = [];
    if (!(period >= 1)) return out;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      sum += points[i].value;
      if (i >= period) sum -= points[i - period].value;
      if (i >= period - 1) out.push({ time: points[i].time, value: sum / period });
    }
    return out;
  }

  /**
   * VWAP anchored to the UTC day (resets at 00:00 UTC, the usual 24/7 crypto session). Typical price
   * (H+L+C)/3 weighted by the bar's volume — our volume is USD (GeckoTerminal), which still yields a
   * volume-weighted average PRICE. A day with no volume so far carries the typical price.
   */
  function vwap(bars) {
    const out = [];
    let day = null, pv = 0, vol = 0;
    for (const b of bars) {
      const d = Math.floor((fin(b.t) ? b.t : b.time * 1000) / DAY_MS); // the real UTC day, not the shifted one
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const tp = (b.high + b.low + b.close) / 3;
      pv += tp * b.volume; vol += b.volume;
      out.push({ time: b.time, value: vol > 0 ? pv / vol : tp });
    }
    return out;
  }

  /** Volume histogram points, coloured by candle direction. */
  function volumes(bars, upColor, downColor) {
    return bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? upColor : downColor }));
  }

  /** The chart time of the bar a ms timestamp falls in, for a period (same shift as toBars). */
  function barTimeOf(tMs, periodMs) { return chartTime(Math.floor(tMs / periodMs) * periodMs); }

  /**
   * Buy/sell markers from the tape, aggregated per bar and side (one arrow per side per bar; size grows with
   * the USD traded in that bar). Only bars that exist in the series get a marker. Sorted by time.
   */
  function tapeMarkers(trades, periodMs, barTimes, colors) {
    const agg = new Map();
    for (const t of trades || []) {
      if (!t || !fin(t.t) || (t.side !== 'buy' && t.side !== 'sell')) continue;
      const time = barTimeOf(t.t, periodMs);
      if (!barTimes.has(time)) continue;
      const k = `${time}:${t.side}`;
      const a = agg.get(k) || { time, side: t.side, n: 0, usd: 0 };
      a.n++; a.usd += fin(t.usd) ? Math.max(0, t.usd) : 0;
      agg.set(k, a);
    }
    const out = [];
    for (const a of agg.values()) {
      const size = Math.max(0.5, Math.min(1.6, 0.5 + Math.log10(1 + a.usd) / 4));
      out.push(a.side === 'buy'
        ? { time: a.time, position: 'belowBar', shape: 'arrowUp', color: colors.up, size, id: `tape-b-${a.time}` }
        : { time: a.time, position: 'aboveBar', shape: 'arrowDown', color: colors.down, size, id: `tape-s-${a.time}` });
    }
    return out.sort((x, y) => x.time - y.time);
  }

  /**
   * Position fill markers (paper ledger fills of the current position) at their fill time and exact fill
   * price when known. Fills outside the loaded series are skipped (the row still shows the position).
   */
  function fillMarkers(fills, periodMs, barTimes, colors) {
    const out = [];
    let lastBar = -Infinity;
    for (const t of barTimes) if (t > lastBar) lastBar = t;
    for (const f of fills || []) {
      if (!f || !fin(f.t) || (f.side !== 'buy' && f.side !== 'sell')) continue;
      let time = barTimeOf(f.t, periodMs);
      // A fill newer than the last candle (the candle feed lags 1–2 min) sits on the forming/last bar, the way
      // a trading chart shows a fresh execution — up to 3 periods ahead; older gaps are skipped.
      if (!barTimes.has(time) && time > lastBar && time - lastBar <= (3 * periodMs) / 1000) time = lastBar;
      if (!barTimes.has(time)) continue;
      const text = `${f.side === 'buy' ? 'BUY' : 'SELL'} ${fin(f.sol) ? fmtSol(f.sol) : ''}`.trim();
      const m = { time, shape: f.side === 'buy' ? 'arrowUp' : 'arrowDown', color: f.side === 'buy' ? colors.buy : colors.sell, text, size: 1.4, id: `fill-${f.side}-${f.t}` };
      if (fin(f.priceUsd) && f.priceUsd > 0) { m.position = f.side === 'buy' ? 'atPriceBottom' : 'atPriceTop'; m.price = f.priceUsd; }
      else m.position = f.side === 'buy' ? 'belowBar' : 'aboveBar';
      out.push(m);
    }
    return out.sort((x, y) => x.time - y.time);
  }

  /** LWC price format for a price magnitude: enough decimals for memecoin prices (down to 1e-12). */
  function priceFormatFor(p) {
    if (!fin(p) || p <= 0) return { type: 'price', precision: 6, minMove: 1e-6 };
    const mag = Math.floor(Math.log10(p));
    const precision = Math.max(2, Math.min(12, 3 - mag + (p < 1 ? 1 : 0)));
    return { type: 'price', precision, minMove: Number((10 ** -precision).toPrecision(1)) };
  }

  // ---- formatting (mirrors @dexterm/tui fmtPrice: subscript zero-compression, $0.0₄123)
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  function fmtPrice(p) {
    if (!fin(p)) return '—';
    if (p < 0) return '-' + fmtPrice(-p);
    if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return '$' + p.toFixed(p >= 100 ? 2 : 3);
    if (p >= 0.01) return '$' + p.toFixed(4);
    if (p === 0) return '$0';
    const s = p.toFixed(14);
    const m = s.match(/^0\.(0*)(\d+)/);
    if (!m) return '$' + p;
    const zeros = m[1].length;
    const digits = m[2].replace(/0+$/, '').slice(0, 4) || '0';
    if (zeros < 3) return `$0.${m[1]}${digits}`;
    return `$0.0${String(zeros).split('').map((c) => SUB[Number(c)]).join('')}${digits}`;
  }
  /** Axis/crosshair price label: fmtPrice without the $ (TradingView style). */
  function fmtAxis(p) { return fmtPrice(p).replace('$', ''); }
  function fmtUsd(x) {
    if (!fin(x)) return '—';
    const a = Math.abs(x), s = x < 0 ? '-' : '';
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
    return `${s}$${a.toFixed(0)}`;
  }
  // ---- task-1366 market cap (mirrors @dexterm/tui fmtMcapBare: K/M/B/T, ≤ 3 significant digits, never 1000K)
  const MC_UNITS = ['', 'K', 'M', 'B', 'T'];
  function fmtMcapAxis(n) {
    if (!fin(n)) return '—';
    const sign = n < 0 ? '-' : '';
    let a = Math.abs(n);
    if (a === 0) return '0';
    if (a < 1) return sign + String(Number(a.toPrecision(2)));
    let u = 0;
    while (u < MC_UNITS.length - 1 && a >= 1000) { a /= 1000; u++; }
    let r = Number(a.toPrecision(3));
    if (r >= 1000 && u < MC_UNITS.length - 1) { r = Number((r / 1000).toPrecision(3)); u++; }
    return `${sign}${r >= 1000 ? String(Math.round(r)) : String(r)}${MC_UNITS[u]}`;
  }
  const MCAP_LABEL = 'mcap (current supply)';
  const MCAP_FALLBACK = 'supply unknown · showing price';
  /**
   * How the page shows numbers for a VM: `mcap` (with the supply multiplier) only when the terminal is in mcap mode AND
   * sent a usable supply; mcap mode without one is `price` + a visible note. Never invents a supply.
   */
  function displayOf(vm) {
    const wantMcap = !!vm && vm.priceMode === 'mcap';
    const supply = wantMcap && fin(vm.supply) && vm.supply > 0 ? vm.supply : null;
    // the key changes only when the supply moves in its 4th significant digit (no re-format on every tick)
    if (supply) return { mode: 'mcap', supply, label: MCAP_LABEL, key: `mcap:${Number(supply.toPrecision(4))}` };
    return { mode: 'price', supply: null, label: wantMcap ? MCAP_FALLBACK : null, key: wantMcap ? 'price:fallback' : 'price' };
  }
  /** The Y-axis / crosshair label formatter for a display: mcap = price × supply in K/M/B, else the price label. */
  function axisFormatter(d) {
    if (d && d.mode === 'mcap' && fin(d.supply)) { const s = d.supply; return (p) => fmtMcapAxis(p * s); }
    return fmtAxis;
  }
  function fmtPct(frac, digits = 2) { return fin(frac) ? `${frac >= 0 ? '+' : '-'}${Math.abs(frac * 100).toFixed(digits)}%` : '—'; }
  function fmtSol(n) { return `${n >= 100 ? n.toFixed(0) : n >= 0.01 ? n.toFixed(2) : n.toFixed(4)} SOL`; }

  /**
   * Crosshair/last-bar legend values for one bar (strings), with change vs the previous close. task-1366: with an mcap
   * display, O/H/L/C read market cap and the close carries the price in parentheses (`C 1.2M ($0.0₄123)`).
   */
  function legendFor(bar, prevClose, display) {
    if (!bar) return null;
    const base = fin(prevClose) && prevClose > 0 ? prevClose : bar.open;
    const chg = base > 0 ? (bar.close - base) / base : null;
    const f = axisFormatter(display);
    const mc = !!display && display.mode === 'mcap';
    return { o: f(bar.open), h: f(bar.high), l: f(bar.low), c: mc ? `${f(bar.close)} (${fmtPrice(bar.close)})` : f(bar.close), v: fmtUsd(bar.volume), chg: fmtPct(chg), up: bar.close >= bar.open };
  }

  /** Index of the bar at `time` (binary search), or -1. */
  function indexOfTime(bars, time) {
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const t = bars[mid].time; if (t === time) return mid; if (t < time) lo = mid + 1; else hi = mid - 1; }
    return -1;
  }

  /** Fractional logical index for any time (extrapolated past either end by the bar period). */
  function logicalOf(bars, time, periodS) {
    if (!bars.length) return null;
    const first = bars[0].time, last = bars[bars.length - 1].time;
    if (time <= first) return (time - first) / periodS;
    if (time >= last) return bars.length - 1 + (time - last) / periodS;
    let lo = 0, hi = bars.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (bars[mid].time <= time) lo = mid; else hi = mid; }
    const span = bars[hi].time - bars[lo].time;
    return lo + (span > 0 ? (time - bars[lo].time) / span : 0);
  }

  /** Time (UTC s) for a fractional logical index (inverse of logicalOf). */
  function timeOfLogical(bars, logical, periodS) {
    if (!bars.length || !fin(logical)) return null;
    const n = bars.length;
    if (logical <= 0) return bars[0].time + logical * periodS;
    if (logical >= n - 1) return bars[n - 1].time + (logical - (n - 1)) * periodS;
    const i = Math.floor(logical), f = logical - i;
    return bars[i].time + f * (bars[i + 1].time - bars[i].time);
  }

  const api = { setTzOffset, chartTime, INTERVALS, PERIOD_MS, INDICATORS, STYLES, SCALES, toBars, mergeTail, ema, sma, vwap, volumes, barTimeOf, tapeMarkers, fillMarkers, priceFormatFor, fmtPrice, fmtAxis, fmtUsd, fmtPct, fmtSol, legendFor, fmtMcapAxis, displayOf, axisFormatter, MCAP_LABEL, MCAP_FALLBACK, indexOfTime, logicalOf, timeOfLogical };
  root.DTChart = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
