import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTts, SayTts } from '../src/index.ts';

test('FakeTts records spoken text, fires first-audio, and resolves', async () => {
  const tts = new FakeTts();
  let firstAudio = false;
  const h = tts.speak('hello world', { onFirstAudio: () => { firstAudio = true; } });
  await h.done;
  assert.deepEqual(tts.spoken, ['hello world']);
  assert.equal(firstAudio, true);
});

test('FakeTts stop() interrupts and counts the interruption', async () => {
  const tts = new FakeTts();
  const h = tts.speak('a long sentence');
  h.stop();
  await h.done;
  assert.equal(tts.stops, 1);
});

test('SayTts reports unavailable off darwin without spawning', async () => {
  const say = new SayTts();
  if (process.platform !== 'darwin') {
    assert.equal(await say.available(), false);
  } else {
    // On a Mac `say` is present; just assert the call resolves to a boolean and never throws.
    assert.equal(typeof (await say.available()), 'boolean');
  }
});
