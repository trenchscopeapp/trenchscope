// task-1415 — the identity-hygiene term list, for tests. It is NOT in this repo (listing the names here would publish
// them): it lives in the maintainers' distribution kit next to the app checkout (../distribution/identity/terms.json,
// never exported) or at $DEXTERM_IDENTITY_TERMS. A public checkout has no kit: `haveKit` is false and tests that need
// the list skip. A maintainer checkout (kit present) must have the list: `loadIdentityTerms()` throws otherwise.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KIT = resolve(APP_ROOT, '..', 'distribution');
export const TERMS_FILE = process.env.DEXTERM_IDENTITY_TERMS || join(KIT, 'identity', 'terms.json');
export const haveKit = !!process.env.DEXTERM_IDENTITY_TERMS || existsSync(join(KIT, 'export', 'manifest.json'));

export interface IdentityAllow { path: string; term: string; reason: string }
export interface IdentityTerms { terms: string[]; allow: IdentityAllow[] }

/** The lower-cased term list + allow entries. Throws when the kit is present but the list is missing or malformed. */
export function loadIdentityTerms(): IdentityTerms {
  if (!existsSync(TERMS_FILE)) throw new Error(`distribution kit present but the identity term list is missing: ${TERMS_FILE}`);
  const t = JSON.parse(readFileSync(TERMS_FILE, 'utf8')) as Partial<IdentityTerms>;
  if (!Array.isArray(t.terms) || !t.terms.length || !t.terms.every((s) => typeof s === 'string' && s.trim().length >= 3)) throw new Error(`${TERMS_FILE}: terms must be non-empty strings`);
  if (t.allow !== undefined && !Array.isArray(t.allow)) throw new Error(`${TERMS_FILE}: allow must be an array`);
  return { terms: t.terms.map((s) => s.toLowerCase()), allow: t.allow ?? [] };
}

/** One case-insensitive regex for every term (plain substrings), or null on a public checkout. */
export function identityRegex(): RegExp | null {
  if (!haveKit) return null;
  return new RegExp(loadIdentityTerms().terms.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
}
