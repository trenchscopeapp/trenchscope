// task-1279 hostile-input fuzz, split out of ../hostile.test.ts by task-1424 so its 50 ms per-input budget is
// measured in the serial lane (scripts/test-lane.mjs serial), not beside ~150 parallel test processes. Same
// corpus (../hostile-inputs.ts), same assertions: 0 exceptions, every input under 50 ms (best of five timings,
// as before), no prototype pollution afterwards.
import assert from 'node:assert/strict';
import { parseKeys, type Key, type ScreenKey } from '@dexterm/tui';
import { makeFixtures } from '../../src/fixtures.ts';
import { fromFixture, type ScreenerRow } from '../../src/screener/rows.ts';
import { parseFilter, applyFilter } from '../../src/screener/filter.ts';
import { makeScreenerState, setFilter, openFilterEditor, filterEditorKey, screenerView } from '../../src/screener/view.ts';
import { makeFixtureState, renderFrame } from '../../src/state.ts';
import { applyKey } from '../../src/main.ts';
import { hostileInputs } from '../hostile-inputs.ts';
import { serialLane } from './lane.ts';

const laneTest = serialLane(import.meta.url);
const rows: ScreenerRow[] = makeFixtures(7).tokens.map(fromFixture);
const keys = (s: string): Key[] => parseKeys(s);

/**
 * One hostile string through every path a user can reach: parser, state, editor keystrokes, the
 * key loop, a frame. Returns the milliseconds spent on the filter's own work (parse, apply, state,
 * keystrokes, key loop); building the fixture state and rendering the frame run for exception
 * coverage but are not the input's cost.
 */
function exercise(src: string, counts: { parsedOk: number; rejected: number }): number {
  let ms = 0;
  const timed = (fn: () => void) => { const t0 = performance.now(); fn(); ms += performance.now() - t0; };
  timed(() => {
    const r = parseFilter(src);
    if (r.ok) { counts.parsedOk++; applyFilter(rows, r.filter); }
    else {
      counts.rejected++;
      assert.equal(typeof r.error, 'string');
      assert.ok(r.error.length > 0, 'rejection has a message');
      assert.ok(Number.isInteger(r.at) && r.at >= 1, `rejection has a 1-based column (${r.at})`);
    }
    const sc = makeScreenerState('fixtures', rows);
    setFilter(sc, src);
    screenerView(sc);
    openFilterEditor(sc);
    for (const k of keys(src.slice(0, 220) + '\r')) filterEditorKey(sc, k);
  });
  // the interactive route: '/' + text + enter + esc through applyKey, then a frame
  const state = makeFixtureState({ screen: 'screener' });
  const stack: ScreenKey[] = [];
  timed(() => {
    applyKey(state, keys('/')[0], stack);
    for (const k of keys(src.slice(0, 220) + '\r\x1b')) applyKey(state, k, stack);
  });
  renderFrame(state, 90, 24).toPlain();
  return ms;
}

laneTest('fuzz: ≥ 200 hostile filter strings never throw through parse, state, editor keystrokes and the key loop, each < 50 ms', {}, () => {
  const inputs = hostileInputs();
  assert.ok(inputs.length >= 200, `only ${inputs.length} inputs`);
  const polluted = Object.create(null);
  let exceptions = 0;
  let slow = 0;
  let maxMs = 0;
  let retimed = 0;
  let slowest = '';
  const counts = { parsedOk: 0, rejected: 0 };
  const findings: string[] = [];
  // warm the JIT on benign input so the first hostile strings are not charged for compiling the renderer
  for (const w of ['vol24 > 1M', 'launchpad:pump cat', '']) exercise(w, { parsedOk: 0, rejected: 0 });
  for (const src of inputs) {
    let ms = Infinity;
    // the budget is about the parser's cost, not the scheduler's: an input over 50 ms is re-timed
    // (the full suite runs test files in parallel) and the best of five counts
    for (let attempt = 0; attempt < 5 && ms >= 50; attempt++) {
      if (attempt > 0) retimed++;
      try {
        ms = Math.min(ms, exercise(src, attempt === 0 ? counts : { parsedOk: 0, rejected: 0 }));
      } catch (e) {
        exceptions++;
        findings.push(`${JSON.stringify(src.slice(0, 60))}: ${(e as Error).message}`);
        break;
      }
    }
    if (ms > maxMs) { maxMs = ms; slowest = src; }
    if (ms >= 50) { slow++; findings.push(`${JSON.stringify(src.slice(0, 60))}: ${ms.toFixed(1)} ms`); }
  }
  const { parsedOk, rejected } = counts;
  assert.equal(exceptions, 0, `exceptions:\n${findings.join('\n')}`);
  assert.equal(slow, 0, `slow inputs (max ${maxMs.toFixed(1)} ms):\n${findings.join('\n')}`);
  assert.ok(parsedOk > 0 && rejected > 0, `parsedOk=${parsedOk} rejected=${rejected}`);
  // no prototype pollution
  assert.equal((polluted as { polluted?: unknown }).polluted, undefined);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.equal(({} as { x?: unknown }).x, undefined);
  assert.equal(typeof ({}).toString, 'function');
  process.stdout.write(`  fuzz: ${inputs.length} inputs, ${exceptions} exceptions, ${slow} over 50 ms, max ${maxMs.toFixed(2)} ms for ${JSON.stringify(slowest.length > 40 ? slowest.slice(0, 37) + '…' : slowest)} (${retimed} re-timed), ${parsedOk} parsed, ${rejected} rejected\n`);
});
