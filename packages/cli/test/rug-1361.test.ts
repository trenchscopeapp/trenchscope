// task-1361: the screener's p(rug) column — the H2-v0.1 heuristic (H1 before trenchscope) scored from the row, labelled as a model
// output (model id in the panel caption and the sort menu, data age in the spotlight), dashed when nothing
// is scoreable, sortable safest-first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h2Score, H2_VERSION } from '@dexterm/packs';
import { THEMES, Canvas } from '@dexterm/tui';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import { screenerColumns, spotlight } from '../src/screens/screener.ts';
import { skeletonRows, type ScreenerRow } from '../src/screener/rows.ts';
import { RUG_MODEL_LABEL, fmtRugP, rugDataAge, rugFeaturesFromRow, rugP } from '../src/screener/rug.ts';
import { SORT_KEYS, parseSortArg, sortRows } from '../src/screener/sort.ts';

const t = THEMES.cyberspace;

test('rugP: the H2-v0.1 heuristic over the row fields; null for a skeleton or a row with nothing to score', () => {
  const s = makeFixtureState({ screen: 'screener' });
  const row = s.screener.rows[0]!;
  const p = rugP(row)!;
  assert.ok(p !== null && p >= 0.02 && p <= 0.98);
  assert.equal(p, h2Score(rugFeaturesFromRow(row)), 'exactly the model scorer, no screener-side tweak');
  assert.equal(RUG_MODEL_LABEL, `${H2_VERSION} heuristic`, 'the label says heuristic, never "model" alone');
  const f = rugFeaturesFromRow(row);
  assert.equal(f.age_sec, row.ageMin === null ? null : row.ageMin * 60);
  assert.equal(f.has_pool, row.liq === null ? null : row.liq > 0);
  assert.equal(f.is_verified, null, 'the heuristic does not use verification; never invent it');
  assert.equal(rugP(skeletonRows(1)[0]!), null);
  const blank: ScreenerRow = { ...row, liq: null, mcap: null, ageMin: null, mintAuth: null, freezeAuth: null };
  assert.equal(rugP(blank), null, 'no liquidity/cap/age/audit at all: nothing to score');
  // the heuristic moves the way its points say: a frozen, mintable, fresh, dry token scores far above an established one
  const bad: ScreenerRow = { ...row, liq: 1000, mcap: 2_000_000, ageMin: 5, mintAuth: true, freezeAuth: true, top10: 60, dev: 20, org: 2, holders: 10 };
  const good: ScreenerRow = { ...row, liq: 500_000, mcap: 5_000_000, ageMin: 30 * 24 * 60, mintAuth: false, freezeAuth: false, top10: 12, dev: 1, org: 85, holders: 5000 };
  assert.equal(rugP(bad), 0.98);
  assert.equal(rugP(good), 0.02);
  assert.equal(fmtRugP(0.4567), '0.46');
  assert.equal(rugDataAge({ fetchedAt: null }, 1_000_000), null);
  assert.equal(rugDataAge({ fetchedAt: 1_000_000 - 42_000 }, 1_000_000), '42s');
  assert.equal(rugDataAge({ fetchedAt: 1_000_000 - 4 * 60_000 }, 1_000_000), '4m');
  assert.equal(rugDataAge({ fetchedAt: 1_000_000 - 3 * 3_600_000 }, 1_000_000), '3h');
});

test('P(RUG) column: two decimals, dashed when unscoreable, colour by the model threshold', () => {
  const s = makeFixtureState({ screen: 'screener' });
  const row = s.screener.rows[0]!;
  const cell = (r: ScreenerRow): string => {
    const cv = new Canvas(6, 1, t);
    const col = screenerColumns(cv, 'wide', null, null).find((c) => c.key === 'rug')!;
    assert.equal(col.label, 'P(RUG)');
    col.render(cv, 0, 0, 6, r, t.bg, { index: 0 } as never);
    return cv.toPlain().trim();
  };
  assert.equal(cell(row), fmtRugP(rugP(row)!));
  assert.equal(cell(skeletonRows(1)[0]!), '—');
  assert.equal(cell({ ...row, liq: 1000, mcap: 2_000_000, ageMin: 5, mintAuth: true, freezeAuth: true, top10: 60, dev: 20, org: 2, holders: 10 }), '0.98');
});

test('the screener names the model: panel caption and sort menu; the spotlight adds the data age', () => {
  const s = makeFixtureState({ screen: 'screener', selected: 0, calm: true }); // calm: no boot glitch over the frame
  const frame = renderFrame(s, 176, 48).toPlain();
  // at 176 columns with the spotlight the table sheds the prio-3 columns (FLAGS and P(RUG) alike), so the model is
  // still named by the caption and the spotlight; the column itself appears on a wider frame
  assert.match(frame, /p\(rug\) = H2-v0\.1 heuristic/, 'the caption names the model');
  assert.match(frame, /p\(rug\) \d\.\d\d · H2-v0\.1 heuristic/, 'the spotlight line');
  // the default (flat) theme draws the score as a RISK gauge; the neon themes keep the numeric P(RUG) column
  const wideFlat = renderFrame(makeFixtureState({ screen: 'screener', selected: 0, calm: true }), 240, 48).toPlain();
  assert.match(wideFlat, / RISK /, 'the RISK gauge header on the default theme');
  assert.match(wideFlat, /[▮▯]{5}/, 'a five-step gauge per row');
  const wide = renderFrame(makeFixtureState({ screen: 'screener', selected: 0, calm: true, theme: THEMES.cyberspace }), 240, 48).toPlain();
  assert.match(wide, /P\(RUG\)/, 'the column header on a wide frame');
  assert.match(wide, /FLAGS/, 'alongside FLAGS, the other prio-3 column');
  // the column shows the same two-decimal value the spotlight prints for the selected row
  const spotP = /p\(rug\) (\d\.\d\d) · H2/.exec(wide)![1];
  assert.match(wide, new RegExp(`\\b${spotP.replace('.', '\\.')}\\b`), 'the selected row carries the value in its cell');
  // the spotlight with a fetch time prints how old the scored data is
  const row = { ...s.screener.rows[0]!, fetchedAt: Date.parse('2026-10-12T08:00:00Z') - 42_000 };
  const cv = new Canvas(44, 46, t);
  spotlight(cv, 0, 0, 44, 46, row, null, null, Date.parse('2026-10-12T08:00:00Z'));
  assert.match(cv.toPlain(), /p\(rug\) \d\.\d\d · H2-v0\.1 heuristic[\s\S]*model output · data 42s old/);
  const cv2 = new Canvas(44, 46, t);
  spotlight(cv2, 0, 0, 44, 46, { ...row, liq: null, mcap: null, ageMin: null, mintAuth: null, freezeAuth: null }, null, null, Date.parse('2026-10-12T08:00:00Z'));
  assert.match(cv2.toPlain(), /p\(rug\) — · H2-v0\.1 heuristic[\s\S]*model output · no data to score/);
  // sort: `rug` is a key, safest first by default, nulls last either way
  const spec = SORT_KEYS.find((k) => k.key === 'rug')!;
  assert.equal(spec.defaultDir, 'asc');
  assert.match(spec.label, /H2-v0\.1 heuristic/);
  assert.deepEqual(parseSortArg('rug'), { key: 'rug', dir: 'asc' });
  const rows: ScreenerRow[] = [
    { ...s.screener.rows[0]!, mint: 'A', liq: 1000, mcap: 2_000_000, ageMin: 5, mintAuth: true, freezeAuth: true, top10: 60, dev: 20, org: 2, holders: 10 },
    { ...s.screener.rows[0]!, mint: 'B', liq: 500_000, mcap: 5_000_000, ageMin: 30 * 24 * 60, mintAuth: false, freezeAuth: false, top10: 12, dev: 1, org: 85, holders: 5000 },
    { ...s.screener.rows[0]!, mint: 'C', liq: null, mcap: null, ageMin: null, mintAuth: null, freezeAuth: null },
  ];
  assert.deepEqual(sortRows(rows, 'rug', 'asc').map((r) => r.mint), ['B', 'A', 'C']);
  assert.deepEqual(sortRows(rows, 'rug', 'desc').map((r) => r.mint), ['A', 'B', 'C']);
});
