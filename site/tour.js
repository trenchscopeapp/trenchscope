// The stage: plays frames rendered by trenchscope itself (packages/cli/tools/site-frames.mjs).
// Each frame is a list of row ids; a row is a list of [text, style] runs drawn as plain text.
const ATTR_BOLD = 1, ATTR_DIM = 2, ATTR_ITALIC = 4, ATTR_UNDERLINE = 8;

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// WCAG contrast between two #rrggbb colours
function contrast(a, b) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Styles whose glyphs are effectively invisible on their own background (the app's decrypt effect fades
 * characters in from about 1.2:1). On the page they draw as empty cells: nothing visible is lost. */
function ghosts(doc) {
  const set = new Set();
  doc.styles.forEach(([fg, bg], i) => { if (/^#[0-9a-f]{6}$/i.test(fg) && /^#[0-9a-f]{6}$/i.test(bg) && contrast(fg, bg) < 1.4) set.add(i); });
  return set;
}

function styleSheet(doc, scope) {
  let css = '';
  doc.styles.forEach(([fg, bg, at], i) => {
    let s = `color:${fg};background:${bg};`;
    if (at & ATTR_BOLD) s += 'font-weight:700;';
    if (at & ATTR_DIM) s += 'opacity:.6;';
    if (at & ATTR_ITALIC) s += 'font-style:italic;';
    if (at & ATTR_UNDERLINE) s += 'text-decoration:underline;';
    css += `${scope} .s${i}{${s}}`;
  });
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The mono face covers ASCII, box drawing and block elements at exactly one cell. Anything else
// (✦ ↳ • ▲ ▼ ◌ …) may come from a fallback font with its own width, so it gets a fixed one-cell box.
const SAFE = /^[\x20-\x7e─-▟]$/;
function cellText(chars) {
  let out = '', plain = '';
  for (const c of chars) {
    if (SAFE.test(c)) { plain += c; continue; }
    if (plain) { out += esc(plain); plain = ''; }
    out += `<i>${esc(c)}</i>`;
  }
  return out + esc(plain);
}

/** Draw one tour into a <pre>. `crop` = [x0, x1, y0, y1] draws a window of the frame. */
export class Tour {
  constructor(pre, doc, { crop = null, chapters = null, onChapter = null, onKey = null, loopFrom = 1 } = {}) {
    this.pre = pre;
    this.doc = doc;
    this.crop = crop;
    this.onChapter = onChapter;
    this.onKey = onKey;
    this.loopFrom = loopFrom;
    this.list = chapters ? doc.chapters.filter((c) => chapters.includes(c.id)) : doc.chapters;
    this.scope = `[data-tour="${pre.dataset.tour}"]`;
    styleSheet(doc, this.scope);
    this.ghosts = ghosts(doc);
    const [x0, x1, y0, y1] = crop ?? [0, doc.w, 0, doc.h];
    this.x0 = x0; this.x1 = x1; this.y0 = y0; this.y1 = y1;
    this.cache = new Map();
    this.lines = [];
    pre.textContent = '';
    for (let y = y0; y < y1; y++) { const d = document.createElement('div'); pre.appendChild(d); this.lines.push({ el: d, id: -1 }); }
    this.ch = 0; this.fr = 0; this.left = 0; this.clock = 0;
    this.playing = false; this.raf = 0; this.last = 0;
    this.hold = false; this.onHold = null;
    this.show(0, 0);
  }

  rowHtml(id) {
    let html = this.cache.get(id);
    if (html !== undefined) return html;
    html = '';
    let col = 0;
    for (const [text, s] of this.doc.rows[id]) {
      const chars = Array.from(text);
      const a = Math.max(this.x0 - col, 0), b = Math.min(this.x1 - col, chars.length);
      if (b > a) html += `<span class="s${s}" style="width:${b - a}ch">${this.ghosts.has(s) ? ' '.repeat(b - a) : cellText(chars.slice(a, b))}</span>`;
      col += chars.length;
      if (col >= this.x1) break;
    }
    this.cache.set(id, html);
    return html;
  }

  paint() {
    const ids = this.list[this.ch].frames[this.fr][0];
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i], id = ids[this.y0 + i];
      if (line.id !== id) { line.el.innerHTML = this.rowHtml(id); line.id = id; }
    }
  }

  /** Jump to a chapter (index into the visible list) and a frame within it. */
  show(ch, fr = 0) {
    this.ch = ch; this.fr = fr;
    this.left = this.list[ch].frames[fr][1];
    this.clock = this.list[ch].frames.slice(0, fr).reduce((n, f) => n + f[1], 0);
    this.paint();
    this.onChapter?.(ch, this.progress());
  }

  progress() {
    const c = this.list[this.ch];
    const total = c.frames.reduce((n, f) => n + f[1], 0);
    return Math.min(1, this.clock / total);
  }

  step() {
    this.left -= 1;
    this.clock += 1;
    const c = this.list[this.ch];
    for (const [at, key] of c.keys) if (at === this.clock) this.onKey?.(key);
    if (this.left > 0) return;
    if (this.fr + 1 < c.frames.length) { this.fr += 1; this.left = c.frames[this.fr][1]; this.paint(); return; }
    // a held chapter (picked by hand) rests on its last frame; the next step after resuming moves on
    if (this.hold) { this.hold = false; this.left = 1; this.clock -= 1; this.pause(); this.onHold?.(); return; }
    let next = this.ch + 1;
    if (next >= this.list.length) next = Math.min(this.loopFrom, this.list.length - 1);
    this.show(next, 0);
    if (this.list[next].key) this.onKey?.(this.list[next].key);
  }

  play() {
    if (this.playing || reduced()) return;
    this.playing = true;
    this.last = performance.now();
    const dt = 1000 / this.doc.fps;
    let acc = 0;
    const loop = (now) => {
      if (!this.playing) return;
      acc += Math.min(250, now - this.last);
      this.last = now;
      while (acc >= dt && this.playing) { acc -= dt; this.step(); }
      this.onChapter?.(this.ch, this.progress());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() { this.playing = false; cancelAnimationFrame(this.raf); }
}
