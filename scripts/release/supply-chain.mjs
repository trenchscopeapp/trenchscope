#!/usr/bin/env node
// Supply-chain checks for a trenchscope release (scripts/release/supply-chain.mjs). Zero dependencies.
//
//   node scripts/release/supply-chain.mjs --out <dir> [--root <checkout>] [--repo <owner/name>] [--npm-name dexterm]
//                                         [--fetch-scorecard] [--offline]
//
// Writes <out>/supply-chain.json: the `supplyChain[]` array of scan-results.schema.json, one entry per check,
// plus the raw tool outputs next to it. Every check records what it could and could not do:
//   npm-audit      `npm audit --json` on the lockfile (dev tooling only: trenchscope has no runtime deps). Needs the registry.
//   osv-scanner    the osv-scanner binary ($OSV_SCANNER or on PATH; CI fetches a pinned one with scripts/release/fetch-tool.sh)
//                  against package-lock.json and the Rust Cargo.lock. Queries api.osv.dev with package names and versions.
//   gitleaks       the gitleaks binary ($GITLEAKS or on PATH) over the full git history of the checkout with .gitleaks.toml.
//   openssf-scorecard  with --fetch-scorecard: GET https://api.scorecard.dev/projects/github.com/<repo> (public, keyless;
//                  only exists once the repo is public and scorecard.yml has published a result). Otherwise pending.
//   socket         pending until the npm package exists; the badge URL is recorded so the site can link it.
// Exit 0 always (results are data for the trust page); exit 1 only on misuse.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = parse(process.argv.slice(2));
if (!args.out) { console.error('usage: supply-chain.mjs --out <dir> [--root <dir>] [--repo owner/name] [--npm-name dexterm] [--fetch-scorecard] [--offline]'); process.exit(1); }
const ROOT = resolve(args.root || process.cwd());
const OUT = resolve(args.out); mkdirSync(OUT, { recursive: true });
const now = () => new Date().toISOString();
const repo = args.repo || null;
const npmName = args['npm-name'] || 'dexterm';
const entries = [];

// npm audit
{
  if (args.offline) entries.push(entry('npm-audit', 'pending', null, null, 'skipped: offline run'));
  else {
    const r = spawnSync('npm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    let j = null; try { j = JSON.parse(r.stdout); } catch { /* not json */ }
    writeFileSync(join(OUT, 'npm-audit.json'), r.stdout || '');
    if (!j || !j.metadata) entries.push(entry('npm-audit', 'error', null, null, `npm audit did not return a report (${(r.stderr || '').trim().slice(0, 160)})`));
    else {
      const v = j.metadata.vulnerabilities; const total = v.total || 0;
      const status = total === 0 ? 'pass' : v.critical || v.high ? 'fail' : 'warn';
      entries.push(entry('npm-audit', status, null, `${total} vulnerabilities`, `${j.metadata.dependencies.total} packages in package-lock.json (${j.metadata.dependencies.dev} dev-only); trenchscope has zero third-party runtime dependencies, so this covers the TypeScript toolchain${total ? `: ${v.critical} critical, ${v.high} high, ${v.moderate} moderate, ${v.low} low` : ''}.`));
    }
  }
}

// osv-scanner
{
  const bin = process.env.OSV_SCANNER || which('osv-scanner');
  if (!bin) entries.push(entry('osv-scanner', 'pending', null, null, 'osv-scanner binary not available in this environment'));
  else if (args.offline) entries.push(entry('osv-scanner', 'pending', null, null, 'skipped: offline run (osv-scanner queries api.osv.dev)'));
  else {
    const lockfiles = ['package-lock.json', 'packages/popup/shell/wry/Cargo.lock'].filter((f) => existsSync(join(ROOT, f)));
    const a = ['scan', 'source', '--format', 'json', '--output-file', join(OUT, 'osv-scanner.json')];
    for (const f of lockfiles) a.push('--lockfile', join(ROOT, f));
    const r = spawnSync(bin, a, { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    let j = null; try { j = JSON.parse(readFileSync(join(OUT, 'osv-scanner.json'), 'utf8')); } catch { /* none */ }
    if (!j) entries.push(entry('osv-scanner', 'error', null, null, `osv-scanner produced no report (exit ${r.status}): ${(r.stderr || '').trim().slice(-200)}`));
    else {
      const vulns = (j.results || []).flatMap((s) => (s.packages || []).flatMap((p) => p.vulnerabilities || []));
      const pkgs = (j.results || []).reduce((n, s) => n + (s.packages || []).length, 0);
      entries.push(entry('osv-scanner', vulns.length ? 'fail' : 'pass', null, `${vulns.length} vulnerabilities`, `${lockfiles.join(' + ')}: ${pkgs} packages with findings out of the lockfile set; ${vulns.length ? vulns.map((v) => v.id).join(', ') : 'no known vulnerabilities in the OSV database'}. The Rust crates are compiled only on machines that opt into the native chart window.`));
    }
  }
}

// gitleaks (history)
{
  const bin = process.env.GITLEAKS || which('gitleaks');
  if (!bin) entries.push(entry('gitleaks', 'pending', null, null, 'gitleaks binary not available in this environment'));
  else {
    const report = join(OUT, 'gitleaks.json');
    const a = ['git', '--log-opts=--all', '--report-format', 'json', '--report-path', report, '--exit-code', '0', '--no-banner'];
    if (existsSync(join(ROOT, '.gitleaks.toml'))) a.push('--config', join(ROOT, '.gitleaks.toml'));
    a.push(ROOT);
    const r = spawnSync(bin, a, { encoding: 'utf8', timeout: 600000 });
    let j = null; try { j = JSON.parse(readFileSync(report, 'utf8')); } catch { /* none */ }
    if (!j) entries.push(entry('gitleaks', 'error', null, null, `gitleaks produced no report (exit ${r.status}): ${(r.stderr || '').trim().slice(-200)}`));
    else entries.push(entry('gitleaks', j.length ? 'fail' : 'pass', null, `${j.length} findings`, j.length ? `${j.length} finding(s) across all refs; each is listed in gitleaks.json and must be resolved or allow-listed in .gitleaks.toml with a reason.` : 'no secrets found in any commit on any ref (Solana addresses and transaction signatures in recorded fixtures are allow-listed by path in .gitleaks.toml).'));
  }
}

// OpenSSF Scorecard
{
  const url = repo ? `https://scorecard.dev/viewer/?uri=github.com/${repo}` : null;
  if (!repo) entries.push(entry('openssf-scorecard', 'pending', null, null, 'needs the public repository name (pass --repo owner/name).'));
  else if (!args['fetch-scorecard'] || args.offline) entries.push(entry('openssf-scorecard', 'pending', url, null, 'computed by .github/workflows/scorecard.yml once the repo is public; fetched by supply-chain.mjs --fetch-scorecard.'));
  else {
    try {
      const res = await fetch(`https://api.scorecard.dev/projects/github.com/${repo}`, { headers: { accept: 'application/json' } });
      if (res.status === 404) entries.push(entry('openssf-scorecard', 'pending', url, null, 'no published Scorecard result yet (scorecard.yml has not run with publish_results on a public repo).'));
      else if (!res.ok) entries.push(entry('openssf-scorecard', 'error', url, null, `api.scorecard.dev returned ${res.status}`));
      else {
        const j = await res.json();
        const score = j.score;
        const low = (j.checks || []).filter((c) => typeof c.score === 'number' && c.score >= 0 && c.score < 5).map((c) => `${c.name} ${c.score}`);
        entries.push(entry('openssf-scorecard', score >= 7 ? 'pass' : score >= 5 ? 'warn' : 'fail', url, score, `aggregate ${score}/10 as of ${j.date}${low.length ? `; checks under 5: ${low.join(', ')}` : ''}. Badge: https://api.scorecard.dev/projects/github.com/${repo}/badge`));
      }
    } catch (e) { entries.push(entry('openssf-scorecard', 'error', url, null, `fetch failed: ${e.message}`)); }
  }
}

// Socket
entries.push(entry('socket', 'pending', `https://socket.dev/npm/package/${npmName}`, null, 'Socket analyses the published npm package; pending until trenchscope is on npm. No account is needed for the public report page; a badge needs the Socket GitHub app installed on the repo.'));

writeFileSync(join(OUT, 'supply-chain.json'), JSON.stringify(entries, null, 2) + '\n');
for (const e of entries) console.log(`[supply-chain] ${e.check}: ${e.status}${e.score != null ? ` (${e.score})` : ''} — ${e.note.slice(0, 110)}`);

function entry(check, status, url, score, note) { return { check, status, checkedAt: status === 'pending' ? null : now(), url, score, note }; }
function which(name) { const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }
function parse(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); const v = argv[i + 1]; if (['fetch-scorecard', 'offline'].includes(k) || !v || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } } return o; }
