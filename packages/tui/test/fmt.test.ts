import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtNum, fmtAmount, fmtPrice, fmtPriceBare, fmtPct, fmtAge, fmtAgeSec, shortAddr, pad, clamp, clock, wrap } from '../src/index.ts';

test('fmtUsd compacts with B/M/K', () => {
  assert.equal(fmtUsd(1.5e9), '$1.50B');
  assert.equal(fmtUsd(2.25e6, { digits: 1 }), '$2.3M');
  assert.equal(fmtUsd(340_000), '$340.0K');
  assert.equal(fmtUsd(340_000, { digits: 0 }), '$340K');
  assert.equal(fmtUsd(12.4), '$12');
  assert.equal(fmtUsd(-5000, { digits: 1 }), '-$5K', 'K drops decimals unless digits > 1');
  assert.equal(fmtUsd(-5000), '-$5.0K');
  assert.equal(fmtUsd(null), '—');
  assert.equal(fmtUsd(NaN), '—');
});

test('fmtNum compacts counts', () => {
  assert.equal(fmtNum(999), '999');
  assert.equal(fmtNum(1234), '1.23K');
  assert.equal(fmtNum(12345), '12.3K');
  assert.equal(fmtNum(2.5e6), '2.50M');
  assert.equal(fmtNum(null), '—');
});

test('fmtPrice compresses leading zeros with subscripts', () => {
  assert.equal(fmtPrice(1234), '$1,234');
  assert.equal(fmtPrice(123.456), '$123.46');
  assert.equal(fmtPrice(1.23456), '$1.235');
  assert.equal(fmtPrice(0.0123), '$0.0123');
  assert.equal(fmtPrice(0.00123), '$0.00123');
  assert.equal(fmtPrice(0.00002749), '$0.0₄2749');
  assert.equal(fmtPrice(0.000000012), '$0.0₇12');
  assert.equal(fmtPrice(1.2e-9), '$0.0₈12');
  assert.equal(fmtPrice(null), '—');
});

test('fmtPriceBare is fmtPrice with no currency symbol (task-1310: SOL-per-token prices carry no $)', () => {
  // Same magnitude/compression as fmtPrice, but never a '$' — the unit (e.g. SOL) is written separately.
  for (const p of [1234, 123.456, 1.23456, 0.0123, 0.00123, 0.00002749, 0.000000012, 1.2e-9]) {
    assert.equal(fmtPriceBare(p), fmtPrice(p).replace('$', ''), `bare == price minus $ for ${p}`);
    assert.ok(!fmtPriceBare(p).includes('$'), `no dollar sign for ${p}`);
  }
  // The exact bug the finding describes: a SOL-per-token price rendered as a SOL amount.
  assert.equal(`${fmtPriceBare(0.00002749)} SOL`, '0.0₄2749 SOL');
  assert.equal(fmtPriceBare(null), '—');
});

test('fmtPct signs and pads zero', () => {
  assert.equal(fmtPct(12.34), '+12.3%');
  assert.equal(fmtPct(-0.5), '-0.5%');
  assert.equal(fmtPct(0), ' 0.0%');
  assert.equal(fmtPct(1234.5), '+1235%');
  assert.equal(fmtPct(12.34, { sign: false }), '12.3%');
  assert.equal(fmtPct(null), '—');
});

test('fmtAge / fmtAgeSec follow SPEC §7.6', () => {
  assert.equal(fmtAge(0.5), '30s');
  assert.equal(fmtAge(3), '3m');
  assert.equal(fmtAge(170), '2.8h');
  assert.equal(fmtAge(720), '12h');
  assert.equal(fmtAge(1440 * 6), '6d');
  assert.equal(fmtAge(43200), '1mo');
  assert.equal(fmtAgeSec(45), '45s');
  assert.equal(fmtAgeSec(180), '3m');
});

test('shortAddr, pad, clamp', () => {
  assert.equal(shortAddr('7xKpABCDEFGHIJKLMNq3Lm', 4), '7xKp…q3Lm');
  assert.equal(shortAddr(''), '');
  assert.equal(pad('ab', 4), 'ab  ');
  assert.equal(pad('ab', 4, 'right'), '  ab');
  assert.equal(pad('abcdef', 4), 'abcd');
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
});

test('clock pins to a zone when asked', () => {
  const d = new Date(Date.UTC(2026, 9, 5, 23, 4, 11));
  assert.equal(clock(d, 'America/New_York'), '19:04:11');
  assert.equal(clock(d, 'UTC'), '23:04:11');
  assert.match(clock(d), /^\d\d:\d\d:\d\d$/);
});

test('wrap breaks on spaces', () => {
  assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
  assert.deepEqual(wrap('one', 10), ['one']);
  // prototype quirk kept for parity: an over-long first word yields a leading empty line
  assert.deepEqual(wrap('supercalifragilistic word', 5), ['', 'supercalifragilistic', 'word']);
});

test('fmtAmount (task-1368): token quantities keep small amounts — a $4.33 buy of a $300 token is 0.0144, never 0', () => {
  assert.equal(fmtAmount(0.0144), '0.0144');
  assert.equal(fmtAmount(1_440_000 / 1e8), '0.0144', 'raw outAmount 1440000 at 8 decimals');
  assert.equal(fmtAmount(0.5), '0.5');
  assert.equal(fmtAmount(0.00001234), '0.0₄1234', 'subscript zeros below 0.01');
  assert.equal(fmtAmount(2.5), '2.5');
  assert.equal(fmtAmount(12.34567), '12.3457');
  assert.equal(fmtAmount(1234.5), '1234.5');
  assert.equal(fmtAmount(9999.999), '10000', 'rounds at 2 dp in the thousands');
  assert.equal(fmtAmount(15_000), '15.0K');
  assert.equal(fmtAmount(2.5e6), '2.50M');
  assert.equal(fmtAmount(0), '0');
  assert.equal(fmtAmount(-0.0144), '-0.0144');
  assert.equal(fmtAmount(null), '—');
  assert.equal(fmtAmount(NaN), '—');
  assert.equal(fmtNum(0.0144), '0', 'the old formatter still rounds counts: it is for counts, not quantities');
});
