// task-1420 — the docs KB cannot drift from the site docs. The site is a sibling checkout (../site) that a public
// checkout does not have: like the identity kit (identity-terms.ts `haveKit`), `haveSite` is false there and these
// tests SKIP; the committed entries still ship. In the maintainers' workspace they run:
//   1. regenerate-and-diff: the committed assets/kb/docs/*.md equal a fresh generation from site/content/docs;
//   2. coverage: every docs page has an intro entry, and every h2/h3 section has an entry whose anchor is the id the
//      site's own markdown renderer gives that heading (so the cited URL lands on the section);
//   3. determinism: two generations are byte-identical.
// Fix a failure with `node packages/cli/scripts/gen-docs-kb.ts` (or dexterm/scripts/docs-sync.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DOCS_KB_DIR } from '@dexterm/mcp';
import { buildDocsEntries, docsPages, haveSite, SITE_DIR } from '../src/docs-kb-gen.ts';
import { serializeEntry } from '../src/app-help-gen.ts';

const skip = haveSite ? false : 'no site checkout next to this app (public checkout): the docs drift check needs ../site';

test('regenerate-and-diff: committed docs KB entries match a fresh generation from the site (run gen-docs-kb.ts)', { skip }, () => {
  const entries = buildDocsEntries();
  const onDisk = fs.readdirSync(DOCS_KB_DIR).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(onDisk, entries.map((e) => `${e.id}.md`).sort(), 'the set of committed docs entry files differs from the generator (a page or section was added/removed)');
  const stale: string[] = [];
  for (const e of entries) if (fs.readFileSync(path.join(DOCS_KB_DIR, `${e.id}.md`), 'utf8') !== serializeEntry(e)) stale.push(e.id);
  assert.equal(stale.length, 0, `stale committed docs entries (re-run packages/cli/scripts/gen-docs-kb.ts): ${stale.join(', ')}`);
});

test('coverage: every docs page and every h2/h3 section has an entry, anchored where the site renders it', { skip }, async () => {
  const { renderMarkdown } = await import(pathToFileURL(path.join(SITE_DIR, 'lib', 'md.mjs')).href) as { renderMarkdown: (s: string) => { headings: Array<{ level: number; id: string }> } };
  const entries = buildDocsEntries();
  const pages = docsPages();
  assert.ok(pages.length >= 17, `expected every docs page, got ${pages.length}`);
  const missing: string[] = [];
  for (const file of pages) {
    const slug = file.slice(0, -3);
    const mine = entries.filter((e) => e.frontmatter.page === slug);
    if (!mine.some((e) => e.id === `docs-${slug}`)) missing.push(`${slug}: no intro entry`);
    const body = fs.readFileSync(path.join(SITE_DIR, 'content', 'docs', file), 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '');
    const anchors = new Set(mine.map((e) => String(e.frontmatter.anchor ?? '')));
    for (const h of renderMarkdown(body).headings) {
      if (h.level !== 2 && h.level !== 3) continue;
      if (!anchors.has(h.id)) missing.push(`${slug}#${h.id}: no entry with this anchor`);
    }
  }
  assert.deepEqual(missing, [], `docs sections without a KB entry:\n  ${missing.join('\n  ')}`);
});

test('determinism: two generations are byte-identical', { skip }, () => {
  const a = buildDocsEntries().map(serializeEntry);
  const b = buildDocsEntries().map(serializeEntry);
  assert.deepEqual(a, b);
});

test('a checkout without the site skips the drift checks cleanly (public-checkout path)', { skip: process.env.DEXTERM_DOCS_DRIFT_CHILD ? 'child run' : false }, () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-nosite-'));
  try {
    // NODE_TEST_CONTEXT would make the child report to this runner instead of printing its TAP summary.
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(import.meta.url)], {
      encoding: 'utf8', env: { ...env, DEXTERM_SITE_DIR: empty, DEXTERM_DOCS_DRIFT_CHILD: '1' },
    });
    assert.match(out, /# fail 0/);
    assert.match(out, /# pass 0/, 'with no site, nothing runs');
    assert.match(out, /# skipped 4/, 'all four tests skip');
    assert.match(out, /no site checkout next to this app/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
