#!/usr/bin/env node
// CycloneDX SBOM for a trenchscope release (scripts/release/sbom.mjs). Zero dependencies, deterministic.
//
//   node scripts/release/sbom.mjs --out <dir> [--version <v>] [--root <checkout>]
//
// Writes <out>/dexterm-<v>.cdx.json (CycloneDX 1.6, JSON). What it lists and why:
//   - the application itself (metadata.component) with the git commit as a property;
//   - the five workspace packages as first-party components;
//   - the ONE vendored runtime library: TradingView Lightweight Charts (Apache-2.0), with the sha256 of the
//     vendored file (packages/popup/vendor/lightweight-charts/VERSION gives the version);
//   - every entry of package-lock.json: trenchscope has no third-party runtime dependencies, so these are all
//     dev tooling and carry scope "excluded" (present in the lockfile, not shipped);
//   - every crate in packages/popup/shell/wry/Cargo.lock with scope "optional": the native chart window is
//     built on the user's machine by `cargo` only when they opt in; nothing compiled ships in the release.
// serialNumber is derived from the commit + version so two builds of the same commit produce identical SBOMs.
// CI attests this file with actions/attest-sbom in addition to the build-provenance attestation.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = parse(process.argv.slice(2));
if (!args.out) { console.error('usage: sbom.mjs --out <dir> [--version <v>] [--root <dir>]'); process.exit(1); }
const ROOT = resolve(args.root || process.cwd());
const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });

const cliPkg = json(join(ROOT, 'packages/cli/package.json'));
const version = (args.version || cliPkg.version).replace(/^v/, '');
const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const lock = json(join(ROOT, 'package-lock.json'));
const repoUrl = args.repo || null; // e.g. https://github.com/<owner>/dexterm; null until decided

const components = [];
const deps = [];

// first-party workspace packages
const ws = ['cli', 'data', 'tui', 'mcp', 'popup'];
for (const w of ws) {
  const p = join(ROOT, 'packages', w, 'package.json');
  if (!existsSync(p)) continue;
  const pk = json(p);
  components.push({
    type: 'library', 'bom-ref': `pkg:npm/${encodeURIComponent(pk.name)}@${pk.version}`, name: pk.name, version: pk.version,
    description: pk.description, scope: 'required', purl: `pkg:npm/${pk.name}@${pk.version}`,
    properties: [{ name: 'dexterm:origin', value: 'first-party workspace package' }],
  });
}

// vendored Lightweight Charts
const lwcDir = join(ROOT, 'packages/popup/vendor/lightweight-charts');
if (existsSync(lwcDir)) {
  const v = readFileSync(join(lwcDir, 'VERSION'), 'utf8').trim();
  const file = join(lwcDir, 'lightweight-charts.standalone.production.js');
  components.push({
    type: 'library', 'bom-ref': `pkg:npm/lightweight-charts@${v}`, name: 'lightweight-charts', version: v, scope: 'required',
    description: 'TradingView Lightweight Charts, vendored (byte-identical to the npm release) and served from the loopback popup server',
    purl: `pkg:npm/lightweight-charts@${v}`, licenses: [{ license: { id: 'Apache-2.0' } }],
    hashes: [{ alg: 'SHA-256', content: sha256(readFileSync(file)) }],
    externalReferences: [{ type: 'website', url: 'https://www.tradingview.com/lightweight-charts/' }, { type: 'distribution', url: `https://registry.npmjs.org/lightweight-charts/-/lightweight-charts-${v}.tgz` }],
    properties: [{ name: 'dexterm:origin', value: 'vendored runtime library (packages/popup/vendor/lightweight-charts)' }],
  });
}

// lockfile entries (dev tooling only; trenchscope has no third-party runtime deps)
for (const [path, e] of Object.entries(lock.packages || {})) {
  if (!path.startsWith('node_modules/') || e.link) continue;
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const purl = `pkg:npm/${name}@${e.version}`;
  const c = { type: 'library', 'bom-ref': purl, name, version: e.version, scope: e.dev ? 'excluded' : 'required', purl, properties: [{ name: 'dexterm:origin', value: e.dev ? 'development dependency from package-lock.json (not shipped)' : 'runtime dependency from package-lock.json' }] };
  if (e.license) c.licenses = [{ license: { id: e.license } }];
  if (e.integrity) { const [alg, b64] = e.integrity.split('-'); c.hashes = [{ alg: alg.toUpperCase().replace('SHA', 'SHA-'), content: Buffer.from(b64, 'base64').toString('hex') }]; }
  if (e.resolved) c.externalReferences = [{ type: 'distribution', url: e.resolved }];
  components.push(c);
}

// optional Rust crates for the native chart window
const cargoLock = join(ROOT, 'packages/popup/shell/wry/Cargo.lock');
if (existsSync(cargoLock)) {
  const text = readFileSync(cargoLock, 'utf8');
  for (const block of text.split('[[package]]').slice(1)) {
    const name = (block.match(/^name = "([^"]+)"/m) || [])[1];
    const v = (block.match(/^version = "([^"]+)"/m) || [])[1];
    const checksum = (block.match(/^checksum = "([0-9a-f]+)"/m) || [])[1];
    if (!name || !v) continue;
    if (name === 'dexterm-shell-wry') continue;
    const purl = `pkg:cargo/${name}@${v}`;
    const c = { type: 'library', 'bom-ref': purl, name, version: v, scope: 'optional', purl, properties: [{ name: 'dexterm:origin', value: 'Rust crate for the optional native chart window; compiled on the user machine by cargo, never shipped' }] };
    if (checksum) c.hashes = [{ alg: 'SHA-256', content: checksum }];
    components.push(c);
  }
}

const appRef = `pkg:npm/dexterm@${version}`;
deps.push({ ref: appRef, dependsOn: components.filter((c) => c.scope === 'required').map((c) => c['bom-ref']) });

const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${uuidFrom(`${commit}:${version}`)}`, version: 1,
  metadata: {
    timestamp: execFileSync('git', ['-C', ROOT, 'show', '-s', '--format=%cI', commit], { encoding: 'utf8' }).trim(),
    tools: { components: [{ type: 'application', name: 'trenchscope scripts/release/sbom.mjs', version: '1' }] },
    component: {
      type: 'application', 'bom-ref': appRef, name: 'dexterm', version, description: cliPkg.description, purl: appRef,
      ...(repoUrl ? { externalReferences: [{ type: 'vcs', url: repoUrl }] } : {}),
      properties: [{ name: 'dexterm:git-commit', value: commit }, { name: 'dexterm:runtime-third-party-deps', value: '0' }],
    },
  },
  components, dependencies: deps,
};
const name = `dexterm-${version}.cdx.json`;
writeFileSync(join(OUT, name), JSON.stringify(bom, null, 2) + '\n');
const counts = components.reduce((a, c) => ((a[c.scope] = (a[c.scope] || 0) + 1), a), {});
console.log(`${name}: ${components.length} components (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}); commit ${commit.slice(0, 7)}`);

function json(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function sha256(b) { return createHash('sha256').update(b).digest('hex'); }
function uuidFrom(s) { const h = createHash('sha256').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(parseInt(h.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0')}${h.slice(18, 20)}-${h.slice(20, 32)}`; }
function parse(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); const v = argv[i + 1]; if (v && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true; } return o; }
