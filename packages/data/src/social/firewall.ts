// @dexterm/data — prompt firewall on ingest for social text (task-1330; SPEC §5.3 CL-06, design §5.6).
//
// `firewallText()` runs on EVERY post, bio and headline before storage: NFC, strip control / bidi /
// zero-width / ANSI-OSC, collapse whitespace, replace URLs with `[url]` and base58 addresses with `[addr]`
// (unless the address is the row's own mint), truncate, and detect instruction-like content (imperatives
// aimed at an assistant, "ignore previous", role-play markers, fake system/tool markup). Detection sets
// the `injection` flag; the caller withholds such posts from the model entirely (design: a red flag,
// never a command). Posts never reach the terminal raw: wide glyphs become ▯ so a row can never overflow
// its cell, and no escape sequence survives.
//
// `untrustedBlock()` is the ONLY path by which a post is handed to the analyst: wrapped as
// `<untrusted source="x:post" author="…">…</untrusted>` with `<`/`>`/`&`/`"` escaped so the text cannot
// close the block or open a new one.

import { POST_STORED_MAX } from './model.ts';

/** Control, DEL, C1, zero-width, bidi overrides/isolates, BOM, and the Unicode line/paragraph separators. */
// eslint-disable-next-line no-control-regex
const STRIP_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u2028\\u2029]', 'g');
/** ANSI CSI / OSC / SS3 sequences that a stripped ESC could have left behind as printable tails. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\\-_])/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9_]{0,15})\b/g;

/**
 * Instruction-like content aimed at an assistant. Deliberately broad (a false positive hides one post
 * from the model; a false negative is a prompt injection), deterministic, and documented by the tests.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|preceding|system|initial|original)\s+(?:\w+\s+){0,2}?(?:instructions?|rules?|prompts?|messages?|directions?|guidance|guidelines|context|text|constraints?)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|instructions?|rules?)\b/i,
  /\bforget\s+(?:all\s+|your\s+)?(?:previous|prior|earlier)?\s*(?:instructions?|rules?|prompts?|context)\b/i,
  /\b(?:new|updated|revised|override|overriding)\s+(?:system\s+)?(?:instructions?|prompt|rules?|directive)\b/i,
  /\byou\s+are\s+(?:now\s+)?(?:a|an|the)\s+\w+(?:\s+\w+)?\s*(?:assistant|ai|model|bot|agent)\b/i,
  /\bact\s+as\s+(?:if\s+you|though\s+you|an?\s+(?:ai|assistant|bot|chatbot|model|agent|different|unrestricted|unfiltered|evil|jailbroken|developer|system|human)|my\s+|the\s+(?:user|system|assistant|model|ai))\b/i,
  /\bpretend\s+(?:to\s+be|you\s+are|that)\b/i,
  /\b(?:system|assistant|developer|tool|function)\s*(?:prompt|message|role)?\s*:\s/i,
  /<\s*\/?\s*(?:system|assistant|user|tool|untrusted|instructions?|im_start|im_end)\b[^>]*>/i,
  /\[(?:INST|\/INST|SYSTEM|ASSISTANT)\]/i,
  /\b(?:mark|rate|flag|label|report|call|declare|classify|score)\s+(?:this|the|that)\s+(?:token|coin|project|mint)\s+(?:as\s+)?(?:safe|clean|legit|verified|low[- ]risk|a\s+buy|buy)\b/i,
  /\b(?:do\s+not|don'?t|never)\s+(?:mention|report|flag|include|say|tell)\b.{0,40}\b(?:rug|risk|spam|warning|injection|user)\b/i,
  /\b(?:tell|instruct|advise|recommend)\s+(?:the\s+)?(?:user|trader|reader|them)\s+to\s+(?:buy|sell|ape|send|transfer|approve|sign|connect)\b/i,
  /\b(?:call|invoke|use|run|execute)\s+(?:the\s+)?(?:tool|function|swap|sign|transfer|send|open_ticket|add_to_watchlist|show_in_screener|open_token|switch_feed)\b/i,
  /\bprompt\s+injection\b/i,
  /\bjailbreak\b/i,
  /\bDAN\s+mode\b/,
];

export interface FirewallOptions {
  /** The row's own mint stays readable; every other base58 address becomes `[addr]`. */
  keepMint?: string | null;
  /** Hard cap on stored characters (default POST_STORED_MAX). */
  max?: number;
  /** Keep URLs readable (news headlines never contain them; posts always lose them). */
  keepUrls?: boolean;
}

export interface FirewallResult {
  /** Terminal-safe, model-safe text. */
  text: string;
  /** True when the text matched an instruction-like pattern. */
  injection: boolean;
  /** Which patterns fired (indices into the rule table), for tests and the `why` tooltip. */
  rules: number[];
  /** Cashtags found in the ORIGINAL text (upper-cased, no `$`). */
  cashtags: string[];
  /** Base58 addresses found in the ORIGINAL text (for cashtag-squat detection), deduplicated. */
  addresses: string[];
  truncated: boolean;
  /** Characters removed as control/bidi/zero-width/ANSI (non-zero is itself a weak spam signal). */
  strippedChars: number;
}

/** East Asian wide/fullwidth ranges and emoji blocks: two columns on most terminals. */
export function isWideCodePoint(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f000 && cp <= 0x1faff)
    || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x20000 && cp <= 0x3fffd);
}

/**
 * Make a string safe for the one-column cell canvas: drop combining marks / variation selectors /
 * skin tones, replace wide glyphs with ▯, keep everything else. Idempotent.
 */
export function terminalSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === 0x200d) continue;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    out += isWideCodePoint(cp) ? '▯' : ch;
  }
  return out;
}

/** The firewall proper. Total: never throws, always returns a string (possibly empty). */
export function firewallText(input: unknown, opts: FirewallOptions = {}): FirewallResult {
  const raw = input === null || input === undefined ? '' : String(input);
  const cashtags = [...new Set([...raw.matchAll(CASHTAG_RE)].map((m) => m[1].toUpperCase()))];
  const addresses = [...new Set(raw.match(BASE58_RE) ?? [])];
  let s = raw.normalize('NFC');
  const before = s.length;
  s = s.replace(ANSI_RE, '');
  s = s.replace(STRIP_RE, '');
  const strippedChars = before - s.length;
  s = s.replace(/\s+/g, ' ').trim();
  s = terminalSafe(s);
  // Detect BEFORE the URL/address rewrite so "visit [url] and ignore previous" still reads naturally,
  // and on the de-obfuscated text (zero-width joiners inside "ig​nore" are already gone).
  const rules: number[] = [];
  INJECTION_PATTERNS.forEach((re, i) => { if (re.test(s)) rules.push(i); });
  if (!opts.keepUrls) s = s.replace(URL_RE, '[url]');
  const keep = opts.keepMint ?? null;
  s = s.replace(BASE58_RE, (m) => (keep && m === keep ? m : '[addr]'));
  const max = opts.max ?? POST_STORED_MAX;
  let truncated = false;
  if (s.length > max) { s = s.slice(0, Math.max(0, max - 1)) + '…'; truncated = true; }
  return { text: s, injection: rules.length > 0, rules, cashtags, addresses, truncated, strippedChars };
}

const escapeAttr = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * Wrap already-firewalled text for the analyst. Escapes `<>&"` inside so the content can neither close
 * this block nor open another. `source` is like `x:post`, `news:coindesk.com`, `chain:rule`.
 */
export function untrustedBlock(text: string, source: string, author: string, extra: Record<string, string | number> = {}): string {
  const attrs = Object.entries(extra).map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`).join('');
  return `<untrusted source="${escapeAttr(source)}" author="${escapeAttr(author)}"${attrs}>${escapeAttr(text)}</untrusted>`;
}

/** Number of injection rules in the table (tests pin it so a rule change is a deliberate diff). */
export const INJECTION_RULE_COUNT = INJECTION_PATTERNS.length;
