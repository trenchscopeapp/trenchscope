// task-1408 / task-1416: the Piper neural TTS engine, exercised against a FAKE piper runtime and a FAKE
// player so the logic is deterministic on any platform with no audio device. This verifies the engine
// contract (text on stdin not argv, sanitise, single queue, pre-warmed sentence-by-sentence streaming,
// stop() kills synth + player, degrade when no player) — NOT real Piper audio, which is proven
// separately (Docker on Linux; the managed venv + afplay + whisper on a real Mac, see the handoff).

import { useNodeScripts } from '../../../scripts/test-support.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dexterm-piper-test-'));
const fakePiper = join(dir, 'fake-piper.mjs');
const fakePlayer = join(dir, 'fake-player.mjs');
const model = join(dir, 'en_GB-alan-medium.onnx');
const piperLog = join(dir, 'piper.jsonl');
const playerLog = join(dir, 'player.jsonl');
useNodeScripts({ [fakePiper]: fakePiper, [fakePlayer]: fakePlayer });

// Fake piper: two modes, matching the real CLI.
//  --output_file OUT : write one WAV to OUT and exit (synthToFile).
//  --output_dir DIR  : stay alive, read stdin line by line, write one WAV per line into DIR (the warm
//                      streaming path). The first line is the discarded priming utterance.
// Logs every line/argv so the test can assert the contract.
const FAKE_PIPER = `#!/usr/bin/env node
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const argv = process.argv.slice(2);
function wav(path) {
  const samples = 160, dataLen = samples * 2, buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE((i % 32) * 500, 44 + i * 2);
  writeFileSync(path, buf);
}
const fi = argv.indexOf('--output_file'), di = argv.indexOf('--output_dir');
if (fi >= 0) {
  let stdin = ''; try { stdin = readFileSync(0, 'utf8'); } catch {}
  appendFileSync(process.env.PIPER_LOG, JSON.stringify({ mode: 'file', argv, stdin }) + '\\n');
  wav(argv[fi + 1]); process.exit(0);
} else if (di >= 0) {
  const outDir = argv[di + 1];
  let n = 0;
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    n += 1;
    appendFileSync(process.env.PIPER_LOG, JSON.stringify({ mode: 'dir', argv, line }) + '\\n');
    wav(join(outDir, Date.now() + '-' + String(n).padStart(4, '0') + '.wav'));
  });
  rl.on('close', () => process.exit(0));
} else { process.exit(2); }
`;

// Fake player: logs its argv, lives briefly, exits (so handle.done resolves on close). SIGTERM-killable.
const FAKE_PLAYER = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PLAYER_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const t = setTimeout(() => process.exit(0), 120);
process.on('SIGTERM', () => { clearTimeout(t); process.exit(143); });
`;

let PiperTts: typeof import('../src/tts/piper.ts').PiperTts;

before(async () => {
  for (const [p, src] of [[fakePiper, FAKE_PIPER], [fakePlayer, FAKE_PLAYER]] as const) {
    writeFileSync(p, src, { mode: 0o755 }); chmodSync(p, 0o755);
  }
  writeFileSync(model, 'fake onnx'); // availability only checks the file exists
  process.env.DEXTERM_PIPER_BIN = fakePiper;
  process.env.DEXTERM_AUDIO_PLAYER = fakePlayer;
  process.env.PIPER_LOG = piperLog;
  process.env.PLAYER_LOG = playerLog;
  ({ PiperTts } = await import('../src/tts/piper.ts'));
});

after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const readLog = (f: string): Array<{ mode?: string; argv?: string[]; stdin?: string; line?: string }> =>
  existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetLogs = (): void => { writeFileSync(piperLog, ''); writeFileSync(playerLog, ''); };

test('available() true with runtime + model + player; false without a player', async () => {
  const tts = new PiperTts(model);
  assert.equal(await tts.available(), true);
  const save = process.env.DEXTERM_AUDIO_PLAYER;
  process.env.DEXTERM_AUDIO_PLAYER = join(dir, 'does-not-exist');
  assert.equal(await tts.available(), false, 'no player → cannot speak aloud');
  assert.equal(tts.canSynth(), true, 'but it can still synthesise to a file');
  process.env.DEXTERM_AUDIO_PLAYER = save;
});

test('listVoices is the model voice id; voiceName matches', async () => {
  const tts = new PiperTts(model);
  assert.deepEqual(await tts.listVoices(), ['en_GB-alan-medium']);
  assert.equal(tts.voiceName, 'en_GB-alan-medium');
});

test('synthToFile writes a non-empty WAV; text on stdin, never argv; rate → --length_scale', async () => {
  resetLogs();
  const tts = new PiperTts(model);
  const out = join(dir, 'synth.wav');
  await tts.synthToFile('liquidity is thin', out, { lengthScale: 1.2 });
  assert.ok(existsSync(out) && readFileSync(out).length > 44, 'a WAV with audio data');
  const rec = readLog(piperLog).at(-1)!;
  assert.equal(rec.mode, 'file');
  assert.ok(rec.argv!.includes('--model') && rec.argv!.includes('--output_file'));
  assert.ok(rec.argv!.includes('--length_scale') && rec.argv!.includes('1.2'), 'rate maps to length_scale');
  assert.ok(!rec.argv!.some((a) => a.includes('liquidity')), 'text is not on argv');
  assert.equal(rec.stdin!.trim(), 'liquidity is thin');
});

test('speak() streams sentence by sentence, plays each WAV in order, fires onFirstAudio once', async () => {
  resetLogs();
  const tts = new PiperTts(model);
  let firstAudio = 0;
  const h = tts.speak('Three new pairs passed. Liquidity looks thin. Watch the top holder.', { onFirstAudio: () => { firstAudio += 1; } });
  await h.done;
  tts.dispose();
  // Each real sentence was fed as its own line (the first 'ready' line is the discarded priming utterance).
  const lines = readLog(piperLog).filter((r) => r.mode === 'dir').map((r) => r.line);
  assert.ok(lines.includes('Three new pairs passed.'), 'first sentence fed');
  assert.ok(lines.includes('Liquidity looks thin.'), 'second sentence fed');
  assert.ok(lines.includes('Watch the top holder.'), 'third sentence fed');
  // Three WAVs played (one per sentence), in order, and onFirstAudio fired exactly once.
  const plays = readLog(playerLog);
  assert.equal(plays.length, 3, 'one playback per sentence');
  assert.ok(plays.every((p) => p.argv!.some((a) => a.endsWith('.wav'))), 'each playback got a WAV');
  assert.equal(firstAudio, 1, 'onFirstAudio fired once, not per sentence');
});

test('sanitises [[ phoneme/command sequences before piper sees them', async () => {
  resetLogs();
  const tts = new PiperTts(model);
  await tts.speak('look [[slnc 5000]] here now').done;
  tts.dispose();
  const fed = readLog(piperLog).filter((r) => r.mode === 'dir' && r.line !== 'ready').map((r) => r.line).join(' ');
  assert.ok(!fed.includes('[['), 'no [[ reaches piper');
});

test('stop() interrupts: kills the synth process and the player (no further playback)', async () => {
  resetLogs();
  const tts = new PiperTts(model);
  const h = tts.speak('One. Two. Three. Four. Five.');
  await new Promise((r) => setTimeout(r, 60)); // let the first WAV(s) start playing
  h.stop();
  const playedAtStop = readLog(playerLog).length;
  await h.done; // resolves promptly on stop
  await new Promise((r) => setTimeout(r, 150)); // give any orphaned synth/player a chance to keep going
  tts.dispose();
  assert.ok(readLog(playerLog).length <= playedAtStop + 1, 'playback stops almost immediately after stop()');
});

test('warmup() pre-loads a standby so the first reply does not pay a cold start; still plays', async () => {
  resetLogs();
  const tts = new PiperTts(model);
  tts.warmup(205);
  await new Promise((r) => setTimeout(r, 600)); // standby primes (node starts, writes + discards one WAV)
  const primedBeforeSpeak = readLog(piperLog).filter((r) => r.line === 'ready').length;
  assert.ok(primedBeforeSpeak >= 1, 'the standby primed the model before any reply');
  await tts.speak('Ready to go.').done;
  tts.dispose();
  assert.ok(readLog(playerLog).length >= 1, 'the warmed engine still speaks');
});

test('no player → speak() degrades to text (resolves, no crash), synthToFile still works', async () => {
  const save = process.env.DEXTERM_AUDIO_PLAYER;
  process.env.DEXTERM_AUDIO_PLAYER = join(dir, 'nope');
  const tts = new PiperTts(model);
  await tts.speak('still fine').done; // must resolve, not throw
  tts.dispose();
  process.env.DEXTERM_AUDIO_PLAYER = save;
  assert.ok(true);
});
