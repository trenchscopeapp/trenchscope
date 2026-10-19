// Readability gate (VISUAL-V2 §6.4), ported from prototype-v2/tools/contrast.mjs: WCAG contrast of every
// numeric cell against its own background must be ≥ 4.5:1 with effects ON, at a glitch frame, on all
// five screens at 176/120/90 plus the boot screen and the pump moment. The report tool
// (packages/cli/tools/contrast.mjs) prints the same table with min / p05 / median per case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, THEMES } from '@dexterm/tui';
import { makeFixtureState, renderFrame, auditContrast, CONTRAST_CASES, isDigit } from '../src/index.ts';

test('every numeric cell is at least 4.5:1 against its own background with effects on (all screens, three widths, boot, pump)', () => {
  let worstNumeric = Infinity;
  for (const cs of CONTRAST_CASES) {
    const row = auditContrast(cs);
    assert.ok(row.hardCells > 100, `${row.screen} ${row.size}: ${row.hardCells} hard cells`);
    const failing = row.worst.filter((w) => isDigit(w.ch));
    assert.equal(failing.length, 0, `${row.screen} ${row.size} ${row.event}: numeric cells below 4.5:1 → ${failing.map((w) => `'${w.ch}'@${w.x},${w.y} ${w.fg}/${w.bg} ${w.r}`).join(' · ')}`);
    assert.ok((row.numericMin ?? 99) >= 4.5, `${row.screen} ${row.size}: numeric min ${row.numericMin}`);
    assert.ok((row.numericMedian ?? 0) >= 7, `${row.screen} ${row.size}: numeric median ${row.numericMedian}`);
    worstNumeric = Math.min(worstNumeric, row.numericMin ?? Infinity);
  }
  assert.ok(worstNumeric >= 4.5);
});

test('non-numeric hard cells below 4.5:1 are limited to launchpad badge letters under a datamosh tint', () => {
  for (const cs of CONTRAST_CASES) {
    const row = auditContrast(cs);
    for (const w of row.worst) {
      assert.ok(!isDigit(w.ch));
      assert.ok(w.r >= 3.0, `${row.screen} ${row.size}: '${w.ch}' at ${w.x},${w.y} is ${w.r}:1`);
    }
    assert.ok(row.below <= 12, `${row.screen} ${row.size}: ${row.below} cells below the gate`);
  }
});

// The v1 themes were never audited (midnight's `dim` on its selected row is 2.1:1, pre-existing); the gate is the cyberspace look.
test('the calm cyberspace render clears the gate on every screen (scanlines must not be what makes a cell pass)', () => {
  for (const screen of ['screener', 'token', 'newpairs', 'watchlist', 'analyst'] as const) {
    const c = renderFrame(makeFixtureState({ screen, theme: THEMES.cyberspace, calm: true, selected: 3 }), 176, 48);
    let worst = Infinity;
    for (let i = 0; i < c.ch.length; i++) if (c.hard[i] && isDigit(c.ch[i])) worst = Math.min(worst, contrast(c.fg[i], c.bg[i]));
    assert.ok(worst >= 4.5, `cyberspace/${screen}: numeric min ${worst.toFixed(2)}`);
  }
});
