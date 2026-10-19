#!/usr/bin/env node
// Draft-text guardrail scan for task-1433. PNG contents are produced from the same strings tested in
// larp-detected-1433.test.ts; this scanner covers every generated Markdown/text sidecar.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] || 'marketing/larp-detected');
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(md|txt)$/i.test(name)) files.push(p);
  }
};
walk(root);

const checks = [
  ['handle', /@[A-Za-z0-9_]{1,15}\b/g],
  ['cashtag', /\$[A-Za-z][A-Za-z0-9_]{1,15}\b/g],
  ['full Solana address', /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g],
  ['price language', /\b(?:price|target|pump|moon|return|profit|gain|loss|alpha|winner|performance)\w*\b/gi],
  ['trade language', /\b(?:buy|sell|entry|exit|ape|long|short)\w*\b/gi],
  ['accusation', /\b(?:scam|fraud|fraudster|thief|criminal)\w*\b/gi],
  // The repository-wide identity ratchet owns the private term list. Keep this standalone scanner
  // generic so the forbidden terms never appear in the app source itself.
  ['machine path', /(?:\/Users\/|\/home\/|\\Users\\)/gi],
];
let hits = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  // Short mints are the guardrail-approved identifier form. Mask them only for semantic word checks so
  // a real suffix such as `pump` is not mistaken for marketing language; address/handle/path checks still
  // inspect the untouched text.
  const semanticText = text.replace(/\b[1-9A-HJ-NP-Za-km-z]{4}\.\.\.[1-9A-HJ-NP-Za-km-z]{4}\b/g, '[identifier]');
  for (const [label, re] of checks) for (const m of (['price language', 'trade language', 'accusation'].includes(label) ? semanticText : text).matchAll(re)) {
    hits++; console.error(`${file}: ${label}: ${m[0]}`);
  }
}
console.log(`larp-detected guardrails: ${hits} hit(s) across ${files.length} draft/report file(s)`);
process.exitCode = hits ? 1 : 0;
