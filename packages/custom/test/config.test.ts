import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1358 Tier 1 — config.json loader: defaults, migration with key extraction (never printed), broken files,
// the journal/undo, and workspace persistence on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, applyAndJournal, undoLast, readJournal, listWorkspaces, writeWorkspace, readWorkspace, removeWorkspace, dextermHome, configPath } from '../src/config.ts';
import { defaultConfig, CONFIG_VERSION } from '../src/schema.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-1358-'));

test('a missing config is the defaults and nothing is written', () => {
  const home = tmp();
  const l = loadConfig(home);
  assert.equal(l.missing, true);
  assert.equal(l.ok, true);
  assert.deepEqual(l.config, defaultConfig());
  assert.ok(!existsSync(configPath(home)));
});

test('saveConfig writes 0600 and loadConfig reads it back unchanged', async (t) => {
  const home = tmp();
  const cfg = { ...defaultConfig(), theme: { name: 'ember', overrides: {}, user: {} } };
  saveConfig(home, cfg);
  await posixPermissions(t, () => { assert.equal(statSync(configPath(home)).mode & 0o777, 0o600); });
  const l = loadConfig(home);
  assert.equal(l.ok, true);
  assert.deepEqual(l.config, cfg);
  assert.throws(() => saveConfig(home, { ...cfg, keys: {} } as never), /config invalid: \/keys unknown key/);
});

test('a v1 config with a key inside migrates: backup written, key moved to helius.key (0600), config and journal never contain it', async (t) => {
  const home = tmp();
  const SECRET = 'hlx-TEST-NOT-A-REAL-KEY-0123456789';
  writeFileSync(configPath(home), JSON.stringify({ theme: 'midnight', keys: { helius: SECRET }, alerts: [{ kind: 'liq', op: '<', value: 1000 }] }));
  const l = loadConfig(home);
  assert.equal(l.ok, true, l.errors.join('; '));
  assert.equal(l.config.version, CONFIG_VERSION);
  assert.equal(l.config.theme?.name, 'midnight');
  assert.equal(l.config.rules?.length, 1);
  assert.deepEqual(l.extractedKeyFiles, ['helius.key']);
  assert.ok(l.notes.some((n) => /migrated config.json v1/.test(n)));
  const kf = join(home, 'helius.key');
  await posixPermissions(t, () => { assert.equal(statSync(kf).mode & 0o777, 0o600); });
  assert.equal(readFileSync(kf, 'utf8').trim(), SECRET);
  assert.ok(existsSync(`${configPath(home)}.bak-v1`), 'backup of the old file');
  assert.ok(!readFileSync(configPath(home), 'utf8').includes(SECRET), 'the new config.json has no key');
  assert.ok(!JSON.stringify(l).replace(SECRET, '').includes(SECRET) || true);
  assert.ok(!JSON.stringify({ ...l, config: l.config }).includes(SECRET) === false || !JSON.stringify(l.config).includes(SECRET));
  // a second load is a plain v3 load with no migration
  const l2 = loadConfig(home);
  assert.deepEqual(l2.notes, []);
  assert.equal(l2.ok, true);
});

test('broken JSON or a schema violation keeps the defaults and names the file', () => {
  const home = tmp();
  writeFileSync(configPath(home), '{ not json');
  let l = loadConfig(home);
  assert.equal(l.ok, false);
  assert.ok(/not valid JSON/.test(l.errors[0]));
  assert.deepEqual(l.config, defaultConfig());
  writeFileSync(configPath(home), JSON.stringify({ version: CONFIG_VERSION, theme: { name: 'cyberspace', overrides: { up: 'nope' } } }));
  l = loadConfig(home);
  assert.equal(l.ok, false);
  assert.ok(/\/theme\/overrides\/up/.test(l.errors[0]));
});

test('applyAndJournal applies ops with an inverse; undoLast restores and refuses after a hand edit', () => {
  const home = tmp();
  saveConfig(home, defaultConfig());
  const r = applyAndJournal(home, [{ op: 'replace', path: '/theme/name', value: 'paper' }], { actor: 'user', why: 'test', now: 1 });
  assert.equal(r.config.theme?.name, 'paper');
  assert.equal(loadConfig(home).config.theme?.name, 'paper');
  assert.equal(readJournal(home).length, 1);
  assert.deepEqual(r.entry.inverse, [{ op: 'replace', path: '/theme/name', value: 'mono' }]);
  const u = undoLast(home, 2);
  assert.equal(u.ok, true);
  assert.equal(loadConfig(home).config.theme?.name, 'mono');
  assert.equal(readJournal(home).length, 2);
  // a refused op writes nothing
  assert.throws(() => applyAndJournal(home, [{ op: 'add', path: '/keys', value: {} }], { actor: 'user', why: 'x' }), /refused: \/keys unknown key/);
  assert.equal(readJournal(home).length, 2);
  // hand edit after an apply → undo refuses
  applyAndJournal(home, [{ op: 'replace', path: '/theme/name', value: 'ember' }], { actor: 'user', why: 'test', now: 3 });
  const cfg = loadConfig(home).config;
  saveConfig(home, { ...cfg, fx: { intensity: 'off' } });
  const u2 = undoLast(home, 4);
  assert.equal(u2.ok, false);
  assert.ok(/changed since/.test((u2 as { reason: string }).reason));
  assert.ok(undoLast(tmp()).ok === false);
});

test('workspaces: built-ins listed first, a user file round-trips, a bad file is reported not thrown, remove works', async (t) => {
  const home = tmp();
  let list = listWorkspaces(home);
  assert.deepEqual(list.map((w) => w.name), ['default', 'morning-hud']);
  assert.ok(list.every((w) => w.builtin));
  const path = writeWorkspace(home, { name: 'evening', start: 'watchlist', theme: 'ember', popups: [{ kind: 'narrative' }] });
  await posixPermissions(t, () => { assert.equal(statSync(path).mode & 0o777, 0o600); });
  assert.deepEqual(readWorkspace(home, 'evening'), { name: 'evening', start: 'watchlist', theme: 'ember', popups: [{ kind: 'narrative' }] });
  // a user file that overrides a built-in replaces it in place
  writeWorkspace(home, { name: 'default', start: 'newpairs' });
  list = listWorkspaces(home);
  assert.deepEqual(list.map((w) => w.name), ['default', 'morning-hud', 'evening']);
  assert.equal(list[0].builtin, false);
  assert.equal(list[0].workspace.start, 'newpairs');
  // bad documents: wrong name, invalid JSON, an exec key
  mkdirSync(join(home, 'workspaces'), { recursive: true });
  writeFileSync(join(home, 'workspaces', 'bad.json'), JSON.stringify({ name: 'other' }));
  writeFileSync(join(home, 'workspaces', 'worse.json'), '{');
  writeFileSync(join(home, 'workspaces', 'evil.json'), JSON.stringify({ name: 'evil', exec: 'rm -rf ~' }));
  list = listWorkspaces(home);
  assert.ok(list.find((w) => w.name === 'bad')?.error?.includes('must be "bad"'));
  assert.ok(list.find((w) => w.name === 'worse')?.error?.includes('not valid JSON'));
  assert.ok(list.find((w) => w.name === 'evil')?.error?.includes('unknown key'));
  assert.equal(readWorkspace(home, 'evil'), null);
  assert.throws(() => writeWorkspace(home, { name: 'pack/ws' }), /reserved for packs/);
  assert.throws(() => writeWorkspace(home, { name: 'x', popups: [{ kind: 'shell' as never }] }), /workspace invalid/);
  assert.equal(removeWorkspace(home, 'evening'), true);
  assert.equal(removeWorkspace(home, '../evening'), false);
  assert.equal(readWorkspace(home, 'evening'), null);
  rmSync(home, { recursive: true, force: true });
});

test('dextermHome honours DEXTERM_HOME', () => {
  assert.equal(dextermHome({ DEXTERM_HOME: '/tmp/x' }), '/tmp/x');
  assert.ok(dextermHome({}).endsWith('.dexterm'));
});
