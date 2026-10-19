import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, THEMES, sgr } from '../src/index.ts';

const T = THEMES.midnight;

test('put/text clip to the frame and never throw', () => {
  const c = new Canvas(10, 3, T);
  c.text(-2, 0, 'hello');
  c.text(8, 1, 'world');
  c.text(0, 5, 'off');
  c.put(10, 0, 'x');
  assert.equal(c.toPlain(), 'llo\n        wo\n');
});

test('textR and textC align within their box and truncate', () => {
  const c = new Canvas(10, 2, T);
  c.textR(0, 0, 10, 'abc');
  c.textC(0, 1, 10, 'abcd');
  assert.equal(c.toPlain(), '       abc\n   abcd');
  const d = new Canvas(5, 1, T);
  d.textR(0, 0, 5, 'toolongvalue');
  assert.equal(d.toPlain(), 'toolo');
});

test('box draws rounded corners, title wins over caption', () => {
  const c = new Canvas(20, 3, T);
  const inner = c.box(0, 0, 20, 3, { title: 'T', caption: 'cap' });
  assert.deepEqual({ x: inner.x, y: inner.y, w: inner.w, h: inner.h }, { x: 1, y: 1, w: 18, h: 1 });
  assert.equal(c.toPlain().split('\n')[0], '╭─ T ──────── cap ─╮');
  const small = new Canvas(12, 3, T);
  small.box(0, 0, 12, 3, { title: 'TITLE', caption: 'caption' });
  assert.equal(small.toPlain().split('\n')[0], '╭─ TITLE ──╮', 'caption dropped when it does not fit');
});

test('toPlain trims trailing whitespace per row and keeps row count', () => {
  const c = new Canvas(6, 3, T);
  c.text(0, 1, 'a');
  assert.equal(c.toPlain(), '\na\n');
  assert.equal(c.toPlain().split('\n').length, 3);
});

test('toAnsi truecolor emits 38;2/48;2 and resets each row', () => {
  const c = new Canvas(3, 2, T);
  c.text(0, 0, 'ab', { fg: '#ff0000', bg: '#000000', b: true });
  const out = c.toAnsi();
  assert.match(out, /^\x1b\[0;1;38;2;255;0;0;48;2;0;0;0mab/);
  assert.equal(out.split('\n').length, 2);
  for (const row of out.split('\n')) assert.ok(row.endsWith('\x1b[0m'));
  assert.ok(c.toAnsi({ home: true }).startsWith('\x1b[H'));
});

test('toAnsi 256 maps colors to the xterm cube', () => {
  const c = new Canvas(2, 1, T);
  c.text(0, 0, 'ab', { fg: '#ff0000', bg: '#000000' });
  const out = c.toAnsi({ depth: '256' });
  assert.match(out, /38;5;196;48;5;16m/);
  assert.doesNotMatch(out, /38;2;/);
});

test('toAnsi none drops colors but keeps attributes, collapsing color-only changes', () => {
  const c = new Canvas(4, 1, T);
  c.text(0, 0, 'ab', { fg: '#ff0000' });
  c.text(2, 0, 'cd', { fg: '#00ff00', b: true });
  const out = c.toAnsi({ depth: 'none' });
  assert.equal(out, '\x1b[0mab\x1b[0;1mcd\x1b[0m');
});

test('sgr covers the attribute bits', () => {
  assert.equal(sgr('#000000', '#ffffff', 1 | 2 | 4 | 8, 'none'), '\x1b[0;1;2;3;4m');
});

test('toHtml escapes markup and reflects style runs', () => {
  const c = new Canvas(5, 1, T);
  c.text(0, 0, '<a&b>', { fg: '#ff0000', b: true, i: true, u: true, d: true });
  const html = c.toHtml({ title: 'x<y', chrome: false });
  assert.match(html, /<title>x&lt;y<\/title>/);
  assert.match(html, /color:#ff0000;background:#0b0e14;width:5ch;overflow:hidden;font-weight:700;opacity:.6;font-style:italic;text-decoration:underline;">&lt;a&amp;b&gt;<\/span>/);
  const fit = c.toHtml({ fit: { width: 320, height: 200 } });
  assert.match(fit, /width:320px;height:200px/);
  assert.doesNotMatch(fit, /class="win"/);
  assert.doesNotMatch(html, /class="bar"/);
});

test('shade repaints background only', () => {
  const c = new Canvas(3, 1, T);
  c.text(0, 0, 'abc', { fg: '#111111', bg: '#222222' });
  c.shade(1, 0, 1, 1, '#333333');
  assert.equal(c.bg[1], '#333333');
  assert.equal(c.fg[1], '#111111');
  assert.equal(c.ch[1], 'b');
});
