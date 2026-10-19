// task-1366 — display.priceMode in the customization config: schema, defaults, v3 → v4 migration, workspaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, defaultConfig, migrate, CONFIG_VERSION, PRICE_MODES, DEFAULT_PRICE_MODE, validate } from '../src/schema.ts';
import { loadConfig, configPath, applyAndJournal, undoLast } from '../src/config.ts';
import { captureWorkspace, validateWorkspace } from '../src/workspace.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-1366-'));

test('schema: display.priceMode is price | mcap, default price; anything else is refused by name', () => {
  assert.equal(CONFIG_VERSION, 4);
  assert.deepEqual([...PRICE_MODES], ['price', 'mcap']);
  assert.equal(DEFAULT_PRICE_MODE, 'price');
  assert.deepEqual(defaultConfig().display, { priceMode: 'price' });
  assert.deepEqual(validateConfig({ ...defaultConfig(), display: { priceMode: 'mcap' } }), []);
  assert.deepEqual(validateConfig({ ...defaultConfig(), display: {} }), []);
  assert.ok(validateConfig({ ...defaultConfig(), display: { priceMode: 'fdv' } }).some((e) => e.path === '/display/priceMode' && /price, mcap/.test(e.msg)));
  assert.ok(validateConfig({ ...defaultConfig(), display: { priceMode: 'mcap', sign: true } }).some((e) => e.path === '/display/sign' && e.msg === 'unknown key'));
});

test('migration v3 → v4 adds display.priceMode = price and keeps everything else', () => {
  const v3 = { ...defaultConfig(), version: 3, theme: { name: 'ember', overrides: {}, user: {} }, rules: [] } as Record<string, unknown>;
  delete v3.display;
  const m = migrate(v3);
  assert.deepEqual(m.errors, []);
  assert.equal(m.from, 3);
  assert.equal(m.config.version, 4);
  assert.deepEqual(m.config.display, { priceMode: 'price' });
  assert.equal(m.config.theme?.name, 'ember');
  assert.ok(m.notes.some((n) => /display\.priceMode = price/.test(n)));
  // a v3 file with a valid hand-written display keeps it; a bad one falls back to price
  assert.deepEqual(migrate({ ...v3, display: { priceMode: 'mcap' } }).config.display, { priceMode: 'mcap' });
  assert.deepEqual(migrate({ ...v3, display: { priceMode: 'nope' } }).config.display, { priceMode: 'price' });
  // the full chain from v1 lands on v4 with the default display
  const m1 = migrate({ theme: 'paper' });
  assert.deepEqual(m1.errors, []);
  assert.equal(m1.config.version, 4);
  assert.deepEqual(m1.config.display, { priceMode: 'price' });
});

test('loader: a v3 config.json on disk is migrated to v4 with a backup', () => {
  const home = tmp();
  const v3 = { ...defaultConfig(), version: 3 } as Record<string, unknown>;
  delete v3.display;
  writeFileSync(configPath(home), JSON.stringify(v3));
  const l = loadConfig(home);
  assert.equal(l.ok, true, l.errors.join('; '));
  assert.equal(l.config.display?.priceMode, 'price');
  assert.ok(existsSync(`${configPath(home)}.bak-v3`));
  assert.equal(JSON.parse(readFileSync(configPath(home), 'utf8')).version, 4);
});

test('persistence: priceMode round-trips through the journal and undo restores it', () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify(defaultConfig()));
  applyAndJournal(home, [{ op: 'add', path: '/display/priceMode', value: 'mcap' }], { actor: 'user', why: 'test', now: 1 });
  assert.equal(loadConfig(home).config.display?.priceMode, 'mcap');
  assert.throws(() => applyAndJournal(home, [{ op: 'add', path: '/display/priceMode', value: 'usd' }], { actor: 'user', why: 'bad' }), /refused: \/display\/priceMode/);
  assert.equal(undoLast(home, 2).ok, true);
  assert.equal(loadConfig(home).config.display?.priceMode, 'price');
});

test('workspaces carry an optional priceMode; capture saves it only when it is not the default', () => {
  assert.deepEqual(validate('workspace', { name: 'trench', priceMode: 'mcap' }), []);
  assert.ok(validateWorkspace({ name: 'x', priceMode: 'fdv' } as never).some((e) => e.path === '/priceMode'));
  const base = { screen: 'screener', theme: 'cyberspace', intensity: 'fever' as const };
  assert.equal(captureWorkspace('a', { ...base, priceMode: 'mcap' }).priceMode, 'mcap');
  assert.equal(captureWorkspace('b', { ...base, priceMode: 'price' }).priceMode, undefined);
  assert.equal(captureWorkspace('c', base).priceMode, undefined);
});
