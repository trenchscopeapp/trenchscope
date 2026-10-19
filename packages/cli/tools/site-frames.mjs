#!/usr/bin/env node
// The site's tour of the app: the same scripted state machine as demo.mjs, rendered by the real app,
// written as compact cell data instead of PNGs so the page can draw the frames as live text.
//
//   node packages/cli/tools/site-frames.mjs --out FILE [--cols 160 --rows 46] [--theme mono] [--fps 12]
//   node packages/cli/tools/site-frames.mjs --dry       print the timeline, write nothing
//
// Output: { w, h, fps, theme, styles: [[fg, bg, attr]], rows: [[[text, style], ...]], chapters: [{ id, label,
// key, frames: [[rowIds, holdFrames], ...] }] }. Rows are deduplicated across the whole tour, and a frame
// that repeats the previous one only lengthens its hold, so a 30 s tour stays small.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blinkFrame, blinkFrames, stepVfx, blendActivity } from '@dexterm/tui';
import { parseArgs, stateFromArgs, renderFrame, demoEvent, activityFor, mulberry32, tick } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const dry = argv.includes('--dry');
const FPS = Number(opt('--fps', '12'));
const cols = Number(opt('--cols', '160'));
const rows = Number(opt('--rows', '46'));
const theme = opt('--theme', 'mono');
const out = resolve(opt('--out', resolve(repo, 'site', 'tour.json')));

const S = (sec) => Math.round(sec * FPS);
const rnd = mulberry32(2026);
const say = (v, text, level, secs = 3) => { v.toast = { text, level, until: v.frame + S(secs) }; };

// Each step may open a chapter (the site's section rail) and name the key a person would press.
const TIMELINE = [
  { at: 0.0, chapter: ['boot', 'Launch'], do: (st) => { st.screen = 'boot'; st.boot = { t: 0 }; }, label: 'first launch: logo and the data sources come up' },
  { at: 2.6, chapter: ['screener', 'Screener'], key: 'trenchscope', do: (st, ctx) => ctx.goto(st, 'screener', { selected: 0 }), label: 'blink to the screener' },
  { at: 3.9, key: 'j', do: (st) => { st.selected = 1; }, label: 'j' },
  { at: 4.4, key: 'j', do: (st) => { st.selected = 2; }, label: 'j' },
  { at: 4.9, key: 'j', do: (st) => { st.selected = 3; }, label: 'j (GIGA)' },
  { at: 6.4, chapter: ['token', 'Token'], key: '⏎', do: (st, ctx) => { st.token = st.fx.tokens[3]; st.ai = { phase: 'thinking', cut: 2, revealed: 0, ticks: 0 }; ctx.goto(st, 'token'); }, label: 'enter: token detail, the analyst reads the same tools' },
  { at: 8.4, do: (st) => { st.ai = { phase: 'streaming', cut: 2, revealed: 0, ticks: 0 }; }, label: 'the analyst answers' },
  { at: 13.6, chapter: ['newpairs', 'New pairs'], key: '2', do: (st, ctx) => { st.ai = null; st.vfx.mood = 'neutral'; st.vfx.activity = 0.6; ctx.goto(st, 'newpairs', { selected: 0 }); }, label: 'new pairs' },
  { at: 14.8, do: (st) => { say(st.vfx, demoEvent(st, 'newpair', rnd), 'info', 3); }, label: 'a launch lands' },
  { at: 16.4, key: 'j', do: (st) => { st.selected = 1; }, label: 'j' },
  { at: 18.6, chapter: ['analyst', 'Analyst'], key: 'a', do: (st, ctx) => { st.ai = { phase: 'streaming', cut: 2, revealed: 0, ticks: 0 }; ctx.goto(st, 'analyst'); }, label: 'a: the analyst full screen' },
  { at: 24.6, chapter: ['watchlist', 'Watchlist'], key: '3', do: (st, ctx) => { st.ai = null; ctx.goto(st, 'watchlist', { selected: 0 }); }, label: 'watchlist and alerts' },
  { at: 26.0, key: 'j', do: (st) => { st.selected = 1; }, label: 'j' },
  { at: 26.6, key: 'j', do: (st) => { st.selected = 2; }, label: 'j' },
  { at: 29.4, do: () => {}, label: 'end' },
];
const total = S(TIMELINE[TIMELINE.length - 1].at);

if (dry) {
  for (const s of TIMELINE) console.log(`${String(s.at).padStart(5)}s  f${String(S(s.at)).padStart(4)}  ${s.chapter ? `[${s.chapter[1]}] ` : ''}${s.label}`);
  console.log(`total ${total} frames (${(total / FPS).toFixed(1)} s) at ${cols}×${rows}, ${theme}`);
  process.exit(0);
}

// ---------------------------------------------------------------- state machine (mirrors demo.mjs)
// --full: the tour shows the full screener table, not the simple view the interactive app opens on
const state = stateFromArgs(parseArgs(['--fixtures', '--full', '--theme', theme, '--seed', '7']));
const v = state.vfx;
v.activity = 0.55;
let prevCanvas = null;
let transition = null;
const ctx = {
  goto(st, screen, opts = {}) {
    st.screen = screen;
    if ('selected' in opts) st.selected = opts.selected;
    blendActivity(v, activityFor(st), true);
    if (prevCanvas) transition = { from: prevCanvas, to: renderFrame(st, cols, rows), i: 0, n: blinkFrames(FPS) };
  },
};
function frameCanvas() {
  if (transition) {
    const c = blinkFrame(transition.from, transition.to, Math.min(1, transition.i / (transition.n - 1)), v);
    transition.i += 1;
    if (transition.i >= transition.n) transition = null;
    return c;
  }
  return renderFrame(state, cols, rows);
}

// ---------------------------------------------------------------- encoder
const styleIds = new Map(), styles = [];
const rowIds = new Map(), rowTable = [];
function styleOf(fg, bg, at) {
  const k = `${fg}|${bg}|${at}`;
  let id = styleIds.get(k);
  if (id === undefined) { id = styles.length; styles.push([fg, bg, at]); styleIds.set(k, id); }
  return id;
}
function encodeRow(c, y) {
  const runs = [];
  let text = '', sid = -1;
  for (let x = 0; x < c.w; x++) {
    const i = c.idx(x, y);
    const s = styleOf(c.fg[i], c.bg[i], c.at[i]);
    // a wide glyph's continuation cell is empty: keep the grid by holding a space in its place
    const ch = c.ch[i] === '' ? '' : c.ch[i];
    if (s !== sid) { if (text) runs.push([text, sid]); text = ''; sid = s; }
    text += ch;
  }
  if (text) runs.push([text, sid]);
  const key = JSON.stringify(runs);
  let id = rowIds.get(key);
  if (id === undefined) { id = rowTable.length; rowTable.push(runs); rowIds.set(key, id); }
  return id;
}

const chapters = [];
let current = null;
let stepIdx = 0;
let lastKey = '';
for (let f = 0; f < total; f++) {
  while (stepIdx < TIMELINE.length && S(TIMELINE[stepIdx].at) <= f) {
    const step = TIMELINE[stepIdx];
    if (step.chapter) { current = { id: step.chapter[0], label: step.chapter[1], key: step.key ?? null, frames: [], keys: [] }; chapters.push(current); lastKey = ''; }
    else if (step.key && current) current.keys.push([current.frames.reduce((n, fr) => n + fr[1], 0), step.key]);
    step.do(state, ctx);
    stepIdx += 1;
  }
  if (f > 0) stepVfx(v);
  if (state.screen === 'boot') state.boot.t = Math.min(1, f / (S(2.6) - S(0.4)));
  if (f % FPS === 0 && f > 0) {
    state.now = new Date(state.now.getTime() + 1000);
    tick(state.fx, rnd);
    state.refreshedAgo = `${Math.floor(rnd() * 4) + 1}s`;
    if (v.mood === 'neutral') blendActivity(v, activityFor(state), false);
  }
  if (state.ai && state.ai.phase === 'streaming') { state.ai.revealed += Math.round(48 / FPS * 2); if (state.ai.revealed > 1500) state.ai.revealed = 1500; }
  if (v.toast && v.frame > v.toast.until) v.toast = null;
  const c = frameCanvas();
  prevCanvas = c;
  const ids = [];
  for (let y = 0; y < rows; y++) ids.push(encodeRow(c, y));
  const last = current.frames[current.frames.length - 1];
  if (last && last[0].length === ids.length && last[0].every((id, i) => id === ids[i])) last[1] += 1;
  else current.frames.push([ids, 1]);
}
void lastKey;

const doc = { w: cols, h: rows, fps: FPS, theme, bg: state.theme.bg, fg: state.theme.text, styles, rows: rowTable, chapters };
mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(doc);
writeFileSync(out, json);
const frames = chapters.reduce((n, ch) => n + ch.frames.length, 0);
console.log(`wrote ${out}: ${chapters.length} chapters, ${frames} distinct frames of ${total}, ${rowTable.length} rows, ${styles.length} styles, ${(json.length / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- analyst crop
// The site's analyst section shows only the analyst panel of the token chapter. At the full width that
// panel is columns 106 to 159 and the rows its answer fills (2 to 31); writing that window on its own
// keeps phones, which play the narrow tour, from downloading the whole wide one for it.
const CROP = { x0: 106, x1: 160, y0: 2, y1: 32 };
if (cols === 160 && rows === 46) {
  const token = chapters.find((c) => c.id === 'token');
  const cropIds = new Map(), cropRows = [];
  const cropRow = (id) => {
    const runs = [];
    let col = 0;
    for (const [text, s] of rowTable[id]) {
      const chars = Array.from(text);
      const a = Math.max(CROP.x0 - col, 0), b = Math.min(CROP.x1 - col, chars.length);
      if (b > a) runs.push([chars.slice(a, b).join(''), s]);
      col += chars.length;
      if (col >= CROP.x1) break;
    }
    const key = JSON.stringify(runs);
    let n = cropIds.get(key);
    if (n === undefined) { n = cropRows.length; cropRows.push(runs); cropIds.set(key, n); }
    return n;
  };
  const cropFrames = [];
  for (const [ids, hold] of token.frames) {
    const next = ids.slice(CROP.y0, CROP.y1).map(cropRow);
    const prev = cropFrames[cropFrames.length - 1];
    if (prev && prev[0].every((id, i) => id === next[i])) prev[1] += hold; else cropFrames.push([next, hold]);
  }
  const crop = { w: CROP.x1 - CROP.x0, h: CROP.y1 - CROP.y0, fps: FPS, theme, bg: doc.bg, fg: doc.fg, styles, rows: cropRows,
    chapters: [{ id: token.id, label: token.label, key: token.key, frames: cropFrames, keys: [] }] };
  const cropOut = resolve(dirname(out), 'tour-analyst.json');
  const cropJson = JSON.stringify(crop);
  writeFileSync(cropOut, cropJson);
  console.log(`wrote ${cropOut}: ${cropFrames.length} distinct frames, ${cropRows.length} rows, ${(cropJson.length / 1024).toFixed(0)} KB`);
}
