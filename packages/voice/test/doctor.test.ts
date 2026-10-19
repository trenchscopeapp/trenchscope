import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceDoctor, type VoiceDoctorDeps } from '../src/index.ts';

const base: VoiceDoctorDeps = {
  platform: 'darwin', sayAvailable: true, voiceCount: 40,
  swiftcPresent: true, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false,
  resolvedStt: 'apple',
};
const deps = (o: Partial<VoiceDoctorDeps> = {}): VoiceDoctorDeps => ({ ...base, ...o });
const find = (cs: ReturnType<typeof voiceDoctor>, re: RegExp) => cs.find((c) => re.test(c.name));

test('a healthy Mac with Apple Speech + say passes, no fix lines', () => {
  const cs = voiceDoctor(deps());
  assert.ok(find(cs, /Voice out/)?.status === 'pass');
  assert.ok(find(cs, /Apple Speech/)?.status === 'pass');
  for (const c of cs) if (c.status === 'pass') assert.equal(c.fix, undefined);
});

test('task-1393: a resolved voice shows a "Default voice" pass line with the reason', () => {
  const cs = voiceDoctor(deps({ resolvedVoice: 'Daniel', resolvedVoiceReason: 'Daniel — deep British male (trenchscope default)' }));
  const dv = find(cs, /Default voice/)!;
  assert.equal(dv.status, 'pass');
  assert.match(dv.detail, /deep British male/);
});

test('task-1393: no safe voice (resolvedVoice null) warns with an install fix, never the system voice', () => {
  const cs = voiceDoctor(deps({ resolvedVoice: null, resolvedVoiceReason: 'no safe voice installed — spoken replies are off (text still works)' }));
  const dv = find(cs, /Default voice/)!;
  assert.equal(dv.status, 'warn');
  assert.match(dv.fix ?? '', /Manage Voices|System Settings/);
  assert.ok(!cs.some((c) => c.status === 'fail'));
});

test('task-1416 — macOS with Piper set up: Piper is the default, say is the fallback, never a fail', () => {
  const cs = voiceDoctor(deps({ piperPresent: true, piperVoicePresent: true, playerName: 'afplay', resolvedVoice: 'Eddy (English (UK))', resolvedVoiceReason: 'Eddy — deep British male (trenchscope default)' }));
  const piper = find(cs, /Voice out \(Piper\)/)!;
  assert.equal(piper.status, 'pass');
  assert.match(piper.detail, /default/);
  assert.match(piper.detail, /afplay/);
  // `say` is still present, now labelled as the fallback.
  assert.match(find(cs, /Voice out \(say/)?.detail ?? '', /fallback/);
  assert.equal(find(cs, /Fallback voice/)?.status, 'pass');
  assert.ok(!cs.some((c) => c.status === 'fail'));
});

test('task-1416 — macOS without Piper: say is the default and a non-silent hint offers `trenchscope voice setup`', () => {
  const cs = voiceDoctor(deps({ resolvedVoice: 'Eddy (English (UK))', resolvedVoiceReason: 'Eddy — deep British male (trenchscope default)' }));
  assert.equal(find(cs, /Default voice/)?.status, 'pass');
  const neural = find(cs, /Neural voice \(Piper\)/)!;
  assert.equal(neural.status, 'warn');
  assert.match(neural.fix ?? '', /trenchscope voice setup/);
  assert.ok(!cs.some((c) => c.status === 'fail'));
});

test('task-1393 Part 2 — Linux with espeak-ng + whisper: both pass, never a fail', () => {
  const cs = voiceDoctor(deps({ platform: 'linux', espeakPresent: true, resolvedStt: 'whisper', whisperBinPresent: true, whisperModelPresent: true, micToolPresent: true }));
  assert.equal(find(cs, /Voice out \(espeak/)?.status, 'pass');
  assert.equal(find(cs, /Voice in \(whisper/)?.status, 'pass');
  assert.ok(!cs.some((c) => c.status === 'fail'));
});

test('task-1393 Part 2 — Linux with nothing installed: warns with apt fixes, app still runs as text', () => {
  const cs = voiceDoctor(deps({ platform: 'linux', espeakPresent: false, resolvedStt: null, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false }));
  assert.equal(find(cs, /Voice out/)?.status, 'warn');
  assert.match(find(cs, /Voice out/)?.fix ?? '', /espeak-ng/);
  assert.equal(find(cs, /Voice in/)?.status, 'warn');
  assert.ok(!cs.some((c) => c.status === 'fail'), 'voice missing must never fail the doctor');
});

test('task-1408 — Linux with Piper ready: a Piper pass line names the player; never a fail', () => {
  const cs = voiceDoctor(deps({ platform: 'linux', piperPresent: true, piperVoicePresent: true, playerName: 'aplay', espeakPresent: true, resolvedStt: 'whisper', whisperBinPresent: true, whisperModelPresent: true, micToolPresent: true }));
  const out = find(cs, /Voice out \(Piper\)/)!;
  assert.equal(out.status, 'pass');
  assert.match(out.detail, /neural/);
  assert.match(out.detail, /aplay/);
  assert.ok(!cs.some((c) => c.status === 'fail'));
});

test('task-1408 — Linux espeak present, Piper not: espeak passes with an upgrade hint, never says `apt install piper`', () => {
  const cs = voiceDoctor(deps({ platform: 'linux', espeakPresent: true, piperPresent: false, piperVoicePresent: false, playerName: null, resolvedStt: 'whisper', whisperBinPresent: true, whisperModelPresent: true, micToolPresent: true }));
  const out = find(cs, /Voice out \(espeak/)!;
  assert.equal(out.status, 'pass');
  assert.match(out.detail, /Piper/);
  assert.match(out.detail, /trenchscope voice download piper-voice/);
  // `apt install piper` may appear ONLY as an explicit "NOT …" warning, never as a recommendation.
  const recommendsApt = (s: string) => /(?<!NOT `)apt install piper/.test(s);
  for (const c of cs) assert.ok(!recommendsApt(c.detail) && !recommendsApt(c.fix ?? ''), 'never recommend the unrelated apt piper');
  assert.match(out.detail, /NOT `apt install piper`/);
});

test('task-1408 — Linux no engine: the fix warns AGAINST `apt install piper` and points to the prebuilt release', () => {
  const cs = voiceDoctor(deps({ platform: 'linux', espeakPresent: false, piperPresent: false, piperVoicePresent: false, playerName: null, resolvedStt: null, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false }));
  const fix = find(cs, /Voice out/)?.fix ?? '';
  assert.match(fix, /Do NOT `apt install piper`/);
  assert.match(fix, /rhasspy\/piper\/releases/);
  assert.match(fix, /trenchscope voice download piper-voice/);
});

test('task-1408 — Linux voice-in fix offers the checksum-verified download and the prebuilt whisper release (not Debian)', () => {
  const cs = voiceDoctor(deps({ platform: 'linux', espeakPresent: true, resolvedStt: null, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false }));
  const fix = find(cs, /Voice in/)?.fix ?? '';
  assert.match(fix, /trenchscope voice download whisper/);
  assert.match(fix, /not in Debian/);
  assert.match(fix, /whisper\.cpp\/releases/);
});

test('task-1393 Part 2 — Windows states espeak-ng is the path and SAPI is not wired (honest)', () => {
  const cs = voiceDoctor(deps({ platform: 'win32', espeakPresent: false, resolvedStt: null }));
  const w = find(cs, /Windows voice/)!;
  assert.equal(w.status, 'warn');
  assert.match(w.detail, /SAPI is not wired/);
});

test('no say: spoken replies warn with a reinstall fix, voice-in can still pass', () => {
  const cs = voiceDoctor(deps({ sayAvailable: false, voiceCount: 0 }));
  const out = find(cs, /Voice out/)!;
  assert.equal(out.status, 'warn');
  assert.match(out.fix ?? '', /xcode-select|Command Line Tools/);
});

test('whisper fallback passes when swiftc is absent but the model + mic tool are present', () => {
  const cs = voiceDoctor(deps({ swiftcPresent: false, resolvedStt: 'whisper', whisperBinPresent: true, whisperModelPresent: true, micToolPresent: true }));
  assert.equal(find(cs, /whisper/)?.status, 'pass');
});

test('nothing for voice-in: warn (degrade to text) with a concrete fix, never fail', () => {
  const cs = voiceDoctor(deps({ swiftcPresent: false, resolvedStt: null, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false }));
  const vin = find(cs, /Voice in/)!;
  assert.equal(vin.status, 'warn');
  assert.match(vin.detail, /degrades to text|still type/);
  assert.match(vin.fix ?? '', /xcode-select|whisper/);
  assert.ok(!cs.some((c) => c.status === 'fail'), 'voice missing must never fail the doctor');
});
