// task-1415 — identity-hygiene ratchet: no person's name, handle, agency or machine name anywhere in the app tree
// (code, comments, tests, fixtures, frontmatter, evidence files). Write "the maintainers" instead.
//
// The term list is deliberately NOT in this repo (see identity-terms.ts): a public checkout has no kit, so the test
// skips there; a maintainer checkout (kit present) FAILS if the list itself is missing, so the ratchet cannot quietly
// switch off. Scope: every tracked + untracked-not-ignored file (what could ever be committed), and its path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT as ROOT, TERMS_FILE, haveKit, loadIdentityTerms as loadTerms } from './identity-terms.ts';

/** Files that could ever be committed: tracked + untracked-not-ignored. Falls back to a walk without git. */
function appFiles(): string[] {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0').filter(Boolean);
  } catch {
    const acc: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git', 'target'].includes(e.name) || e.name.startsWith('app-wt-')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r); else if (e.isFile()) acc.push(r);
      }
    };
    walk('');
    return acc;
  }
}

/** Every (term, line) hit in one text, case-insensitive plain substring. */
function scanText(text: string, terms: string[]): Array<{ term: string; line: number }> {
  const hits: Array<{ term: string; line: number }> = [];
  const lower = text.toLowerCase();
  for (const term of terms) {
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + 1)) {
      hits.push({ term, line: lower.slice(0, i).split('\n').length });
    }
  }
  return hits;
}

const skip = haveKit ? false : 'no maintainer distribution kit next to this checkout (public checkout): term list not available';

test('ratchet self-check: a listed term is caught in any case, and allow entries carry a written reason', { skip }, () => {
  const { terms, allow } = loadTerms();
  for (const term of terms) {
    const probe = `// written by ${term.toUpperCase()} on a Tuesday\nconst ok = 1;\n`;
    assert.deepEqual(scanText(probe, [term]), [{ term, line: 1 }], `term ${terms.indexOf(term)} is detected`);
  }
  for (const a of allow) assert.ok(a.path && a.term && typeof a.reason === 'string' && a.reason.trim().length >= 10, `allow entry for ${a.path} needs a written reason`);
});

test('no personal name, handle, agency or machine name in any app file or path (say "the maintainers")', { skip }, () => {
  const { terms, allow } = loadTerms();
  const allowed = (path: string, term: string) => allow.some((a) => a.path === path && a.term.toLowerCase() === term);
  const found: string[] = [];
  const files = appFiles();
  assert.ok(files.length > 100, `expected the app tree, got ${files.length} files`);
  for (const rel of files) {
    for (const h of scanText(rel, terms)) if (!allowed(rel, h.term)) found.push(`${rel} (path, term #${terms.indexOf(h.term)})`);
    let buf: Buffer;
    try { buf = readFileSync(join(ROOT, rel)); } catch { continue; } // deleted in the worktree but still tracked
    if (buf.includes(0)) continue; // binary
    for (const h of scanText(buf.toString('utf8'), terms)) if (!allowed(rel, h.term)) found.push(`${rel}:${h.line} (term #${terms.indexOf(h.term)})`);
  }
  // Term numbers, not the terms, so a CI log of a public fork never prints the list.
  assert.deepEqual(found, [], `identity terms found (index into ${TERMS_FILE}); rewrite as "the maintainers" / neutral fixtures:\n  ${found.join('\n  ')}`);
});
