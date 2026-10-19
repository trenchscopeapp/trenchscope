#!/usr/bin/env node
// Render the demo video from the real app: a scripted timeline → one PNG per frame (headless Chrome,
// the same cell-exact HTML emitter as the screenshots) → ffmpeg mp4 → contact sheet. Deterministic:
// same script, same frames. Same pipeline as prototype-v2/tools/demo.mjs.
//
//   node packages/cli/tools/demo.mjs --out DIR          # 1920×1080 @ 30 fps, ~21 s → DIR/dexterm-app-demo.mp4
//   node packages/cli/tools/demo.mjs --dry              # print the timeline, render nothing
//
// One heavy process at a time: Chrome captures all frames, then ffmpeg runs.
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { blinkFrame, blinkFrames, stepVfx, blendActivity } from '@dexterm/tui';
import { parseArgs, stateFromArgs, renderFrame, demoEvent, activityFor, mulberry32, tick } from '../src/index.ts';
import { findPuppeteer } from './shot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const dry = argv.includes('--dry');
const FPS = 30;
const outDir = resolve(opt('--out', resolve(repo, 'demo')));
const framesDir = resolve(outDir, 'frames');
const name = 'dexterm-app-demo';
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- timeline
const S = (sec) => Math.round(sec * FPS);
const rnd = mulberry32(2026);
const say = (v, text, level, secs = 3) => { v.toast = { text, level, until: v.frame + S(secs) }; };

const TIMELINE = [
  { at: 0.0, do: (st) => { st.screen = 'boot'; st.boot = { t: 0 }; }, label: 'first launch: full glitch boot (rain + logo + jacking in)' },
  { at: 3.1, do: (st, ctx) => ctx.goto(st, 'screener', { selected: 0 }), label: 'blink → screener (rain driven by the fixture market, phosphor green)' },
  { at: 4.2, do: (st) => { st.selected = 1; }, label: 'j' },
  { at: 4.6, do: (st) => { st.selected = 2; }, label: 'j' },
  { at: 5.0, do: (st) => { st.selected = 3; }, label: 'j (GIGA)' },
  { at: 6.6, do: (st, ctx) => { st.token = st.fx.tokens[3]; st.ai = { phase: 'thinking', cut: 2, revealed: 0, ticks: 0 }; ctx.goto(st, 'token'); }, label: 'enter → blink → token detail; the analyst thinks (spinner), rain from this token\'s candles' },
  { at: 9.0, do: (st) => { st.ai = { phase: 'streaming', cut: 2, revealed: 0, ticks: 0 }; }, label: 'the analyst\'s verdict decrypts in (coral)' },
  { at: 13.0, do: (st) => { say(st.vfx, demoEvent(st, 'pump', rnd), 'up', 3); }, label: 'pump: gold rain, PUMPING band, toast' },
  { at: 16.0, do: (st, ctx) => { st.vfx.mood = 'neutral'; st.vfx.activity = 0.6; ctx.goto(st, 'newpairs', { selected: 0 }); }, label: 'blink → new pairs' },
  { at: 17.2, do: (st) => { say(st.vfx, demoEvent(st, 'newpair', rnd), 'info', 3); }, label: 'new pair arrives: datamosh + stutter + shake' },
  { at: 19.0, do: (st) => { say(st.vfx, demoEvent(st, 'rug', rnd), 'down', 3); }, label: 'rug flag: red-shifted rain + full glitch' },
  { at: 21.5, do: () => {}, label: 'end' },
];

const total = S(TIMELINE[TIMELINE.length - 1].at);
const bootEnd = S(TIMELINE[1].at);
const cols = 160, rows = 45, fontPx = 17;
const fit = { width: 1920, height: 1080 };

if (dry) {
  for (const s of TIMELINE) console.log(`${String(s.at).padStart(5)}s  f${String(S(s.at)).padStart(4)}  ${s.label}`);
  console.log(`total ${total} frames (${(total / FPS).toFixed(1)} s) at ${cols}×${rows}, font ${fontPx}px → ${fit.width}×${fit.height}`);
  process.exit(0);
}

// ---------------------------------------------------------------- state machine (mirrors main.ts interactive)
const state = stateFromArgs(parseArgs(['--fixtures', '--theme', 'cyberspace', '--seed', '7']));
const v = state.vfx;
v.activity = 0.55;
let prevCanvas = null;
let transition = null;
const ctx = {
  goto(st, screen, opts = {}) {
    const from = prevCanvas;
    st.screen = screen;
    if ('selected' in opts) st.selected = opts.selected;
    blendActivity(v, activityFor(st), true);
    if (from) transition = { from, to: renderFrame(st, cols, rows), i: 0, n: blinkFrames(FPS) };
  },
};

function frameCanvas() {
  if (transition) {
    const tt = transition.i / (transition.n - 1);
    const c = blinkFrame(transition.from, transition.to, Math.min(1, tt), v);
    transition.i += 1;
    if (transition.i >= transition.n) transition = null;
    return c;
  }
  return renderFrame(state, cols, rows);
}

// ---------------------------------------------------------------- render loop
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
const puppeteer = findPuppeteer();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--font-render-hinting=none'] });
const page = await browser.newPage();
await page.setViewport({ width: fit.width, height: fit.height, deviceScaleFactor: 1 });
let stepIdx = 0;
let lastPng = null;
const t0 = Date.now();
try {
  for (let f = 0; f < total; f++) {
    while (stepIdx < TIMELINE.length && S(TIMELINE[stepIdx].at) <= f) { TIMELINE[stepIdx].do(state, ctx); stepIdx += 1; }
    if (f > 0) stepVfx(v);
    if (state.screen === 'boot') state.boot.t = Math.min(1, f / (bootEnd - S(0.6)));
    if (f % (FPS / 2) === 0 && f > 0) {
      state.now = new Date(state.now.getTime() + 500);
      tick(state.fx, rnd);
      state.refreshedAgo = `${Math.floor(rnd() * 4) + 1}s`;
      if (v.mood === 'neutral') blendActivity(v, activityFor(state), false);
    }
    if (state.ai && state.ai.phase === 'streaming') { state.ai.revealed += 4; if (state.ai.revealed > 1500) state.ai = null; }
    if (v.toast && v.frame > v.toast.until) v.toast = null;
    const png = resolve(framesDir, `${String(f).padStart(4, '0')}.png`);
    if (v.stutter > 0 && !transition && lastPng) { copyFileSync(lastPng, png); continue; } // datamosh stutter: hold frame
    const c = frameCanvas();
    prevCanvas = c;
    const html = c.toHtml({ title: 'dexterm', fontPx, fit });
    await page.setContent(html, { waitUntil: 'load' });
    if (f === 0) await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: png, type: 'png' });
    lastPng = png;
    if (f % 60 === 0) console.log(`frame ${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
} finally {
  await browser.close();
}
console.log(`captured ${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---------------------------------------------------------------- ffmpeg (sequential, after Chrome exits)
const mp4 = resolve(outDir, `${name}.mp4`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', resolve(framesDir, '%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'medium', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
console.log(`wrote ${mp4}`);
const sheet = resolve(outDir, `${name}-contact.png`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `select='not(mod(n\\,30))',scale=480:-1,tile=6x4:padding=4:margin=4:color=0x020507`, '-frames:v', '1', sheet], { stdio: 'inherit' });
console.log(`wrote ${sheet}`);
writeFileSync(resolve(outDir, `${name}-timeline.txt`), TIMELINE.map((s) => `${String(s.at).padStart(5)}s  ${s.label}`).join('\n') + '\n');
rmSync(framesDir, { recursive: true, force: true });
