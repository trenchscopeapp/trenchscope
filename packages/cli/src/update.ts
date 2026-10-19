// task-1397 — `trenchscope update` and the quiet startup notice.
//
// The check is two anonymous GETs: the npm registry's `latest` for trenchscope and GitHub's latest published
// release of trenchscopeapp/trenchscope. Both carry only fixed headers (no version, no OS, no ids, no cookies); nothing
// about the user or the machine is sent beyond the IP any request has. No telemetry.
//
// Startup: a live interactive run reads ~/.dexterm/update-check.json (no network) and shows one toast when a
// newer version was seen; at most once a day it refreshes that file in the background (never blocks, never in
// --fixtures/--replay, never with DEXTERM_OFFLINE/CI). Off switches: `trenchscope update --off`,
// DEXTERM_NO_UPDATE_CHECK=1 or NO_UPDATE_NOTIFIER=1. `trenchscope update` itself never upgrades anything: it prints
// the exact command for how this copy was installed (npm, Homebrew, release tarball, git checkout).
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dextermHome } from './boot-state.ts';
import { VERSION } from './version.ts';

export const NPM_PACKAGE = 'trenchscope';
export const GITHUB_REPO = 'trenchscopeapp/trenchscope';
export const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
export const GITHUB_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
/** Fixed request headers: the same bytes for every user (GitHub's API requires a user-agent). */
export const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({ accept: 'application/json', 'user-agent': 'dexterm' });
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 4000;
export const UPDATE_FILE = 'update-check.json';
export const UPDATE_USAGE = `usage: trenchscope update          check npm + GitHub now and print the upgrade command for this install
       trenchscope update --off    turn the once-a-day startup check off (trenchscope update still works)
       trenchscope update --on     turn it back on`;

// ---- versions ---------------------------------------------------------------------------------------------

export interface Version { major: number; minor: number; patch: number; pre: string[] }

/** `1.2.3`, `v1.2.3`, `1.2.3-rc.1` → parts; anything else → null (never guessed). */
export function parseVersion(s: unknown): Version | null {
  if (typeof s !== 'string') return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: < 0 when a is older than b. Unparseable versions compare equal (no notice on junk). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release outranks its prereleases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) - Number(q); }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const bare = (v: string): string => v.trim().replace(/^v/, '');

// ---- how this copy was installed --------------------------------------------------------------------------

export type InstallKind = 'npm' | 'brew' | 'tarball' | 'checkout';

/** This module's real path (symlinks resolved): …/node_modules/dexterm-cli/dist/…, …/Cellar/dexterm/…, or a source tree. */
export function selfPath(): string {
  const p = fileURLToPath(import.meta.url);
  try { return realpathSync(p); } catch { return p; }
}

/** The source tree's root for a tarball/checkout install (this file is packages/cli/src/update.ts). */
export function sourceRoot(path: string = selfPath()): string {
  return resolve(dirname(path), '..', '..', '..');
}

export function detectInstall(path: string = selfPath(), exists: (p: string) => boolean = existsSync): InstallKind {
  const p = path.replace(/\\/g, '/');
  if (p.includes(`/node_modules/${NPM_PACKAGE}/`)) return 'npm';
  if (/\/Cellar\/dexterm\/|\/opt\/homebrew\/|\/home\/linuxbrew\/\.linuxbrew\//.test(p)) return 'brew';
  return exists(join(sourceRoot(path), '.git')) ? 'checkout' : 'tarball';
}

export const INSTALL_LABEL: Record<InstallKind, string> = {
  npm: `npm (${NPM_PACKAGE})`, brew: 'Homebrew (dexterm-xyz/dexterm tap)', tarball: 'release tarball (install.sh)', checkout: 'git checkout',
};

/** The exact commands that move this install to `latest`. Nothing here is ever run by dexterm. */
export function upgradeCommands(kind: InstallKind, latest: string, opts: { platform?: NodeJS.Platform; root?: string } = {}): string[] {
  const v = bare(latest);
  if (kind === 'npm') return [`npm i -g ${NPM_PACKAGE}@${v}`];
  if (kind === 'brew') return ['brew update', 'brew upgrade dexterm'];
  if (kind === 'checkout') return [`git -C ${shellQuote(opts.root ?? sourceRoot())} pull --ff-only`];
  const base = `${RELEASES_URL}/download/v${v}`;
  const file = `dexterm-${v}-src.tar.gz`;
  const sum = (opts.platform ?? process.platform) === 'darwin' ? 'shasum -a 256 -c' : 'sha256sum -c';
  return [
    `curl -fL -O ${base}/${file} -O ${base}/SHA256SUMS`,
    `grep ' ${file}$' SHA256SUMS | ${sum}`,
    `tar -xzf ${file} && cd dexterm-${v} && ./install.sh`,
  ];
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- the network check --------------------------------------------------------------------------------------

/** The subset of fetch the check uses (tests replay recorded responses through it). */
export type UpdateFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'follow' }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type SourceResult = { ok: true; version: string; url: string } | { ok: false; error: string };
export interface LatestResult { npm: SourceResult; github: SourceResult }

async function getJson(fetchFn: UpdateFetch, url: string, timeoutMs: number, cancel?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetchFn(url, { headers: { ...REQUEST_HEADERS }, signal: cancel ? AbortSignal.any([cancel, timeout]) : timeout, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function why(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timed out';
  return String(err?.message ?? e).slice(0, 120);
}

/** Ask both sources. Never throws; each side reports its own error. */
export async function fetchLatest(fetchFn: UpdateFetch = fetch as unknown as UpdateFetch, timeoutMs = REQUEST_TIMEOUT_MS, cancel?: AbortSignal): Promise<LatestResult> {
  const npm = getJson(fetchFn, NPM_LATEST_URL, timeoutMs, cancel).then((b): SourceResult => {
    const v = (b as { version?: unknown })?.version;
    return parseVersion(v) ? { ok: true, version: bare(v as string), url: `https://www.npmjs.com/package/${NPM_PACKAGE}` } : { ok: false, error: 'no version in the registry reply' };
  }, (e): SourceResult => ({ ok: false, error: why(e) }));
  const github = getJson(fetchFn, GITHUB_LATEST_URL, timeoutMs, cancel).then((b): SourceResult => {
    const r = b as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    if (r?.draft || r?.prerelease || !parseVersion(r?.tag_name)) return { ok: false, error: 'no published release in the reply' };
    const tag = r.tag_name as string;
    return { ok: true, version: bare(tag), url: `${RELEASES_URL}/tag/${tag}` };
  }, (e): SourceResult => ({ ok: false, error: why(e) }));
  return { npm: await npm, github: await github };
}

/** The newest stable version either source reported, or null. */
export function newestOf(r: LatestResult): string | null {
  let best: string | null = null;
  for (const s of [r.npm, r.github]) {
    if (!s.ok || parseVersion(s.version)?.pre.length) continue;
    if (best === null || compareVersions(s.version, best) > 0) best = s.version;
  }
  return best;
}

/** The version this install's channel can actually move to: npm → the registry; the rest → the GitHub release. */
export function targetFor(kind: InstallKind, r: LatestResult): string | null {
  const primary = kind === 'npm' ? r.npm : r.github;
  return primary.ok ? primary.version : newestOf(r);
}

// ---- persisted state (~/.dexterm/update-check.json) -------------------------------------------------------

export interface UpdateState {
  /** false after `trenchscope update --off`. */
  enabled: boolean;
  /** ms epoch of the last completed check (either source answered). */
  checkedAt: number | null;
  /** newest version seen at that check. */
  latest: string | null;
}

export function updateStatePath(env: NodeJS.ProcessEnv): string {
  return join(dextermHome(env), UPDATE_FILE);
}

export function readUpdateState(env: NodeJS.ProcessEnv): UpdateState {
  try {
    const j = JSON.parse(readFileSync(updateStatePath(env), 'utf8')) as Partial<UpdateState>;
    return {
      enabled: j.enabled !== false,
      checkedAt: typeof j.checkedAt === 'number' && Number.isFinite(j.checkedAt) ? j.checkedAt : null,
      latest: typeof j.latest === 'string' && parseVersion(j.latest) ? bare(j.latest) : null,
    };
  } catch {
    return { enabled: true, checkedAt: null, latest: null };
  }
}

export function writeUpdateState(env: NodeJS.ProcessEnv, s: UpdateState): void {
  const p = updateStatePath(env);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

const truthy = (v: string | undefined): boolean => !!v && v !== '0' && v.toLowerCase() !== 'false';

/** Why the startup check is off, or null when it may run. `trenchscope update` itself ignores all but DEXTERM_OFFLINE. */
export function startupCheckOff(env: NodeJS.ProcessEnv, s: UpdateState): string | null {
  if (truthy(env.DEXTERM_NO_UPDATE_CHECK)) return 'DEXTERM_NO_UPDATE_CHECK is set';
  if (truthy(env.NO_UPDATE_NOTIFIER)) return 'NO_UPDATE_NOTIFIER is set';
  if (truthy(env.DEXTERM_OFFLINE)) return 'DEXTERM_OFFLINE is set';
  if (truthy(env.CI)) return 'CI is set';
  if (!s.enabled) return 'turned off with trenchscope update --off';
  return null;
}

/** The one-line notice for a cached result, or null. */
export function noticeFor(current: string, latest: string | null): string | null {
  if (!latest || parseVersion(latest)?.pre.length || compareVersions(latest, current) <= 0) return null;
  return `trenchscope ${bare(latest)} is available (you have ${bare(current)}) · run trenchscope update`;
}

export interface StartupCheck {
  /** From the cache, available immediately (no network). */
  notice: string | null;
  /** The background refresh, when one was started; resolves to a notice found by it (null otherwise). Never rejects. */
  refresh: Promise<string | null> | null;
  /** Abort an unfinished refresh (on quit, so a slow network never holds the exit). */
  cancel(): void;
}

/**
 * Startup: the cached notice now, plus a background refresh when the last check is older than a day.
 * The caller decides where the notice goes (the interactive loop shows it as a toast after the boot).
 */
export function startupCheck(env: NodeJS.ProcessEnv, opts: { now?: number; current?: string; fetchFn?: UpdateFetch } = {}): StartupCheck {
  const s = readUpdateState(env);
  const none = (): void => {};
  if (startupCheckOff(env, s)) return { notice: null, refresh: null, cancel: none };
  const current = opts.current ?? VERSION;
  const now = opts.now ?? Date.now();
  const notice = noticeFor(current, s.latest);
  if (s.checkedAt !== null && now - s.checkedAt >= 0 && now - s.checkedAt < CHECK_EVERY_MS) return { notice, refresh: null, cancel: none };
  const ctl = new AbortController();
  const refresh = fetchLatest(opts.fetchFn, REQUEST_TIMEOUT_MS, ctl.signal).then((r) => {
    if (ctl.signal.aborted || (!r.npm.ok && !r.github.ok)) return null; // quit / offline / blocked: try again next launch
    const latest = newestOf(r);
    try { writeUpdateState(env, { ...s, checkedAt: now, latest }); } catch { /* read-only home: no cache */ }
    // only a notice the cache did not already produce
    const n = noticeFor(current, latest);
    return n && n !== notice ? n : null;
  }).catch(() => null);
  return { notice, refresh, cancel: () => ctl.abort() };
}

// ---- `trenchscope update` ---------------------------------------------------------------------------------------

export interface UpdateIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv }
export interface UpdateDeps { fetchFn?: UpdateFetch; now?: number; current?: string; install?: InstallKind; root?: string; platform?: NodeJS.Platform }

export async function updateCommand(argv: string[], io: UpdateIo, deps: UpdateDeps = {}): Promise<number> {
  const [arg, ...rest] = argv;
  const env = io.env;
  if (arg === '-h' || arg === '--help' || arg === 'help') { io.stdout.write(UPDATE_USAGE + '\n'); return 0; }
  if (rest.length || (arg !== undefined && arg !== '--off' && arg !== '--on')) {
    io.stderr.write(`trenchscope update: unknown argument ${JSON.stringify(String(rest[0] ?? arg).slice(0, 20))}\n${UPDATE_USAGE}\n`);
    return 2;
  }
  const state = readUpdateState(env);
  if (arg === '--off' || arg === '--on') {
    try { writeUpdateState(env, { ...state, enabled: arg === '--on' }); } catch (e) { io.stderr.write(`trenchscope update: ${(e as Error).message}\n`); return 1; }
    io.stdout.write(arg === '--off'
      ? `startup update check: off (saved to ${updateStatePath(env)}). trenchscope update still checks when you run it.\n`
      : `startup update check: on (at most once a day; saved to ${updateStatePath(env)})\n`);
    return 0;
  }
  if (truthy(env.DEXTERM_OFFLINE)) { io.stderr.write('trenchscope update: DEXTERM_OFFLINE is set; the check needs the network\n'); return 2; }

  const current = deps.current ?? VERSION;
  const kind = deps.install ?? detectInstall();
  const r = await fetchLatest(deps.fetchFn);
  const line = (label: string, s: SourceResult): string => `  ${label.padEnd(20)} ${s.ok ? `${s.version.padEnd(10)} ${s.url}` : `unavailable (${s.error})`}\n`;
  io.stdout.write(`trenchscope ${current} · installed via ${INSTALL_LABEL[kind]}\n`);
  io.stdout.write(line(`npm ${NPM_PACKAGE}`, r.npm));
  io.stdout.write(line('GitHub release', r.github));
  if (!r.npm.ok && !r.github.ok) {
    io.stderr.write(`trenchscope update: could not reach npm or GitHub; check your connection, or see ${RELEASES_URL}\n`);
    return 1;
  }
  const latest = newestOf(r);
  try { writeUpdateState(env, { ...state, checkedAt: deps.now ?? Date.now(), latest }); } catch { /* read-only home */ }
  const target = targetFor(kind, r);
  if (!target || compareVersions(target, current) <= 0) {
    const ahead = latest && compareVersions(latest, current) > 0;
    io.stdout.write(ahead
      ? `You are on the newest version ${kind === 'npm' ? 'npm has' : 'the GitHub release has'} (${current}); ${latest} is out on the other channel and reaches yours shortly.\n`
      : `You are up to date (${current}).\n`);
  } else {
    io.stdout.write(`\ntrenchscope ${target} is available. Upgrade with:\n\n`);
    for (const c of upgradeCommands(kind, target, { platform: deps.platform, root: deps.root })) io.stdout.write(`  ${c}\n`);
    io.stdout.write('\n');
    if (kind === 'tarball') io.stdout.write(`Verify the download first: ${RELEASES_URL}/tag/v${target} (docs/verify-your-download.md). Release notes: CHANGELOG.md.\n`);
  }
  const off = startupCheckOff(env, readUpdateState(env));
  io.stdout.write(`startup check: ${off ? `off (${off})` : 'on, at most once a day; trenchscope update --off or DEXTERM_NO_UPDATE_CHECK=1 turns it off'}. No telemetry: two anonymous GETs (registry.npmjs.org, api.github.com).\n`);
  return 0;
}
