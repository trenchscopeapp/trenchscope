#!/usr/bin/env node
// Render reference frames to HTML + PNG with headless Chrome (puppeteer resolved from any parent
// node_modules; not a dependency). Every shot is a deterministic frame (fixed --frame), so re-running
// produces identical PNGs.
//   node packages/cli/tools/shot.mjs [--out DIR] [--only screener,token,<name>] [--scale 2]   the cyberspace set (default)
//   node packages/cli/tools/shot.mjs --legacy [--out DIR]                                     the nine SPEC §7.8 midnight/ember/paper frames
//   node packages/cli/tools/shot.mjs --replay FILE [--out DIR]                                the screener at 176/120/90 from a recording (D-03)
// D-22 turns this into `dexterm shot`.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { THEMES } from '@dexterm/tui';
import { makeFeedState, createReplayFeed, renderFrame, parseArgs, stateFromArgs, applyEffectArgs, syncFeed } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const outDir = resolve(opt('--out', resolve(repo, 'screenshots')));
const only = opt('--only', '').split(',').filter(Boolean);
const scale = Number(opt('--scale', '2'));
const replayPath = opt('--replay', '');
const legacy = args.includes('--legacy');
mkdirSync(outDir, { recursive: true });

/** Puppeteer from any parent node_modules of the repo or of the cwd (a worktree under /tmp runs from the workspace root). */
export function findPuppeteer() {
  for (const start of [repo, process.cwd(), process.env.DEXTERM_NODE_MODULES_FROM].filter(Boolean)) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      const cand = resolve(dir, 'node_modules', 'puppeteer');
      if (existsSync(cand)) return createRequire(resolve(dir, 'package.json')).call(null, 'puppeteer');
      dir = resolve(dir, '..');
    }
  }
  throw new Error('puppeteer not found in any parent node_modules of the repo or the cwd (set DEXTERM_NODE_MODULES_FROM)');
}

/** The cyberspace set (same list as prototype-v2/tools/screenshot.mjs, rendered by the real app). */
export const CYBER_SHOTS = [
  { name: '01-screener-176', screen: 'screener', width: 176, height: 48, selected: 3, frame: 40 },
  { name: '02-token-176', screen: 'token', width: 176, height: 50, selected: 3, frame: 40, ai: 'streaming:260' },
  { name: '03-newpairs-176', screen: 'newpairs', width: 176, height: 46, selected: 1, frame: 40 },
  { name: '04-watchlist-176', screen: 'watchlist', width: 176, height: 44, selected: 1, frame: 40 },
  { name: '05-analyst-176', screen: 'analyst', width: 176, height: 46, frame: 40, ai: 'streaming:120' },
  { name: '11-screener-120', screen: 'screener', width: 120, height: 40, selected: 3, frame: 52 },
  { name: '12-token-120', screen: 'token', width: 120, height: 42, selected: 3, frame: 52 },
  { name: '13-newpairs-120', screen: 'newpairs', width: 120, height: 40, selected: 1, frame: 52 },
  { name: '14-watchlist-120', screen: 'watchlist', width: 120, height: 40, selected: 1, frame: 52 },
  { name: '15-analyst-120', screen: 'analyst', width: 120, height: 40, frame: 52 },
  { name: '21-screener-90', screen: 'screener', width: 90, height: 36, selected: 3, frame: 64 },
  { name: '22-token-90', screen: 'token', width: 90, height: 40, selected: 3, frame: 64 },
  { name: '23-newpairs-90', screen: 'newpairs', width: 90, height: 36, selected: 1, frame: 64 },
  { name: '24-watchlist-90', screen: 'watchlist', width: 90, height: 36, selected: 1, frame: 64 },
  { name: '25-analyst-90', screen: 'analyst', width: 90, height: 36, frame: 64 },
  { name: '31-screener-176-calm', screen: 'screener', width: 176, height: 48, selected: 3, calm: true },
  { name: '32-token-176-calm', screen: 'token', width: 176, height: 50, selected: 3, calm: true },
  { name: '33-newpairs-176-calm', screen: 'newpairs', width: 176, height: 46, selected: 1, calm: true },
  { name: '34-watchlist-176-calm', screen: 'watchlist', width: 176, height: 44, selected: 1, calm: true },
  { name: '35-analyst-176-calm', screen: 'analyst', width: 176, height: 46, calm: true },
  { name: '41-boot-176', screen: 'boot', width: 176, height: 48, frame: 30, t: 0.78 },
  { name: '42-token-pump-176', screen: 'token', width: 176, height: 50, selected: 3, frame: 41, event: 'pump', ai: 'thinking' },
  { name: '43-newpairs-glitch-176', screen: 'newpairs', width: 176, height: 46, selected: 0, frame: 41, event: 'newpair' },
  { name: '44-token-rug-120', screen: 'token', width: 120, height: 42, selected: 3, frame: 41, event: 'dump' },
  { name: '45-screener-normal-176', screen: 'screener', width: 176, height: 48, selected: 3, frame: 40, intensity: 'normal' },
  { name: '51-screener-midnight', screen: 'screener', width: 150, height: 42, selected: 5, theme: 'midnight', calm: true },
];

/** The nine SPEC §7.8 reference frames (D-01), kept for the v1 themes. */
export const LEGACY_SHOTS = [
  { name: '01-screener-wide', screen: 'screener', width: 176, height: 48, theme: 'midnight', selected: 3, calm: true },
  { name: '02-token-detail-analyst', screen: 'token', width: 176, height: 50, theme: 'midnight', selected: 3, calm: true },
  { name: '03-new-pairs', screen: 'newpairs', width: 176, height: 46, theme: 'midnight', selected: 1, calm: true },
  { name: '04-watchlist-alerts', screen: 'watchlist', width: 176, height: 44, theme: 'midnight', selected: 1, calm: true },
  { name: '05-analyst-fullscreen', screen: 'analyst', width: 176, height: 46, theme: 'midnight', selected: 0, calm: true },
  { name: '06-screener-standard-120', screen: 'screener', width: 120, height: 40, theme: 'midnight', selected: 3, calm: true },
  { name: '07-token-compact-90', screen: 'token', width: 90, height: 40, theme: 'midnight', selected: 3, calm: true },
  { name: '08-screener-ember', screen: 'screener', width: 150, height: 42, theme: 'ember', selected: 5, calm: true },
  { name: '09-token-paper', screen: 'token', width: 150, height: 44, theme: 'paper', selected: 5, calm: true },
];

/** The screener over a recording, cyberspace with effects, plus the other screens as the live app shows them (◌ demo data). */
export const LIVE_SHOTS = [
  { name: 'live-screener-176', screen: 'screener', width: 176, height: 48, selected: 3, frame: 40 },
  { name: 'live-screener-120', screen: 'screener', width: 120, height: 40, selected: 3, frame: 52 },
  { name: 'live-screener-90', screen: 'screener', width: 90, height: 40, selected: 3, frame: 64 },
  { name: 'live-screener-176-calm', screen: 'screener', width: 176, height: 48, selected: 3, calm: true },
  { name: 'live-token-176', screen: 'token', width: 176, height: 50, selected: 3, frame: 40 },
  { name: 'live-newpairs-176', screen: 'newpairs', width: 176, height: 46, selected: 1, frame: 40 },
  { name: 'live-watchlist-176', screen: 'watchlist', width: 176, height: 44, selected: 1, frame: 40 },
  { name: 'live-analyst-176', screen: 'analyst', width: 176, height: 46, frame: 40 },
];

export function shotArgs(s) {
  const a = ['--fixtures', '--screen', s.screen, '--width', String(s.width), '--height', String(s.height), '--theme', s.theme || 'cyberspace', '--selected', String(s.selected ?? 0), '--frame', String(s.frame ?? 0)];
  if (s.calm) a.push('--calm');
  if (s.intensity) a.push('--intensity', s.intensity);
  if (s.ai) a.push('--ai', s.ai);
  if (s.event) a.push('--event', s.event);
  if (s.t != null) a.push('--t', String(s.t));
  if (s.mood) a.push('--mood', s.mood);
  return a;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await captureAll();

async function captureAll() {
let feed = null;
if (replayPath) { feed = createReplayFeed(resolve(replayPath)); await feed.refresh(); }
const shots = replayPath ? LIVE_SHOTS : legacy ? LEGACY_SHOTS : CYBER_SHOTS;

mkdirSync(outDir, { recursive: true });
const puppeteer = findPuppeteer();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--font-render-hinting=none'] });
try {
  for (const s of shots) {
    if (only.length && !only.includes(s.screen) && !only.includes(s.name)) continue;
    let state;
    if (feed) {
      state = makeFeedState(feed, 'replay', { screen: s.screen, selected: s.selected, theme: THEMES[s.theme || 'cyberspace'], calm: !!s.calm, frame: s.frame ?? 0 });
      syncFeed(state);
    } else {
      const a = parseArgs(shotArgs(s));
      state = stateFromArgs(a);
      applyEffectArgs(state, a);
    }
    const canvas = renderFrame(state, s.width, s.height);
    const html = resolve(outDir, `${s.name}.html`);
    const title = `dexterm — ${s.screen} — ${s.width}×${s.height} — ${s.theme || 'cyberspace'}${s.calm ? ' (calm)' : ''}${feed ? ' (live replay)' : ''}`;
    writeFileSync(html, canvas.toHtml({ title }));
    const page = await browser.newPage();
    await page.setViewport({ width: 2400, height: 1600, deviceScaleFactor: scale });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$('body');
    const png = resolve(outDir, `${s.name}.png`);
    await el.screenshot({ path: png, omitBackground: false });
    await page.close();
    console.log(`wrote ${png}`);
  }
} finally {
  await browser.close();
  feed?.close();
}
}
