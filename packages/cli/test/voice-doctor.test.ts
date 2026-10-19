// task-1282: the voice section is wired into `trenchscope doctor` via an injected voiceProbe, and it is
// warn-only so a machine with no voice support never fails the doctor (it just degrades to text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, renderDoctor, type DoctorDeps, type ProbeResult } from '../src/index.ts';

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: { COLORTERM: 'truecolor', TERM: 'xterm-256color' } as NodeJS.ProcessEnv,
    isTTY: true, nodeVersion: '22.18.0', platform: 'darwin',
    claude: async () => 'ok',
    probe: async (): Promise<ProbeResult> => ({ reachable: true, status: 200, ms: 30 }),
    checkWritable: () => null, offline: true,
    ...over,
  };
}

test('a healthy Mac voiceProbe adds passing voice checks and keeps the doctor ok', async () => {
  const r = await runDoctor(deps({
    voiceProbe: async () => ({ platform: 'darwin', sayAvailable: true, voiceCount: 67, swiftcPresent: true, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false, resolvedStt: 'apple' }),
  }));
  assert.ok(r.ok);
  assert.ok(r.checks.some((c) => /Voice out/.test(c.name) && c.status === 'pass'));
  assert.ok(r.checks.some((c) => /Apple Speech/.test(c.name) && c.status === 'pass'));
});

test('no voice support anywhere is warn-only — the doctor still reports ok', async () => {
  const r = await runDoctor(deps({
    platform: 'linux',
    voiceProbe: async () => ({ platform: 'linux', sayAvailable: false, voiceCount: 0, swiftcPresent: false, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false, resolvedStt: null, espeakPresent: false }),
  }));
  assert.ok(r.ok, 'voice missing must never fail the doctor');
  const out = r.checks.find((c) => /Voice out/.test(c.name));
  assert.ok(out && out.status === 'warn');
  // and it renders with an espeak-ng install fix line
  assert.match(renderDoctor(r), /espeak-ng/);
});

test('a voiceProbe that throws does not break the doctor', async () => {
  const r = await runDoctor(deps({ voiceProbe: async () => { throw new Error('probe boom'); } }));
  assert.ok(r.ok);
  // the non-voice checks are still present
  assert.ok(r.checks.some((c) => c.name === 'Node'));
});
