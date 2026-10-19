// Conservative robots policy for analyst page reads, never a bypass for blocked pages.
import { safeFetch, SsrfError, type SafeFetchOptions, type SafeFetchResult } from './safe-fetch.ts';

// Iterative wildcard matching avoids regex backtracking on attacker-owned robots.
function pathMatches(pattern: string, target: string): boolean {
  const unreserved = (s: string) => s.replace(/%([a-f0-9]{2})/gi, (m, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[a-z0-9._~-]/i.test(ch) ? ch : m.toUpperCase();
  });
  pattern = unreserved(pattern); target = unreserved(target);
  const exact = pattern.endsWith('$');
  const p = (exact ? pattern.slice(0, -1) : pattern + '*');
  let i = 0, j = 0, star = -1, retry = 0;
  while (j < target.length) {
    if (p[i] === '*') { star = i++; retry = j; }
    else if (p[i] === target[j]) { i++; j++; }
    else if (star >= 0) { i = star + 1; j = ++retry; }
    else return false;
  }
  while (p[i] === '*') i++;
  return i === p.length;
}

/** RFC-style product groups and longest-path allow/disallow matching. */
export function robotsAllows(text: string, url: URL): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let group = { agents: [] as string[], rules: [] as Array<{ allow: boolean; path: string }> };
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line.split('#')[0]);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2];
    if (key === 'user-agent') {
      if (group.rules.length) { groups.push(group); group = { agents: [], rules: [] }; }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length && (key === 'allow' || key === 'disallow') && value) {
      group.rules.push({ allow: key === 'allow', path: value });
    }
  }
  groups.push(group);
  const specific = groups.filter((g) => g.agents.includes('dexterm'));
  const selected = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  let best = -1, allowed = true;
  for (const rule of selected.flatMap((g) => g.rules)) {
    if (pathMatches(rule.path, url.pathname + url.search)) {
      const length = rule.path.replaceAll('*', '').length;
      if (length > best || (length === best && rule.allow)) { best = length; allowed = rule.allow; }
    }
  }
  return allowed;
}

export async function fetchPage(url: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  // Per-operation cache only: no persistent untrusted state, and every origin
  // reached by a redirect gets its own robots check through the SSRF transport.
  const robots = new Map<string, SafeFetchResult>();
  return safeFetch(url, { ...options, beforeRequest: async (target) => {
    let result = robots.get(target.origin);
    if (!result) {
      result = await safeFetch(new URL('/robots.txt', target).href, { ...options, beforeRequest: undefined, maxBytes: 64 * 1024, timeoutMs: 3000 });
      robots.set(target.origin, result);
    }
    if ([404, 410].includes(result.status) && !result.blocked) return;
    if (!result.ok || result.blocked || result.truncated) throw new SsrfError('robots unavailable; page not fetched');
    // A long requested crawl delay cannot fit this interactive tool's budget.
    // Decline the page rather than quietly violate it (even for another group).
    if ([...result.body.matchAll(/^\s*crawl-delay\s*:\s*([\d.]+)/gim)].some((m) => Number(m[1]) > 1)) throw new SsrfError('robots crawl-delay exceeds interactive budget; page not fetched');
    if (!robotsAllows(result.body, target)) throw new SsrfError('robots disallow; page not fetched');
  } });
}
