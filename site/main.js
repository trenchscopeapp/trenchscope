import { Tour } from './tour.js';
import { liveTrench, reveals, sparks, magnet, glare } from './fx.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const narrowQ = window.matchMedia('(max-width: 767px)');

// ---------------------------------------------------------------- install blocks
for (const box of $$('[data-install]')) {
  const out = $('[data-cmd-out]', box);
  const note = $('[data-note-out]', box);
  const tabs = $$('[role="tab"]', box);
  const word = $('[data-copy-word]', box);
  const copy = $('[data-copy]', box);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let lines = [];
  const pick = (tab) => {
    for (const t of tabs) { t.setAttribute('aria-selected', String(t === tab)); t.tabIndex = t === tab ? 0 : -1; }
    lines = tab.dataset.cmd.split('\n');
    // the program name in ink, its arguments a step quieter
    out.innerHTML = lines.map((l) => `<span class="ps" aria-hidden="true">$ </span>${esc(l).replace(/^(\S+)/, '<b>$1</b>')}`).join('\n');
    // data-soon on a tab: the command is right but not live yet (repo or package unpublished); remove it at launch
    const soon = tab.hasAttribute('data-soon');
    note.textContent = soon ? `Not live yet: available at the public release. ${tab.dataset.note}` : tab.dataset.note;
    box.toggleAttribute('data-soon', soon);
  };
  pick(tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0]);
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => pick(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus(); pick(next);
    });
  });
  let timer = 0;
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lines.join('\n')); word.textContent = 'copied'; } catch { word.textContent = 'select to copy'; }
    copy.setAttribute('data-done', '');
    clearTimeout(timer);
    timer = setTimeout(() => { word.textContent = 'copy'; copy.removeAttribute('data-done'); }, 1600);
  });
}

// ---------------------------------------------------------------- stage
const KEY_LABEL = { trenchscope: 'launch', j: 'next row', '⏎': 'open the coin', a: 'ask the analyst', 2: 'new pairs', 3: 'watchlist' };

/** Scale a <pre> of cells to fill its box, keeping the terminal's aspect. */
function fit(box, pre, cols, rows) {
  const measure = () => {
    // offsetWidth is the untransformed layout width of the grid
    const w = pre.offsetWidth || cols * 8.4;
    const s = box.clientWidth / w;
    pre.style.transform = `scale(${s})`;
    box.style.height = `${rows * 18 * s}px`;
  };
  new ResizeObserver(measure).observe(box);
  // the mono face loads only once cells use it, so wait for that face, not just fonts.ready
  document.fonts.load('400 14px "JetBrains Mono"').then(measure, measure);
  document.fonts.load('700 14px "JetBrains Mono"').then(measure, measure);
  measure();
}

async function load(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function stage() {
  const pre = $('[data-tour="main"]');
  const box = $('[data-fit]');
  const doc = await load(narrowQ.matches ? 'tour-narrow.json' : 'tour.json');
  $('[data-size]').textContent = `${doc.w}×${doc.h}`;

  const list = $('[data-chapters]');
  const items = doc.chapters.map((c, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chapter';
    b.innerHTML = `<span class="chapter-track"><i></i></span><span class="chapter-label"><span>${c.label}</span>${c.key ? `<kbd>${c.key === 'trenchscope' ? '$' : c.key}</kbd>` : ''}</span>`;
    b.addEventListener('click', () => { tour.show(i, reduced.matches ? last(i) : 0); if (c.key) key(c.key); });
    li.appendChild(b);
    list.appendChild(li);
    return b;
  });

  const hud = $('[data-hud]');
  let hudTimer = 0;
  const key = (k) => {
    $('[data-hud-key]', hud).textContent = k === 'trenchscope' ? '$' : k;
    $('[data-hud-label]', hud).textContent = k === 'trenchscope' ? 'trenchscope' : KEY_LABEL[k] ?? '';
    hud.setAttribute('data-on', '');
    hud.removeAttribute('data-press'); void hud.offsetWidth; hud.setAttribute('data-press', '');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.removeAttribute('data-on'), 1300);
    // the key press ripples out through the live trench from where it lands on the screen
    const r = hud.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) window.dispatchEvent(new CustomEvent('ts:pulse', { detail: { x: r.left + r.width / 2, y: r.top + r.height / 2 } }));
  };

  let shown = -1;
  const onChapter = (ch, p) => {
    if (ch !== shown) {
      items.forEach((b, i) => {
        if (i === ch) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
        if (i < ch) b.setAttribute('data-done', ''); else b.removeAttribute('data-done');
        if (i !== ch) b.firstElementChild.firstElementChild.style.setProperty('--p', i < ch ? '1' : '0');
      });
      // the tour clicks its own tab as it moves on, so the rail reads as being clicked through
      if (shown !== -1) { const b = items[ch]; b.removeAttribute('data-press'); void b.offsetWidth; b.setAttribute('data-press', ''); }
      shown = ch;
    }
    items[ch].firstElementChild.firstElementChild.style.setProperty('--p', String(p));
  };

  const tour = new Tour(pre, doc, { onChapter, onKey: key, loopFrom: 1 });
  fit(box, pre, doc.w, doc.h);

  // reduced motion: no frames play, but the tour still steps through every screen, each at its finished state
  const last = (ch) => tour.list[ch].frames.length - 1;
  if (reduced.matches) tour.show(1, last(1));
  let stepTimer = 0;
  const stepStill = () => {
    const next = tour.ch + 1 >= tour.list.length ? 1 : tour.ch + 1;
    tour.show(next, last(next));
    if (tour.list[next].key) key(tour.list[next].key);
  };

  // play while on screen; pause when the tab is hidden, a mouse rests on the screen, or by hand.
  // Touch never pauses it: a tap fires pointerenter with no matching leave.
  const toggle = $('[data-toggle]');
  let byHand = false, visible = false, hover = false;
  const sync = () => {
    const go = visible && !byHand && !hover && !document.hidden;
    if (reduced.matches) {
      clearInterval(stepTimer);
      if (go) stepTimer = setInterval(stepStill, 5000);
      return;
    }
    if (go) tour.play(); else tour.pause();
  };
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; sync(); }, { threshold: 0.2 }).observe(box);
  document.addEventListener('visibilitychange', sync);
  const scene = $('.bezel');
  scene.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'mouse') return; hover = true; sync(); });
  scene.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'mouse') return; hover = false; sync(); });
  toggle.addEventListener('click', () => {
    byHand = !byHand;
    toggle.setAttribute('aria-pressed', String(byHand));
    $('[data-toggle-word]', toggle).textContent = byHand ? 'Play' : 'Pause';
    $('[data-icon-pause]', toggle).toggleAttribute('hidden', byHand);
    $('[data-icon-play]', toggle).toggleAttribute('hidden', !byHand);
    sync();
  });

  // a slight lean toward the pointer (after Osmo's 3D perspective hover), fine pointers only
  const lean = $('[data-lean]');
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches && !reduced.matches) {
    let raf = 0, px = 0, py = 0;
    window.addEventListener('pointermove', (e) => {
      px = e.clientX; py = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = lean.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        const nx = Math.max(-1, Math.min(1, (px - (r.left + r.width / 2)) / (r.width / 2)));
        const ny = Math.max(-1, Math.min(1, (py - (r.top + r.height / 2)) / (r.height / 2)));
        lean.style.setProperty('--ry', `${(nx * 2.2).toFixed(2)}deg`);
        lean.style.setProperty('--rx', `${(-ny * 1.6).toFixed(2)}deg`);
      });
    }, { passive: true });
  }

  return doc;
}

// the analyst panel on its own: the token chapter, cropped to the panel, playing its answer
async function crop(doc) {
  const pre = $('[data-tour="crop"]');
  const box = $('[data-fit-crop]');
  const wide = doc.w >= 120 ? doc : await load('tour.json');
  // the analyst panel's own box on the token screen at 160 columns: columns 106 to 159, the rows the
  // answer fills (2 to 31). It rests on the answered frame; on first view it plays the answer once.
  const panel = [106, 160, 2, 32];
  const t = new Tour(pre, wide, { crop: panel, chapters: ['token'], loopFrom: 0 });
  const frames = t.list[0].frames;
  const end = frames.length - 1;
  t.show(0, end);
  fit(box, pre, panel[1] - panel[0], panel[3] - panel[2]);
  if (reduced.matches) return;
  // the answer starts streaming 2 s into the token chapter (site-frames.mjs: thinking at 6.4 s, streaming at 8.4 s)
  let start = 0;
  for (let acc = 0; start < end && acc + frames[start][1] <= 2 * t.doc.fps; start++) acc += frames[start][1];
  let played = false;
  const io = new IntersectionObserver((es) => {
    if (!es[0].isIntersecting || played) return;
    played = true; io.disconnect();
    t.show(0, start);
    const hold = () => { if (t.fr >= end) { t.pause(); t.show(0, end); } else requestAnimationFrame(hold); };
    t.play(); requestAnimationFrame(hold);
  }, { threshold: 0.4 });
  io.observe(box);
}

liveTrench(document.querySelector('.ascii-bg'));
reveals();
sparks();
magnet();
glare(document.querySelector('.screen'));

stage().then(crop).catch((err) => {
  console.error(err);
  $('[data-fit]').innerHTML = '<p class="caption" style="padding:2rem">The tour could not load. Run trenchscope --fixtures to see the same screens.</p>';
});

// ---------------------------------------------------------------- glyph field
// A sparse ASCII field over the whole background: a few cells hold a glyph, a few of those change or
// go dark each tick, the way the app decrypts text. Denser toward the bottom, where the trench is.
(function field() {
  const cv = document.querySelector('[data-field]');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const GLYPHS = '.·:+x*=%#$';
  const CELL = 15;
  let cols = 0, rows = 0, cells = [], dpr = 1, raf = 0, last = 0;
  const seed = (y) => Math.random() < 0.012 + 0.05 * (y / rows) ** 2.2;
  const pick = () => GLYPHS[Math.floor(Math.random() ** 1.6 * GLYPHS.length)];
  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    cols = Math.ceil(innerWidth / CELL * 1.65); rows = Math.ceil(innerHeight / CELL);
    cells = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (seed(y)) cells.push({ x, y, g: pick(), a: 0.05 + Math.random() * 0.13 });
    draw();
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.font = '400 12px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    const cw = CELL / 1.65;
    for (const c of cells) { if (c.a <= 0) continue; ctx.fillStyle = `rgba(237,237,237,${c.a.toFixed(3)})`; ctx.fillText(c.g, c.x * cw, c.y * CELL); }
  }
  function tick(now) {
    // the live trench draws its own sky once it is running
    if (cv.parentElement.classList.contains('gl')) { cancelAnimationFrame(raf); return; }
    raf = requestAnimationFrame(tick);
    if (now - last < 110) return;
    last = now;
    for (let i = 0; i < cells.length * 0.04; i++) {
      const c = cells[Math.floor(Math.random() * cells.length)];
      if (Math.random() < 0.25) c.a = c.a > 0 ? 0 : 0.05 + Math.random() * 0.13; else c.g = pick();
    }
    draw();
  }
  size();
  let t = 0;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(size, 150); });
  document.fonts.load('400 12px "JetBrains Mono"').then(draw, draw);
  if (reduced.matches) return;
  const run = () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(tick); };
  document.addEventListener('visibilitychange', run);
  run();
})();
