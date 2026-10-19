// trenchscope — generator for the docs knowledge base (task-1420).
//
// Builds the `@dexterm/mcp` docs KB entries (assets/kb/docs/*.md) from EVERY page of the site's docs
// (dexterm/site/content/docs/*.md), chunked by heading, so the analyst can answer from the docs and cite the
// exact page section (https://dexterm.xyz/docs/<slug>#<anchor>). The app-help KB (app-help-gen.ts) stays the
// authority for an exact key or command; these entries carry the docs' explanations and never a structured
// key/command/flag/tool list (docs text is data: nothing in it becomes a key, a command or an action).
//
// The site is a sibling checkout (../site from the app root) that a public checkout does not have: `haveSite`
// is false there, the drift test skips, and the committed entries still ship.
//
// Deterministic by construction: files in name order, no clock, no network, no writes here (the script does
// that). The site's `{{placeholders}}` are filled from the app at site build time; they are NOT expanded here
// (that would tie the KB to the app's current commit). `{{minNode}}` comes from site.json; the commit stamp
// sentences are dropped; every other placeholder becomes a pointer to the docs page section.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenEntry } from './app-help-gen.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** App root: packages/cli/src → up three. */
const ROOT = path.resolve(HERE, '..', '..', '..');
/** The site checkout next to the app (absent in a public checkout). `DEXTERM_SITE_DIR` overrides it. */
export const SITE_DIR = process.env.DEXTERM_SITE_DIR || path.resolve(ROOT, '..', 'site');
export const haveSite = fs.existsSync(path.join(SITE_DIR, 'content', 'docs'));

/** Stamped into every generated entry; bump on a deliberate regenerate. */
export const DOCS_GENERATED_DATE = '2026-10-16';
export const DOCS_BASE_URL = 'https://dexterm.xyz';

const SLUG_FILE = /^[a-z0-9][a-z0-9-]*\.md$/;
const MAX_ID = 64;

/** The site's heading slug (site/lib/html.mjs `slug`), applied to heading text without backticks. */
export function siteSlug(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The site's frontmatter split (site/lib/pages/docs.mjs `frontMatter`): flat `key: value` lines. */
function siteFrontMatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src.replace(/\r/g, ''));
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { meta, body: m[2] };
}

/** One frontmatter value on one line: no newlines, no leading/trailing quote the KB parser would strip. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^"+|"+$/g, '');
}

/** Absolute URL for a docs link: `/docs/x/#a` → https://dexterm.xyz/docs/x#a, `#a` → this page. */
export function docsUrl(href: string, pageUrl: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('#')) return `${pageUrl}${href}`;
  if (!href.startsWith('/')) return href;
  const d = /^\/docs\/([a-z0-9-]+)\/?(#[a-z0-9-]+)?$/.exec(href);
  if (d) return `${DOCS_BASE_URL}/docs/${d[1]}${d[2] ?? ''}`;
  return `${DOCS_BASE_URL}${href}`;
}

const HTML_TAG = /<\/?(?:kbd|code|a|em|strong|b|i|br|span|div|p|details|summary|table|thead|tbody|tr|td|th|img|ul|ol|li|sup|sub|small|figure|figcaption|hr)\b[^>]*>/gi;
const TAG_STOP = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'you', 'your', 'its', 'not', 'one', 'see', 'also', 'from', 'into', 'when', 'it', 'is', 'of', 'to', 'in', 'on', 'a', 'an', 'vs', 'by', 'or']);

/** Prose → KB body: placeholders resolved, links made absolute, inline HTML tags dropped (code fences kept as-is). */
function cleanBody(lines: string[], ctx: { pageUrl: string; sectionUrl: string; nodeMin: string | null }): string {
  const out: string[] = [];
  let fence = false;
  for (const raw of lines) {
    let line = raw;
    if (/^```/.test(line)) { fence = !fence; out.push(line); continue; }
    if (!fence) {
      // The commit-stamp sentences ("Generated against … at commit {{head}}.") describe the site build, not the app.
      line = line.replace(/(^|(?<=[.!?]\s))[^.!?\n]*\{\{head(?:Date)?\}\}[^\n]*?[.!?](?=\s|$)\s*/g, '');
      line = line.replace(/\[\[([^\]]+)\]\]/g, '`$1`'); // the site's [[key]] → <kbd> shorthand
      line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
      line = line.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => `${text} (${docsUrl(href, ctx.pageUrl)})`);
      line = line.replace(HTML_TAG, '');
    }
    line = line.replace(/\{\{minNode\}\}/g, ctx.nodeMin ?? `(see ${ctx.sectionUrl})`);
    line = line.replace(/\{\{[^}]*\}\}/g, `(generated from the app: see ${ctx.sectionUrl}; app-help has the exact keys and commands)`);
    out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function tagsFor(...texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const w of t.replace(/`/g, '').toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? []) {
      if (w.length < 3 || TAG_STOP.has(w) || out.includes(w)) continue;
      out.push(w);
    }
  }
  return out.slice(0, 12);
}

/** A KB id ≤ 64 chars (cut at a dash), unique within this run. */
function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  if (id.length > MAX_ID) { id = id.slice(0, MAX_ID); const d = id.lastIndexOf('-'); if (d > 20) id = id.slice(0, d); }
  let out = id, n = 2;
  while (used.has(out)) { const suf = `-${n++}`; out = id.slice(0, MAX_ID - suf.length) + suf; }
  used.add(out);
  return out;
}

interface Section { level: number; heading: string; anchor: string; lines: string[] }

/** Split a page into its intro + one section per h2/h3, with anchors exactly as the site renders them. */
export function splitPage(body: string): { intro: string[]; sections: Section[] } {
  const ids = new Set<string>();
  const uid = (text: string) => { const base = siteSlug(text.replace(/`/g, '')); let id = base, n = 2; while (ids.has(id)) id = `${base}-${n++}`; ids.add(id); return id; };
  const lines = body.replace(/\r/g, '').split('\n');
  const intro: string[] = [];
  const sections: Section[] = [];
  let cur: string[] = intro;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      // a fenced block: copied whole, never scanned for headings (mirrors the site renderer)
      cur.push(line);
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) cur.push(lines[i]);
      if (i < lines.length) cur.push(lines[i]);
      continue;
    }
    if (/^<(?!kbd|code|a |em|strong)[a-z!]/.test(line)) {
      // a raw HTML block (until a blank line): the site does not read headings inside it either
      for (; i < lines.length && lines[i].trim(); i++) cur.push(lines[i]);
      i--;
      continue;
    }
    const h = /^(#{1,4})\s+(.+?)\s*(?:\{#([a-z0-9-]+)\})?$/.exec(line);
    if (h) {
      const level = h[1].length;
      const anchor = h[3] ? (ids.add(h[3]), h[3]) : uid(h[2]);
      if (level === 2 || level === 3) {
        const s: Section = { level, heading: h[2].replace(/`/g, ''), anchor, lines: [] };
        sections.push(s);
        cur = s.lines;
        continue;
      }
      cur.push(line); // h1/h4 stay inside their section as text
      continue;
    }
    cur.push(line);
  }
  return { intro, sections };
}

/** Every docs page file (name order), or [] when the site is absent. */
export function docsPages(siteDir: string = SITE_DIR): string[] {
  const dir = path.join(siteDir, 'content', 'docs');
  try { return fs.readdirSync(dir).filter((f) => SLUG_FILE.test(f)).sort(); } catch { return []; }
}

/** Build every docs KB entry from the site's docs pages. Throws when the site has no docs directory. */
export function buildDocsEntries(siteDir: string = SITE_DIR): GenEntry[] {
  const dir = path.join(siteDir, 'content', 'docs');
  if (!fs.existsSync(dir)) throw new Error(`no site docs at ${dir} (the site checkout is not next to the app)`);
  let nodeMin: string | null = null;
  try { nodeMin = String((JSON.parse(fs.readFileSync(path.join(siteDir, 'site.json'), 'utf8')) as { nodeMin?: unknown }).nodeMin ?? '') || null; } catch { /* no site.json */ }

  const out: GenEntry[] = [];
  const used = new Set<string>();
  for (const file of docsPages(siteDir)) {
    const slug = file.slice(0, -3);
    const { meta, body } = siteFrontMatter(fs.readFileSync(path.join(dir, file), 'utf8'));
    const pageTitle = oneLine(meta.title || slug);
    const description = oneLine(meta.description || '');
    const pageUrl = `${DOCS_BASE_URL}/docs/${slug}`;
    const { intro, sections } = splitPage(body);

    const entry = (heading: string, anchor: string, lines: string[], parent: string | null) => {
      const url = anchor ? `${pageUrl}#${anchor}` : pageUrl;
      let text = cleanBody(lines, { pageUrl, sectionUrl: url, nodeMin });
      if (!anchor && description) text = text ? `${description}\n\n${text}` : description;
      if (!text) return;
      const head = oneLine(heading);
      const title = head ? `${pageTitle} › ${parent ? `${oneLine(parent)} › ` : ''}${head}` : pageTitle;
      const id = uniqueId(anchor ? `docs-${slug}-${anchor}` : `docs-${slug}`, used);
      const fmo: Array<[string, unknown]> = [
        ['id', id], ['title', title], ['kind', 'docs'], ['page', slug], ['page_title', pageTitle],
        ['heading', head], ['anchor', anchor], ['url', url],
        ['tags', ['docs', slug, ...tagsFor(head, parent ?? '', pageTitle).filter((t) => t !== slug && t !== 'docs')]],
        ['confidence', 'high'], ['owner', 'maintainers'], ['origin', 'docs-generated'],
        ['reviewed_by', `generated@${DOCS_GENERATED_DATE}`],
        ['generated_from', 'dexterm/site content/docs (task-1420)'],
        ['sources', [`site/content/docs/${file}`]],
        ['date', DOCS_GENERATED_DATE],
      ];
      const frontmatter: Record<string, unknown> = {};
      for (const [k, v] of fmo) if (v !== '' && !(Array.isArray(v) && v.length === 0)) frontmatter[k] = v;
      out.push({ id, frontmatter, body: text });
    };

    entry('', '', intro, null);
    let h2: string | null = null;
    for (const s of sections) {
      if (s.level === 2) h2 = s.heading;
      entry(s.heading, s.anchor, s.lines, s.level === 3 ? h2 : null);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
