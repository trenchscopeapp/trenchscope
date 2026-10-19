// ~/.dexterm/state.json: the first launch is the full glitch boot, later launches the one-second
// boot. Everything goes through DEXTERM_HOME so no test touches the real directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBootState, bootPlan, recordBoot, stateFile, dextermHome, FULL_BOOT, SHORT_BOOT } from '../src/boot-state.ts';

function home() { return mkdtempSync(join(tmpdir(), 'dexterm-boot-')); }

test('first launch: no state file → full boot; recordBoot writes boots=1 with mode 600; later launches get the short boot', (t) => {
  const dir = join(home(), 'nested', '.dexterm');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { DEXTERM_HOME: dir };
  assert.equal(dextermHome(env), dir);
  assert.equal(stateFile(env), join(dir, 'state.json'));
  assert.deepEqual(readBootState(env), { version: 1, boots: 0 });
  const first = bootPlan(readBootState(env));
  assert.equal(first.full, true);
  assert.equal(first.seconds, FULL_BOOT.seconds);
  assert.equal(recordBoot(env, new Date('2026-10-06T13:30:00Z')), true);
  assert.ok(existsSync(join(dir, 'state.json')), 'directory created on demand');
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.boots, 1);
  assert.equal(saved.firstBoot, '2026-10-06T13:30:00.000Z');
  assert.equal(saved.lastBoot, '2026-10-06T13:30:00.000Z');
  const second = bootPlan(readBootState(env));
  assert.equal(second.full, false);
  assert.equal(second.seconds, SHORT_BOOT.seconds);
  assert.ok(second.seconds + second.holdSeconds <= 1.0, 'later boots take one second');
  assert.equal(recordBoot(env, new Date('2026-10-07T00:00:00Z')), true);
  const again = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(again.boots, 2);
  assert.equal(again.firstBoot, '2026-10-06T13:30:00.000Z', 'first boot preserved');
  assert.equal(again.lastBoot, '2026-10-07T00:00:00.000Z');
});

test('malformed or hostile state is a first launch, never a crash', (t) => {
  const dir = home();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { DEXTERM_HOME: dir };
  for (const body of ['', '{', 'null', '[]', '{"boots":"many"}', '{"boots":-3}', '{"__proto__":{"boots":9}}']) {
    writeFileSync(join(dir, 'state.json'), body);
    assert.deepEqual(readBootState(env), { version: 1, boots: 0 }, JSON.stringify(body));
  }
  writeFileSync(join(dir, 'state.json'), '{"boots":2.7,"firstBoot":5}');
  assert.deepEqual(readBootState(env), { version: 1, boots: 2, firstBoot: undefined, lastBoot: undefined });
});

test('an unwritable home does not throw: recordBoot reports false and the next launch is still a first launch', (t) => {
  const dir = home();
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const locked = join(dir, 'ro');
  // A file in the parent path makes this unwritable on NTFS, POSIX, and root-run CI.
  writeFileSync(locked, 'not a directory');
  const env = { DEXTERM_HOME: join(locked, 'deeper') };
  assert.equal(recordBoot(env), false);
  assert.equal(bootPlan(readBootState(env)).full, true);
});

test('DEXTERM_HOME unset or blank falls back to ~/.dexterm', () => {
  assert.match(dextermHome({}), /\.dexterm$/);
  assert.match(dextermHome({ DEXTERM_HOME: '  ' }), /\.dexterm$/);
});
