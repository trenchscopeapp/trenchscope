// task-1416: the managed macOS Piper runtime (venv + model + record). All system/network effects are
// INJECTED (a fake `run`, a fake model-download, a fake confirm), so this is deterministic and never
// spawns python, pip, or touches the network. The real end-to-end install is proven by one real run in a
// temp HOME (see the handoff); here we pin the branching logic and the record/uninstall contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  setupPiperRuntime, uninstallPiperRuntime, piperRuntimeStatus, piperRuntimePaths, readRuntimeRecord,
  detectPython, parsePythonVersion, pythonVersionOk, pythonFixLine, PIPER_PYPI_VERSION,
  type RunResult,
} from '../src/tts/piper-setup.ts';

function tmpHome(): string { return mkdtempSync(join(tmpdir(), 'dexterm-setup-')); }

/** A fake `run` that creates the venv python on `venv`, and returns the given code for each step. */
function fakeRun(home: string, opts: { version?: string; venvCode?: number; pipCode?: number; importCode?: number } = {}): (cmd: string, args: string[]) => Promise<RunResult> {
  const paths = piperRuntimePaths(home);
  return async (_cmd: string, args: string[]): Promise<RunResult> => {
    if (args.includes('--version')) return { code: 0, stdout: opts.version ?? 'Python 3.11.7', stderr: '' };
    if (args.includes('venv')) {
      if ((opts.venvCode ?? 0) === 0) { mkdirSync(dirname(paths.python), { recursive: true }); writeFileSync(paths.python, '#!/bin/sh\n'); }
      return { code: opts.venvCode ?? 0, stdout: '', stderr: opts.venvCode ? 'venv boom' : '' };
    }
    if (args.includes('pip')) return { code: opts.pipCode ?? 0, stdout: '', stderr: opts.pipCode ? 'pip boom' : '' };
    if (args.join(' ').includes('import piper')) return { code: opts.importCode ?? 0, stdout: '', stderr: opts.importCode ? 'no module' : '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

const okDownload = async (): Promise<{ status: 'ok'; files: string[] }> => ({ status: 'ok', files: ['model.onnx', 'model.onnx.json'] });

test('parsePythonVersion + pythonVersionOk gate on >= 3.9', () => {
  assert.deepEqual(parsePythonVersion('Python 3.11.7'), [3, 11, 7]);
  assert.deepEqual(parsePythonVersion('Python 3.9'), [3, 9, 0]);
  assert.equal(parsePythonVersion('not python'), null);
  assert.equal(pythonVersionOk([3, 11, 0]), true);
  assert.equal(pythonVersionOk([3, 9, 0]), true);
  assert.equal(pythonVersionOk([3, 8, 10]), false);
  assert.equal(pythonVersionOk([2, 7, 18]), false);
  assert.equal(pythonVersionOk(null), false);
  assert.match(pythonFixLine('darwin'), /brew install python|xcode-select/);
  assert.match(pythonFixLine('linux'), /python3-venv/);
});

test('detectPython skips a too-old interpreter and picks the first >= 3.9', async () => {
  const run = async (cmd: string): Promise<RunResult> =>
    cmd === 'python3.8' ? { code: 0, stdout: 'Python 3.8.10', stderr: '' }
    : cmd === 'python3.12' ? { code: 0, stdout: 'Python 3.12.2', stderr: '' }
    : { code: 127, stdout: '', stderr: 'not found' };
  const found = await detectPython({ run, pythonCandidates: ['python3.8', 'python3.12', 'python3'] });
  assert.equal(found?.python, 'python3.12');
});

test('setup → no-python when nothing qualifies, with a fix line', async () => {
  const home = tmpHome();
  try {
    const res = await setupPiperRuntime({
      home, confirm: async () => true, run: async () => ({ code: 127, stdout: '', stderr: 'nope' }),
      pythonCandidates: ['python3'], downloadModelImpl: okDownload,
    });
    assert.equal(res.status, 'no-python');
    assert.ok(res.fix && res.fix.length > 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('setup → cancelled leaves nothing installed', async () => {
  const home = tmpHome();
  try {
    const res = await setupPiperRuntime({ home, confirm: async () => false, run: fakeRun(home), pythonCandidates: ['python3'], downloadModelImpl: okDownload });
    assert.equal(res.status, 'cancelled');
    assert.equal(existsSync(piperRuntimePaths(home).python), false, 'no venv built after a no');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('setup → failed with a fix when pip install fails', async () => {
  const home = tmpHome();
  try {
    const res = await setupPiperRuntime({ home, confirm: async () => true, run: fakeRun(home, { pipCode: 1 }), pythonCandidates: ['python3'], downloadModelImpl: okDownload });
    assert.equal(res.status, 'failed');
    assert.match(res.fix!, /pip install failed/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('setup → ok builds the venv, installs piper-tts, downloads the model, writes the record', async () => {
  const home = tmpHome();
  try {
    let now = 1_700_000_000_000;
    const res = await setupPiperRuntime({
      home, confirm: async () => true, run: fakeRun(home, { version: 'Python 3.12.2' }),
      pythonCandidates: ['python3'], downloadModelImpl: okDownload, now: () => now,
    });
    assert.equal(res.status, 'ok');
    assert.ok(existsSync(piperRuntimePaths(home).python), 'the venv python exists');
    const rec = readRuntimeRecord(home);
    assert.equal(rec?.kind, 'venv');
    assert.equal(rec?.piperTts, PIPER_PYPI_VERSION);
    assert.equal(rec?.pythonVersion, '3.12.2');
    assert.ok(rec?.installedAt, 'records when it was installed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('piperRuntimeStatus reports a partial (runtime present, model missing) install', async () => {
  const home = tmpHome();
  try {
    const paths = piperRuntimePaths(home);
    mkdirSync(dirname(paths.python), { recursive: true }); writeFileSync(paths.python, '#!/bin/sh\n');
    const st = await piperRuntimeStatus(home);
    assert.equal(st.pythonPresent, true);
    assert.equal(st.modelInstalled, false);
    assert.equal(st.installed, false, 'not fully installed until the model is there too');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstall removes the venv + record; absent when nothing is there; --purge-model removes the model', async () => {
  const home = tmpHome();
  try {
    assert.equal((await uninstallPiperRuntime(home)).status, 'absent');
    const paths = piperRuntimePaths(home);
    mkdirSync(dirname(paths.python), { recursive: true }); writeFileSync(paths.python, 'x');
    writeFileSync(paths.record, '{"kind":"venv"}');
    const modelFile = join(home, 'models', 'en_GB-alan-medium.onnx');
    mkdirSync(dirname(modelFile), { recursive: true }); writeFileSync(modelFile, 'onnx');
    const r1 = await uninstallPiperRuntime(home);
    assert.equal(r1.status, 'ok');
    assert.equal(existsSync(paths.venv), false, 'venv gone');
    assert.equal(existsSync(paths.record), false, 'record gone');
    assert.equal(existsSync(modelFile), true, 'model kept by default');
    const r2 = await uninstallPiperRuntime(home, { purgeModel: true });
    assert.equal(r2.status, 'ok');
    assert.equal(existsSync(modelFile), false, 'model purged on request');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
