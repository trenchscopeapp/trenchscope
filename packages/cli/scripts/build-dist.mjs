#!/usr/bin/env node
// Publish build for the single `dexterm` npm package (task-1346, docs/npm-publish-shape.md).
//
// Node refuses to type-strip .ts under node_modules, so the published package ships compiled JS.
// Every workspace package is compiled into packages/cli/dist/, mirroring the repo layout:
//   dist/packages/<pkg>/src/**/*.js   compiled sources
//   dist/packages/<pkg>/{assets,vendor,src/pages,bin}   runtime files loaded by path
// so the existing import.meta.url-relative paths (assets, vendor, popup pages, the MCP bin) resolve unchanged.
// The @dexterm/* workspace packages are inlined: bare `@dexterm/x` specifiers are rewritten to relative paths.
//
// Usage: node packages/cli/scripts/build-dist.mjs   (also runs as the cli package's `prepack`)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(CLI, '..', '..');
const DIST = path.join(CLI, 'dist');
const PKGS = path.join(ROOT, 'packages');

// Runtime files outside src/ that code loads by path (relative to each package dir).
const RUNTIME_DIRS = {
  cli: ['assets'],
  data: ['vendor'],
  mcp: ['assets'],
  popup: ['vendor'],
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__pycache__') walk(p, out); }
    else out.push(p);
  }
  return out;
}

// 1. clean + compile
fs.rmSync(DIST, { recursive: true, force: true });
const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
execFileSync(process.execPath, [tsc, '-p', path.join(CLI, 'tsconfig.build.json')], { stdio: 'inherit' });

// 2. map @dexterm/<name>[/sub] -> compiled entry, from each package's exports map
const pkgDirs = fs.readdirSync(PKGS).filter((d) => fs.existsSync(path.join(PKGS, d, 'package.json')));
const entries = new Map();
for (const d of pkgDirs) {
  const pj = JSON.parse(fs.readFileSync(path.join(PKGS, d, 'package.json'), 'utf8'));
  if (!pj.name?.startsWith('@dexterm/') || !pj.exports) continue;
  for (const [sub, target] of Object.entries(pj.exports)) {
    const spec = sub === '.' ? pj.name : `${pj.name}/${sub.replace(/^\.\//, '')}`;
    entries.set(spec, path.join(DIST, 'packages', d, String(target).replace(/\.ts$/, '.js')));
  }
}

// 3. post-process compiled JS
const jsFiles = walk(DIST).filter((f) => f.endsWith('.js'));
let rewrites = 0;
for (const f of jsFiles) {
  let src = fs.readFileSync(f, 'utf8');
  const before = src;
  // bare workspace specifiers in static import/export ... from '...' and import('...')
  src = src.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(@dexterm\/[a-z]+(?:\/[a-z]+)?)\2/g, (m, lead, q, spec) => {
    const target = entries.get(spec);
    if (!target) throw new Error(`build-dist: no export for ${spec} (in ${path.relative(DIST, f)})`);
    let rel = path.relative(path.dirname(f), target).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${lead}${q}${rel}${q}`;
  });
  // file URLs built from a relative .ts literal (worker scripts, child-process entry points):
  // tsc only rewrites import specifiers, so point these at the emitted .js too.
  src = src.replace(/new URL\((['"])(\.{1,2}\/[^'"]+)\.ts\1,\s*import\.meta\.url\)/g, 'new URL($1$2.js$1, import.meta.url)');
  if (src !== before) { fs.writeFileSync(f, src); rewrites++; }
  if (/['"]@dexterm\//.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) {
    throw new Error(`build-dist: unresolved @dexterm specifier left in ${path.relative(DIST, f)}`);
  }
}

// 4. runtime files: non-TS files inside src (popup pages), declared runtime dirs, and the bins
let copied = 0;
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); copied++; };
for (const d of pkgDirs) {
  const pkg = path.join(PKGS, d);
  const out = path.join(DIST, 'packages', d);
  if (fs.existsSync(path.join(pkg, 'src'))) {
    for (const f of walk(path.join(pkg, 'src'))) {
      if (f.endsWith('.ts') || f.endsWith('.md')) continue;
      copy(f, path.join(out, path.relative(pkg, f)));
    }
  }
  for (const r of RUNTIME_DIRS[d] ?? []) {
    for (const f of walk(path.join(pkg, r))) copy(f, path.join(out, path.relative(pkg, f)));
  }
  const bin = path.join(pkg, 'bin');
  if (fs.existsSync(bin)) {
    for (const f of walk(bin)) {
      const to = path.join(out, path.relative(pkg, f));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // bin shims import ../src/*.ts; the compiled copies import ../src/*.js
      const text = fs.readFileSync(f, 'utf8').replace(/(['"])(\.\.\/src\/[^'"]+)\.ts\1/g, '$1$2.js$1');
      fs.writeFileSync(to, text, { mode: fs.statSync(f).mode });
      copied++;
    }
  }
}

process.stdout.write(`build-dist: ${jsFiles.length} js files (${rewrites} rewritten), ${copied} runtime files -> ${path.relative(ROOT, DIST)}\n`);
