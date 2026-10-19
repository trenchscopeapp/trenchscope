// task-1416: Piper alan is the DEFAULT TTS engine wherever it is installed. selectTts('auto') must
// prefer Piper over macOS `say` when the managed runtime (a Piper runtime + the voice model + a player)
// is present, and an explicit choice still resolves the engine it names. availability only checks that
// the runtime/model/player PATHS exist, so empty stub files are enough — nothing is spawned here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dexterm-engines-piper-'));
const fakePiper = join(dir, 'piper');
const fakePlayer = join(dir, 'player');
const model = join(dir, 'en_GB-alan-medium.onnx');

let selectTts: typeof import('../src/engines.ts').selectTts;

before(async () => {
  writeFileSync(fakePiper, '#!/bin/sh\n', { mode: 0o755 }); chmodSync(fakePiper, 0o755);
  writeFileSync(fakePlayer, '#!/bin/sh\n', { mode: 0o755 }); chmodSync(fakePlayer, 0o755);
  writeFileSync(model, 'fake onnx');
  process.env.DEXTERM_PIPER_BIN = fakePiper;
  process.env.DEXTERM_PIPER_MODEL = model;
  process.env.DEXTERM_AUDIO_PLAYER = fakePlayer;
  ({ selectTts } = await import('../src/engines.ts'));
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('selectTts(piper) resolves the Piper engine when the runtime, model and player are present', async () => {
  const tts = await selectTts('piper', 'Eddy (English (UK))');
  assert.ok(tts, 'piper resolves');
  assert.equal(tts!.name, 'piper');
  assert.deepEqual(await tts!.listVoices(), ['en_GB-alan-medium'], 'the voice is the model, never the mac name');
});

test('selectTts(auto) on macOS prefers Piper over say when Piper is installed', { skip: process.platform !== 'darwin' }, async () => {
  const tts = await selectTts('auto', 'Eddy (English (UK))');
  assert.ok(tts, 'an engine resolves');
  assert.equal(tts!.name, 'piper', 'Piper is the default speaking engine when set up');
});

test('selectTts(say) still forces macOS say (never Piper), when say is available', { skip: process.platform !== 'darwin' }, async () => {
  const tts = await selectTts('say', 'Eddy (English (UK))');
  // On a Mac with safe voices installed this is `say`; if no safe voice is installed it is null — either
  // way it is NEVER Piper (an explicit `say` choice must not be hijacked by the Piper preference).
  assert.notEqual(tts?.name, 'piper');
});
