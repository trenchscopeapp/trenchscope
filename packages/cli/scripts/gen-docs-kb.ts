// Regenerate the docs KB entries (task-1420) from the site docs. Run after any docs page changes:
//   node packages/cli/scripts/gen-docs-kb.ts
// It reads ../site/content/docs/*.md (or $DEXTERM_SITE_DIR) and writes assets/kb/docs/*.md in @dexterm/mcp.
// The drift test (packages/cli/test/docs-kb-drift-1420.test.ts) fails until the committed files match a re-run.
// dexterm/scripts/docs-sync.sh (workspace) runs this plus the drift tests and the site checks.
import fs from 'node:fs';
import path from 'node:path';
import { buildDocsEntries, haveSite, SITE_DIR } from '../src/docs-kb-gen.ts';
import { serializeEntry } from '../src/app-help-gen.ts';
import { DOCS_KB_DIR } from '@dexterm/mcp';

if (!haveSite) {
  process.stderr.write(`no site docs at ${path.join(SITE_DIR, 'content', 'docs')}: nothing to generate (the committed entries stay)\n`);
  process.exit(1);
}

const entries = buildDocsEntries();
fs.mkdirSync(DOCS_KB_DIR, { recursive: true });

// Remove stale entries (a page or section that no longer exists).
const want = new Set(entries.map((e) => `${e.id}.md`));
for (const f of fs.readdirSync(DOCS_KB_DIR)) {
  if (f.endsWith('.md') && !want.has(f)) { fs.rmSync(path.join(DOCS_KB_DIR, f)); process.stdout.write(`removed stale ${f}\n`); }
}
for (const e of entries) fs.writeFileSync(path.join(DOCS_KB_DIR, `${e.id}.md`), serializeEntry(e), { mode: 0o644 });

const pages = new Set(entries.map((e) => String(e.frontmatter.page)));
process.stdout.write(`wrote ${entries.length} docs entries from ${pages.size} pages to ${DOCS_KB_DIR}\n`);
