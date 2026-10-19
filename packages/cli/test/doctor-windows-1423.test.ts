// task-1423: `trenchscope doctor` on Windows. PATH there is `;`-separated and commands carry an extension
// (`claude.cmd` from npm, `claude.exe` from the native installer); a `:` split with bare names reported every
// installed tool as missing. Runs on every OS: the platform is injected, the "PATH" is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { onPath, claudeProbe } from '../src/doctor.ts';

function binDir(...files: string[]): string {
  // Keep artificial POSIX PATH entries on cwd's drive, even when Windows TEMP is on C: and cwd on D:.
  const dir = mkdtempSync(join(process.cwd(), '.dexterm-doctor-1423-'));
  for (const f of files) writeFileSync(join(dir, f), '');
  return dir;
}

test('onPath on win32 splits PATH on ; and finds claude.cmd / claude.exe through PATHEXT', () => {
  const cmd = binDir('claude.cmd');
  const exe = binDir('whisper-cli.exe');
  const empty = binDir();
  try {
    const env = { PATH: `${empty};${cmd};${exe}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' } as NodeJS.ProcessEnv;
    assert.equal(onPath('claude', env, 'win32'), true);
    assert.equal(onPath('whisper-cli', env, 'win32'), true);
    assert.equal(onPath('sox', env, 'win32'), false);
    // no PATHEXT in the environment: the Windows default list still applies
    assert.equal(onPath('claude', { PATH: cmd } as NodeJS.ProcessEnv, 'win32'), true);
    // Windows spells it `Path` when the variable is inherited untouched
    assert.equal(onPath('claude', { Path: cmd } as NodeJS.ProcessEnv, 'win32'), true);
  } finally {
    for (const d of [cmd, exe, empty]) rmSync(d, { recursive: true, force: true });
  }
});

test('onPath off Windows keeps the : split and exact names (claude.cmd is not claude)', () => {
  const cmd = binDir('claude.cmd');
  const bare = binDir('claude');
  try {
    assert.equal(onPath('claude', { PATH: cmd } as NodeJS.ProcessEnv, 'linux'), false);
    assert.equal(onPath('claude', { PATH: `nonexistent:${relative(process.cwd(), bare)}` } as NodeJS.ProcessEnv, 'darwin'), true);
  } finally {
    for (const d of [cmd, bare]) rmSync(d, { recursive: true, force: true });
  }
});

test('claudeProbe on win32 answers from PATH: claude.exe is present, an npm claude.cmd alone is not (the analyst spawns without a shell)', async () => {
  const exe = binDir('claude.exe');
  const cmd = binDir('claude.cmd');
  const empty = binDir();
  try {
    assert.equal(await claudeProbe(1000, 'win32', { PATH: exe } as NodeJS.ProcessEnv), 'present');
    assert.equal(await claudeProbe(1000, 'win32', { PATH: cmd, PATHEXT: '.COM;.EXE;.BAT;.CMD' } as NodeJS.ProcessEnv), 'missing');
    assert.equal(await claudeProbe(1000, 'win32', { PATH: empty } as NodeJS.ProcessEnv), 'missing');
  } finally {
    for (const d of [exe, cmd, empty]) rmSync(d, { recursive: true, force: true });
  }
});
