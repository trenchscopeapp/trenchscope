import { useNodeScripts } from '../../../scripts/test-support.ts';
// task-1411 part A — the screener "Jarvis silence". A tester, on the MAIN SCREENER, said "what do you think
// of this one" (a row highlighted) and heard only a tiny useless fragment; on a token screen the same
// works. ROOT CAUSE: a voice analyst question on a non-token screen started a context-free `trench-scan`
// with NO mint, so the analyst never learned which coin "this one" was and answered with a short, useless
// fragment. FIX: attach the HIGHLIGHTED coin as a token-dossier target (the context a token screen gives)
// and append a short "answer for speech" instruction. This drives the REAL interactive loop in-process
// (fake TTY, replay data, fake STT/TTS, a fake `claude` on PATH) and asserts the fix.
//
// Fails before the fix: the session would be skill 'trench-scan' with mint undefined.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, '../../data/fixtures/live-sample.json');

// ---- fake claude on PATH: a realistic multi-sentence chat answer (no paid run can ever happen).
const ANSWER = 'This token looks risky. Liquidity is thin and the top holders control most of the supply. Keep any position small.';
const fc = mkdtempSync(join(tmpdir(), 'voice1411-claude-'));
const fakeClaude = join(fc, 'claude.cjs');
writeFileSync(fakeClaude, [
  `console.log(JSON.stringify({"type":"system","subtype":"init","model":"fake","session_id":"s1","mcp_servers":[],"skills":[]}));`,
  `console.log(JSON.stringify({"type":"result","subtype":"success","result":"${ANSWER}","total_cost_usd":0,"duration_ms":5,"num_turns":1,"is_error":false,"session_id":"s1"}));`,
].join('\n'));
useNodeScripts({ claude: fakeClaude });
process.env.DEXTERM_VOICE_STT = 'fake';
process.env.DEXTERM_VOICE_TTS = 'fake';
process.env.DEXTERM_OFFLINE = '1';
const HOME = mkdtempSync(join(tmpdir(), 'voice1411-home-'));
writeFileSync(join(HOME, 'state.json'), JSON.stringify({ version: 1, boots: 3 }) + '\n');
process.env.DEXTERM_HOME = HOME;

const voiceMod = await import('@dexterm/voice');
const { interactive, parseArgs } = await import('../src/main.ts');
const { makeFeedState } = await import('../src/state.ts');
const { createReplayFeed } = await import('../src/feed.ts');
const { LiveContext } = await import('../src/live/index.ts');
const { AnalystSession } = await import('../src/analyst/session.ts');
const { screenerView } = await import('../src/screener/view.ts');

// ---- scripted fake STT; recording TTS; capture every question handed to the analyst.
const QUEUE: string[] = [];
voiceMod.FakeStt.prototype.listen = async function () {
  const text = QUEUE.shift() ?? '';
  return { stop: () => Promise.resolve({ text, confidence: 1, speakerCount: 1 }), cancel: () => {} };
};
const SPOKEN: string[] = [];
const origSpeak = voiceMod.FakeTts.prototype.speak;
voiceMod.FakeTts.prototype.speak = function (text: string, o?: unknown) { SPOKEN.push(text); return origSpeak.call(this, text, o as never); };
const ASKED: string[] = [];
const origAsk = AnalystSession.prototype.ask;
AnalystSession.prototype.ask = function (q: string, ...rest: unknown[]) { ASKED.push(q); return origAsk.call(this, q, ...(rest as [])); };

// ---- fake TTY
let out = '';
const stdout = new Writable({ write(c, _e, cb) { out += c.toString(); if (out.length > 4e6) out = out.slice(-1e6); cb(); } }) as unknown as NodeJS.WriteStream;
Object.assign(stdout, { isTTY: true, columns: 140, rows: 40 });
const stderr = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
Object.assign(stdin, { isTTY: true, setRawMode() { return stdin; } });
const proc = Object.assign(new EventEmitter(), { exit: () => {} }) as unknown as NodeJS.Process;
const io = { stdout, stderr, stdin, env: { DEXTERM_OFFLINE: '1', DEXTERM_HOME: HOME } };

const feed = createReplayFeed(SAMPLE);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state: any = makeFeedState(feed, 'replay', { selected: 0 });
state.live = new LiveContext(feed.dl, { mode: 'replay' });
let done: Promise<number>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (s: string) => { stdin.write(s); };
const ESC = '\x1b';
async function until(c: () => boolean, ms = 6000) { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) return false; await sleep(10); } return true; }
const mode = () => state.voice?.mode ?? 'none';
const view = () => screenerView(state.screener);
async function home() {
  for (let i = 0; i < 4; i++) { key(ESC); await sleep(30); }
  state.overlay = null; state.aiFocused = false; state.screen = 'screener'; state.screener.mode = 'table';
  await sleep(50);
}
function select(sym: string): boolean { const i = view().findIndex((r) => (r.symbol ?? '') === sym); if (i < 0) return false; state.selected = i; return true; }
async function say(text: string) {
  QUEUE.push(text);
  key('v'); assert.ok(await until(() => mode() === 'listening', 4000), `listening for "${text}"`);
  key('v'); await until(() => mode() !== 'listening' && mode() !== 'transcribing', 4000);
  await sleep(150);
}
let SEL = '', SELMINT = '';

before(async () => {
  done = interactive(state, io as never, 'none', parseArgs(['--replay', SAMPLE, '--no-boot', '--calm']), proc as never);
  await sleep(250); key(' '); assert.ok(await until(() => view().length > 2, 8000), 'replay rows landed');
  await home();
  const row = view().find((r) => r.symbol && r.price && r.mcap && !r.fixture && !r.skeleton);
  assert.ok(row, 'the replay has a row with price + market cap');
  SEL = row!.symbol as string; SELMINT = row!.mint as string;
  QUEUE.push(''); key('v'); assert.ok(await until(() => mode() === 'listening', 5000), 'voice came up'); key(ESC); await until(() => mode() === 'idle');
});

after(async () => {
  await home(); key('\x03');
  await Promise.race([done, sleep(3000)]);
  rmSync(fc, { recursive: true, force: true }); rmSync(HOME, { recursive: true, force: true });
});

test('ROOT CAUSE: a screener "what do you think of this one" attaches the HIGHLIGHTED coin and is spoken in full', async () => {
  await home(); assert.ok(select(SEL));
  state.analyst = null; state.pendingAnalyst = null; // a fresh ask (no warm session)
  ASKED.length = 0; const sp0 = SPOKEN.length;
  await say('what do you think of this one');
  // the app routed the question to the analyst surface
  assert.ok(await until(() => state.screen === 'analyst' || state.screen === 'token', 3000), `analyst surface (screen ${state.screen})`);
  // THE FIX: the session carries the selected coin as a token-dossier target, not a context-free scan.
  assert.ok(await until(() => !!state.analyst, 3000), 'a session started');
  assert.equal(state.analyst.opts.skill, 'token-dossier', 'the selected coin is the dossier target (was trench-scan)');
  assert.equal(state.analyst.opts.mint, SELMINT, 'the dossier is on the HIGHLIGHTED coin');
  // the question carries the "answer for speech" instruction (market cap / round / short)
  assert.ok(ASKED.some((q) => /text-to-speech/i.test(q) && /market cap/i.test(q)), `speech instruction appended: ${JSON.stringify(ASKED)}`);
  // and the whole answer is spoken (not a tiny fragment)
  assert.ok(await until(() => SPOKEN.slice(sp0).some((s) => /Keep any position small/.test(s)), 8000), `full answer spoken: ${JSON.stringify(SPOKEN.slice(sp0))}`);
});

test('instant commands on the screener speak a sensible, complete ack', async () => {
  await home(); const sp0 = SPOKEN.length;
  await say('show the new pairs');
  assert.ok(await until(() => state.screen === 'newpairs', 2000), `nav → newpairs (screen ${state.screen})`);
  assert.ok(SPOKEN.slice(sp0).some((s) => /new pairs/i.test(s)), `complete ack for new pairs: ${JSON.stringify(SPOKEN.slice(sp0))}`);
  const sp1 = SPOKEN.length;
  await say('go to the watchlist');
  assert.ok(await until(() => state.screen === 'watchlist', 2000), 'nav → watchlist');
  assert.ok(SPOKEN.slice(sp1).some((s) => /watchlist/i.test(s)), `complete ack for watchlist: ${JSON.stringify(SPOKEN.slice(sp1))}`);
});

test('the < / > keys change the speaking rate (surfaced on the HUD) and persist it when config is present', async () => {
  await home();
  key('>'); await sleep(60);
  key('>'); await sleep(60);
  // the nudge is surfaced to the user on the voice HUD message
  assert.ok(/voice rate \d+ wpm/i.test(state.voice?.message ?? ''), `rate shown on the HUD: ${JSON.stringify(state.voice?.message)}`);
  key('<'); await sleep(60);
  // when the config UI is loaded, the choice is journaled to config.voice.rate (actor 'user')
  if (state.custom?.config) assert.equal(typeof state.custom.config.voice?.rate, 'number', 'voice.rate persisted');
});
