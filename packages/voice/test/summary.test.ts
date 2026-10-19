import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenSummary, splitSentences } from '../src/index.ts';

test('splitSentences handles ., !, ? and a trailing fragment', () => {
  assert.deepEqual(splitSentences('One. Two! Three? four'), ['One.', 'Two!', 'Three?', 'four']);
  assert.deepEqual(splitSentences('  '), []);
});

test('spokenSummary speaks the verdict first, then the whole answer (maxSentences can still limit it)', () => {
  const all = spokenSummary({ verdict: 'AVOID', summary: ['Liquidity is thin.', 'Top holder owns 40%.', 'Dev wallet still active.'] });
  assert.ok(all.includes('Dev wallet still active.'), 'the whole answer is spoken by default');
  const s = spokenSummary({ verdict: 'AVOID', summary: ['Liquidity is thin.', 'Top holder owns 40%.', 'Dev wallet still active.'] }, 2);
  assert.match(s, /^Verdict: AVOID\./);
  assert.ok(s.includes('Liquidity is thin.'));
  assert.ok(s.includes('Top holder owns 40%.'));
  assert.ok(!s.includes('Dev wallet still active.'), 'only the first two body sentences are spoken');
});

test('spokenSummary falls back to free prose when there is no summary array', () => {
  const s = spokenSummary({ text: 'This token launched four minutes ago. It has decent volume. Watch the next candle.' }, 2);
  assert.equal(s, 'This token launched four minutes ago. It has decent volume.');
});

test('spokenSummary strips markdown and urls so they are not read aloud', () => {
  const s = spokenSummary({ text: 'See **BONK** at https://example.com/x for details.' });
  assert.ok(!s.includes('*'));
  assert.ok(!s.includes('http'));
  assert.ok(s.includes('a link'));
});

test('spokenSummary caps length so say starts promptly', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the token and its liquidity profile.`).join(' ');
  const s = spokenSummary({ text: long }, 40);
  assert.ok(s.length <= 1802, `expected a capped length, got ${s.length}`);
});
