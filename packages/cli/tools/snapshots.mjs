#!/usr/bin/env node
// Snapshot golden files for the five prototype screens at 176/120/90 columns.
//
//   node packages/cli/tools/snapshots.mjs --update            regenerate from this renderer
//   node packages/cli/tools/snapshots.mjs --from-prototype    regenerate from dexterm/prototype-v2 --calm (the design reference)
//   node packages/cli/tools/snapshots.mjs --check             exit 1 if the renderer disagrees with the goldens
//
// The committed goldens are this renderer's calm output (task-1297); --from-prototype shows where the
// port deviates from prototype-v2 in calm mode (expected: the screener's D-03 filter bar and captions).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repo = resolve(pkg, '..', '..');
const snapDir = resolve(pkg, 'test', 'snapshots');
const protoEntry = resolve(repo, '..', 'prototype-v2', 'dexterm.mjs');

/** Same sizes/selection as prototype/tools/screenshot.mjs (01, 06, 07) extended to every screen. */
export const CASES = [];
for (const screen of ['screener', 'token', 'newpairs', 'watchlist', 'analyst']) {
  const selected = screen === 'screener' || screen === 'token' ? 3 : screen === 'analyst' ? 0 : 1;
  for (const [width, height] of [[176, 48], [120, 40], [90, 40]]) {
    CASES.push({ screen, width, height, selected, theme: 'midnight', name: `${screen}-${width}x${height}` });
  }
}

/** The screener over the recorded data-store sample (D-03); goldens come from this renderer, not the prototype. */
export const LIVE_CASES = [];
for (const [width, height] of [[176, 48], [120, 40], [90, 40]]) {
  LIVE_CASES.push({ screen: 'screener', width, height, selected: 3, theme: 'midnight', live: true, name: `screener-live-${width}x${height}` });
}
export const samplePath = resolve(repo, 'packages', 'data', 'fixtures', 'live-sample.json');

export function renderOurs(c, { ansi = false } = {}) {
  const { makeFixtureState, makeFeedState, renderFrame } = loadCli();
  const { THEMES } = loadTui();
  // goldens are the calm render: effects off, so the text is the data and the chrome, nothing frame-dependent
  const state = c.live
    ? makeFeedState(replayFeed, 'replay', { screen: c.screen, selected: c.selected, theme: THEMES[c.theme], calm: true })
    : makeFixtureState({ screen: c.screen, selected: c.selected, theme: THEMES[c.theme], calm: true });
  const canvas = renderFrame(state, c.width, c.height);
  return ansi ? canvas.toAnsi({ depth: 'truecolor' }) : canvas.toPlain();
}

export function renderPrototype(c, { ansi = false } = {}) {
  if (!existsSync(protoEntry)) throw new Error(`prototype not found at ${protoEntry}`);
  const args = [protoEntry, '--screen', c.screen, '--width', String(c.width), '--height', String(c.height), '--selected', String(c.selected), '--theme', c.theme, '--calm'];
  if (!ansi) args.push('--plain');
  // The prototype prints the local clock; the screenshots were taken in New York.
  const out = execFileSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  return out.replace(/\n$/, '');
}

export function hasPrototype() { return existsSync(protoEntry); }
export function snapPath(c) { return resolve(snapDir, `${c.name}.txt`); }
export function readSnap(c) { return readFileSync(snapPath(c), 'utf8'); }

let cliMod, tuiMod, replayFeed;
function loadCli() { return cliMod; }
function loadTui() { return tuiMod; }
export async function init() {
  cliMod = await import('../src/index.ts');
  tuiMod = await import('@dexterm/tui');
  replayFeed = cliMod.createReplayFeed(samplePath);
  await replayFeed.refresh();
}
export function close() { replayFeed?.close(); }

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv[2] || '--check';
  await init();
  mkdirSync(snapDir, { recursive: true });
  let bad = 0;
  for (const c of [...CASES, ...LIVE_CASES]) {
    if (c.live && mode === '--from-prototype') continue; // the prototype has no data store; --update writes these
    if (mode === '--update' || mode === '--from-prototype') {
      const text = mode === '--update' ? renderOurs(c) : renderPrototype(c);
      writeFileSync(snapPath(c), text + '\n');
      console.log(`wrote ${snapPath(c)}`);
    } else {
      const want = readSnap(c).replace(/\n$/, '');
      const got = renderOurs(c);
      const ok = want === got;
      if (!ok) bad++;
      console.log(`${ok ? 'OK  ' : 'DIFF'} ${c.name}`);
    }
  }
  close();
  if (bad) process.exit(1);
}
