#!/usr/bin/env node
// Assemble scan-results.json for the trust page (scripts/release/scan-results.mjs). Zero dependencies.
//
//   node scripts/release/scan-results.mjs --dir <release dir> --out <file> [--vt <dir>] [--supply <file>]
//        [--release-url <url>] [--download-base <url>] [--run-url <url>] [--workflow .github/workflows/release.yml]
//        [--attestation-url <url>] [--owner <github owner>] [--repo-url <url>] [--tag v0.1.0] [--published-at <iso>]
//        [--npm-name dexterm] [--npm-url <url>] [--provenance] [--license <SPDX>] [--rescan-schedule <text>] [--sample]
//   node scripts/release/scan-results.mjs --check <file>
//
// Reads SHA256SUMS + build-info.json from --dir (written by build.mjs / checksums.mjs), the vt-*.json entries
// from --vt (virustotal.mjs) and supply-chain.json (supply-chain.mjs), and writes one scan-results.json that
// validates against scan-results.schema.json (the copy next to this script is byte-identical to the site's;
// `--check` also compares the two when DEXTERM_SITE_SCHEMA points at the site copy). Real results need
// --run-url, --release-url and a commit; without them use --sample, which the site renders with a SAMPLE banner.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(HERE, 'scan-results.schema.json'), 'utf8'));
const args = parse(process.argv.slice(2));

if (args.check) {
  const doc = JSON.parse(readFileSync(resolve(args.check), 'utf8'));
  const errs = validate(doc, schema);
  if (!doc.sample && (!doc.pipeline.runUrl || !doc.release.url || !doc.release.commit)) errs.push('real (non-sample) results need pipeline.runUrl, release.url and release.commit');
  if (process.env.DEXTERM_SITE_SCHEMA) {
    const a = createHash('sha256').update(readFileSync(join(HERE, 'scan-results.schema.json'))).digest('hex');
    const b = createHash('sha256').update(readFileSync(process.env.DEXTERM_SITE_SCHEMA)).digest('hex');
    if (a !== b) errs.push(`schema drift: ${process.env.DEXTERM_SITE_SCHEMA} differs from scripts/release/scan-results.schema.json`);
    else console.log('schema matches the site copy');
  }
  if (errs.length) { console.error('scan-results.json INVALID:\n  ' + errs.join('\n  ')); process.exit(1); }
  console.log(`${args.check}: valid (${doc.sample ? 'SAMPLE' : 'real'}, ${doc.artifacts.length} artifacts, ${doc.supplyChain.length} supply-chain checks)`);
  process.exit(0);
}

if (!args.dir || !args.out) { console.error('usage: scan-results.mjs --dir <release dir> --out <file> [options]  |  --check <file>'); process.exit(1); }
const DIR = resolve(args.dir);
const info = JSON.parse(readFileSync(join(DIR, 'build-info.json'), 'utf8'));
const sums = readFileSync(join(DIR, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => { const [sha256, name] = l.split('  '); return { sha256, name }; });
const sizes = Object.fromEntries(sums.map((s) => [s.name, statSize(join(DIR, s.name))]));
const vt = {};
if (args.vt && existsSync(resolve(args.vt))) for (const f of readdirSync(resolve(args.vt))) if (f.startsWith('vt-') && f.endsWith('.json')) { const j = JSON.parse(readFileSync(join(resolve(args.vt), f), 'utf8')); vt[j.sha256] = j.scan; }
const supply = args.supply && existsSync(resolve(args.supply)) ? JSON.parse(readFileSync(resolve(args.supply), 'utf8')) : [];
const sample = !!args.sample;
const base = args['download-base'] || null;
const owner = args.owner || null;
const sbomName = sums.find((s) => s.name.endsWith('.cdx.json'))?.name || null;
const sbomUrl = sbomName && base ? `${base}/${sbomName}` : null;

const artifacts = sums.map(({ sha256, name }) => {
  const kind = name.endsWith('-src.tar.gz') ? 'tarball' : name.endsWith('.tgz') ? 'npm-tarball' : name === 'SHA256SUMS' ? 'checksums' : name.endsWith('.cdx.json') ? 'sbom' : name.endsWith('.zip') ? 'zip' : 'other';
  const code = kind === 'tarball' || kind === 'npm-tarball' || kind === 'zip' || kind === 'single-file';
  const scans = vt[sha256] ? [vt[sha256]] : [];
  const attested = !!args['attestation-url'];
  return {
    name, kind, sha256, sizeBytes: sizes[name], downloadUrl: base ? `${base}/${name}` : null, scans,
    attestation: attested ? { type: 'github-build-provenance', url: args['attestation-url'], verifyCommand: `gh attestation verify ${name} --owner ${owner || '<github-owner>'}` } : { type: null, url: null, verifyCommand: null },
    sbom: code && sbomName ? { format: 'cyclonedx-json', url: sbomUrl } : { format: null, url: null },
  };
});
// SHA256SUMS itself is listed (so the page can show its hash) but is never scanned
const doc = {
  $schema: './schema/scan-results.schema.json',
  schemaVersion: 1,
  sample,
  generatedAt: new Date().toISOString(),
  pipeline: { name: sample ? 'trenchscope release pipeline (local dry run, SAMPLE)' : 'trenchscope release pipeline', workflow: args.workflow || '.github/workflows/release.yml', runUrl: args['run-url'] || info.ci?.runUrl || null, rescanSchedule: args['rescan-schedule'] || 'weekly (sunday 06:00 utc, .github/workflows/rescan.yml) and on every release' },
  release: { version: info.version, tag: args.tag || info.ci?.refName || null, commit: info.commit, publishedAt: args['published-at'] || null, url: args['release-url'] || null },
  artifacts,
  supplyChain: supply,
  package: { npmName: args['npm-name'] || null, npmUrl: args['npm-url'] || null, provenance: !!args.provenance, repoUrl: args['repo-url'] || null, license: args.license || null },
};
const errs = validate(doc, schema);
if (!sample && (!doc.pipeline.runUrl || !doc.release.url || !doc.release.commit)) errs.push('real (non-sample) results need --run-url, --release-url and a commit (use --sample for local runs)');
if (errs.length) { console.error('scan-results.json INVALID:\n  ' + errs.join('\n  ')); process.exit(1); }
writeFileSync(resolve(args.out), JSON.stringify(doc, null, 2) + '\n');
console.log(`${args.out}: ${sample ? 'SAMPLE' : 'real'}; ${artifacts.length} artifacts (${artifacts.filter((a) => a.scans.length).length} with VirusTotal entries: ${artifacts.flatMap((a) => a.scans.map((s) => s.status)).join(', ') || 'none'}); ${supply.length} supply-chain checks`);

function statSize(p) { try { return readFileSync(p).length; } catch { return 0; } }
function parse(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); const v = argv[i + 1]; if (['sample', 'provenance'].includes(k) || !v || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } } return o; }
