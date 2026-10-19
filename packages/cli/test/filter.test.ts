// Filter grammar (SPEC §4.1 row 6, §8 D-03 acceptance): `vol24 > 250K liq > 50K` must select the
// same rows as a hand-written predicate, and bad input must come back as a message with a column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixtures } from '../src/fixtures.ts';
import { fromFixture, type ScreenerRow } from '../src/screener/rows.ts';
import { parseFilter, parseValue, tokenize, applyFilter, FIELDS, fieldSpec } from '../src/screener/filter.ts';

const rows: ScreenerRow[] = makeFixtures(7).tokens.map(fromFixture);

function parsed(src: string) {
  const r = parseFilter(src);
  assert.ok(r.ok, `expected "${src}" to parse, got ${r.ok ? '' : r.error}`);
  return r.filter;
}

function failure(src: string) {
  const r = parseFilter(src);
  assert.ok(!r.ok, `expected "${src}" to fail`);
  return r;
}

test('acceptance: vol24 > 250K liq > 50K selects the same rows as a hand-written predicate', () => {
  const f = parsed('vol24 > 250K liq > 50K');
  const byHand = rows.filter((r) => r.vol24 !== null && r.vol24 > 250_000 && r.liq !== null && r.liq > 50_000);
  assert.ok(byHand.length > 0 && byHand.length < rows.length, `fixture set should split (got ${byHand.length}/${rows.length})`);
  assert.deepEqual(applyFilter(rows, f).map((r) => r.mint), byHand.map((r) => r.mint));
  assert.equal(f.clauses.length, 2);
  assert.deepEqual(f.clauses.map((c) => c.kind === 'cmp' && [c.field.key, c.op, c.value]), [['vol24', '>', 250_000], ['liq', '>', 50_000]]);
  assert.equal(f.text, 'vol24 > 250K  liq > 50K');
});

test('the SPEC example parses: vol24 > 250K liq > 50K age < 30d chain:solana', () => {
  const f = parsed('vol24 > 250K liq > 50K age < 30d chain:solana');
  const byHand = rows.filter((r) => r.vol24! > 250e3 && r.liq! > 50e3 && r.ageMin! < 30 * 1440);
  assert.deepEqual(applyFilter(rows, f), byHand);
  assert.equal(f.clauses[2].kind === 'cmp' && f.clauses[2].value, 30 * 1440);
  assert.equal(f.clauses[3].kind === 'tag' && f.clauses[3].value, 'solana');
});

test('values: $, commas, K/M/B, %, age units, decimals', () => {
  assert.equal(parseValue('$1,250.5K', 'usd'), 1_250_500);
  assert.equal(parseValue('2m', 'usd'), 2e6);
  assert.equal(parseValue('1.5B', 'usd'), 1.5e9);
  assert.equal(parseValue('35%', 'pct'), 35);
  assert.equal(parseValue('-12.5', 'pct'), -12.5);
  assert.equal(parseValue('90s', 'age'), 1.5);
  assert.equal(parseValue('45m', 'age'), 45);
  assert.equal(parseValue('2h', 'age'), 120);
  assert.equal(parseValue('30d', 'age'), 43_200);
  assert.equal(parseValue('1w', 'age'), 10_080);
  assert.equal(parseValue('2mo', 'age'), 86_400);
  assert.equal(parseValue('1000', 'num'), 1000);
  assert.equal(parseValue('0.0001', 'price'), 0.0001);
});

test('operators and field aliases', () => {
  const f = parsed('volume >= 1M  liquidity <= 500K  mc != 0  organic = 55  h == 100');
  assert.deepEqual(f.clauses.map((c) => c.kind === 'cmp' && `${c.field.key}${c.op}${c.value}`), ['vol24>=1000000', 'liq<=500000', 'mcap!=0', 'org=55', 'holders=100']);
  for (const key of FIELDS.map((x) => x.key)) assert.ok(fieldSpec(key), key);
  assert.equal(fieldSpec('5m')?.key, 'm5');
  assert.equal(fieldSpec('24H')?.key, 'h24');
  assert.equal(fieldSpec('nope'), undefined);
});

test('tags: launchpad, flag, verified, sus, negation, and free text', () => {
  const pump = applyFilter(rows, parsed('launchpad:pump'));
  assert.ok(pump.length > 0);
  assert.ok(pump.every((r) => r.launchpad === 'pump.fun'));
  const notPump = applyFilter(rows, parsed('!lp:pump'));
  assert.equal(notPump.length, rows.length - pump.length);
  assert.ok(notPump.every((r) => r.launchpad !== 'pump.fun'));
  const clean = applyFilter(rows, parsed('flag:clean'));
  assert.ok(clean.every((r) => r.flags.length === 0));
  const flagged = applyFilter(rows, parsed('flag:top10'));
  assert.ok(flagged.every((r) => r.flags.includes('TOP10')));
  assert.equal(applyFilter(rows, parsed('verified:yes')).length, 0, 'fixtures are not verified');
  assert.equal(applyFilter(rows, parsed('sus:no')).length, rows.length);
  const cats = applyFilter(rows, parsed('cat'));
  assert.ok(cats.length >= 2);
  assert.ok(cats.every((r) => /cat/i.test(r.symbol + ' ' + r.name)));
  const both = applyFilter(rows, parsed('cat launchpad:pump'));
  assert.ok(both.every((r) => r.launchpad === 'pump.fun' && /cat/i.test(r.symbol + ' ' + r.name)));
});

test('comparisons against missing values are false, in both directions', () => {
  const r = { ...rows[0], holders: null, org: null } as ScreenerRow;
  assert.equal(applyFilter([r], parsed('holders > 0')).length, 0);
  assert.equal(applyFilter([r], parsed('holders < 1B')).length, 0);
  assert.equal(applyFilter([r], parsed('org != 50')).length, 0);
  assert.equal(applyFilter([r], parsed('vol24 > 0')).length, 1, 'present fields still match');
});

test('empty and whitespace-only filters keep every row', () => {
  assert.equal(parsed('').clauses.length, 0);
  assert.equal(applyFilter(rows, parsed('   ')).length, rows.length);
  assert.equal(applyFilter(rows, null).length, rows.length);
});

test('error messages name the problem and the column', () => {
  const cases: Array<[src: string, pattern: RegExp, at: number]> = [
    ['vol24 >', /needs a value/, 8],
    ['> 100', /has no field in front/, 1],
    ['foo > 1', /unknown field "foo"/, 1],
    ['liq > 50K age < 30', /needs an age unit/, 17],
    ['liq > 50X', /unknown unit "x"/, 7],
    ['vol24 > abc', /bad number "abc"/, 9],
    ['top10 > 10pc', /unknown suffix "pc"/, 9],
    ['chain:eth', /solana only/, 1],
    ['launchpad:moon', /unknown launchpad "moon"/, 1],
    ['flag:bogus', /unknown flag "bogus"/, 1],
    ['verified:maybe', /takes yes or no/, 1],
    ['color:red', /unknown tag "color:"/, 1],
    [':x', /has no tag in front/, 1],
    ['!cat', /must be followed by a tag/, 1],
    ['launchpad:', /needs a value/, 1],
    ['liq > 50K vol24 >', /needs a value/, 18],
  ];
  for (const [src, pattern, at] of cases) {
    const r = failure(src);
    assert.match(r.error, pattern, src);
    assert.equal(r.at, at, `${src}: column`);
  }
});

test('tokenizer keeps column numbers (1-based) through whitespace runs', () => {
  const toks = tokenize('  vol24   >  250K');
  assert.deepEqual(toks.map((t) => [t.kind, t.text, t.at]), [['word', 'vol24', 3], ['op', '>', 11], ['word', '250K', 14]]);
});

test('filter text is normalised for display but keeps the typed units', () => {
  assert.equal(parsed('  VOL   >=   $2M   lp:pump  !flag:mint  ').text, 'vol24 >= $2M  launchpad:pump.fun  !flag:MINT');
});
