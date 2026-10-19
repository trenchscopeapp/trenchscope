#!/usr/bin/env node
// VirusTotal v3 client for trenchscope release artifacts (scripts/release/virustotal.mjs). Zero dependencies.
//
//   VT_API_KEY=… node scripts/release/virustotal.mjs scan --out <dir> [--rescan] <file>...
//   node scripts/release/virustotal.mjs scan --out <dir> --fixtures <dir> <file>...     replay recorded responses, no network
//   node scripts/release/virustotal.mjs scan --out <dir> --dry-run <file>...            no key, no network: print the plan, write "pending"
//
// For every file it writes <out>/vt-<file name>.json holding the `scans[]` entry in the shape of
// scan-results.schema.json (engine, status, scannedAt, reportUrl, summary, flaggedBy, note) plus the raw stats.
// scan-results.mjs picks these up by sha256.
//
// Flow per file:  GET /files/{sha256}  → known & fresh? reuse  ·  unknown? POST /files (≤32 MB) or
//                 GET /files/upload_url + POST (≤650 MB)  ·  --rescan & known? POST /files/{sha256}/analyse
//                 → poll GET /analyses/{id} until status=completed → GET /files/{sha256} for the canonical result.
// Uploading makes the file public to the VirusTotal community (fine for an open-source release artifact; it
// is the point) — never run this on anything private.
//
// Public API limits (docs.virustotal.com/reference/public-vs-premium-api, read 2026-10-09): 4 requests per
// minute, 500 per day, no commercial use, no multiple accounts. This client enforces both: a persisted
// minimum spacing between requests (default 15.5 s = 3.9/min) and a persisted per-UTC-day counter with a
// budget (default 450, leaving headroom); 429 QuotaExceededError waits a minute and retries up to three
// times, then records status "error". A release of four artifacts costs about 4 lookups + 4 uploads +
// ~4-12 polls + 4 final lookups ≈ 16-24 requests, i.e. 4-6 minutes at the public pace. A weekly re-scan of
// the same four costs ≈ 12-20. The key is read from VT_API_KEY only, used only in the request header, and
// never logged. Exit code: 0 when every file produced an entry (even "pending"/"error"), 1 on misuse.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const API = 'https://www.virustotal.com/api/v3';
const argv = process.argv.slice(2);
const cmd = argv.shift();
const args = parse(argv);
if (cmd !== 'scan' || !args.out || !args._.length) { console.error('usage: virustotal.mjs scan --out <dir> [--rescan] [--fixtures <dir>] [--dry-run] [--fresh-days 7] [--daily-budget 450] [--min-interval-ms 15500] [--poll-max-ms 900000] <file>...'); process.exit(1); }
const OUT = resolve(args.out); mkdirSync(OUT, { recursive: true });
const FIXTURES = args.fixtures ? resolve(args.fixtures) : null;
const DRY = !!args['dry-run'];
const KEY = DRY || FIXTURES ? null : process.env.VT_API_KEY;
if (!DRY && !FIXTURES && !KEY) { console.error('virustotal.mjs: VT_API_KEY is not set (use --dry-run or --fixtures for a keyless run)'); process.exit(1); }
const FRESH_MS = Number(args['fresh-days'] || 7) * 86400e3;
const BUDGET = Number(args['daily-budget'] || 450);
const MIN_INTERVAL = FIXTURES || DRY ? 0 : Number(args['min-interval-ms'] || 15500);
const POLL_EVERY = FIXTURES || DRY ? 0 : Number(args['poll-every-ms'] || 20000);
const POLL_MAX = Number(args['poll-max-ms'] || 900000);
const STATE = join(process.env.VT_STATE_DIR || OUT, 'vt-quota.json');

const state = loadState();
const fixture = FIXTURES ? loadFixtures(FIXTURES) : null;
let exitCode = 0;

for (const file of args._) {
  const path = resolve(file);
  const name = basename(path);
  const buf = readFileSync(path);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const size = statSync(path).size;
  const reportUrl = `https://www.virustotal.com/gui/file/${sha256}`;
  const log = (m) => console.log(`[vt] ${name}: ${m}`);
  const entry = { file: name, sha256, sizeBytes: size, scan: null, raw: { requests: [] } };
  try {
    if (DRY) {
      log(`dry run: would GET /files/${sha256.slice(0, 12)}…, upload ${size} bytes${size > 32 * 1024 * 1024 ? ' via /files/upload_url' : ' via POST /files'}, poll /analyses/{id}, then GET /files/{sha256}; ≈4-7 requests`);
      entry.scan = pending('dry run: no VirusTotal request was made (no key configured). Status becomes real once the pipeline runs with VT_API_KEY.');
    } else {
      const ctx = { name, sha256, size, log, entry };
      let fileObj = await vtFetch(ctx, 'GET', `/files/${sha256}`, null, { allow404: true });
      const known = fileObj && fileObj.data;
      const lastDate = known ? (fileObj.data.attributes.last_analysis_date || 0) * 1000 : 0;
      const fresh = known && Date.now() - lastDate < FRESH_MS;
      let analysisId = null;
      if (known && args.rescan) {
        const r = await vtFetch(ctx, 'POST', `/files/${sha256}/analyse`);
        analysisId = r.data.id; log(`re-analysis requested (${analysisId.slice(0, 12)}…)`);
      } else if (!known) {
        analysisId = await upload(ctx, path, buf);
        log(`uploaded; analysis ${analysisId.slice(0, 12)}…`);
      } else if (fresh) {
        log(`known to VirusTotal, last analysis ${new Date(lastDate).toISOString()} (fresh) — reusing`);
      } else {
        const r = await vtFetch(ctx, 'POST', `/files/${sha256}/analyse`);
        analysisId = r.data.id; log(`known but stale; re-analysis requested`);
      }
      let completed = !analysisId;
      if (analysisId) {
        const started = Date.now();
        while (Date.now() - started <= POLL_MAX) {
          const a = await vtFetch(ctx, 'GET', `/analyses/${analysisId}`);
          const status = a.data?.attributes?.status;
          if (status === 'completed') { completed = true; break; }
          log(`analysis ${status || 'queued'}…`);
          if (POLL_EVERY) await sleep(POLL_EVERY);
          if (FIXTURES && fixture.exhausted()) break;
        }
        if (completed) fileObj = await vtFetch(ctx, 'GET', `/files/${sha256}`);
      }
      if (!completed) entry.scan = pending(`analysis still running after ${Math.round(POLL_MAX / 60000)} min; the weekly re-scan picks it up (${reportUrl})`);
      else entry.scan = summarize(fileObj.data.attributes, reportUrl);
      entry.raw.stats = fileObj?.data?.attributes?.last_analysis_stats || null;
      entry.raw.analysisId = analysisId;
    }
  } catch (e) {
    exitCode = 0; // an error is a recorded outcome, not a pipeline failure: the trust page shows it honestly
    entry.scan = { engine: 'virustotal', status: 'error', scannedAt: null, reportUrl, summary: zero(), note: `scan failed: ${String(e.message || e).slice(0, 200)}` };
    log(`ERROR ${e.message}`);
  }
  entry.scan.reportUrl = entry.scan.reportUrl || reportUrl;
  writeFileSync(join(OUT, `vt-${name}.json`), JSON.stringify(entry, null, 2) + '\n');
  log(`${entry.scan.status}${entry.scan.summary.engines ? ` (${entry.scan.summary.malicious} malicious, ${entry.scan.summary.suspicious} suspicious of ${entry.scan.summary.engines} engines)` : ''}`);
}
saveState();
console.log(`[vt] requests this run: ${state.runRequests}; today (${state.day}): ${state.count}/${BUDGET}; ${FIXTURES ? 'fixture replay, no network' : DRY ? 'dry run, no network' : 'live'}`);
process.exit(exitCode);

// ---- pieces ------------------------------------------------------------------------------------------
async function upload(ctx, path, buf) {
  const form = new FormData();
  form.append('file', new Blob([buf]), ctx.name);
  if (buf.length <= 32 * 1024 * 1024) { const r = await vtFetch(ctx, 'POST', '/files', form); return r.data.id; }
  if (buf.length > 650 * 1024 * 1024) throw new Error('file over the 650 MB upload limit');
  const u = await vtFetch(ctx, 'GET', '/files/upload_url');
  const r = await vtFetch(ctx, 'POST', u.data, form, { absolute: true });
  return r.data.id;
}

function summarize(attr, reportUrl) {
  const s = attr.last_analysis_stats || {};
  const results = attr.last_analysis_results || {};
  const timeout = (s.timeout || 0) + (s['confirmed-timeout'] || 0);
  const summary = { engines: Object.keys(results).length || sum(s), malicious: s.malicious || 0, suspicious: s.suspicious || 0, harmless: s.harmless || 0, undetected: (s.undetected || 0) + (s['type-unsupported'] || 0) + (s.failure || 0), timeout };
  const flaggedBy = Object.values(results).filter((r) => r.category === 'malicious' || r.category === 'suspicious').map((r) => ({ engine: r.engine_name, label: r.result || r.category }));
  const flagged = summary.malicious + summary.suspicious > 0;
  const scannedAt = attr.last_analysis_date ? new Date(attr.last_analysis_date * 1000).toISOString() : new Date().toISOString();
  const extra = (s['type-unsupported'] ? `${s['type-unsupported']} engines do not scan this file type; ` : '') + (s.failure ? `${s.failure} engine failures; ` : '');
  const note = flagged
    ? `${flaggedBy.length} engine(s) flagged this file. We treat every flag as a report: see the false-positives section of the trust page; the result stays visible here until resolved. ${extra}`.trim()
    : `No engine flagged this file as of ${scannedAt}. ${extra}A clean scan means the engines did not recognise the file as known malware; it is not a proof of safety.`.trim();
  const out = { engine: 'virustotal', status: flagged ? 'flagged' : 'clean', scannedAt, reportUrl, summary, note };
  if (flagged) out.flaggedBy = flaggedBy;
  return out;
}
function pending(note) { return { engine: 'virustotal', status: 'pending', scannedAt: null, reportUrl: null, summary: zero(), note }; }
function zero() { return { engines: 0, malicious: 0, suspicious: 0, harmless: 0, undetected: 0, timeout: 0 }; }
function sum(s) { return Object.values(s).reduce((a, b) => a + (b || 0), 0); }

// ---- transport with quota + rate limit + fixtures ------------------------------------------------------
async function vtFetch(ctx, method, path, body = null, opts = {}) {
  const url = opts.absolute ? path : API + path;
  const label = `${method} ${opts.absolute ? '<upload_url>' : path.replace(ctx.sha256, '{sha256}').replace(/analyses\/[^/]+/, 'analyses/{id}')}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (!FIXTURES) await pace();
    if (state.count >= BUDGET) throw new Error(`daily request budget ${BUDGET} reached (counter in ${STATE})`);
    state.count++; state.runRequests++; state.lastAt = Date.now();
    ctx.entry.raw.requests.push(label);
    let status, json;
    if (FIXTURES) ({ status, json } = fixture.next(method, path, ctx));
    else {
      const res = await fetch(url, { method, headers: { 'x-apikey': KEY, accept: 'application/json' }, body });
      status = res.status;
      json = status === 204 ? null : await res.json().catch(() => null);
    }
    if (status === 404 && opts.allow404) return null;
    if (status === 429) {
      const code = json?.error?.code || 'TooManyRequests';
      ctx.log(`429 ${code} (attempt ${attempt}/4)`);
      if (/daily|monthly/i.test(json?.error?.message || '') || attempt === 4) throw new Error(`quota exceeded: ${code}`);
      if (!FIXTURES) await sleep(61000);
      continue;
    }
    if (status >= 500) { ctx.log(`${status} server error (attempt ${attempt}/4)`); if (attempt === 4) throw new Error(`server error ${status}`); if (!FIXTURES) await sleep(5000 * 3 ** (attempt - 1)); continue; }
    if (status >= 400) throw new Error(`${status} ${json?.error?.code || ''}: ${(json?.error?.message || '').slice(0, 120)}`);
    saveState();
    return json;
  }
}
async function pace() { const wait = MIN_INTERVAL - (Date.now() - (state.lastAt || 0)); if (wait > 0) await sleep(wait); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function loadState() {
  const day = new Date().toISOString().slice(0, 10);
  let s = { day, count: 0, lastAt: 0 };
  if (existsSync(STATE)) { try { const j = JSON.parse(readFileSync(STATE, 'utf8')); if (j.day === day) s = j; } catch { /* fresh */ } }
  s.runRequests = 0; return s;
}
function saveState() { writeFileSync(STATE, JSON.stringify({ day: state.day, count: state.count, lastAt: state.lastAt, budget: BUDGET, note: 'VirusTotal public API: 4 req/min, 500 req/day (UTC). Shared across runs on this machine/runner via this file.' }, null, 2) + '\n'); }
function loadFixtures(dir) {
  const seq = JSON.parse(readFileSync(join(dir, 'sequence.json'), 'utf8'));
  let i = 0; const queue = [];
  for (const s of seq) for (let k = 0; k < (s.repeat || 1); k++) queue.push(s);
  return {
    exhausted: () => i >= queue.length,
    next(method, path, ctx) {
      const s = queue[i++];
      if (!s) throw new Error(`fixture sequence exhausted at ${method} ${path}`);
      const want = s.match.split(' ');
      if (want[0] !== method || !path.startsWith(want[1])) throw new Error(`fixture mismatch: expected ${s.match}, got ${method} ${path}`);
      let text = readFileSync(join(dir, s.body), 'utf8');
      text = text.replaceAll('{{SHA256}}', ctx.sha256).replaceAll('{{SIZE}}', String(ctx.size)).replaceAll('{{NAME}}', ctx.name).replaceAll('{{NOW}}', String(Math.floor(Date.now() / 1000)));
      return { status: s.status || 200, json: JSON.parse(text) };
    },
  };
}
function parse(a) { const o = { _: [] }; for (let i = 0; i < a.length; i++) { if (!a[i].startsWith('--')) { o._.push(a[i]); continue; } const k = a[i].slice(2), v = a[i + 1]; if (['rescan', 'dry-run'].includes(k) || !v || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } } return o; }
