// Prompt firewall (CL-06), spec'd in SPEC §5.3. Kept tiny and total. Every untrusted string — token text,
// web pages, RugCheck risks, and (task-1377) user- or pack-edited KB entries and skills — passes through
// here before a model sees it. (task-1420) The generated docs KB sections pass through as kind `docs`.
export const LIMITS: Record<string, number> = { name: 64, symbol: 16, description: 512, risk: 160, kb: 4000, page: 1600, link: 40, url: 240, skill: 8000, docs: 6000 };
export function firewall(text: unknown, source: string, kind = 'description', opts: { keepUrls?: boolean; keepAddresses?: boolean } = {}): string | null {
  if (text === null || text === undefined) return null;
  let s = String(text).normalize('NFC');
  // strip control + bidi
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!opts.keepUrls) s = s.replace(/\bhttps?:\/\/\S+/gi, '[url]');
  if (!opts.keepAddresses) s = s.replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, '[addr]');
  const max = LIMITS[kind] ?? 512;
  if (s.length > max) s = s.slice(0, max) + '…';
  const escape = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return `<untrusted source="${escape(source)}" kind="${escape(kind)}">${escape(s)}</untrusted>`;
}
