#!/usr/bin/env node
// trenchscope release build (scripts/release/build.mjs). Zero dependencies, Node >= 22.18.
//
//   node scripts/release/build.mjs --out <dir> [--version <v>] [--ref <git ref>] [--npm]
//
// Produces, from a clean checkout, the downloadable release artifacts:
//   dexterm-<v>-src.tar.gz   reproducible source tarball: `git archive` of the exact commit, gzip -n
//                            (no timestamp in the gzip header), so the same commit always yields the same bytes.
//   dexterm-<v>.tgz          (only with --npm) the npm tarball from `npm pack`. Requires a JavaScript build in
//                            dist/ first: Node refuses to type-strip .ts files under node_modules
//                            (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the TypeScript sources cannot be
//                            published as-is. See docs/npm-publish-shape.md.
//   build-info.json          commit, ref, tool versions, timestamps; consumed by scan-results.mjs.
//
// It never modifies the working tree. Version defaults to packages/cli/package.json.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = parse(process.argv.slice(2));
if (!args.out) { console.error('usage: build.mjs --out <dir> [--version <v>] [--ref <ref>] [--npm]'); process.exit(1); }
const ROOT = resolve(args.root || process.cwd());
const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });

const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
const version = (args.version || pkg.version).replace(/^v/, '');
const ref = args.ref || 'HEAD';
const commit = git(['rev-parse', ref]).trim();
const commitDate = git(['show', '-s', '--format=%cI', commit]).trim();
const dirty = git(['status', '--porcelain']).trim().length > 0;
if (dirty && !args['allow-dirty']) { console.error('build.mjs: working tree is dirty; release builds run from a clean checkout (--allow-dirty to override for local experiments)'); process.exit(1); }

const artifacts = [];

// 1. source tarball (reproducible)
const srcName = `dexterm-${version}-src.tar.gz`;
const srcPath = join(OUT, srcName);
const sh = spawnSync('sh', ['-c', `git -C "${ROOT}" archive --format=tar --prefix="dexterm-${version}/" "${commit}" | gzip -n -9 > "${srcPath}"`], { stdio: ['ignore', 'inherit', 'inherit'] });
if (sh.status !== 0) { console.error('git archive failed'); process.exit(1); }
artifacts.push(describe(srcPath, 'tarball'));

// 2. npm tarball (opt-in; needs the JS build)
if (args.npm) {
  if (!existsSync(join(ROOT, 'packages', 'cli', 'dist'))) { console.error('build.mjs --npm: packages/cli/dist does not exist; run the JS build first (docs/npm-publish-shape.md)'); process.exit(1); }
  const r = spawnSync('npm', ['pack', '--workspace', 'packages/cli', '--pack-destination', OUT, '--json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  const info = JSON.parse(r.stdout)[0];
  artifacts.push(describe(join(OUT, info.filename), 'npm-tarball'));
}

// 3. build info
const info = {
  name: 'dexterm', version, commit, ref, commitDate, builtAt: new Date().toISOString(),
  node: process.version, npm: tool('npm', ['--version']), git: tool('git', ['--version']), platform: `${process.platform}-${process.arch}`,
  ci: process.env.GITHUB_ACTIONS ? { runId: process.env.GITHUB_RUN_ID, runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, workflow: process.env.GITHUB_WORKFLOW_REF, repository: process.env.GITHUB_REPOSITORY, refName: process.env.GITHUB_REF_NAME } : null,
  artifacts,
};
writeFileSync(join(OUT, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
for (const a of artifacts) console.log(`${a.sha256}  ${a.name}  (${a.sizeBytes} bytes, ${a.kind})`);
console.log(`build-info.json written; commit ${commit.slice(0, 7)} version ${version}`);

function describe(path, kind) { const buf = readFileSync(path); return { name: path.split('/').pop(), kind, sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: statSync(path).size }; }
function git(a) { return execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }); }
function tool(cmd, a) { try { return execFileSync(cmd, a, { encoding: 'utf8' }).trim(); } catch { return null; } }
function parse(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); const v = argv[i + 1]; if (v && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true; } return o; }
