// task-1393: voice resolution, the novelty ban-list, and speech sanitisation. Pure unit tests — no
// spawning. The two invariants required: a novelty voice can NEVER be auto-selected, and the
// machine's system voice is NEVER used silently (resolution returns an explicit voice or null → text).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVoice, isBannedVoice, normalizeVoiceName, parseSayVoices, sanitizeSpeech,
  BANNED_VOICE_NAMES, voiceStyleDefaults, type VoiceInfo,
} from '../src/index.ts';

// A realistic slice of a Mac's `say -v '?'` output, including the single-space padding on long names
// that the old regex choked on, and the full novelty set.
const SAY_OUTPUT = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Bad News            en_US    # Hello! My name is Bad News.',
  'Bubbles             en_US    # Hello! My name is Bubbles.',
  'Daniel              en_GB    # Hello! My name is Daniel.',
  'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
  'Eddy (English (US)) en_US    # Hello! My name is Eddy.',
  'Grandpa (English (UK)) en_GB    # Hello! My name is Grandpa.',
  'Reed (English (UK)) en_GB    # Hello! My name is Reed.',
  'Rocko (English (UK)) en_GB    # Hello! My name is Rocko.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Alex                en_US    # Hello! My name is Alex.',
  'Zarvox              en_US    # Hello! My name is Zarvox.',
  'Rishi               en_IN    # Hello! My name is Rishi.',
  'Jacques             fr_FR    # Bonjour, je m’appelle Jacques.',
].join('\n');

test('parseSayVoices keeps long-name en_GB voices the old regex dropped', () => {
  const vs = parseSayVoices(SAY_OUTPUT);
  const byName = (n: string) => vs.find((v) => v.name === n);
  assert.equal(vs.length, 14);
  assert.deepEqual(byName('Eddy (English (UK))'), { name: 'Eddy (English (UK))', locale: 'en_GB' });
  assert.deepEqual(byName('Daniel'), { name: 'Daniel', locale: 'en_GB' });
  assert.deepEqual(byName('Rocko (English (UK))'), { name: 'Rocko (English (UK))', locale: 'en_GB' });
});

test('normalizeVoiceName strips the locale qualifier', () => {
  assert.equal(normalizeVoiceName('Eddy (English (UK))'), 'eddy');
  assert.equal(normalizeVoiceName('Daniel'), 'daniel');
});

test('isBannedVoice flags the novelty set, not the good voices', () => {
  for (const n of ['Zarvox', 'Bad News', 'Bubbles', 'Albert', 'Whisper', 'Trinoids', 'Organ', 'Fred']) {
    assert.equal(isBannedVoice(n), true, `${n} should be banned`);
  }
  for (const n of ['Daniel', 'Eddy (English (UK))', 'Alex', 'Samantha', 'Oliver']) {
    assert.equal(isBannedVoice(n), false, `${n} should not be banned`);
  }
});

test('default resolves to Eddy (British male, the default pick) when installed', () => {
  const r = resolveVoice({ installed: parseSayVoices(SAY_OUTPUT) });
  assert.equal(r.voice, 'Eddy (English (UK))');
  assert.equal(r.source, 'default');
  assert.match(r.reason, /deep British male/);
});

test('an Enhanced/Premium Daniel is preferred over the plain one', () => {
  const installed: VoiceInfo[] = [
    { name: 'Daniel', locale: 'en_GB' },
    { name: 'Daniel (Enhanced)', locale: 'en_GB' },
  ];
  const r = resolveVoice({ installed });
  assert.equal(r.voice, 'Daniel (Enhanced)');
});

test('a configured voice wins when installed and safe', () => {
  const r = resolveVoice({ configured: 'Alex', installed: parseSayVoices(SAY_OUTPUT) });
  assert.equal(r.voice, 'Alex');
  assert.equal(r.source, 'config');
});

test('a configured NOVELTY voice is refused and falls back to the British male default', () => {
  const r = resolveVoice({ configured: 'Zarvox', installed: parseSayVoices(SAY_OUTPUT) });
  assert.equal(r.voice, 'Eddy (English (UK))');
  assert.notEqual(r.source, 'config');
});

test('a configured but MISSING voice falls back, never errors', () => {
  const r = resolveVoice({ configured: 'Totally Not Installed', installed: parseSayVoices(SAY_OUTPUT) });
  assert.equal(r.voice, 'Eddy (English (UK))');
});

test('falls back to an en_GB British voice when no first-class male is installed', () => {
  const installed: VoiceInfo[] = [
    { name: 'Zarvox', locale: 'en_US' },
    { name: 'Grandpa (English (UK))', locale: 'en_GB' },
    { name: 'Reed (English (UK))', locale: 'en_GB' },
  ];
  const r = resolveVoice({ installed });
  assert.equal(r.voice, 'Grandpa (English (UK))');
  assert.equal(r.source, 'british');
});

test('falls back to a safe English male (Alex) when nothing British is installed', () => {
  const installed: VoiceInfo[] = [
    { name: 'Bad News', locale: 'en_US' },
    { name: 'Alex', locale: 'en_US' },
    { name: 'Samantha', locale: 'en_US' },
  ];
  const r = resolveVoice({ installed });
  assert.equal(r.voice, 'Alex');
  assert.equal(r.source, 'english');
});

test('ONLY novelty voices installed → text-only (null), NEVER the system default', () => {
  const installed: VoiceInfo[] = [
    { name: 'Zarvox', locale: 'en_US' },
    { name: 'Bad News', locale: 'en_US' },
    { name: 'Bubbles', locale: 'en_US' },
  ];
  const r = resolveVoice({ installed });
  assert.equal(r.voice, null);
  assert.equal(r.source, 'none');
});

test('no voices at all → null, never a throw', () => {
  assert.equal(resolveVoice({ installed: [] }).voice, null);
});

// The headline safety property, swept across many installed sets: a resolved voice is NEVER banned.
test('resolveVoice never returns a banned voice, across many installed sets', () => {
  const all = parseSayVoices(SAY_OUTPUT);
  const banned = [...BANNED_VOICE_NAMES];
  // Try every single-voice set, the full set, and banned-only subsets.
  const sets: VoiceInfo[][] = [all, ...all.map((v) => [v]), banned.map((n) => ({ name: n, locale: 'en_US' }))];
  for (const installed of sets) {
    const r = resolveVoice({ installed });
    if (r.voice !== null) assert.equal(isBannedVoice(r.voice), false, `resolved ${r.voice} is banned`);
  }
  // And with a banned configured value too.
  for (const n of banned) {
    const r = resolveVoice({ configured: n, installed: all });
    if (r.voice !== null) assert.equal(isBannedVoice(r.voice), false);
  }
});

// ---- sanitisation

test('sanitizeSpeech defuses say embedded commands so none can execute', () => {
  const out = sanitizeSpeech('nice token [[slnc 5000]] and [[rate 10]] done');
  assert.ok(!/\[\[/.test(out), 'no [[ survives');
  assert.ok(!/\]\]/.test(out), 'no ]] survives');
  assert.match(out, /nice token/);
});

test('sanitizeSpeech neutralises a leading dash', () => {
  assert.equal(sanitizeSpeech('--version is funny').startsWith('-'), false);
});

test('sanitizeSpeech shortens contract addresses instead of reading 44 characters', () => {
  const mint = 'So11111111111111111111111111111111111111112';
  const out = sanitizeSpeech(`buy ${mint} now`);
  assert.ok(!out.includes(mint), 'the full address is not read aloud');
  assert.match(out, /So11…1112/);
});

test('sanitizeSpeech caps length on a word boundary', () => {
  const long = 'word '.repeat(400);
  const out = sanitizeSpeech(long, { maxChars: 100 });
  assert.ok(out.length <= 100);
  assert.ok(!out.endsWith('wor'), 'cuts on a word boundary');
});

test('sanitizeSpeech strips control characters', () => {
  assert.equal(/[\u0000\u001B]/.test(sanitizeSpeech('a\u0000b\u001Bc')), false);
});

test('Eddy (en_GB) is the default when installed; Daniel is the fallback when Eddy is missing', () => {
  const both: VoiceInfo[] = [{ name: 'Daniel', locale: 'en_GB' }, { name: 'Eddy (English (UK))', locale: 'en_GB' }];
  assert.equal(resolveVoice({ installed: both }).voice, 'Eddy (English (UK))');
  assert.equal(resolveVoice({ installed: both }).source, 'default');
  assert.equal(resolveVoice({ installed: [{ name: 'Daniel', locale: 'en_GB' }] }).voice, 'Daniel');
});

test('a non-UK Eddy is NOT chosen as the British default', () => {
  const installed: VoiceInfo[] = [{ name: 'Eddy (English (US))', locale: 'en_US' }, { name: 'Daniel', locale: 'en_GB' }];
  assert.equal(resolveVoice({ installed }).voice, 'Daniel');
});

test('no voice carries a per-voice style override — every voice uses the engine defaults (task-1411)', () => {
  // task-1411: the old Eddy override (rate 168 + pbas 30) was "crazy bad" / "way too slow" and distorted;
  // it is removed. Every voice now speaks at the brisk engine DEFAULT_RATE with no pitch shift.
  assert.equal(voiceStyleDefaults('Eddy (English (UK))'), undefined);
  assert.equal(voiceStyleDefaults('Daniel'), undefined);
  assert.equal(voiceStyleDefaults(null), undefined);
});

// Verifier defect 1 (task-1393): Eddy/Reed/Rocko exist in many languages; a saved FULL name must win.
const MULTI: VoiceInfo[] = [
  { name: 'Eddy (German (Germany))', locale: 'de_DE' },
  { name: 'Eddy (English (UK))', locale: 'en_GB' },
  { name: 'Eddy (English (US))', locale: 'en_US' },
  { name: 'Reed (German (Germany))', locale: 'de_DE' },
  { name: 'Reed (English (UK))', locale: 'en_GB' },
  { name: 'Daniel', locale: 'en_GB' },
];

test('a saved FULL voice name resolves to exactly that voice, not another language with the same base', () => {
  assert.equal(resolveVoice({ configured: 'Eddy (English (UK))', installed: MULTI }).voice, 'Eddy (English (UK))');
  assert.equal(resolveVoice({ configured: 'Reed (English (UK))', installed: MULTI }).voice, 'Reed (English (UK))');
  assert.equal(resolveVoice({ configured: 'Eddy (English (US))', installed: MULTI }).voice, 'Eddy (English (US))');
  assert.equal(resolveVoice({ configured: 'Eddy (English (UK))', installed: MULTI }).source, 'config');
});

test('a bare base name picks en_GB first, then any English, never a foreign-language voice first', () => {
  assert.equal(resolveVoice({ configured: 'Reed', installed: MULTI }).voice, 'Reed (English (UK))');
  assert.equal(resolveVoice({ configured: 'eddy', installed: MULTI }).voice, 'Eddy (English (UK))');
  const noUk = MULTI.filter((v) => v.locale !== 'en_GB');
  assert.equal(resolveVoice({ configured: 'Eddy', installed: noUk }).voice, 'Eddy (English (US))');
});

test('exact-name matching is case-insensitive and still refuses a banned voice', () => {
  assert.equal(resolveVoice({ configured: 'eddy (english (uk))', installed: MULTI }).voice, 'Eddy (English (UK))');
  const r = resolveVoice({ configured: 'Zarvox', installed: [...MULTI, { name: 'Zarvox', locale: 'en_US' }] });
  assert.equal(r.voice, 'Eddy (English (UK))');
  assert.notEqual(r.source, 'config');
});
