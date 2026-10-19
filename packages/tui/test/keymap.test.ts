import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys, keyId, Keymap, DEFAULT_KEYMAP } from '../src/index.ts';

test('parseKeys decodes printable, control and escape sequences', () => {
  assert.deepEqual(parseKeys('j').map(keyId), ['j']);
  assert.deepEqual(parseKeys('G').map(keyId), ['G']);
  assert.deepEqual(parseKeys('\r').map(keyId), ['enter']);
  assert.deepEqual(parseKeys('\n').map(keyId), ['enter']);
  assert.deepEqual(parseKeys('\t').map(keyId), ['tab']);
  assert.deepEqual(parseKeys('\x7f').map(keyId), ['backspace']);
  assert.deepEqual(parseKeys(' ').map(keyId), ['space']);
  assert.deepEqual(parseKeys('\x1b').map(keyId), ['esc']);
  assert.deepEqual(parseKeys('\x03').map(keyId), ['ctrl+c']);
  assert.deepEqual(parseKeys('\x0c').map(keyId), ['ctrl+l']);
  assert.deepEqual(parseKeys('\x1b[A\x1b[B\x1b[C\x1b[D').map(keyId), ['up', 'down', 'right', 'left']);
  assert.deepEqual(parseKeys('\x1bOA').map(keyId), ['up']);
  assert.deepEqual(parseKeys('\x1b[5~\x1b[6~').map(keyId), ['pageup', 'pagedown']);
  assert.deepEqual(parseKeys('\x1b[H\x1b[F').map(keyId), ['home', 'end']);
  assert.deepEqual(parseKeys('\x1b[1;2A').map(keyId), ['shift+up']);
  assert.deepEqual(parseKeys('\x1b[1;5C').map(keyId), ['ctrl+right']);
  assert.deepEqual(parseKeys('\x1bx').map(keyId), ['alt+x']);
  assert.deepEqual(parseKeys('\x1b[15~').map(keyId), ['f5']);
  assert.deepEqual(parseKeys('\x1bOP').map(keyId), ['f1']);
});

test('parseKeys handles several keys in one chunk and multi-byte glyphs', () => {
  assert.deepEqual(parseKeys('jjk\r').map(keyId), ['j', 'j', 'k', 'enter']);
  const ks = parseKeys('é😀');
  assert.deepEqual(ks.map((k) => k.ch), ['é', '😀']);
});

test('Keymap resolves per-screen bindings before global ones', () => {
  const km = new Keymap<'a' | 'b' | 'c'>([
    { keys: ['x'], action: 'a' },
    { keys: ['x'], action: 'b', screen: 'token' },
    { keys: ['ctrl+c'], action: 'c' },
  ]);
  assert.equal(km.resolve(parseKeys('x')[0]), 'a');
  assert.equal(km.resolve(parseKeys('x')[0], 'token'), 'b');
  assert.equal(km.resolve(parseKeys('x')[0], 'screener'), 'a');
  assert.deepEqual(km.resolveRaw('x\x03y', 'token'), ['b', 'c']);
  assert.equal(km.forScreen('token').length, 3);
  assert.equal(km.forScreen('screener').length, 2);
});

test('DEFAULT_KEYMAP mirrors the prototype README', () => {
  const r = (s: string) => DEFAULT_KEYMAP.resolveRaw(s);
  assert.deepEqual(r('q'), ['quit']);
  assert.deepEqual(r('\x03'), ['quit']);
  assert.deepEqual(r('1234'), ['screen.screener', 'screen.newpairs', 'screen.watchlist', 'screen.analyst']);
  assert.deepEqual(r('\t'), ['screen.next']);
  assert.deepEqual(r('j\x1b[B'), ['move.down', 'move.down']);
  assert.deepEqual(r('k\x1b[A'), ['move.up', 'move.up']);
  assert.deepEqual(r('\r'), ['open']);
  assert.deepEqual(r('\x1b'), ['back']);
  assert.deepEqual(r('\x7f'), ['back']);
  assert.deepEqual(r('a'), ['analyst.toggle']);
  assert.deepEqual(r('t'), ['theme.next']);
  assert.deepEqual(r('p'), ['pause.toggle']);
  assert.deepEqual(r('z'), []);
});
