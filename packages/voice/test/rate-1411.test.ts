// task-1411 part B: the speaking rate. The old per-voice Eddy override (slow + pitched) is gone, the
// engine default is brisk, and the user can nudge the rate live with < / > — persisted and clamped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController, RATE_MIN, RATE_MAX, RATE_STEP } from '../src/controller.ts';
import { DEFAULT_RATE } from '../src/tts/say.ts';
import { FakeTts } from '../src/tts/fake.ts';

function mk(onRateChange?: (r: number) => void) {
  const tts = new FakeTts();
  const spoken: Array<{ text: string; rate?: number }> = [];
  const orig = tts.speak.bind(tts);
  tts.speak = (text, o = {}) => { spoken.push({ text, rate: o.rate }); return orig(text, o); };
  const c = new VoiceController({ stt: null, tts, onRateChange });
  c.enable();
  return { c, spoken };
}

test('the engine default rate is brisk (>= 200 wpm) and there is no pitch override', () => {
  assert.ok(DEFAULT_RATE >= 200, `DEFAULT_RATE ${DEFAULT_RATE} should be >= 200`);
  const { c, spoken } = mk();
  assert.equal(c.currentRate(), DEFAULT_RATE);
  c.speak('hello there');
  assert.equal(spoken[0].rate, DEFAULT_RATE, 'speaks at the default rate');
});

test('< / > nudge the rate by one step, clamp at the bounds, and persist each change', () => {
  const changes: number[] = [];
  const { c } = mk((r) => changes.push(r));
  const base = c.currentRate();
  c.nudgeRate(1);
  assert.equal(c.currentRate(), base + RATE_STEP, 'faster');
  c.nudgeRate(-1);
  assert.equal(c.currentRate(), base, 'slower, back to base');
  assert.deepEqual(changes, [base + RATE_STEP, base], 'both changes persisted');

  // clamp fast
  for (let i = 0; i < 100; i++) c.nudgeRate(1);
  assert.equal(c.currentRate(), RATE_MAX, 'clamped at RATE_MAX');
  const n = changes.length;
  c.nudgeRate(1); // already at max: no further persist
  assert.equal(changes.length, n, 'no persist when already clamped');

  // clamp slow
  for (let i = 0; i < 100; i++) c.nudgeRate(-1);
  assert.equal(c.currentRate(), RATE_MIN, 'clamped at RATE_MIN');
});

test('a user-saved rate wins over the default', () => {
  const tts = new FakeTts();
  const c = new VoiceController({ stt: null, tts, rate: 150 });
  c.enable();
  assert.equal(c.currentRate(), 150);
});
