// task-1408: `trenchscope voice` CLI surface — status report and the guarded download command. No network
// is touched here: status is read-only, and download refuses to run non-interactively without --yes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceCommand, type VoiceCmdIo } from '../src/voice-cmd.ts';

function mkIo(over: Partial<VoiceCmdIo> & { tty?: boolean } = {}): { io: VoiceCmdIo; out: () => string; err: () => string } {
  let out = '', err = '';
  const home = mkdtempSync(join(tmpdir(), 'dexterm-voice-cmd-'));
  const io: VoiceCmdIo = {
    stdin: { isTTY: over.tty ?? false } as VoiceCmdIo['stdin'],
    stdout: { write: (s: string) => { out += s; return true; } },
    stderr: { write: (s: string) => { err += s; return true; } },
    env: { DEXTERM_HOME: home, PATH: '' } as NodeJS.ProcessEnv,
    ...over,
  };
  return { io, out: () => out, err: () => err };
}

test('`voice status` prints the engines and the model install state', async () => {
  const { io, out } = mkIo();
  const code = await voiceCommand(['status'], io);
  assert.equal(code, 0);
  assert.match(out(), /speech-out/);
  assert.match(out(), /speech-in/);
  assert.match(out(), /whisper/);
  assert.match(out(), /piper-voice/);
});

test('`voice` with no args defaults to status', async () => {
  const { io, out } = mkIo();
  assert.equal(await voiceCommand([], io), 0);
  assert.match(out(), /trenchscope voice/);
});

test('`voice download` with no model name is a usage error', async () => {
  const { io, err } = mkIo();
  assert.equal(await voiceCommand(['download'], io), 2);
  assert.match(err(), /name a model/);
});

test('`voice download <unknown>` is a usage error', async () => {
  const { io, err } = mkIo();
  assert.equal(await voiceCommand(['download', 'nope'], io), 2);
  assert.match(err(), /unknown model/);
});

test('`voice download whisper` without a TTY and without --yes refuses (never a silent download)', async () => {
  const { io, err } = mkIo({ tty: false });
  const code = await voiceCommand(['download', 'whisper'], io);
  assert.equal(code, 2);
  assert.match(err(), /--yes/);
});

test('unknown subcommand is a usage error', async () => {
  const { io, err } = mkIo();
  assert.equal(await voiceCommand(['wat'], io), 2);
  assert.match(err(), /unknown subcommand/);
});
