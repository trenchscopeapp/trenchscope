// task-1358 Tier 2 — keymap overrides: rebinding, reserved keys/actions, collisions, chords, all-or-nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyKeymapConfig, collisions, renderKeymap, RESERVED_KEYS, type BindingLike } from '../src/keymap.ts';

const DEFAULTS: BindingLike[] = [
  { keys: ['q', 'ctrl+c'], action: 'quit', label: 'quit' },
  { keys: ['j', 'down'], action: 'move.down', label: 'move' },
  { keys: ['k', 'up'], action: 'move.up', label: 'move' },
  { keys: ['enter'], action: 'open', label: 'open' },
  { keys: ['esc', 'backspace'], action: 'back', label: 'back' },
  { keys: ['y'], action: 'alert.confirm', label: 'confirm alert' },
  { keys: ['t'], action: 'theme.next', label: 'theme' },
  { keys: ['s'], action: 'sort.menu', label: 'sort', screen: 'screener' },
  { keys: ['1'], action: 'tf.1', label: '1m', screen: 'token' },
  { keys: ['1'], action: 'screen.screener', label: 'screener' },
  { keys: ['ctrl+w s'], action: 'workspace.save', label: 'save workspace' },
  { keys: ['!'], action: 'plans.panic', label: 'PANIC', screen: 'plans' },
];

test('rebinding a global action and adding a screen override keeps everything else and marks the overrides', () => {
  const r = applyKeymapConfig(DEFAULTS, { global: { 'theme.next': ['T', 'f2'] }, screens: { token: { 'move.down': ['n'] } } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.bindings.find((b) => b.action === 'theme.next')?.keys, ['T', 'f2']);
  assert.deepEqual(r.bindings.find((b) => b.action === 'move.down' && b.screen === 'token')?.keys, ['n']);
  assert.deepEqual(r.bindings.find((b) => b.action === 'move.down' && !b.screen)?.keys, ['j', 'down'], 'the global binding is untouched');
  assert.deepEqual(r.overridden, [{ action: 'theme.next', screen: null, keys: ['T', 'f2'] }, { action: 'move.down', screen: 'token', keys: ['n'] }]);
  assert.deepEqual(DEFAULTS.find((b) => b.action === 'theme.next')?.keys, ['t'], 'defaults are not mutated');
  assert.ok(renderKeymap(r, 'token').includes('· global     theme.next'));
});

test('reserved keys and reserved actions are refused by name, and NOTHING is applied when any error exists', () => {
  for (const k of RESERVED_KEYS) {
    const r = applyKeymapConfig(DEFAULTS, { global: { 'theme.next': [k] } });
    assert.ok(r.errors.some((e) => e.path === '/keymap/global/theme.next' && /reserved/.test(e.msg)), `${k} must be refused`);
  }
  const r = applyKeymapConfig(DEFAULTS, { global: { quit: ['x'], 'alert.confirm': ['z'], 'plans.panic': ['p'], 'theme.next': ['T'] } });
  assert.equal(r.errors.length, 3);
  assert.deepEqual(r.bindings, DEFAULTS, 'all-or-nothing: the valid theme rebind did not apply either');
  assert.deepEqual(r.overridden, []);
  assert.ok(applyKeymapConfig(DEFAULTS, { global: { 'no.such': ['x'] } }).errors.some((e) => /unknown action/.test(e.msg)));
  assert.ok(applyKeymapConfig(DEFAULTS, { global: { 'theme.next': ['ctrl+c x'] } }).errors.some((e) => /reserved/.test(e.msg)), 'a chord starting on a reserved key is refused');
});

test('collisions: two actions on one key in a scope are refused; global vs screen shadowing is allowed; chord prefixes stay free', () => {
  assert.deepEqual(collisions(DEFAULTS), [], 'the defaults shadow 1 (screener) with 1 (token tf) legally');
  const r = applyKeymapConfig(DEFAULTS, { global: { 'theme.next': ['j'] } });
  assert.ok(r.errors.some((e) => /"j" is bound to both move.down and theme.next/.test(e.msg)));
  const p = applyKeymapConfig(DEFAULTS, { global: { 'theme.next': ['ctrl+w'] } });
  assert.ok(p.errors.some((e) => /starts a chord/.test(e.msg)));
  const chord = applyKeymapConfig(DEFAULTS, { global: { 'theme.next': ['ctrl+w t'] } });
  assert.deepEqual(chord.errors, []);
});

test('schema: bad key ids, more than 4 keys and a non-array value are refused with the config path', () => {
  assert.ok(applyKeymapConfig(DEFAULTS, { global: { 'theme.next': ['ctrl+'] } }).errors.some((e) => e.path.startsWith('/keymap/global/theme.next')));
  assert.ok(applyKeymapConfig(DEFAULTS, { global: { 'theme.next': ['a', 'b', 'c', 'd', 'e'] } }).errors.some((e) => /more than 4/.test(e.msg)));
  assert.ok(applyKeymapConfig(DEFAULTS, { global: { 'theme.next': 'T' } } as never).errors.length);
  assert.ok(applyKeymapConfig(DEFAULTS, { global: { 'theme.next': ['\x1b[2J'] } }).errors.length, 'an escape sequence is not a key id');
  const none = applyKeymapConfig(DEFAULTS, undefined);
  assert.deepEqual(none.bindings, DEFAULTS);
});
