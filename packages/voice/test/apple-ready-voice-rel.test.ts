// voice-reliability: AppleStt.listen() resolves only once the helper says `ready` (the mic is really open),
// a helper that fails before ready rejects with its message, and stop() returns the final text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { APPLE_HELPER_SWIFT } from '../src/stt/apple-helper.swift.ts';

const dir = mkdtempSync(join(tmpdir(), 'voice-rel-apple-'));
process.env.DEXTERM_VOICE_HELPER_DIR = dir;
process.env.DEXTERM_SWIFTC = '/usr/bin/true';
writeFileSync(join(dir, '.srchash'), createHash('sha256').update(APPLE_HELPER_SWIFT).digest('hex'));
const helper = (body: string): void => writeFileSync(join(dir, 'recognize'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const { AppleStt } = await import('../src/index.ts');

test('listen() waits for ready, and stop() returns the final text', { skip: process.platform === 'win32' }, async () => {
  helper(`sleep 0.4; echo '{"type":"ready"}'; read l; echo '{"type":"final","text":"open bonk","confidence":0.9}'`);
  const t0 = Date.now();
  const s = await new AppleStt().listen();
  assert.ok(Date.now() - t0 >= 350, 'listen() did not resolve before the helper was ready');
  const r = await s.stop();
  assert.equal(r.text, 'open bonk');
});

test('a helper that errors before ready rejects listen() with its message', { skip: process.platform === 'win32' }, async () => {
  helper(`echo '{"type":"error","message":"speech recognition not authorized"}'; exit 1`);
  await assert.rejects(new AppleStt().listen(), /not authorized/);
  rmSync(dir, { recursive: true, force: true });
});
