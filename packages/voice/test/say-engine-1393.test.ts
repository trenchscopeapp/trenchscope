// task-1393: SayTts hardening, exercised against a FAKE `say` binary (DEXTERM_SAY_BIN) so it runs on
// any platform and is deterministic. Asserts: text goes on STDIN (never argv), the text is sanitised
// before `say` ever sees it, and a second speak() cleanly interrupts the first so two `say` processes
// never overlap (a single speak queue).
//
// The env must be set BEFORE say.ts is evaluated, and ES `import` is hoisted above top-level code, so
// this file uses a dynamic import() after wiring up the fake binary.

import { useNodeScripts } from '../../../scripts/test-support.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dexterm-say-test-'));
const fakeSay = join(dir, 'fake-say.mjs');
const log = join(dir, 'log.jsonl');
useNodeScripts({ [fakeSay]: fakeSay });

// A stand-in for macOS `say`: records argv + stdin, then "speaks" for 300 ms. On SIGTERM it dies before
// writing its END line, which is how the test sees that an utterance was interrupted (not overlapped).
const FAKE_SAY = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const LOG = process.env.FAKE_SAY_LOG;
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch {}
const id = argv.includes('-v') ? argv[argv.indexOf('-v') + 1] : 'novoice';
appendFileSync(LOG, JSON.stringify({ ev: 'start', argv, stdin }) + '\\n');
const timer = setTimeout(() => { appendFileSync(LOG, JSON.stringify({ ev: 'end', stdin }) + '\\n'); process.exit(0); }, 300);
process.on('SIGTERM', () => { clearTimeout(timer); process.exit(143); });
`;

let SayTts: typeof import('../src/tts/say.ts').SayTts;

before(async () => {
  writeFileSync(fakeSay, FAKE_SAY, { mode: 0o755 });
  chmodSync(fakeSay, 0o755);
  process.env.DEXTERM_SAY_BIN = fakeSay;
  process.env.FAKE_SAY_LOG = log;
  ({ SayTts } = await import('../src/tts/say.ts'));
});

after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const readLog = (): Array<{ ev: string; argv?: string[]; stdin?: string }> =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('speak() delivers text on stdin, not as an argv word, with an explicit voice and rate', async () => {
  writeFileSync(log, '');
  const tts = new SayTts('Daniel');
  const h = tts.speak('hello there');
  await h.done;
  const starts = readLog().filter((e) => e.ev === 'start');
  assert.equal(starts.length, 1);
  const { argv, stdin } = starts[0];
  assert.ok(argv!.includes('-v') && argv![argv!.indexOf('-v') + 1] === 'Daniel', 'explicit -v Daniel');
  assert.ok(argv!.includes('-r'), 'has a rate');
  assert.deepEqual(argv!.slice(-2), ['-f', '-'], 'reads from stdin');
  assert.ok(!argv!.some((a) => a.includes('hello there')), 'text is NOT on argv');
  assert.equal(stdin, 'hello there', 'text arrives on stdin');
});

test('speak() sanitises before say sees it: no [[ commands, address shortened', async () => {
  writeFileSync(log, '');
  const tts = new SayTts('Daniel');
  const mint = 'So11111111111111111111111111111111111111112';
  const h = tts.speak(`[[slnc 9000]] watch ${mint}`);
  await h.done;
  const { stdin } = readLog().find((e) => e.ev === 'start')!;
  assert.ok(!stdin!.includes('[['), 'no embedded command reaches say');
  assert.ok(!stdin!.includes(mint), 'the full contract address is not spoken');
});

test('a trusted pitch is applied as a prefix even though [[ in the text is stripped', async () => {
  writeFileSync(log, '');
  const tts = new SayTts('Daniel');
  const h = tts.speak('[[pbas 99]] make me squeaky', { pitch: 30 });
  await h.done;
  const { stdin } = readLog().find((e) => e.ev === 'start')!;
  assert.match(stdin!, /^\[\[pbas 30\]\] /, 'our trusted pitch leads');
  // The only intact `[[` command is ours; the text-injected one is defused (broken into `[ [`).
  assert.equal(stdin!.indexOf('[['), 0, 'no second intact [[ command survives');
  assert.ok(!/\[\[pbas 99/.test(stdin!), 'the injected pitch command cannot execute');
});

test('a second speak() cleanly interrupts the first — the two never overlap', async () => {
  writeFileSync(log, '');
  const tts = new SayTts('Daniel');
  const a = tts.speak('first utterance AAAA');
  const b = tts.speak('second utterance BBBB'); // must stop A before spawning
  await a.done; // resolves immediately because A was interrupted, not after A's full 300 ms
  await b.done;
  const log1 = readLog();
  const ends = log1.filter((e) => e.ev === 'end');
  // B completed; A was interrupted so it never wrote its END line → no overlap, single queue.
  assert.equal(ends.length, 1, 'exactly one utterance finished');
  assert.equal(ends[0].stdin, 'second utterance BBBB');
});
