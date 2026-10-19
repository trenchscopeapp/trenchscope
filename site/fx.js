// Page motion and the live trench.
// - liveTrench: a WebGL2 ASCII field. The near ridge is a candle chart that keeps printing new candles
//   from the right edge, one cell step at a time like the terminal, drawn in glyphs picked by brightness
//   on the GPU. The cursor lifts the ridge under it; the tour's key presses send a ring through it.
//   Without WebGL2 the ASCII Magic plates and the canvas glyph field stay as they are.
// - reveals: headings typed in by a cursor, list rows wiped in, mono labels decrypted in the app's
//   own hex glyphs (after React Bits Decrypted Text), install commands typed once, a keycap wave.
// - sparks: line sparks on click (after React Bits Click Spark); magnet on the primary action
//   (after React Bits Magnet); a glare on the screen glass that follows the pointer (after Glare Hover).
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// ---------------------------------------------------------------- live trench (WebGL2)
const RAMP = ' .·:-=+*x#%@█';

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
uniform sampler2D uSeries;
uniform vec2 uRes;
uniform vec2 uCell;
uniform float uN;
uniform float uCpc;
uniform float uShift;
uniform float uLast;
uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uPulse;
uniform float uAlpha;
uniform vec3 uLastCol;
out vec4 o;
const vec3 INK = vec3(0.93);
const vec3 UP = vec3(0.32, 0.88, 0.54);
const vec3 DOWN = vec3(1.0, 0.42, 0.36);
float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 cell = floor(frag / uCell);
  vec2 inCell = fract(frag / uCell);
  vec2 cc = (cell + 0.5) * uCell;
  float y = cc.y / uRes.y;
  float ch = uCell.y / uRes.y;
  float ci = cell.x + uShift;
  float idx = floor(ci / uCpc);
  float local = mod(ci, uCpc);
  vec4 k = texelFetch(uSeries, ivec2(int(idx), 0), 0);
  float lift = 0.0;
  if (uMouse.x >= 0.0) { float dx = (cc.x - uMouse.x) / uRes.y; lift = 0.075 * exp(-dx * dx / 0.006); }
  k -= lift;
  float top = min(k.x, k.y), bot = max(k.x, k.y);
  bool bodyCol = local < uCpc - 1.0;
  bool wickCol = abs(local - 1.0) < 0.5;
  float lum = 0.0;
  vec3 col = INK;
  if (idx == uLast) col = uLastCol;
  if (bodyCol && y >= top - ch * 0.5 && y <= bot + ch * 0.5) lum = idx == uLast ? 1.0 : 0.86;
  else if (wickCol && y >= k.z && y <= k.w) lum = 0.5;
  else if (y > bot) {
    float d = y - bot;
    lum = 0.46 * exp(-d * 6.0) + 0.09 * (1.0 - smoothstep(0.0, 0.45, d));
    if (!bodyCol) lum *= 0.6;
  }
  if (lum > 0.0 && lum < 0.8) lum *= 0.82 + 0.36 * hash(cell + floor(uTime * 3.0));
  if (lum == 0.0 && y < top) {
    float h = hash(cell * 1.37 + floor(uTime * 0.7 + hash(cell) * 9.0));
    if (h > 0.9972) {
      lum = 0.22 * smoothstep(0.1, 0.6, y);
      float tint = hash(cell + 7.7);
      if (tint < 0.22) { col = UP; lum *= 1.8; } else if (tint < 0.32) { col = DOWN; lum *= 1.8; }
    }
  }
  if (uMouse.x >= 0.0 && lum > 0.0) { float r = length(cc - uMouse) / uRes.y; lum += 0.42 * exp(-r * r / 0.014); }
  if (uPulse.z >= 0.0) {
    float r = length(cc - uPulse.xy) / uRes.y;
    float band = exp(-pow((r - uPulse.z * 0.85) / 0.035, 2.0));
    float fade = 1.0 - smoothstep(0.0, 1.5, uPulse.z);
    float seed = step(0.55, hash(cell + 3.1));
    lum += band * fade * (lum > 0.0 ? 0.45 : 0.3 * seed);
    col = mix(col, UP, clamp(band * fade * 1.2, 0.0, 1.0));
  }
  lum = clamp(lum, 0.0, 1.0);
  float g = floor(lum * (uN - 1.0) + 0.5);
  float a = texture(uAtlas, vec2((g + inCell.x) / uN, inCell.y)).a;
  float shade = (0.32 + 0.68 * lum) * uAlpha;
  o = vec4(col * a * shade, a * shade);
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

/** A seeded random walk, one candle per step, in price units. */
function market(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let price = 100, drift = 0;
  const next = () => {
    drift = drift * 0.86 + (rnd() - 0.5) * 0.9 + (100 - price) * 0.004;
    const o = price;
    const c = Math.max(20, o + drift + (rnd() - 0.5) * 1.6);
    const h = Math.max(o, c) + rnd() * 1.4;
    const l = Math.min(o, c) - rnd() * 1.4;
    price = c;
    return { o, c, h, l };
  };
  return { next, rnd };
}

// index.html marks <html class="webgl2"> before first paint so the near plates (which the live trench
// replaces) are never fetched; any failure here takes the mark off and the plates load as the fallback.
const plates = () => document.documentElement.classList.remove('webgl2');

export function liveTrench(root) {
  const canvas = root.querySelector('[data-gl]');
  if (!canvas) { plates(); return null; }
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
  if (!gl) { plates(); return null; }
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  } catch (err) { console.warn('live trench off:', err); plates(); return null; }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = {};
  for (const n of ['uAtlas', 'uSeries', 'uRes', 'uCell', 'uN', 'uCpc', 'uShift', 'uLast', 'uTime', 'uMouse', 'uPulse', 'uAlpha', 'uLastCol']) U[n] = gl.getUniformLocation(prog, n);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const atlasTex = gl.createTexture();
  const seriesTex = gl.createTexture();
  const CPC = 4, MAXC = 512;
  const series = new Float32Array(MAXC * 4);
  const m = market(2026);
  const candles = [];
  for (let i = 0; i < 200; i++) candles.push(m.next());

  let W = 0, H = 0, dpr = 1, cellW = 9, cellH = 16, cols = 0, shift = 0, last = 0, lo = 0, hi = 0, raf = 0;
  let mouse = [-1, -1], pulse = [0, 0, -1], pulseAt = 0, running = false, t0 = performance.now();
  const mobile = () => innerWidth < 768;

  function atlas() {
    const gw = Math.round(cellW * dpr), gh = Math.round(cellH * dpr);
    const c = document.createElement('canvas');
    c.width = gw * RAMP.length; c.height = gh;
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = `400 ${Math.round(gh * 0.74)}px "JetBrains Mono", monospace`;
    [...RAMP].forEach((g, i) => { if (g === '█') x.fillRect(i * gw + gw * 0.08, gh * 0.06, gw * 0.84, gh * 0.88); else x.fillText(g, i * gw + gw / 2, gh / 2); });
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cellW = mobile() ? 7 : 9; cellH = mobile() ? 13 : 16;
    W = Math.round(innerWidth * dpr); H = Math.round(innerHeight * dpr);
    canvas.width = W; canvas.height = H;
    cols = Math.ceil(innerWidth / cellW);
    gl.viewport(0, 0, W, H);
    atlas();
    upload(true);
    draw();
  }

  /** Map visible candles to screen fractions; the range eases so the ridge never jumps. */
  function upload(snap) {
    const n = Math.min(MAXC, Math.ceil(cols / CPC) + 2);
    const vis = candles.slice(-n);
    let a = Infinity, b = -Infinity;
    for (const k of vis) { a = Math.min(a, k.l); b = Math.max(b, k.h); }
    if (snap || !hi) { lo = a; hi = b; } else { lo += (a - lo) * 0.08; hi += (b - hi) * 0.08; }
    const top = mobile() ? 0.62 : 0.57, span = mobile() ? 0.2 : 0.27;
    const yOf = (p) => top + (1 - (p - lo) / (hi - lo || 1)) * span;
    vis.forEach((k, i) => { series.set([yOf(k.o), yOf(k.c), yOf(k.h), yOf(k.l)], i * 4); });
    last = vis.length - 1;
    gl.bindTexture(gl.TEXTURE_2D, seriesTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAXC, 1, 0, gl.RGBA, gl.FLOAT, series);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  function draw(now = performance.now()) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasTex); gl.uniform1i(U.uAtlas, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, seriesTex); gl.uniform1i(U.uSeries, 1);
    gl.uniform2f(U.uRes, W, H);
    gl.uniform2f(U.uCell, cellW * dpr, cellH * dpr);
    gl.uniform1f(U.uN, RAMP.length);
    gl.uniform1f(U.uCpc, CPC);
    gl.uniform1f(U.uShift, shift);
    gl.uniform1f(U.uLast, last);
    gl.uniform1f(U.uTime, (now - t0) / 1000);
    gl.uniform2f(U.uMouse, mouse[0], mouse[1]);
    const age = pulse[2] < 0 ? -1 : (now - pulseAt) / 1000;
    gl.uniform3f(U.uPulse, pulse[0], pulse[1], age > 1.6 ? -1 : age);
    gl.uniform1f(U.uAlpha, mobile() ? 0.34 : 0.42);
    const k = candles[candles.length - 1];
    if (k.c >= k.o) gl.uniform3f(U.uLastCol, 0.32, 0.88, 0.54); else gl.uniform3f(U.uLastCol, 1.0, 0.42, 0.36);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // one cell step every STEP ms; a new candle every CPC steps; the forming candle ticks in between.
  // Nothing on screen changes faster than the 160 ms tick unless the pointer or a pulse is moving the
  // field, so it draws at about 6 fps at rest and 30 fps only while one of those is live.
  const STEP = 420, FRAME = 1000 / 30, IDLE = 160;
  let stepAt = 0, lastFrame = 0, tickAt = 0, movedAt = -1e9;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const busy = now - movedAt < 1200 || (pulse[2] >= 0 && now - pulseAt < 1600);
    if (now - lastFrame < (busy ? FRAME : IDLE)) return;
    lastFrame = now;
    if (now - tickAt > 160) {
      tickAt = now;
      const k = candles[candles.length - 1];
      k.c += (m.rnd() - 0.5) * 0.7; k.h = Math.max(k.h, k.c); k.l = Math.min(k.l, k.c);
    }
    if (now - stepAt > STEP) {
      stepAt = now;
      shift += 1;
      if (shift >= CPC) { shift = 0; candles.push(m.next()); if (candles.length > 1000) candles.splice(0, 500); }
    }
    upload(false);
    draw(now);
  }
  const start = () => { if (running || reduced || document.hidden) return; running = true; raf = requestAnimationFrame(frame); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };

  if (finePointer && !reduced) {
    addEventListener('pointermove', (e) => { mouse = [e.clientX * dpr, e.clientY * dpr]; movedAt = performance.now(); }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => { mouse = [-1, -1]; movedAt = performance.now(); });
  }
  addEventListener('ts:pulse', (e) => {
    if (reduced) return;
    pulse = [e.detail.x * dpr, e.detail.y * dpr, 0];
    pulseAt = performance.now();
  });
  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(size, 150); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); root.classList.remove('gl'); plates(); });

  return document.fonts.load('400 16px "JetBrains Mono"').catch(() => {}).then(() => {
    size();
    root.classList.add('gl');
    start();
    return { start, stop };
  });
}

// ---------------------------------------------------------------- reveals
const CODE = '0123456789ABCDEF∷⋮⋯╳◇◆';

function inView(el) { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }

function once(els, fn, threshold = 0.25) {
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); fn(e.target); }
  }, { threshold });
  els.forEach((el) => io.observe(el));
}

/** Mono text decrypts left to right in the app's hex and line glyphs. Same width throughout, so nothing reflows. */
function decrypt(el, ms = 520) {
  const text = el.textContent;
  const chars = [...text];
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const shown = Math.floor(p * chars.length * 1.25);
    el.textContent = chars.map((c, i) => (c === ' ' || i < shown - 3 ? c : i < shown ? CODE[(Math.random() * CODE.length) | 0] : c === ' ' ? ' ' : '·')).join('');
    if (p < 1) requestAnimationFrame(step); else el.textContent = text;
  };
  requestAnimationFrame(step);
}

/** Type a pre's lines once at a terminal's pace; the copy button always copies the full text. */
function type(pre, ms = 26) {
  const html = pre.innerHTML;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const full = tmp.textContent;
  let n = 0, stopped = false;
  // picking another tab mid-type hands the block back to the tabs at once
  pre.closest('[data-install]')?.addEventListener('click', () => { stopped = true; pre.removeAttribute('aria-busy'); }, { once: true, capture: true });
  pre.setAttribute('aria-busy', 'true');
  const tick = () => {
    if (stopped) return;
    n += 1;
    pre.textContent = full.slice(0, n);
    pre.insertAdjacentHTML('beforeend', '<span class="type-cur" aria-hidden="true"></span>');
    if (n < full.length) setTimeout(tick, full[n - 1] === '\n' ? ms * 8 : ms);
    else { pre.innerHTML = html; pre.removeAttribute('aria-busy'); }
  };
  tick();
}

export function reveals() {
  if (reduced) return;
  // headings: a block cursor types them in, left to right
  const heads = [...document.querySelectorAll('.h2, .display')];
  heads.forEach((h) => { if (!inView(h)) h.classList.add('fx-wait'); });
  // a clipped element never intersects, so watch each heading's section and type its heading in
  const waiting = heads.filter((h) => h.classList.contains('fx-wait'));
  once([...new Set(waiting.map((h) => h.closest('section') ?? h.parentElement))], (sec) => {
    sec.querySelectorAll('.fx-wait').forEach((h) => { h.classList.remove('fx-wait'); h.classList.add('fx-type'); });
  }, 0.12);

  // list rows wipe in like a feed, capped at 400 ms of stagger per list
  const lists = [...document.querySelectorAll('.rules, .keylist, .table tbody')];
  for (const list of lists) {
    const rows = [...list.children];
    if (inView(list)) continue;
    rows.forEach((r, i) => { r.classList.add('fx-row'); r.style.setProperty('--d', `${Math.min(i * 55, 400)}ms`); });
  }
  once(lists, (list) => [...list.children].forEach((r) => r.classList.add('fx-in')), 0.15);

  // mono labels decrypt in the app's own glyphs
  const mono = [...document.querySelectorAll('.states code, .table td:last-child, .foot-in > span:not(.foot-end), .frame-bar span:first-child')];
  once(mono.filter((el) => !inView(el)), (el) => decrypt(el), 0.6);

  // keycaps press in a wave when the keys arrive
  once([document.querySelector('.keylist')].filter(Boolean), (list) => {
    list.querySelectorAll('.caps kbd').forEach((k, i) => setTimeout(() => { k.classList.add('fx-press'); setTimeout(() => k.classList.remove('fx-press'), 260); }, 380 + i * 70));
  }, 0.35);

  // install commands type once: the hero right away, the closing block when it arrives
  const pres = [...document.querySelectorAll('[data-install] [data-cmd-out]')];
  pres.forEach((pre) => {
    if (inView(pre)) setTimeout(() => type(pre), 500);
    else once([pre], (p) => type(p), 0.6);
  });
}

// ---------------------------------------------------------------- sparks, magnet, glare
// sparks pop in the app's state colours: mostly up green, a little down red, ink between
const SPARK = ['#52e08a', '#ededed', '#52e08a', '#ff6a5c', '#52e08a', '#ededed', '#52e08a', '#ededed'];

export function sparks() {
  if (reduced || !finePointer) return;
  const cv = document.createElement('canvas');
  cv.className = 'sparks';
  cv.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const bursts = [];
  let raf = 0, dpr = 1;
  const fit = () => { dpr = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
  fit();
  addEventListener('resize', fit);
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const frame = (now) => {
    raf = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'square';
    ctx.lineWidth = 1.5;
    for (let b = bursts.length - 1; b >= 0; b--) {
      const s = bursts[b], p = (now - s.t) / 420;
      if (p >= 1) { bursts.splice(b, 1); continue; }
      const d = 22 * ease(p), len = 9 * Math.pow(1 - p, 1.6);
      ctx.globalAlpha = 1 - Math.max(0, (p - 0.55) / 0.45);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + s.r;
        ctx.strokeStyle = SPARK[(i + s.k) % SPARK.length];
        ctx.beginPath();
        ctx.moveTo(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d);
        ctx.lineTo(s.x + Math.cos(a) * (d + len), s.y + Math.sin(a) * (d + len));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (bursts.length) raf = requestAnimationFrame(frame);
  };
  addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    bursts.push({ x: e.clientX, y: e.clientY, t: performance.now(), r: Math.random() * 0.8, k: (Math.random() * 8) | 0 });
    if (bursts.length > 24) bursts.shift();
    if (!raf) raf = requestAnimationFrame(frame);
  });
}

/** The primary action leans toward the pointer and springs home. */
export function magnet(sel = '.btn-ink', { padding = 48, strength = 3.2, max = 7 } = {}) {
  if (reduced || !finePointer) return;
  for (const el of document.querySelectorAll(sel)) {
    let x = 0, y = 0, vx = 0, vy = 0, tx = 0, ty = 0, raf = 0, prev = 0;
    const tick = (now) => {
      const dt = prev ? Math.min((now - prev) / 1000, 1 / 30) : 1 / 60;
      prev = now;
      for (let i = 0; i < 2; i++) {
        vx += (170 * (tx - x) - 16 * vx) * (dt / 2); x += vx * (dt / 2);
        vy += (170 * (ty - y) - 16 * vy) * (dt / 2); y += vy * (dt / 2);
      }
      el.style.translate = `${x.toFixed(2)}px ${y.toFixed(2)}px`;
      if (Math.abs(tx - x) + Math.abs(ty - y) + Math.abs(vx) + Math.abs(vy) > 0.05) raf = requestAnimationFrame(tick);
      else { raf = 0; prev = 0; }
    };
    let px = 0, py = 0, aim = 0;
    const target = () => {
      aim = 0;
      const r = el.getBoundingClientRect();
      const dx = px - (r.left + r.width / 2), dy = py - (r.top + r.height / 2);
      const out = Math.hypot(Math.max(0, Math.abs(dx) - r.width / 2), Math.max(0, Math.abs(dy) - r.height / 2));
      if (out > padding) { tx = 0; ty = 0; } else {
        tx = dx / strength; ty = dy / strength;
        const l = Math.hypot(tx, ty); if (l > max) { tx *= max / l; ty *= max / l; }
      }
      if (!raf) raf = requestAnimationFrame(tick);
    };
    addEventListener('pointermove', (e) => {
      px = e.clientX; py = e.clientY;
      if (!aim) aim = requestAnimationFrame(target);
    }, { passive: true });
  }
}

/** A soft light on the screen glass sits where the pointer is. */
export function glare(screen) {
  if (reduced || !finePointer || !screen) return;
  let raf = 0, px = 0, py = 0;
  screen.addEventListener('pointermove', (e) => {
    px = e.clientX; py = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = screen.getBoundingClientRect();
      screen.style.setProperty('--gx', `${(((px - r.left) / r.width) * 100).toFixed(1)}%`);
      screen.style.setProperty('--gy', `${(((py - r.top) / r.height) * 100).toFixed(1)}%`);
    });
  });
  screen.addEventListener('pointerenter', () => screen.setAttribute('data-glare', ''));
  screen.addEventListener('pointerleave', () => screen.removeAttribute('data-glare'));
}
