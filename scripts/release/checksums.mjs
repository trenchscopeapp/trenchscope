#!/usr/bin/env node
// SHA256SUMS for a release directory (scripts/release/checksums.mjs). Zero dependencies.
//
//   node scripts/release/checksums.mjs <dir>            write <dir>/SHA256SUMS over every file except itself,
//                                                       build-info.json and scan-results.json (which embed hashes)
//   node scripts/release/checksums.mjs <dir> --verify   re-hash and compare; exit 1 on any mismatch
//
// Format is the GNU coreutils one (`<hex>  <name>`), so users verify with
//   shasum -a 256 -c SHA256SUMS --ignore-missing     (macOS)   or   sha256sum -c SHA256SUMS --ignore-missing (Linux)

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || '.');
const verify = process.argv.includes('--verify');
const SKIP = new Set(['SHA256SUMS', 'build-info.json', 'scan-results.json']);
const files = readdirSync(dir).filter((f) => !SKIP.has(f) && statSync(join(dir, f)).isFile()).sort();
const lines = files.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`);

if (verify) {
  const want = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const have = new Set(lines);
  let bad = 0;
  for (const w of want) { const ok = have.has(w); console.log(`${ok ? 'OK ' : 'FAILED'} ${w.split('  ')[1]}`); if (!ok) bad++; }
  process.exit(bad ? 1 : 0);
}
writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
