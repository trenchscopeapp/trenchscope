// task-1408: the whisper mic-capture recorder picks `arecord` (alsa-utils) on Linux. This verifies the
// SELECTION + argv only (no real mic — containers and CI have none; real capture is unverified, see the
// handoff). process.platform and PATH are stubbed so the test is deterministic on macOS.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pickRecorder } from '../src/stt/whisper.ts';

// A relative fixture PATH has no drive colon while pretending to be Linux/macOS.
const dir = mkdtempSync(join(process.cwd(), '.dexterm-recorder-test-'));
const realPlatform = process.platform;
const realPath = process.env.PATH;

function setPlatform(p: NodeJS.Platform): void { Object.defineProperty(process, 'platform', { value: p, configurable: true }); }
function putBin(name: string): void { const f = join(dir, name); writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 }); chmodSync(f, 0o755); }

before(() => { process.env.PATH = relative(process.cwd(), dir); }); // only the bins we drop in `dir` are "installed"
after(() => { setPlatform(realPlatform); process.env.PATH = realPath; rmSync(dir, { recursive: true, force: true }); });

test('Linux with only arecord installed → arecord recorder, 16 kHz mono 16-bit WAV argv', () => {
  setPlatform('linux');
  putBin('arecord');
  const rec = pickRecorder();
  assert.ok(rec);
  assert.equal(rec!.cmd, 'arecord');
  const args = rec!.args('/tmp/out.wav');
  assert.deepEqual(args, ['-q', '-f', 'S16_LE', '-c', '1', '-r', '16000', '/tmp/out.wav']);
  assert.equal(rec!.stopSignal, 'SIGINT');
});

test('macOS never picks arecord even if present (it is a Linux tool)', () => {
  setPlatform('darwin');
  // dir still contains only arecord; on darwin arecord is skipped → no recorder
  const rec = pickRecorder();
  assert.equal(rec, null, 'darwin ignores arecord');
});

test('Linux ffmpeg falls back to the ALSA input format, not avfoundation', () => {
  setPlatform('linux');
  rmSync(join(dir, 'arecord')); // remove arecord so ffmpeg is the only option
  putBin('ffmpeg');
  const rec = pickRecorder();
  assert.ok(rec && rec.cmd === 'ffmpeg');
  assert.ok(rec!.args('/tmp/o.wav').includes('alsa'), 'alsa input on Linux');
  assert.ok(!rec!.args('/tmp/o.wav').includes('avfoundation'));
});
