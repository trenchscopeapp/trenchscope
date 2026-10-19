// Hostile input (task-1279 verification fix): names that live on Object.prototype must be ordinary
// unknown tags / values / fields / sort keys / presets, never inherited lookups, and no filter string
// may throw anywhere between the parser and the interactive key loop. The fuzz that keeps that property
// (≥ 200 hostile strings through parse → state → editor keystrokes, 0 exceptions, each under 50 ms, no
// prototype pollution afterwards) has a wall-clock budget, so it runs in the serial lane:
// serial/hostile-fuzz.test.ts (task-1424).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys, type Key, type ScreenKey } from '@dexterm/tui';
import { makeFixtures } from '../src/fixtures.ts';
import { fromFixture, type ScreenerRow } from '../src/screener/rows.ts';
import { parseFilter, parseValue, applyFilter, fieldSpec, clausePredicate, type Clause } from '../src/screener/filter.ts';
import { parseSortArg, sortSpec, sortRows } from '../src/screener/sort.ts';
import { presetSpec } from '../src/screener/presets.ts';
import { makeScreenerState, setSort, screenerView } from '../src/screener/view.ts';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import { applyKey, parseArgs, stateFromArgs } from '../src/main.ts';
import { PROTO_NAMES } from './hostile-inputs.ts';

const rows: ScreenerRow[] = makeFixtures(7).tokens.map(fromFixture);
const keys = (s: string): Key[] => parseKeys(s);


test('prototype-named tags are unknown tags, with the normal grammar error and column', () => {
  for (const name of PROTO_NAMES) {
    for (const src of [`${name}:yes`, `${name}:true`, `!${name}:no`, `  ${name}:1`]) {
      const r = parseFilter(src);
      assert.ok(!r.ok, `${src} must not parse`);
      assert.match(r.error, new RegExp(`unknown tag "${name}:"`), src);
      assert.equal(r.at, src.indexOf(name) + 1, `${src}: column`);
    }
  }
});

test('prototype-named launchpads, flags and yes/no words are rejected, not silently empty', () => {
  for (const name of PROTO_NAMES) {
    const lp = parseFilter(`launchpad:${name}`);
    assert.ok(!lp.ok && /unknown launchpad/.test(lp.error), `launchpad:${name} → ${lp.ok ? 'parsed' : lp.error}`);
    const lp2 = parseFilter(`lp:${name}`);
    assert.ok(!lp2.ok && /unknown launchpad/.test(lp2.error), `lp:${name}`);
    const fl = parseFilter(`flag:${name}`);
    assert.ok(!fl.ok && /unknown flag/.test(fl.error), `flag:${name} → ${fl.ok ? 'parsed' : fl.error}`);
    const v = parseFilter(`verified:${name}`);
    assert.ok(!v.ok && /takes yes or no/.test(v.error), `verified:${name}`);
    const s = parseFilter(`!sus:${name}`);
    assert.ok(!s.ok && /takes yes or no/.test(s.error), `!sus:${name}`);
    const ch = parseFilter(`chain:${name}`);
    assert.ok(!ch.ok && /solana only/.test(ch.error), `chain:${name}`);
  }
});

test('prototype-named fields and units are unknown; values never become NaN through an inherited unit', () => {
  for (const name of PROTO_NAMES) {
    assert.equal(fieldSpec(name), undefined, name);
    const f = parseFilter(`${name} > 1`);
    assert.ok(!f.ok && /unknown field/.test(f.error), `${name} > 1`);
    const unit = name.toLowerCase();
    if (/^[a-z]+$/.test(unit)) {
      for (const kind of ['usd', 'num', 'price'] as const) {
        const v = parseValue(`1${unit}`, kind);
        assert.equal(typeof v, 'string', `1${unit} as ${kind} must be an error, got ${String(v)}`);
        assert.match(v as string, /unknown unit/);
      }
      const a = parseValue(`1${unit}`, 'age');
      assert.equal(typeof a, 'string', `1${unit} as age`);
      assert.match(a as string, /unknown age unit/);
    }
  }
  // real units still work after the own-property change
  assert.equal(parseValue('2K', 'usd'), 2000);
  assert.equal(parseValue('3d', 'age'), 3 * 1440);
});

test('a hand-built clause with a tag the parser never emits matches nothing instead of throwing', () => {
  const c = { kind: 'tag', tag: '__proto__', value: 'yes', not: false, raw: '__proto__:yes' } as unknown as Clause;
  assert.equal(applyFilter(rows, { text: '', clauses: [c], predicate: clausePredicate(c) }).length, 0);
  const n = { ...c, not: true } as unknown as Clause;
  assert.equal(applyFilter(rows, { text: '', clauses: [n], predicate: clausePredicate(n) }).length, rows.length);
});

test('prototype-named sort keys and presets are unknown on the CLI and inert on the state', () => {
  for (const name of PROTO_NAMES) {
    assert.equal(sortSpec(name), undefined, name);
    assert.throws(() => parseSortArg(name), /unknown sort key/, name);
    assert.throws(() => parseSortArg(`${name}:asc`), /unknown sort key/, name);
    assert.throws(() => parseArgs(['--sort', name]), /unknown sort key/, name);
    assert.equal(presetSpec(name), undefined, name);
    assert.throws(() => parseArgs(['--preset', name]), /unknown preset/, name);
    assert.throws(() => parseArgs(['--filter', `${name}:yes`]), /unknown tag/, name);
    assert.throws(() => stateFromArgs(parseArgs(['--fixtures', '--theme', name])), /unknown theme/, name);
    assert.deepEqual(sortRows(rows, name, 'desc').map((r) => r.mint), rows.map((r) => r.mint), 'unknown sort key keeps the order');
    const sc = makeScreenerState('fixtures', rows);
    setSort(sc, name, 'asc');
    assert.deepEqual(sc.sort, { key: 'vol', dir: 'desc' }, `setSort(${name}) is a no-op`);
  }
});

test('TUI path: / then __proto__:yes then enter keeps the editor open with the grammar error, never throws', () => {
  for (const src of ['__proto__:yes', 'constructor:true', '!__proto__:no', 'launchpad:constructor', 'flag:constructor', 'liq > 1constructor']) {
    const state = makeFixtureState({ screen: 'screener', selected: 5 });
    const stack: ScreenKey[] = [];
    applyKey(state, keys('/')[0], stack);
    for (const k of keys(`${src}\r`)) applyKey(state, k, stack);
    assert.equal(state.screener.mode, 'filter', `${src}: editor stays open`);
    assert.ok(state.screener.edit.error, `${src}: error shown`);
    assert.equal(state.screener.filter, null, `${src}: nothing applied`);
    assert.equal(screenerView(state.screener).length, rows.length);
    const plain = renderFrame(state, 120, 30).toPlain();
    assert.match(plain, /✗ unknown/, `${src}: frame shows the error`);
    // esc leaves the editor, q still quits
    applyKey(state, keys('\x1b')[0], stack);
    assert.equal(state.screener.mode, 'table');
    assert.equal(applyKey(state, keys('q')[0], stack), 'quit');
  }
});
