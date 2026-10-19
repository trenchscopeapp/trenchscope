import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeConfig, loadConfig, configPath, DEFAULT_HOTKEY, DEFAULT_CONFIG } from '../src/config.ts';

test('normalizeConfig: defaults when empty', () => {
  const c = normalizeConfig({});
  assert.equal(c.hotkey, DEFAULT_HOTKEY);
  assert.equal(c.rain.enabled, true);
  assert.equal(c.rain.speedScale, 1);
  assert.equal(c.fpsCap, DEFAULT_CONFIG.fpsCap);
});

test('normalizeConfig: clamps rain + fps, keeps a valid hotkey', () => {
  const c = normalizeConfig({ hotkey: 'Control+Shift+KeyG', rain: { enabled: false, speedScale: 99, density: 5 }, fpsCap: 9999 });
  assert.equal(c.hotkey, 'Control+Shift+KeyG');
  assert.equal(c.rain.enabled, false);
  assert.equal(c.rain.speedScale, 5);   // clamped to max 5
  assert.equal(c.rain.density, 1);       // clamped to max 1
  assert.equal(c.fpsCap, 120);           // clamped to max 120
});

test('normalizeConfig: empty hotkey disables, garbage hotkey falls back to default', () => {
  assert.equal(normalizeConfig({ hotkey: '' }).hotkey, '');
  assert.equal(normalizeConfig({ hotkey: 'rm -rf /; echo pwn' }).hotkey, DEFAULT_HOTKEY);
  assert.equal(normalizeConfig({ hotkey: 'a'.repeat(200) }).hotkey, DEFAULT_HOTKEY);
});

test('loadConfig: reads ~/.dexterm/popup.json via DEXTERM_HOME, falls back on missing/malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-popup-'));
  try {
    const env = { DEXTERM_HOME: dir } as NodeJS.ProcessEnv;
    assert.equal(configPath(env), join(dir, 'popup.json'));
    // missing file → defaults
    assert.equal(loadConfig(env).hotkey, DEFAULT_HOTKEY);
    assert.equal(loadConfig(env).source, 'defaults');
    // a real file is read and normalized
    writeFileSync(join(dir, 'popup.json'), JSON.stringify({ hotkey: 'Alt+KeyK', rain: { speedScale: 2 } }));
    const c = loadConfig(env);
    assert.equal(c.source, 'file');
    assert.equal(c.hotkey, 'Alt+KeyK');
    assert.equal(c.rain.speedScale, 2);
    // malformed JSON → defaults, never throws
    writeFileSync(join(dir, 'popup.json'), '{ not json');
    assert.equal(loadConfig(env).hotkey, DEFAULT_HOTKEY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
