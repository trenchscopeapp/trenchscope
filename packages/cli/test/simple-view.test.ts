// trenchscope simple split view: the plain-English verdict and the five-key layout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verdictFor, riskWord } from '../src/screens/simple.ts';
import { makeFixtureState, renderFrame, parseArgs, stateFromArgs } from '../src/index.ts';
import type { ScreenerRow } from '../src/screener/rows.ts';

function row(o: Partial<ScreenerRow>): ScreenerRow {
  const s = makeFixtureState({ screen: 'screener' });
  return { ...s.screener.rows[0]!, mintAuth: false, freezeAuth: false, top10: 12, dev: 0.5, bundled: null, lpLocked: 100, liq: 500_000, mcap: 5_000_000, ageMin: 3000, flags: [], chg: { m5: 0, h1: 0, h6: 0, h24: 5 }, ...o };
}

test('verdict: hard red flags say AVOID, soft ones CAREFUL, nothing bad says NO RED FLAGS (never "safe")', () => {
  assert.equal(verdictFor(row({ flags: ['DEAD'], liq: 7000, mcap: 9000, chg: { m5: 0, h1: 0, h6: 0, h24: -78 } })).word, 'AVOID');
  assert.equal(verdictFor(row({ mintAuth: true, flags: ['MINT'] })).word, 'AVOID');
  assert.equal(verdictFor(row({ top10: 48, flags: ['TOP10'] })).word, 'CAREFUL');
  const ok = verdictFor(row({}));
  assert.equal(ok.word, 'NO RED FLAGS');
  assert.ok(ok.reasons.every((r) => r.mark !== '✗'));
  assert.equal(riskWord(row({})), 'low');
});

test('verdict: a LARP result is a hard flag; a no-product meme is a neutral note', () => {
  assert.equal(verdictFor(row({}), 'LARP').word, 'AVOID');
  const meme = verdictFor(row({}), 'NO_PRODUCT_CLAIMED');
  assert.equal(meme.word, 'NO RED FLAGS');
  assert.ok(meme.reasons.some((r) => r.mark === '◐' && /meme/.test(r.text)));
});

test('verdict: unknown checks are listed as unknown, red flags come first', () => {
  const v = verdictFor(row({ dev: null, top10: null, liq: 7000 }));
  assert.equal(v.reasons[0].mark, '✗');
  assert.ok(v.reasons.some((r) => r.mark === '◐' && /dev holding unknown/.test(r.text)));
  assert.ok(v.reasons.some((r) => r.mark === '◐' && /holder spread unknown/.test(r.text)));
});

test('the interactive app opens simple; one-shots stay on the full table unless --simple; f toggles', () => {
  assert.equal(stateFromArgs(parseArgs(['--fixtures'])).simple, true);
  assert.equal(stateFromArgs(parseArgs(['--fixtures', '--screen', 'screener'])).simple, false);
  assert.equal(stateFromArgs(parseArgs(['--fixtures', '--screen', 'screener', '--simple'])).simple, true);
  const s = makeFixtureState({ screen: 'screener' });
  s.simple = true;
  const plain = renderFrame(s, 120, 36).toPlain();
  assert.match(plain, /trending now/);
  assert.match(plain, /COIN\s+MCAP\s+24H\s+RISK/);
  assert.match(plain, /(AVOID|CAREFUL|NO RED FLAGS)/);
  assert.match(plain, /move.*open coin.*search.*ask AI.*full table.*quit/);
  assert.match(plain, /1 Screener.*2 New pairs/, 'the simple view keeps the tab bar, like the full table and the site');
  assert.match(plain, /╭─ TRENDING /, 'the list sits in a titled panel');
  assert.match(plain, /SAFETY VERDICT/);
});
