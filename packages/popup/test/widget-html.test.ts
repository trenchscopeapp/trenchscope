// task-1358 r2 — the pack-widget page audit + the CSP hash list, as pure functions. The audit names LOADERS (the
// `__NONCE__` token, <script src|href>, <link>, frames/embeds/<base>, <meta http-equiv>, @import) and nothing else;
// the hashes are the browser's (exact element text, CR LF → LF, UTF-8, base64). Comments are not read; raw text is.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { auditWidgetHtml, inlineHashes, normalizeWidgetHtml, cspHash, WIDGET_INLINE_MAX } from '../src/widget-html.ts';

const sha = (s: string): string => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const CLEAN = `<!doctype html><html><head><meta charset="utf-8"><title>T</title><style>body{color:var(--text)}</style></head><body><div id="x">waiting</div><a href="https://example.com/docs">docs</a><img alt="" src="/img/0123456789abcdef0123456789abcdef.png"><script>dexterm.on('rows', (vm) => { document.getElementById('x').textContent = vm.rows.length; });</script></body></html>`;

test('auditWidgetHtml: a clean page passes; every loader is refused by name; comments are not read but raw text is', () => {
  assert.deepEqual(auditWidgetHtml(CLEAN), []);
  assert.deepEqual(auditWidgetHtml('<p>hi</p>'), []);
  assert.deepEqual(auditWidgetHtml(''), []);
  const refused = (html: string, re: RegExp): void => { const r = auditWidgetHtml(html); assert.ok(r.some((x) => re.test(x)), `${html} → ${JSON.stringify(r)}`); };
  // the r2 defect: the nonce token anywhere (an attribute, text, a script body) — and a remote src wearing it
  refused('<script nonce="__NONCE__">x</script>', /__NONCE__/);
  refused('<p>__NONCE__</p>', /__NONCE__/);
  refused('<script nonce="__NONCE__" src="https://evil.example/x.js"></script>', /__NONCE__/);
  refused('<script nonce="__NONCE__" src="https://evil.example/x.js"></script>', /<script src=…>/);
  // a script from elsewhere, however it is spelled
  refused('<script src="https://evil.example/x.js"></script>', /<script src=…>/);
  refused("<SCRIPT SRC='https://evil.example/x.js'></SCRIPT>", /<script src=…>/);
  refused('<script src=https://evil.example/x.js></script>', /<script src=…>/);
  refused('<script\n  type="module"\n  src="/vendor/lightweight-charts.standalone.production.js"></script>', /<script src=…>/, );
  refused('<svg><script href="https://evil.example/x.js"></script></svg>', /<script href=…>/);
  refused('<svg><script xlink:href="https://evil.example/x.js"/></svg>', /<script xlink:href=…>/);
  refused('<script data-x="a>b" src="https://evil.example/x.js"></script>', /<script src=…>/); // a > inside quotes does not end the tag
  // stylesheets and documents from elsewhere
  refused('<link rel="stylesheet" href="https://evil.example/x.css">', /<link>/);
  refused('<link rel="prefetch" href="https://evil.example/">', /<link>/);
  refused('<LINK REL=icon HREF=/favicon.ico>', /<link>/);
  refused('<style>@import url(https://evil.example/x.css);</style>', /@import/);
  refused('<style>@IMPORT "x.css";</style>', /@import/);
  refused('<style>@\\69 mport "x.css";</style>', /escaped CSS at-rule/);
  refused('<p style="@import url(https://evil.example/x.css)">x</p>', /@import in a style attribute/);
  refused("<div STYLE='@\\69 mport \"x\"'></div>", /escaped CSS at-rule name .* in a style attribute/);
  // r4: @import is a CSS construct — the literal in a script string or in prose is not a loader (a runtime <style> has no
  // hash, and an @import inserted through CSSOM is a stylesheet fetch with no style-src source)
  assert.deepEqual(auditWidgetHtml("<script>const s = '@import url(x)'; const t = '@\\\\69 mport';</script><p>write @import nowhere</p>"), []);
  refused('<iframe src="https://evil.example/"></iframe>', /<iframe>/);
  refused('<iframe srcdoc="<script>1</script>"></iframe>', /<iframe>/);
  refused('<object data="x.swf"></object>', /<object>/);
  refused('<embed src="x.pdf">', /<embed>/);
  refused('<base href="https://evil.example/">', /<base>/);
  refused('<meta http-equiv="refresh" content="0;url=https://evil.example/">', /<meta http-equiv>/);
  refused('<meta HTTP-EQUIV="Content-Security-Policy" content="default-src *">', /<meta http-equiv>/);
  assert.deepEqual(auditWidgetHtml('<meta name="viewport" content="width=device-width">'), [], 'a meta that is not http-equiv is fine');
  // a comment may talk about all of this: no parser reads a comment
  assert.deepEqual(auditWidgetHtml('<!-- never write nonce="__NONCE__", <script src="https://x"> , <link>, @import or <iframe> --><p>hi</p>'), []);
  // …but <!-- inside a <style> is raw text to the CSS parser, so an @import there is still refused
  refused('<style><!-- @import url(https://evil.example/x.css); --></style>', /@import/);
  // and the raw-text rule means a </script> inside a comment-looking script body is still where the browser ends the element
  assert.deepEqual(auditWidgetHtml('<script>/* <!-- */ var a = 1; /* --> */</script><p>x</p>'), []);
  // more inline blocks than the header will list
  const many = Array.from({ length: WIDGET_INLINE_MAX + 1 }, (_, i) => `<script>${i}</script>`).join('');
  refused(many, new RegExp(`${WIDGET_INLINE_MAX + 1} inline script/style blocks`));
  assert.deepEqual(auditWidgetHtml(Array.from({ length: WIDGET_INLINE_MAX }, (_, i) => `<script>${i}</script>`).join('')), []);
  // one reason per distinct problem, in a stable order
  const r = auditWidgetHtml('<script src="a"></script><script src="b"></script><link href="c"><link href="d">');
  assert.equal(r.filter((x) => /<script src/.test(x)).length, 1);
  assert.equal(r.filter((x) => /<link>/.test(x)).length, 1);
});

test('inlineHashes: the browser\'s hash of each inline block; CR LF normalised; empty blocks, external scripts skipped; duplicates once; case-insensitive tags', () => {
  const h = inlineHashes(CLEAN);
  assert.deepEqual(h.scripts, [sha("dexterm.on('rows', (vm) => { document.getElementById('x').textContent = vm.rows.length; });")]);
  assert.deepEqual(h.styles, [sha('body{color:var(--text)}')]);
  assert.equal(cspHash('abc'), sha('abc'));
  assert.equal(cspHash('alert(1)'), "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='", 'the well-known CSP hash of alert(1)');
  // CR LF: the parser preprocesses the input stream to LF before hashing — so does normalizeWidgetHtml
  const crlf = '<script>\r\nconst a = 1;\r\n</script>\r\n<style>\r\nbody{}\r\n</style>';
  assert.equal(normalizeWidgetHtml(crlf), '<script>\nconst a = 1;\n</script>\n<style>\nbody{}\n</style>');
  assert.deepEqual(inlineHashes(normalizeWidgetHtml(crlf)), { scripts: [sha('\nconst a = 1;\n')], styles: [sha('\nbody{}\n')] });
  assert.equal(normalizeWidgetHtml('a\rb\r\nc\n'), 'a\nb\nc\n');
  // whitespace and the exact text matter (a hash is of the text, not a trimmed version)
  assert.deepEqual(inlineHashes('<script> x </script>').scripts, [sha(' x ')]);
  // empty blocks do not execute and are not listed; a <script src> ignores its text (and the audit refused it anyway)
  assert.deepEqual(inlineHashes('<script></script><style></style><script src="x">ignored</script>'), { scripts: [], styles: [] });
  // the same text twice is one source; different attributes do not change the hash
  assert.deepEqual(inlineHashes('<script>a()</script><script type="module">a()</script><script>b()</script>').scripts, [sha('a()'), sha('b()')]);
  // tag name case and a self-closing-looking end tag
  assert.deepEqual(inlineHashes('<SCRIPT>a()</SCRIPT ><Style>b{}</STYLE>'), { scripts: [sha('a()')], styles: [sha('b{}')] });
  // a comment holding a script is not a script
  assert.deepEqual(inlineHashes('<!-- <script>evil()</script> --><script>ok()</script>'), { scripts: [sha('ok()')], styles: [] });
  // unterminated raw text runs to the end of the document (as it does in the browser)
  assert.deepEqual(inlineHashes('<script>a()').scripts, [sha('a()')]);
});
