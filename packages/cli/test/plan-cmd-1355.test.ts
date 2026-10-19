// task-1355 — `trenchscope plan` / `trenchscope mandate` CLI: propose never arms, arming needs a PHYSICAL
// keypress on a TTY (a pipe/agent is refused), and the hash-chained journal persists across invocations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan, runMandate } from '../src/plan-cmd.ts';
import type { Io } from '../src/main.ts';
import type { KeyInput } from '../src/wallet-cmd.ts';

function io(): Io & { out: string; err: string } {
  const o = {
    out: '', err: '', env: {} as NodeJS.ProcessEnv, stdin: undefined as unknown as Io['stdin'],
    stdout: { write(s: string) { (o as { out: string }).out += s; return true; } } as unknown as Io['stdout'],
    stderr: { write(s: string) { (o as { err: string }).err += s; return true; } } as unknown as Io['stderr'],
  };
  return o as Io & { out: string; err: string };
}

/** stdin stand-in: tty=true mimics a terminal; keys are delivered on resume(). */
function fakeStdin(tty: boolean, keys: string[] = []): KeyInput {
  let handler: ((c: Buffer | string) => void) | null = null;
  const s: KeyInput = {
    isTTY: tty,
    setRawMode(_v: boolean) { return s; },
    once(_e: 'data', cb: (c: Buffer | string) => void) { handler = cb; return s; },
    off() { handler = null; return s; },
    resume() { const k = keys.shift(); if (k !== undefined && handler) setImmediate(() => handler?.(Buffer.from(k))); return s; },
    pause() { return s; },
  } as unknown as KeyInput;
  return s;
}

const MINT = 'Fx9sDipT3StRench3sHoTAbcdefGhiJkLmNoPqRsTuV';
function journal(): string[] { return ['--journal', join(mkdtempSync(join(tmpdir(), 'dexterm-plan-cli-')), 'plans.journal')]; }

test('plan propose prints a read-back and does NOT arm; list shows it proposed', async () => {
  const j = journal();
  const o = io();
  assert.equal(await runPlan(['propose', ...j, '--mint', MINT, '--symbol', 'TRENCH', '--size', '20', '--entry', 'mc-below:300k', '--tp', 'mc-above:600k:50%', '--stop', 'mc-below:150k', '--supply', '1b'], o), 0);
  assert.match(o.out, /dips to \$300k/);
  assert.match(o.out, /PROPOSAL only — not armed/);
  const l = io();
  await runPlan(['list', ...j], l);
  assert.match(l.out, /proposed/);
});

test('mandate arm is refused without a physical keypress (pipe / non-TTY / agent); a real keypress arms', async () => {
  const j = journal();
  // draft
  const draft = io();
  assert.equal(await runMandate(['draft', ...j, '--total', '1000', '--per-trade', '25'], draft), 0);
  const id = /drafted (\S+)/.exec(draft.out)![1];
  // arm with a non-TTY stdin → refused
  const piped = io(); piped.stdin = fakeStdin(false, ['y']) as unknown as Io['stdin'];
  assert.equal(await runMandate(['arm', id, ...j], piped), 1);
  assert.match(piped.err, /refused: no physical keypress/);
  // arm with a real keypress → armed
  const tty = io(); tty.stdin = fakeStdin(true, ['y']) as unknown as Io['stdin'];
  assert.equal(await runMandate(['arm', id, ...j], tty), 0);
  assert.match(tty.out, /armed mandate/);
  const l = io(); await runMandate(['list', ...j], l);
  assert.match(l.out, /armed/);
});

test('plan arm into an armed mandate needs a keypress; then the journal verifies and persists across invocations', async () => {
  const j = journal();
  // armed mandate
  const dm = io(); await runMandate(['draft', ...j, '--total', '1000', '--per-trade', '25'], dm);
  const mid = /drafted (\S+)/.exec(dm.out)![1];
  const am = io(); am.stdin = fakeStdin(true, ['y']) as unknown as Io['stdin'];
  await runMandate(['arm', mid, ...j], am);
  // proposed plan
  const pp = io(); await runPlan(['propose', ...j, '--mint', MINT, '--size', '20', '--entry', 'mc-below:300k', '--tp', 'mc-above:600k:50%', '--supply', '1b', '--json'], pp);
  const pid = JSON.parse(pp.out).id as string;
  // arm needs a keypress
  const noKey = io(); noKey.stdin = fakeStdin(false) as unknown as Io['stdin'];
  assert.equal(await runPlan(['arm', pid, '--mandate', mid, ...j], noKey), 1);
  const yesKey = io(); yesKey.stdin = fakeStdin(true, ['y']) as unknown as Io['stdin'];
  assert.equal(await runPlan(['arm', pid, '--mandate', mid, ...j], yesKey), 0);
  assert.match(yesKey.out, /armed/);
  // a fresh invocation (new process model) still sees the armed plan — persistence + audit chain
  const l = io(); await runPlan(['list', ...j], l);
  assert.match(l.out, /armed/);
  const v = io(); assert.equal(await runPlan(['journal', ...j, '--verify'], v), 0);
  assert.match(v.out, /audit log OK/);
});
