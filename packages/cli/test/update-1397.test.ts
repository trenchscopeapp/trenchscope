import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1397 — `trenchscope update` and the startup notice. The network is replayed from the two responses recorded
// in fixtures/update-1397.json (npm registry `latest`, GitHub latest release); a "0.1.2 is out" world is the same
// recording with the version moved forward. DEXTERM_HOME is a temp dir; nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { THEMES } from '@dexterm/tui';
import {
  CHECK_EVERY_MS, GITHUB_LATEST_URL, NPM_LATEST_URL, REQUEST_HEADERS, compareVersions, detectInstall, fetchLatest, noticeFor, parseVersion,
  readUpdateState, startupCheck, updateCommand, updateStatePath, upgradeCommands, writeUpdateState, type UpdateFetch,
} from '../src/update.ts';
import { VERSION } from '../src/version.ts';
import { HELP, interactive, main, parseArgs, type Io } from '../src/main.ts';
import { makeFixtureState } from '../src/state.ts';

type Rec = { url: string; status: number; body: Record<string, unknown> };
const REC = JSON.parse(readFileSync(new URL('./fixtures/update-1397.json', import.meta.url), 'utf8')) as { npm: Rec; github: Rec };

/** A copy of the recording with both sources moved to `v` (the world after a release). */
function world(v: string): { npm: Rec; github: Rec } {
  return { npm: { ...REC.npm, body: { ...REC.npm.body, version: v } }, github: { ...REC.github, body: { ...REC.github.body, tag_name: `v${v}`, html_url: `https://github.com/dexterm-xyz/dexterm/releases/tag/v${v}` } } };
}

/** Replays recorded responses by URL and logs every request (url + headers) it sees. */
function replay(rec: { npm: Rec | 'fail' | number; github: Rec | 'fail' | number }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn: UpdateFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = url === NPM_LATEST_URL ? rec.npm : url === GITHUB_LATEST_URL ? rec.github : 404;
    if (r === 'fail') throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    if (typeof r === 'number') return { ok: false, status: r, json: async () => ({}) };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => structuredClone(r.body) };
  };
  return { fetchFn, calls };
}

const home = (): string => mkdtempSync(join(tmpdir(), 'dexterm-1397-'));
function bufIo(env: NodeJS.ProcessEnv) { let out = ''; let err = ''; return { io: { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, env }, out: () => out, err: () => err }; }

test('versions: parse, semver precedence, prereleases and junk', () => {
  assert.deepEqual(parseVersion('v0.1.2'), { major: 0, minor: 1, patch: 2, pre: [] });
  assert.deepEqual(parseVersion('1.0.0-rc.1'), { major: 1, minor: 0, patch: 0, pre: ['rc', '1'] });
  for (const bad of ['', '0.1', 'latest', '0.1.2.3', ' ', null, 7]) assert.equal(parseVersion(bad), null, String(bad));
  const ordered = ['0.0.9', '0.1.0-rc.1', '0.1.0-rc.2', '0.1.0-rc.10', '0.1.0', '0.1.1', '0.1.10', '0.2.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(compareVersions(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.ok(compareVersions(ordered[i + 1], ordered[i]) > 0, `${ordered[i + 1]} > ${ordered[i]}`);
  }
  assert.equal(compareVersions('v0.1.1', '0.1.1'), 0);
  assert.equal(compareVersions('junk', '9.9.9'), 0, 'unparseable never produces a notice');
});

test('replay: the check asks exactly two URLs with fixed headers (no version, no ids, no query) and reads the recorded versions', async () => {
  const r = replay(REC);
  const res = await fetchLatest(r.fetchFn);
  assert.deepEqual(res.npm, { ok: true, version: '0.1.1', url: 'https://www.npmjs.com/package/trenchscope' });
  assert.deepEqual(res.github, { ok: true, version: '0.1.1', url: 'https://github.com/trenchscopeapp/trenchscope/releases/tag/v0.1.1' });
  assert.deepEqual(r.calls.map((c) => c.url).sort(), [GITHUB_LATEST_URL, NPM_LATEST_URL].sort());
  for (const c of r.calls) {
    assert.ok(!c.url.includes('?'), 'no query string');
    assert.deepEqual(c.headers, { ...REQUEST_HEADERS }, 'only the fixed headers');
    assert.ok(!JSON.stringify(c.headers).includes(VERSION), 'the running version is not sent');
  }
  assert.deepEqual(REQUEST_HEADERS, { accept: 'application/json', 'user-agent': 'dexterm' });
});

test('trenchscope update: newer version → the exact command for each install method', async () => {
  const cases: [Parameters<typeof updateCommand>[2], string[]][] = [
    [{ install: 'npm' }, ['  npm i -g trenchscope@0.1.2']],
    [{ install: 'brew' }, ['  brew update', '  brew upgrade dexterm']],
    [{ install: 'checkout', root: '/src/dexterm' }, ['  git -C /src/dexterm pull --ff-only']],
    [{ install: 'tarball', platform: 'darwin' }, [
      '  curl -fL -O https://github.com/trenchscopeapp/trenchscope/releases/download/v0.1.2/dexterm-0.1.2-src.tar.gz -O https://github.com/trenchscopeapp/trenchscope/releases/download/v0.1.2/SHA256SUMS',
      "  grep ' dexterm-0.1.2-src.tar.gz$' SHA256SUMS | shasum -a 256 -c",
      '  tar -xzf dexterm-0.1.2-src.tar.gz && cd dexterm-0.1.2 && ./install.sh',
    ]],
    [{ install: 'tarball', platform: 'linux' }, ["  grep ' dexterm-0.1.2-src.tar.gz$' SHA256SUMS | sha256sum -c"]],
  ];
  for (const [deps, lines] of cases) {
    const env = { DEXTERM_HOME: home() };
    const b = bufIo(env);
    const code = await updateCommand([], b.io, { ...deps, current: '0.1.1', now: 1_000, fetchFn: replay(world('0.1.2')).fetchFn });
    assert.equal(code, 0, deps?.install);
    assert.match(b.out(), /^trenchscope 0\.1\.1 · installed via /);
    assert.match(b.out(), /trenchscope 0\.1\.2 is available\. Upgrade with:/);
    for (const l of lines) assert.ok(b.out().split('\n').includes(l), `${deps?.install}: ${l}\n${b.out()}`);
    assert.equal(b.err(), '');
    assert.deepEqual(readUpdateState(env), { enabled: true, checkedAt: 1_000, latest: '0.1.2' }, 'the result is cached for the startup notice');
  }
});

test('trenchscope update: up to date on the recorded 0.1.1; a channel that lags says so instead of offering a downgrade', async () => {
  const b = bufIo({ DEXTERM_HOME: home() });
  assert.equal(await updateCommand([], b.io, { install: 'npm', current: '0.1.1', fetchFn: replay(REC).fetchFn }), 0);
  assert.match(b.out(), /You are up to date \(0\.1\.1\)\./);
  assert.doesNotMatch(b.out(), /Upgrade with/);
  // GitHub has 0.1.2 already, npm not yet: an npm install is told it is current for its channel
  const lag = { npm: REC.npm, github: world('0.1.2').github };
  const c = bufIo({ DEXTERM_HOME: home() });
  assert.equal(await updateCommand([], c.io, { install: 'npm', current: '0.1.1', fetchFn: replay(lag).fetchFn }), 0);
  assert.match(c.out(), /newest version npm has \(0\.1\.1\); 0\.1\.2 is out on the other channel/);
  assert.doesNotMatch(c.out(), /Upgrade with/);
  // …while a Homebrew install (follows the GitHub release) gets the upgrade
  const d = bufIo({ DEXTERM_HOME: home() });
  await updateCommand([], d.io, { install: 'brew', current: '0.1.1', fetchFn: replay(lag).fetchFn });
  assert.match(d.out(), /brew upgrade dexterm/);
});

test('trenchscope update: one source down still answers; both down exits 1 without caching; offline refuses', async () => {
  const half = bufIo({ DEXTERM_HOME: home() });
  assert.equal(await updateCommand([], half.io, { install: 'brew', current: '0.1.0', fetchFn: replay({ npm: 503, github: REC.github }).fetchFn }), 0);
  assert.match(half.out(), /npm trenchscope\s+unavailable \(HTTP 503\)/);
  assert.match(half.out(), /brew upgrade dexterm/);

  const env = { DEXTERM_HOME: home() };
  const down = bufIo(env);
  assert.equal(await updateCommand([], down.io, { install: 'npm', current: '0.1.0', fetchFn: replay({ npm: 'fail', github: 'fail' }).fetchFn }), 1);
  assert.match(down.err(), /could not reach npm or GitHub/);
  assert.equal(readUpdateState(env).checkedAt, null, 'a failed check is not cached');

  const off = bufIo({ DEXTERM_HOME: home(), DEXTERM_OFFLINE: '1' });
  const r = replay(REC);
  assert.equal(await updateCommand([], off.io, { fetchFn: r.fetchFn }), 2);
  assert.equal(r.calls.length, 0);
});

test('drafts, prereleases and junk replies never become a notice', async () => {
  const pre = { npm: { ...REC.npm, body: { ...REC.npm.body, version: '0.2.0-rc.1' } }, github: { ...REC.github, body: { ...REC.github.body, tag_name: 'v0.2.0-rc.1', prerelease: true } } };
  const env = { DEXTERM_HOME: home() };
  const s = startupCheck(env, { current: '0.1.1', now: 5, fetchFn: replay(pre).fetchFn });
  assert.equal(await s.refresh, null);
  assert.equal(readUpdateState(env).latest, null);
  const junk = { npm: { ...REC.npm, body: { error: 'not found' } }, github: { ...REC.github, body: { ...REC.github.body, draft: true, tag_name: 'v9.9.9' } } };
  const b = bufIo({ DEXTERM_HOME: home() });
  assert.equal(await updateCommand([], b.io, { install: 'npm', current: '0.1.1', fetchFn: replay(junk).fetchFn }), 1);
  assert.equal(noticeFor('0.1.1', '0.1.2-rc.1'), null);
  assert.equal(noticeFor('0.1.1', '0.1.1'), null);
  assert.equal(noticeFor('0.1.2', '0.1.1'), null);
  assert.equal(noticeFor('0.1.1', '0.1.2'), 'trenchscope 0.1.2 is available (you have 0.1.1) · run trenchscope update');
});

test('startup: no cache → one background refresh that writes the cache; within a day → cache only, no network', async (t) => {
  const env = { DEXTERM_HOME: home() };
  const r = replay(world('0.1.2'));
  const first = startupCheck(env, { current: '0.1.1', now: 10_000, fetchFn: r.fetchFn });
  assert.equal(first.notice, null, 'nothing cached yet');
  assert.equal(await first.refresh, 'trenchscope 0.1.2 is available (you have 0.1.1) · run trenchscope update', 'the refresh reports what it found');
  assert.equal(r.calls.length, 2);
  assert.deepEqual(readUpdateState(env), { enabled: true, checkedAt: 10_000, latest: '0.1.2' });
  await posixPermissions(t, () => { assert.equal(statSync(updateStatePath(env)).mode & 0o777, 0o600); });

  const next = startupCheck(env, { current: '0.1.1', now: 10_000 + CHECK_EVERY_MS - 1, fetchFn: r.fetchFn });
  assert.equal(next.notice, 'trenchscope 0.1.2 is available (you have 0.1.1) · run trenchscope update');
  assert.equal(next.refresh, null);
  assert.equal(r.calls.length, 2, 'no request within a day');

  const later = startupCheck(env, { current: '0.1.1', now: 10_000 + CHECK_EVERY_MS, fetchFn: r.fetchFn });
  assert.equal(await later.refresh, null, 'same result as the cached notice: no second toast');
  assert.equal(r.calls.length, 4, 'a day later it checks again');

  const upgraded = startupCheck(env, { current: '0.1.2', now: 10_000 + CHECK_EVERY_MS + 1, fetchFn: r.fetchFn });
  assert.equal(upgraded.notice, null, 'after the upgrade the notice is gone');
});

test('startup: a failed refresh is not cached (tries again next launch); cancel() aborts an unfinished one', async () => {
  const env = { DEXTERM_HOME: home() };
  const s = startupCheck(env, { current: '0.1.1', now: 1, fetchFn: replay({ npm: 'fail', github: 'fail' }).fetchFn });
  assert.equal(await s.refresh, null);
  assert.equal(readUpdateState(env).checkedAt, null);

  let aborted = false;
  const hang: UpdateFetch = (_url, init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => { aborted = true; rej(init.signal.reason); }); });
  const h = startupCheck({ DEXTERM_HOME: home() }, { current: '0.1.1', now: 1, fetchFn: hang });
  h.cancel();
  assert.equal(await h.refresh, null);
  assert.ok(aborted, 'the in-flight request saw the abort');
});

test('opt-out: --off persists and silences startup (no request); env switches and CI do too; --on restores', async () => {
  const H = home();
  const off = bufIo({ DEXTERM_HOME: H });
  assert.equal(await updateCommand(['--off'], off.io), 0);
  assert.match(off.out(), /startup update check: off/);
  assert.equal(readUpdateState({ DEXTERM_HOME: H }).enabled, false);
  const r = replay(world('0.1.2'));
  for (const env of [{ DEXTERM_HOME: H }, { DEXTERM_HOME: home(), DEXTERM_NO_UPDATE_CHECK: '1' }, { DEXTERM_HOME: home(), NO_UPDATE_NOTIFIER: '1' }, { DEXTERM_HOME: home(), CI: 'true' }, { DEXTERM_HOME: home(), DEXTERM_OFFLINE: '1' }]) {
    const s = startupCheck(env, { current: '0.1.1', now: 1, fetchFn: r.fetchFn });
    assert.equal(s.notice, null);
    assert.equal(s.refresh, null, JSON.stringify(env));
  }
  assert.equal(r.calls.length, 0, 'no request with any off switch');
  // `trenchscope update` still checks when asked, and reports the switch
  const b = bufIo({ DEXTERM_HOME: H });
  assert.equal(await updateCommand([], b.io, { install: 'npm', current: '0.1.1', fetchFn: r.fetchFn }), 0);
  assert.match(b.out(), /startup check: off \(turned off with trenchscope update --off\)/);
  assert.equal(readUpdateState({ DEXTERM_HOME: H }).enabled, false, 'a manual check keeps the switch');
  const on = bufIo({ DEXTERM_HOME: H });
  assert.equal(await updateCommand(['--on'], on.io), 0);
  assert.equal(readUpdateState({ DEXTERM_HOME: H }).enabled, true);
  // usage errors
  const bad = bufIo({ DEXTERM_HOME: H });
  assert.equal(await updateCommand(['--now'], bad.io), 2);
  assert.match(bad.err(), /unknown argument "--now"/);
  assert.equal(await updateCommand(['--off', 'x'], bufIo({ DEXTERM_HOME: H }).io), 2);
});

test('a corrupt or hand-edited cache file is ignored, not trusted', () => {
  const env = { DEXTERM_HOME: home() };
  mkdirSync(env.DEXTERM_HOME, { recursive: true });
  writeFileSync(updateStatePath(env), '{not json');
  assert.deepEqual(readUpdateState(env), { enabled: true, checkedAt: null, latest: null });
  writeFileSync(updateStatePath(env), JSON.stringify({ enabled: 'nope', checkedAt: 'x', latest: '$(rm -rf ~)' }));
  assert.deepEqual(readUpdateState(env), { enabled: true, checkedAt: null, latest: null });
  writeUpdateState(env, { enabled: false, checkedAt: 3, latest: 'v0.1.2' });
  assert.deepEqual(readUpdateState(env), { enabled: false, checkedAt: 3, latest: '0.1.2' });
});

test('install detection from the real path of the running code', () => {
  const no = () => false, yes = () => true;
  assert.equal(detectInstall('/usr/local/lib/node_modules/trenchscope/dist/packages/cli/src/update.js', no), 'npm');
  assert.equal(detectInstall('/home/u/.nvm/versions/node/v22.18.0/lib/node_modules/trenchscope/dist/packages/cli/src/update.js', no), 'npm');
  assert.equal(detectInstall('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\trenchscope\\dist\\packages\\cli\\src\\update.js', no), 'npm');
  assert.equal(detectInstall('/opt/homebrew/Cellar/dexterm/0.1.1/libexec/packages/cli/src/update.ts', no), 'brew');
  assert.equal(detectInstall('/usr/local/Cellar/dexterm/0.1.1/libexec/packages/cli/src/update.ts', no), 'brew');
  assert.equal(detectInstall('/home/linuxbrew/.linuxbrew/Cellar/dexterm/0.1.1/libexec/packages/cli/src/update.ts', no), 'brew');
  assert.equal(detectInstall('/home/u/Downloads/dexterm-0.1.1/packages/cli/src/update.ts', no), 'tarball');
  let asked = '';
  assert.equal(detectInstall('/home/u/src/dexterm/packages/cli/src/update.ts', (p) => { asked = p; return yes(); }), 'checkout');
  assert.equal(asked, resolve('/home/u/src/dexterm/.git'));
  assert.deepEqual(upgradeCommands('checkout', '0.1.2', { root: "/home/u/my src/it's" }), [`git -C '/home/u/my src/it'\\''s' pull --ff-only`]);
});

test('main: `trenchscope update` routes to the command; help lists it; --version is the single VERSION', async () => {
  const H = home();
  const b = { out: '', err: '' };
  const io = { stdout: { write: (s: string) => { b.out += s; } }, stderr: { write: (s: string) => { b.err += s; } }, stdin: {}, env: { DEXTERM_HOME: H, DEXTERM_OFFLINE: '1' } } as unknown as Io;
  assert.equal(await main(['update'], io), 2, 'offline → refuses before any request');
  assert.match(b.err, /DEXTERM_OFFLINE is set/);
  assert.equal(await main(['update', '--off'], io), 0);
  assert.equal(readUpdateState({ DEXTERM_HOME: H }).enabled, false);
  assert.match(HELP, /trenchscope update \[--off\|--on\]/);
  assert.match(HELP, /DEXTERM_NO_UPDATE_CHECK=1/);
  assert.ok(HELP.startsWith(`trenchscope ${VERSION} `));
});

// ---- the toast in the interactive loop ------------------------------------------------------------------------

function fakeTty(env: NodeJS.ProcessEnv) {
  const stdout = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 36 });
  Object.assign(stderr, { isTTY: true });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { fd: 0 };
  Object.assign(stdin, { isTTY: true, setRawMode() { return stdin; } });
  const io: Io = { stdout, stderr, stdin, env };
  return { io, type: (s: string) => { (stdin as unknown as PassThrough).write(s); } };
}
const proc = () => Object.assign(new EventEmitter(), { exit: () => {} }) as never;
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
}

test('TUI: the notice is one toast after the boot, never during it; it waits behind the welcome card', async () => {
  const H = home();
  writeFileSync(join(H, 'state.json'), JSON.stringify({ version: 1, boots: 3 }) + '\n'); // not a first launch → short boot
  const t = fakeTty({ DEXTERM_OFFLINE: '1', DEXTERM_HOME: H });
  const state = makeFixtureState({ screen: 'screener', theme: THEMES.midnight });
  state.updateNotice = 'trenchscope 0.1.2 is available (you have 0.1.1) · run trenchscope update';
  let shownDuringBoot = false;
  const run = interactive(state, t.io, 'none', parseArgs(['--fixtures']), proc());
  const spy = setInterval(() => { if (state.screen === 'boot' && state.vfx.toast?.text.includes('is available')) shownDuringBoot = true; }, 5);
  try {
    await until(() => state.vfx.toast?.text === 'trenchscope 0.1.2 is available (you have 0.1.1) · run trenchscope update');
    assert.notEqual(state.screen, 'boot');
    assert.equal(state.updateNotice, null, 'shown once');
    assert.equal(shownDuringBoot, false);
  } finally { clearInterval(spy); t.type('q'); }
  assert.equal(await run, 0);

  // welcome card up (first launch): the notice waits until it is dismissed
  const t2 = fakeTty({ DEXTERM_OFFLINE: '1', DEXTERM_HOME: H });
  const s2 = makeFixtureState({ screen: 'screener', theme: THEMES.midnight });
  s2.updateNotice = 'trenchscope 0.1.2 is available (you have 0.1.1) · run trenchscope update';
  const run2 = interactive(s2, t2.io, 'none', parseArgs(['--fixtures', '--no-boot']), proc());
  try {
    await until(() => s2.screen === 'screener');
    s2.overlay = 'welcome';
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s2.updateNotice !== null, true, 'held behind the welcome card');
    s2.overlay = null;
    await until(() => s2.updateNotice === null && (s2.vfx.toast?.text.includes('is available') ?? false));
  } finally { t2.type('q'); }
  assert.equal(await run2, 0);
});
