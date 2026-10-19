// task-1393 Part 2: the portable espeak-ng engine, exercised against a FAKE espeak binary so the logic
// is deterministic on any platform. NOTE: this verifies argv/stdin/sanitise/queue behaviour, NOT real
// espeak-ng audio — that was not runnable because the Linux (WSL) box was unreachable during the task.

import { useNodeScripts } from '../../../scripts/test-support.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dexterm-espeak-test-'));
const fakeBin = join(dir, 'fake-espeak.mjs');
const log = join(dir, 'log.jsonl');
useNodeScripts({ [fakeBin]: fakeBin });

const FAKE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const LOG = process.env.FAKE_ESPEAK_LOG;
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch {}
appendFileSync(LOG, JSON.stringify({ ev: 'start', argv, stdin }) + '\\n');
const t = setTimeout(() => { appendFileSync(LOG, JSON.stringify({ ev: 'end', stdin }) + '\\n'); process.exit(0); }, 300);
process.on('SIGTERM', () => { clearTimeout(t); process.exit(143); });
`;

let EspeakTts: typeof import('../src/tts/espeak.ts').EspeakTts;

before(async () => {
  writeFileSync(fakeBin, FAKE, { mode: 0o755 });
  chmodSync(fakeBin, 0o755);
  process.env.DEXTERM_ESPEAK_BIN = fakeBin;
  process.env.FAKE_ESPEAK_LOG = log;
  ({ EspeakTts } = await import('../src/tts/espeak.ts'));
});

after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const readLog = (): Array<{ ev: string; argv?: string[]; stdin?: string }> =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('available() is true when the binary resolves', async () => {
  assert.equal(await new EspeakTts().available(), true);
});

test('default voice is a British male; text on stdin, pitch/rate as flags, not argv', async () => {
  writeFileSync(log, '');
  const tts = new EspeakTts();
  assert.equal(tts.voiceName, 'en-gb+m3');
  const h = tts.speak('liquidity is thin', { pitch: 30, rate: 160 });
  await h.done;
  const { argv, stdin } = readLog().find((e) => e.ev === 'start')!;
  assert.deepEqual(argv!.slice(0, 2), ['-v', 'en-gb+m3']);
  assert.ok(argv!.includes('-s') && argv![argv!.indexOf('-s') + 1] === '160');
  assert.ok(argv!.includes('-p') && argv![argv!.indexOf('-p') + 1] === '30');
  assert.ok(argv!.includes('--stdin'));
  assert.ok(!argv!.some((a) => a.includes('liquidity')), 'text is not on argv');
  assert.equal(stdin, 'liquidity is thin');
});

test('sanitises [[ phoneme sequences before espeak sees them', async () => {
  writeFileSync(log, '');
  const tts = new EspeakTts();
  await tts.speak('look [[dfilms]] here').done;
  const { stdin } = readLog().find((e) => e.ev === 'start')!;
  assert.ok(!stdin!.includes('[['), 'no [[ phoneme input reaches espeak');
});

test('a second speak() cleanly interrupts the first (single queue)', async () => {
  writeFileSync(log, '');
  const tts = new EspeakTts();
  const a = tts.speak('first AAAA');
  const b = tts.speak('second BBBB');
  await a.done;
  await b.done;
  const ends = readLog().filter((e) => e.ev === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].stdin, 'second BBBB');
});
