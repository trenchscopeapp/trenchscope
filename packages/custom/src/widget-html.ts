// @dexterm/custom — PACK WIDGET HTML (task-1358 r2): the install-time copy of the popup host's page audit, so a pack whose
// widget page carries a loader (the `__NONCE__` token, a <script src>, a <link>, a frame, <meta http-equiv>, `@import`)
// is refused before it lands — the host refuses the same page again at open and at ticket issue.
//
// MIRROR of @dexterm/popup/src/widget-html.ts (the canonical copy, with the reasoning); the two zero-dependency packages
// do not import each other (like WIDGET_TOPICS), and packages/cli/test/widget-1358.test.ts asserts that everything from
// the import line down is byte-identical in both files. Edit the popup copy first, then copy it here.
import { createHash } from 'node:crypto';

/** Most inline <script> + <style> blocks one widget page may carry (the CSP header lists one hash per block). */
export const WIDGET_INLINE_MAX = 64;

/** CR LF and lone CR become LF, as the HTML parser's input-stream preprocessor does before it hashes an element's text. */
export function normalizeWidgetHtml(html: string): string { return html.replace(/\r\n?/g, '\n'); }

/** The CSP hash-source for one inline block's exact text. */
export function cspHash(text: string): string { return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`; }

/** Elements whose whole purpose is loading another document or resource: a widget page has no use for them. */
const LOADER_TAGS = new Set(['link', 'iframe', 'frame', 'frameset', 'embed', 'object', 'applet', 'base', 'portal', 'fencedframe']);
const SCRIPT_SRC_ATTRS = new Set(['src', 'href', 'xlink:href']);

interface Tag { name: string; attrs: Map<string, string>; /** index just past the closing `>` of the start tag */ end: number; selfClosing: boolean }

/**
 * Read one start tag at `i` (which points at `<`): tag name + attributes, honouring quoted values (a `>` inside quotes
 * does not end the tag). Returns null when `<` does not open a tag. Mirrors the tokenizer closely enough for the audit:
 * any disagreement makes the browser see an element we did not hash, which the CSP then refuses — never the reverse.
 */
function readTag(html: string, i: number): Tag | null {
  const m = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(i, i + 64));
  if (!m) return null;
  const name = m[1].toLowerCase();
  let p = i + m[0].length;
  const attrs = new Map<string, string>();
  let selfClosing = false;
  for (;;) {
    while (p < html.length && /\s/.test(html[p])) p++;
    if (p >= html.length) return null;
    if (html[p] === '>') { p++; break; }
    if (html[p] === '/') { selfClosing = true; p++; continue; }
    const a = /^([^\s"'>\/=]+)/.exec(html.slice(p, p + 256));
    if (!a) { p++; continue; } // a stray quote or `=`: the tokenizer skips it too
    const key = a[1].toLowerCase();
    p += a[0].length;
    while (p < html.length && /\s/.test(html[p])) p++;
    let value = '';
    if (html[p] === '=') {
      p++;
      while (p < html.length && /\s/.test(html[p])) p++;
      const q = html[p];
      if (q === '"' || q === "'") { const j = html.indexOf(q, p + 1); if (j < 0) return null; value = html.slice(p + 1, j); p = j + 1; }
      else { const v = /^[^\s>]*/.exec(html.slice(p))!; value = v[0]; p += v[0].length; }
    }
    if (!attrs.has(key)) attrs.set(key, value);
  }
  return { name, attrs, end: p, selfClosing };
}

/** Index of the `</name` that closes a raw-text element (script/style), case-insensitive, or -1. */
function rawTextEnd(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}[\\s/>]`, 'ig');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

/**
 * The document without its HTML comments — what the parsers actually see. Only top-level `<!-- -->` is a comment: inside
 * <script>/<style> the same characters are raw text (the CSS parser would still honour an `@import` written there).
 */
function withoutComments(html: string): string {
  let out = '', i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; continue; }
    const tag = readTag(html, lt);
    if (!tag) { out += '<'; i = lt + 1; continue; }
    if ((tag.name === 'script' || tag.name === 'style') && !tag.selfClosing) {
      const e = rawTextEnd(html, tag.name, tag.end);
      const end = e < 0 ? html.length : e;
      out += html.slice(lt, end); i = end; continue;
    }
    out += html.slice(lt, tag.end); i = tag.end;
  }
  return out;
}

/** Every start tag in the document, with the raw text of script/style elements (comments are skipped). */
function* walk(html: string): Generator<{ tag: Tag; raw?: string }> {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return;
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; continue; }
    const tag = readTag(html, lt);
    if (!tag) { i = lt + 1; continue; }
    if ((tag.name === 'script' || tag.name === 'style') && !tag.selfClosing) {
      const e = rawTextEnd(html, tag.name, tag.end);
      const raw = html.slice(tag.end, e < 0 ? html.length : e);
      yield { tag, raw };
      i = e < 0 ? html.length : e + 1;
    } else { yield { tag }; i = tag.end; }
  }
}

/**
 * The reasons a widget page is refused (empty = acceptable). Pure over the text; the CSP header is still the enforcement
 * for everything this does not model (inline handlers, remote images, forms, runtime injection) — this names the things
 * whose only purpose is loading code or documents from elsewhere, so a pack that tries is refused before it lands.
 */
export function auditWidgetHtml(html: string): string[] {
  const out: string[] = [];
  const text = withoutComments(html); // an author may write about these in a comment; a parser never sees one
  if (text.includes('__NONCE__')) out.push('"__NONCE__" is not substituted into a pack page (write plain <script>/<style>: each block is allow-listed by its hash)');
  let blocks = 0;
  const seen = new Set<string>();
  const push = (s: string): void => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
  // r4: `@import` is a CSS construct — it is refused where CSS is parsed (a <style> block, a style="" attribute), not in
  // a script string or prose (the verifier's probe pages tripped on the literal in JS text). A runtime-built <style> has
  // no hash and an @import inserted through CSSOM is a stylesheet fetch with no style-src source: the header holds there.
  const css = (s: string, where: string): void => {
    if (/@import\b/i.test(s)) push(`@import in ${where} (a stylesheet from elsewhere) is refused`);
    if (/@\\/.test(s)) push(`an escaped CSS at-rule name (@\\…) in ${where} is refused`);
  };
  for (const { tag, raw } of walk(html)) {
    if (tag.name === 'script') {
      for (const a of SCRIPT_SRC_ATTRS) if (tag.attrs.has(a)) push(`<script ${a}=…> (a script from elsewhere) is refused: every script is inline`);
      if (raw !== undefined && raw.length) blocks++;
    } else if (tag.name === 'style') { if (raw !== undefined && raw.length) { blocks++; css(raw, 'a <style> block'); } }
    else if (LOADER_TAGS.has(tag.name)) push(`<${tag.name}> is refused (it loads another document or resource)`);
    else if (tag.name === 'meta' && tag.attrs.has('http-equiv')) push('<meta http-equiv> is refused (headers are the host\'s)');
    if (tag.attrs.has('style')) css(tag.attrs.get('style') ?? '', 'a style attribute');
  }
  if (blocks > WIDGET_INLINE_MAX) out.push(`${blocks} inline script/style blocks (max ${WIDGET_INLINE_MAX})`);
  return out;
}

/**
 * The CSP hash-sources for the page's inline blocks, deduplicated, in document order. Call it on the EXACT text that is
 * served (after normalizeWidgetHtml); a block the browser sees differently simply does not run.
 */
export function inlineHashes(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [], styles: string[] = [];
  for (const { tag, raw } of walk(html)) {
    if (raw === undefined || !raw.length) continue;
    // a <script src> ignores its text in the browser (and the audit refused it anyway): nothing to hash
    if (tag.name === 'script' && !tag.attrs.has('src')) { const h = cspHash(raw); if (!scripts.includes(h)) scripts.push(h); }
    else if (tag.name === 'style') { const h = cspHash(raw); if (!styles.includes(h)) styles.push(h); }
  }
  return { scripts, styles };
}
