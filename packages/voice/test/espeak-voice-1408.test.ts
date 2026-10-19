// task-1408 (criterion 5): a macOS voice name (config.voice.name is e.g. "Eddy (English (UK))") must
// NEVER be passed verbatim to a Linux engine. espeakVoiceFor() drops it so espeak falls back to its own
// British default, and selectTts('espeak', <mac name>) speaks with that default, not the Mac name.

import { useNodeScripts } from '../../../scripts/test-support.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dexterm-espeak-voice-test-'));
const fakeBin = join(dir, 'fake-espeak.mjs');
const log = join(dir, 'log.jsonl');
useNodeScripts({ [fakeBin]: fakeBin });

const FAKE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
let stdin = ''; try { stdin = readFileSync(0, 'utf8'); } catch {}
appendFileSync(process.env.FAKE_ESPEAK_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
setTimeout(() => process.exit(0), 50);
`;

let espeakVoiceFor: typeof import('../src/tts/espeak.ts').espeakVoiceFor;
let selectTts: typeof import('../src/engines.ts').selectTts;

before(async () => {
  writeFileSync(fakeBin, FAKE, { mode: 0o755 }); chmodSync(fakeBin, 0o755);
  process.env.DEXTERM_ESPEAK_BIN = fakeBin;
  process.env.FAKE_ESPEAK_LOG = log;
  ({ espeakVoiceFor } = await import('../src/tts/espeak.ts'));
  ({ selectTts } = await import('../src/engines.ts'));
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const lastArgv = (): string[] => JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)!).argv;

test('espeakVoiceFor drops macOS voice names, keeps real espeak voice tokens', () => {
  // macOS names → null (use the engine default)
  for (const mac of ['Eddy (English (UK))', 'Daniel', 'Reed (English (UK))', 'Alex', 'Zarvox']) {
    assert.equal(espeakVoiceFor(mac), null, `${mac} must not reach espeak`);
  }
  // real espeak voice tokens → kept
  for (const ev of ['en', 'en-gb', 'en-us+m3', 'de+f2', 'en-gb+m1']) {
    assert.equal(espeakVoiceFor(ev), ev, `${ev} is a valid espeak voice`);
  }
  assert.equal(espeakVoiceFor(''), null);
  assert.equal(espeakVoiceFor(null), null);
});

test('selectTts(espeak, <mac name>) speaks with the British default, not the mac name', async () => {
  writeFileSync(log, '');
  const tts = await selectTts('espeak', 'Eddy (English (UK))');
  assert.ok(tts, 'espeak engine resolves against the fake binary');
  await tts!.speak('three new pairs passed the checks').done;
  const argv = lastArgv();
  const v = argv[argv.indexOf('-v') + 1];
  assert.equal(v, 'en-gb+m3', 'the mac name was dropped; the espeak default is used');
  assert.ok(!argv.some((a) => a.includes('Eddy') || a.includes('English')), 'no mac voice name on argv');
});

test('selectTts(espeak, <espeak token>) honours a real espeak voice', async () => {
  writeFileSync(log, '');
  const tts = await selectTts('espeak', 'en-us+m1');
  await tts!.speak('ok').done;
  const argv = lastArgv();
  assert.equal(argv[argv.indexOf('-v') + 1], 'en-us+m1');
});
