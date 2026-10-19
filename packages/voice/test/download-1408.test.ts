// task-1408: the voice model downloader. Verifies the safety contract with an INJECTED fetch (no real
// network): asks before downloading, verifies the checksum, rejects a bad/corrupt download without
// writing it into place, skips files already present, and never downloads when the user says no.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadModel, modelRegistry, type ModelSpec } from '../src/index.ts';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const okFetch = (bytes: Buffer): typeof fetch => (async () => new Response(bytes)) as unknown as typeof fetch;
const noFetch = (): typeof fetch => (async () => { throw new Error('network must not be touched'); }) as unknown as typeof fetch;

function tmp(): string { return mkdtempSync(join(tmpdir(), 'dexterm-dl-test-')); }

function oneFileSpec(dir: string, bytes: Buffer, sha256: string, size?: number): ModelSpec {
  return { id: 'x', label: 'test model', note: 'test', files: [{ url: 'https://example.invalid/m.bin', dest: join(dir, 'm.bin'), sha256, size }] };
}

test('confirm=false → cancelled, nothing written, no network beyond the (unused) fetch', async () => {
  const dir = tmp();
  try {
    const bytes = Buffer.from('hello model');
    const res = await downloadModel(oneFileSpec(dir, bytes, sha(bytes)), { fetchImpl: noFetch(), confirm: async () => false });
    assert.equal(res.status, 'cancelled');
    assert.ok(!existsSync(join(dir, 'm.bin')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('confirm=true + matching checksum → ok, file written with the exact bytes', async () => {
  const dir = tmp();
  try {
    const bytes = Buffer.from('solana screener model bytes');
    const res = await downloadModel(oneFileSpec(dir, bytes, sha(bytes), bytes.length), { fetchImpl: okFetch(bytes), confirm: async () => true });
    assert.equal(res.status, 'ok');
    assert.deepEqual(readFileSync(join(dir, 'm.bin')), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checksum mismatch → throws, destination left absent, .part cleaned up', async () => {
  const dir = tmp();
  try {
    const bytes = Buffer.from('tampered payload');
    await assert.rejects(
      downloadModel(oneFileSpec(dir, bytes, sha(Buffer.from('the real thing'))), { fetchImpl: okFetch(bytes), confirm: async () => true }),
      /checksum mismatch/,
    );
    assert.ok(!existsSync(join(dir, 'm.bin')), 'bad download never lands at the destination');
    assert.ok(!existsSync(join(dir, 'm.bin.part')), '.part is removed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('size mismatch → throws, nothing written', async () => {
  const dir = tmp();
  try {
    const bytes = Buffer.from('12345');
    await assert.rejects(
      downloadModel(oneFileSpec(dir, bytes, sha(bytes), 999), { fetchImpl: okFetch(bytes), confirm: async () => true }),
      /size mismatch/,
    );
    assert.ok(!existsSync(join(dir, 'm.bin')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('already present + valid → "already", confirm never asked, network never touched', async () => {
  const dir = tmp();
  try {
    const bytes = Buffer.from('already here');
    writeFileSync(join(dir, 'm.bin'), bytes);
    let asked = false;
    const res = await downloadModel(oneFileSpec(dir, bytes, sha(bytes)), { fetchImpl: noFetch(), confirm: async () => { asked = true; return true; } });
    assert.equal(res.status, 'already');
    assert.equal(asked, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a validateJson file is accepted when it parses and rejected when it does not', async () => {
  const dir = tmp();
  try {
    const good = Buffer.from(JSON.stringify({ audio: { sample_rate: 22050 } }));
    const jsonSpec: ModelSpec = { id: 'j', label: 'cfg', note: 'cfg', files: [{ url: 'https://example.invalid/c.json', dest: join(dir, 'c.json'), validateJson: true }] };
    const ok = await downloadModel(jsonSpec, { fetchImpl: okFetch(good), confirm: async () => true });
    assert.equal(ok.status, 'ok');
    rmSync(join(dir, 'c.json'));
    const bad = Buffer.from('not json {');
    await assert.rejects(downloadModel(jsonSpec, { fetchImpl: okFetch(bad), confirm: async () => true }), /verification failed/);
    assert.ok(!existsSync(join(dir, 'c.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('modelRegistry pins both models with official HF URLs and checksums', () => {
  const reg = modelRegistry('/tmp/fake-home');
  assert.ok(reg.whisper.files[0].url.includes('huggingface.co/ggerganov/whisper.cpp'));
  assert.match(reg.whisper.files[0].sha256!, /^[0-9a-f]{64}$/);
  assert.ok(reg['piper-voice'].files[0].url.includes('huggingface.co/rhasspy/piper-voices'));
  assert.match(reg['piper-voice'].files[0].sha256!, /^[0-9a-f]{64}$/);
  // the piper config is the tiny JSON-validated companion, no checksum
  assert.equal(reg['piper-voice'].files[1].validateJson, true);
});
