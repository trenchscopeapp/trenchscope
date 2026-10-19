#!/usr/bin/env node
// Readability report (VISUAL-V2 §6.4): WCAG contrast of every data cell (hard mask) against its own
// background, per screen, at 176/120/90, with effects ON at a busy frame. Prints min / p05 / median and
// the worst cells; exit 1 when any numeric cell is below the threshold (the same rule the test enforces).
//   node packages/cli/tools/contrast.mjs [--theme cyberspace] [--min 4.5] [--json out.json]
import { writeFileSync } from 'node:fs';
import { auditContrast, CONTRAST_CASES, isDigit } from '../src/index.ts';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const theme = opt('--theme', 'cyberspace');
const MIN = Number(opt('--min', '4.5'));
const jsonOut = opt('--json', null);

const rows = CONTRAST_CASES.map((cs) => auditContrast(cs, MIN, theme));
let worstOverall = Infinity;
let failures = 0;
for (const r of rows) {
  worstOverall = Math.min(worstOverall, r.numericMin ?? Infinity);
  failures += r.worst.filter((w) => isDigit(w.ch)).length;
}
const pad = (s, n, right) => (right ? String(s).padStart(n) : String(s).padEnd(n));
console.log(`theme ${theme} · threshold ${MIN}:1 · hard cells = digits, letters, $ % ▲ ▼ (effects ON)`);
console.log(pad('screen', 10) + pad('size', 9) + pad('event', 9) + pad('cells', 7, 1) + pad('min', 7, 1) + pad('p05', 7, 1) + pad('median', 8, 1) + pad('num min', 9, 1) + pad('num med', 9, 1) + pad('<min', 6, 1));
for (const r of rows) console.log(pad(r.screen, 10) + pad(r.size, 9) + pad(r.event, 9) + pad(r.hardCells, 7, 1) + pad(r.min, 7, 1) + pad(r.p05, 7, 1) + pad(r.median, 8, 1) + pad(r.numericMin ?? '-', 9, 1) + pad(r.numericMedian ?? '-', 9, 1) + pad(r.below, 6, 1));
for (const r of rows) if (r.worst.length) console.log(`  ${r.screen} ${r.size}: ` + r.worst.map((w) => `'${w.ch}'@${w.x},${w.y} ${w.fg}/${w.bg} ${w.r}`).join(' · '));
console.log(`numeric cells below ${MIN}:1 → ${failures}; worst numeric ratio ${worstOverall.toFixed(2)}:1`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ theme, min: MIN, rows }, null, 2) + '\n');
process.exit(failures ? 1 : 0);
