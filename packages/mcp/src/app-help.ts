// @dexterm/mcp — the app-help knowledge base (task-1413).
//
// A SECOND bundled KB set, separate from the 17 memecoin-risk entries, that teaches an agent how dexterm
// ITSELF works: what each screen shows, the exact key for a task, the CLI subcommand/flag, and the MCP
// tools. The entries in `assets/kb/app-help/*.md` are GENERATED from the app's own keymap / help overlay /
// MCP tool list / CLI by `packages/cli/src/app-help-gen.ts` (committed, run in tests), so they cannot drift
// from the real app. This module only LOADS and SEARCHES them — it is read-only and dependency-free.
//
// It is kept out of the main KB store on purpose: the memecoin KB's "exactly 17 bundled entries" invariant
// stays true, and a "how do I …" search hits app-help first without the two sets diluting each other.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundled, type ContentEntry } from './user-content.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The shipped app-help KB directory (read-only; generated). */
export const APP_HELP_DIR = path.resolve(HERE, '..', 'assets', 'kb', 'app-help');

/** One app-help entry with its structured fields surfaced (all lists default to []). */
export interface AppHelpEntry {
  id: string;
  title: string;
  /** The screen this is about, or 'all' for a global/CLI topic. */
  screen: string;
  tags: string[];
  /** Canonical key ids a user presses (e.g. 'E', '?', 'ctrl+w s'); '' for pure-CLI topics. */
  keys: string[];
  /** Keymap action ids referenced (for drift checks against the keymap). */
  actions: string[];
  /** `dexterm` subcommands referenced (e.g. 'doctor', 'voice'). */
  commands: string[];
  /** CLI flags referenced (e.g. '--fixtures', '--export'). */
  flags: string[];
  /** MCP tool names referenced (e.g. 'larp_check'). */
  tools: string[];
  /** features.json id this maps to, or ''. */
  feature: string;
  body: string;
  bytes: number;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [];
}

function toAppHelp(e: ContentEntry): AppHelpEntry {
  return {
    id: e.id,
    title: String(e.meta.title ?? e.id),
    screen: String(e.meta.screen ?? 'all'),
    tags: list(e.meta.tags),
    keys: list(e.meta.keys),
    actions: list(e.meta.actions),
    commands: list(e.meta.commands),
    flags: list(e.meta.flags),
    tools: list(e.meta.tools),
    feature: String(e.meta.feature ?? ''),
    body: e.body,
    bytes: e.bytes,
  };
}

/** Load every app-help entry (bundled-only; deterministic order by id). */
export function loadAppHelp(dir: string = APP_HELP_DIR): AppHelpEntry[] {
  const entries = loadBundled([{ dir, layout: 'flat' }]).map(toAppHelp);
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

// Generic words that carry no retrieval signal in a "how do I …" question — dropped before scoring so a
// short noise word ('to', 'my') can't substring-match an unrelated entry and outrank the real one.
const STOP = new Set([
  'how', 'do', 'does', 'did', 'the', 'a', 'an', 'to', 'my', 'me', 'i', 'is', 'it', 'its', 'of', 'in', 'on',
  'at', 'by', 'or', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'your', 'you', 'can', 'what',
  'which', 'where', 'when', 'who', 'am', 'are', 'be', 'get', 'got', 'use', 'using', 'make', 'want', 'need',
  'from', 'into', 'show', 'see', 'tell', 'about', 'some', 'any', 'all', 'up', 'out', 'off', 'on',
  // generic action verbs — they appear in many entry titles ("Change…", "Switch…") and carry no signal.
  'change', 'switch', 'set', 'setting', 'turn', 'open', 'close', 'enable', 'disable', 'add', 'remove',
  'start', 'stop', 'run', 'cycle', 'pick', 'choose', 'save', 'view', 'check',
]);

function tokenise(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? []).filter((t) => !STOP.has(t));
}

/** A short, deterministic how-to synonym map so natural phrasings land on the right entry. */
const QUERY_SYNONYMS: Record<string, string> = {
  paste: 'open', ca: 'open', 'contract-address': 'open', address: 'open', link: 'open',
  screenshot: 'export', save: 'export', png: 'export', report: 'export', share: 'export',
  speed: 'rate', faster: 'rate', slower: 'rate', wpm: 'rate',
  speak: 'voice', talk: 'voice', jarvis: 'voice', mic: 'voice', microphone: 'voice',
  notify: 'alert', notification: 'alerts', telegram: 'alerts', discord: 'alerts',
  filtering: 'filter', query: 'filter',
  marketcap: 'mcap', 'market-cap': 'mcap', cap: 'mcap',
  honeypot: 'rug', safe: 'rug', scam: 'rug',
  fake: 'larp', legit: 'larp', real: 'larp', website: 'larp', 'rug-pull': 'rug',
  agent: 'mcp', agents: 'mcp', bot: 'mcp', claude: 'analyst',
  helius: 'key', rpc: 'key', holders: 'key',
  layout: 'workspace', workspaces: 'workspace',
  keybind: 'keymap', keybinding: 'keymap', rebind: 'keymap', shortcut: 'keymap',
  theme: 'theme', colour: 'theme', color: 'theme',
  buy: 'paper', sell: 'paper', trade: 'paper', ticket: 'paper',
  upgrade: 'update',
  chart: 'popup', candles: 'popup',
  bubbles: 'bubble', cluster: 'bubble', clusters: 'bubble',
  scanner: 'scan', watcher: 'scan',
  copy: 'follow', mirror: 'follow', unfollow: 'follow',
};

function expand(terms: string[]): string[] {
  const out = new Set(terms);
  for (const t of terms) { const s = QUERY_SYNONYMS[t]; if (s) out.add(s); }
  return [...out];
}

/** Raw word tokens of a haystack (no stopword filtering), for exact word-boundary matching. */
function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? [];
}

/**
 * Deterministic keyword retrieval over the app-help set (no model). Matches on WORD BOUNDARIES (not
 * substrings) so "screener" does not match the tag "dexscreener" and "token" does not match a tool name
 * like "open_token". title/tags/screen/feature score strongest; the body is the weak tail.
 */
export function searchAppHelp(query: string, limit = 5, entries: AppHelpEntry[] = loadAppHelp()): Array<AppHelpEntry & { score: number }> {
  const terms = expand(tokenise(query));
  // A query whose only meaningful word is a screen name ("what does the screener show") is a request for
  // that screen's overview, not for a topic that happens to run there.
  const soleScreen = terms.length === 1 ? terms[0] : null;
  // An explicit "... screen ..." question ("what does the kol screen show") is a request for that screen's
  // overview even when other words survive; boost the matching overview so it beats a topic that shares the name.
  const asksScreen = words(query).includes('screen');
  const scored = entries.map((e) => {
    const overview = e.id.startsWith('screen-');
    // Screen field matches only for an overview entry; on a topic it is just where the action happens.
    const strong = new Set(words(`${e.title} ${e.tags.join(' ')} ${e.feature}${overview ? ' ' + e.screen : ''}`));
    // An overview's body is the enumerated key list — it names every action word, so it is NOT scored
    // (else "sort the screener" would match the screener overview's `s — sort` line over the sort topic).
    const bodyWords = overview ? [] : words(e.body);
    let score = 0;
    for (const t of terms) {
      if (strong.has(t)) score += 4;
      let n = 0;
      for (const w of bodyWords) if (w === t) n++;
      score += Math.min(n, 3);
    }
    if (overview && soleScreen && soleScreen === e.screen) score += 6;
    if (overview && asksScreen && terms.includes(e.screen)) score += 3;
    return { e, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || a.e.id.localeCompare(b.e.id))
    .slice(0, limit);
  return scored.map(({ e, score }) => ({ ...e, score }));
}

/** Fetch one app-help entry by id. */
export function getAppHelp(id: string, entries: AppHelpEntry[] = loadAppHelp()): AppHelpEntry | null {
  return entries.find((e) => e.id === id) ?? null;
}

// ---------------------------------------------------------------------------------------- docs (task-1420)
// A THIRD bundled set: every page of the site docs (dexterm.xyz/docs), chunked by heading. GENERATED from the
// site by `packages/cli/src/docs-kb-gen.ts` (committed; a regenerate-and-diff test runs when the site checkout
// is present). The app-help entries stay the authority for an exact key or command; a docs entry carries the
// explanation and the URL to cite, and NEVER structured keys/commands/flags/tools. Its text is reference DATA:
// the app_help tool hands it to a model firewalled (`<untrusted kind="docs">`), so an instruction written into
// a docs page reads as quoted text, never as an order.

/** The shipped docs KB directory (read-only; generated from the site docs). */
export const DOCS_KB_DIR = path.resolve(HERE, '..', 'assets', 'kb', 'docs');

/** One docs entry: a section of a docs page. */
export interface DocsEntry {
  id: string;
  title: string;
  /** The docs page slug (`spectator` for /docs/spectator). */
  page: string;
  pageTitle: string;
  /** The section heading ('' for a page's intro). */
  heading: string;
  /** The heading anchor on the page ('' for the intro). */
  anchor: string;
  /** The URL to cite: https://dexterm.xyz/docs/<slug>#<anchor>. */
  url: string;
  tags: string[];
  body: string;
  bytes: number;
}

function toDocs(e: ContentEntry): DocsEntry {
  return {
    id: e.id,
    title: String(e.meta.title ?? e.id),
    page: String(e.meta.page ?? ''),
    pageTitle: String(e.meta.page_title ?? ''),
    heading: String(e.meta.heading ?? ''),
    anchor: String(e.meta.anchor ?? ''),
    url: String(e.meta.url ?? ''),
    tags: list(e.meta.tags),
    body: e.body,
    bytes: e.bytes,
  };
}

/** Load every docs entry (bundled-only; deterministic order by id). */
export function loadDocsKb(dir: string = DOCS_KB_DIR): DocsEntry[] {
  const entries = loadBundled([{ dir, layout: 'flat' }]).map(toDocs);
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

/**
 * A light, deterministic stemmer for the docs set only (prose, unlike the app-help titles): "answers"/"answer",
 * "cached"/"cache", "clarifies"/"clarify", "streaming"/"stream" meet. Short words are left alone.
 */
function stem(w: string): string {
  if (w.length < 4 || w.includes('-')) return w;
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (/(?:ss|sh|ch|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s;
}

/**
 * Deterministic keyword retrieval over the docs set (no model), same word-boundary matching as app-help.
 * The section heading and tags score strongest, the page title less (every section of a page shares it),
 * the body is the weak tail.
 */
export function searchDocs(query: string, limit = 5, entries: DocsEntry[] = loadDocsKb()): Array<DocsEntry & { score: number }> {
  const terms = [...new Set(expand(tokenise(query)).map(stem))];
  const scored = entries.map((e) => {
    const strong = new Set(words(`${e.heading} ${e.tags.filter((t) => t !== 'docs').join(' ')}`).map(stem));
    const page = new Set(words(`${e.pageTitle} ${e.page}`).map(stem));
    const bodyWords = words(e.body).map(stem);
    let score = 0;
    for (const t of terms) {
      if (strong.has(t)) score += 4;
      else if (page.has(t)) score += 2;
      let n = 0;
      for (const w of bodyWords) if (w === t) n++;
      score += Math.min(n, 3);
    }
    // A question that names a section's own heading words is about that section: +3 per heading word
    // matched (+2 more when it names all of them), so "what is redacted in the spectator view" lands on "What is redacted",
    // not on the page's other sections that merely share the page title.
    const head = new Set(tokenise(e.heading).map(stem));
    let hit = 0;
    for (const w of head) if (terms.includes(w)) hit++;
    if (hit >= 1 && head.size > 0) score += 3 * hit + (hit === head.size ? 2 : 0);
    return { e, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || a.e.id.localeCompare(b.e.id))
    .slice(0, limit);
  return scored.map(({ e, score }) => ({ ...e, score }));
}

/** Fetch one docs entry by id. */
export function getDocs(id: string, entries: DocsEntry[] = loadDocsKb()): DocsEntry | null {
  return entries.find((e) => e.id === id) ?? null;
}

/** Words that make a question about an exact key or command: app-help answers it. */
const KEY_OR_COMMAND = /\b(?:key|keys|keybind\w*|press|pressing|shortcut|shortcuts|hotkey|hotkeys|command|commands|subcommand|subcommands|flag|flags|cli)\b/i;
/** "how do I …" / "how to …": a how-to, answered by an app-help topic. */
const HOW_TO = /^\s*how\s+(?:do|can|could|would|should)\s+(?:i|you|we)\b|^\s*how\s+to\b/i;
/** A conceptual question opens with a question word ("what is …", "does it …", "how does …", "how long …"). */
const CONCEPT = /^\s*(?:what|whats|what's|why|is|are|does|do|did|can|could|will|would|should|where|when|which|who|how)\b/i;

/** About a screen ("what does the token screen show") or the coin on it ("is this coin a rug"): an app-help topic/tool. */
const APP_SUBJECT = /\b(?:screen|screener)\b|\bthis\s+(?:[a-z-]+\s+){0,2}(?:coin|token|project)\b/i;

/** The question's shape: 'key' (exact key/command, a how-to, an imperative, a screen/this-coin question) or 'concept'. */
export function helpIntent(query: string): 'key' | 'concept' {
  if (KEY_OR_COMMAND.test(query) || HOW_TO.test(query) || APP_SUBJECT.test(query)) return 'key';
  return CONCEPT.test(query) ? 'concept' : 'key';
}

export type HelpHit =
  | (AppHelpEntry & { origin: 'app-help'; score: number })
  | (DocsEntry & { origin: 'docs'; score: number });

/**
 * The analyst's help search (task-1420): app-help AND the docs, merged by the question's shape.
 *  - a key/command question, a how-to or an imperative ("export the view", "how do I sort"): app-help ranks
 *    first (it carries the exact key/command), the docs after it;
 *  - a conceptual question ("what is redacted in the spectator view", "does voice work on linux"): the docs rank
 *    first (nothing ranks above them), the app-help after.
 * Either way the answer keeps both sets in view: up to 3 hits of the leading set, then up to 2 of the other,
 * then the rest. A set with no hits simply yields to the other (a docs-only answer beats no answer).
 */
export function searchHelp(
  query: string, limit = 5,
  sets: { appHelp?: AppHelpEntry[]; docs?: DocsEntry[] } = {},
): HelpHit[] {
  const app: HelpHit[] = searchAppHelp(query, limit, sets.appHelp ?? loadAppHelp()).map((e) => ({ ...e, origin: 'app-help' as const }));
  const docs: HelpHit[] = searchDocs(query, limit, sets.docs ?? loadDocsKb()).map((e) => ({ ...e, origin: 'docs' as const }));
  const [lead, other] = helpIntent(query) === 'concept' ? [docs, app] : [app, docs];
  return [...lead.slice(0, 3), ...other.slice(0, 2), ...lead.slice(3), ...other.slice(2)].slice(0, limit);
}
