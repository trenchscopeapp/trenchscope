// task-1339 (re-verify N5): a helper binary that cannot be spawned (EACCES / ENOENT) must surface as a
// rejected listen() — "mic/STT could not start" — never as an uncaughtException that exits dexterm.
// Headless: the "helper" is a non-executable file in a temp cache dir with a matching source hash, and
// `swiftc` is pointed at /usr/bin/true so nothing is compiled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { APPLE_HELPER_SWIFT } from '../src/stt/apple-helper.swift.ts';

const dir = mkdtempSync(join(tmpdir(), 'voice-1339-apple-'));
process.env.DEXTERM_VOICE_HELPER_DIR = dir;
process.env.DEXTERM_SWIFTC = existsSync('/usr/bin/true') ? '/usr/bin/true' : process.execPath;
writeFileSync(join(dir, 'recognize'), '#!/bin/sh\necho never\n', { mode: 0o644 }); // present but NOT executable → EACCES
writeFileSync(join(dir, '.srchash'), createHash('sha256').update(APPLE_HELPER_SWIFT).digest('hex'));

const { AppleStt, ensureHelper, VoiceController, FakeTts } = await import('../src/index.ts');

test('N5: a non-executable helper rejects listen() cleanly (no uncaughtException)', async () => {
  if (process.platform === 'win32') return;
  assert.equal(ensureHelper(), join(dir, 'recognize'), 'the cached (fake) helper is used without a compile');
  const uncaught: unknown[] = [];
  const onU = (e: unknown) => { uncaught.push(e); };
  process.on('uncaughtException', onU);
  try {
    const stt = new AppleStt();
    await assert.rejects(stt.listen(), /mic helper failed to start/);
    await new Promise<void>((r) => setTimeout(r, 30));
    assert.equal(uncaught.length, 0, 'the spawn error never escaped');
  } finally { process.off('uncaughtException', onU); }
});

test('N5: through the controller the failure is a status message and the mode is idle', async () => {
  if (process.platform === 'win32') return;
  const ctrl = new VoiceController({ stt: new AppleStt(), tts: new FakeTts() });
  ctrl.enable();
  await ctrl.toggleTalk();
  assert.equal(ctrl.status().mode, 'idle');
  assert.equal(ctrl.status().starting, false);
  assert.match(ctrl.status().message ?? '', /mic\/STT could not start/);
  assert.equal(ctrl.micEngaged, false, 'nothing is live');
  rmSync(dir, { recursive: true, force: true });
});
