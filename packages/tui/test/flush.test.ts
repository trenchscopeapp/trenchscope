import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, Flusher, THEMES, ENTER_SCREEN, LEAVE_SCREEN } from '../src/index.ts';

const T = THEMES.midnight;

function frame(w: number, h: number, draw: (c: Canvas) => void): Canvas {
  const c = new Canvas(w, h, T);
  draw(c);
  return c;
}

test('first flush paints every row with absolute cursor moves', () => {
  const f = new Flusher({ depth: 'none', hideCursor: false });
  const r = f.diff(frame(4, 3, (c) => c.text(0, 0, 'abcd')));
  assert.equal(r.full, true);
  assert.equal(r.rows, 3);
  assert.ok(r.out.startsWith('\x1b[H\x1b[1;1H'));
  assert.match(r.out, /\x1b\[2;1H/);
  assert.match(r.out, /\x1b\[3;1H/);
  assert.doesNotMatch(r.out, /\x1b\[2J/, 'no clear on the first frame');
});

test('unchanged frame writes nothing; a one-row change writes one row', () => {
  const f = new Flusher({ depth: 'none' });
  f.diff(frame(4, 3, (c) => c.text(0, 0, 'abcd')));
  const same = f.diff(frame(4, 3, (c) => c.text(0, 0, 'abcd')));
  assert.equal(same.rows, 0);
  assert.equal(same.out, '');
  const one = f.diff(frame(4, 3, (c) => { c.text(0, 0, 'abcd'); c.text(0, 2, 'zz'); }));
  assert.equal(one.rows, 1);
  assert.equal(one.full, false);
  assert.equal(one.out, '\x1b[?25l\x1b[3;1H\x1b[0mzz  \x1b[0m');
});

test('color-only change still counts as a row change at truecolor depth', () => {
  const f = new Flusher({ depth: 'truecolor', hideCursor: false });
  f.diff(frame(2, 1, (c) => c.text(0, 0, 'ab', { fg: '#ff0000' })));
  const r = f.diff(frame(2, 1, (c) => c.text(0, 0, 'ab', { fg: '#00ff00' })));
  assert.equal(r.rows, 1);
});

test('resize forces a clear and full repaint; invalidate forces full repaint without clear', () => {
  const f = new Flusher({ depth: 'none', hideCursor: false });
  f.diff(frame(4, 2, () => {}));
  const r = f.diff(frame(5, 2, () => {}));
  assert.equal(r.full, true);
  assert.match(r.out, /\x1b\[2J/);
  assert.equal(r.rows, 2);
  f.invalidate();
  const r2 = f.diff(frame(5, 2, () => {}));
  assert.equal(r2.full, true);
  assert.equal(r2.rows, 2);
  assert.doesNotMatch(r2.out, /\x1b\[2J/);
});

test('flush writes through the sink only when there is output', () => {
  const f = new Flusher({ depth: 'none' });
  const writes: string[] = [];
  f.flush(frame(2, 1, (c) => c.text(0, 0, 'hi')), (s) => writes.push(s));
  f.flush(frame(2, 1, (c) => c.text(0, 0, 'hi')), (s) => writes.push(s));
  assert.equal(writes.length, 1);
});

test('screen enter/leave sequences are balanced', () => {
  assert.match(ENTER_SCREEN, /\x1b\[\?1049h/);
  assert.match(ENTER_SCREEN, /\x1b\[\?25l/);
  assert.match(LEAVE_SCREEN, /\x1b\[\?1049l/);
  assert.match(LEAVE_SCREEN, /\x1b\[\?25h/);
});
