// Voice resolution, the novelty ban-list, and speech-text sanitisation (task-1393). All pure and
// dependency-free so every rule is unit-testable without spawning `say`.
//
// Why this exists: SayTts used to be constructed with NO default voice, so macOS fell back to the
// machine's *system* voice — which differs per machine and can be a novelty/odd voice (a maintainer heard a
// "terrifying" one). This module makes the default an EXPLICIT deep British male and guarantees a
// novelty voice (Zarvox, Bad News, …) can never be auto-selected and the system default is never used
// silently: if nothing safe is installed, voice degrades to text (voice === null), never to "whatever
// the OS picks".

/** A voice as `say -v '?'` reports it: display name + BCP-47-ish locale (e.g. `en_GB`). */
export interface VoiceInfo {
  name: string;
  locale: string;
}

/** How a voice was chosen, for the `trenchscope doctor` "why" line. */
export type VoiceSource = 'config' | 'default' | 'british' | 'english' | 'none';

export interface VoiceResolution {
  /** The voice to pass to `say -v`; null means "no safe voice — replies stay text-only" (never the system default). */
  voice: string | null;
  source: VoiceSource;
  /** Human-readable reason for the doctor / status line. */
  reason: string;
}

/**
 * Novelty / "scary" voices that must never be auto-selected, normalised to lowercase base names (the
 * locale qualifier like " (English (UK))" is stripped first — see normalizeVoiceName). The list is the
 * classic MacinTalk novelty set plus the names the task named explicitly ("and similar"). The resolver
 * also uses POSITIVE allow-lists, so this is defence in depth; the ban test asserts no resolved voice
 * is ever on it.
 */
export const BANNED_VOICE_NAMES: ReadonlySet<string> = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged', 'fred',
  'good news', 'hysterical', 'jester', 'junior', 'organ', 'pipe organ', 'princess', 'ralph',
  'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox',
]);

/**
 * Strip the locale qualifier macOS appends to the newer voices ("Eddy (English (UK))" → "Eddy"),
 * collapse whitespace, lowercase. Used for ban/allow matching so "Eddy (English (US))" and
 * "Eddy (English (UK))" share one base name.
 */
export function normalizeVoiceName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
}

/** True when a voice is on the novelty ban-list (matched on its normalised base name). */
export function isBannedVoice(name: string): boolean {
  return BANNED_VOICE_NAMES.has(normalizeVoiceName(name));
}

/**
 * Parse the output of `say -v '?'`. Each line is `<name>  <locale>  # <sample sentence>`, but the name
 * column is only padded to a fixed width, so a LONG name ("Eddy (English (UK))") leaves a SINGLE space
 * before the locale — the old regex required two and silently dropped exactly the en_GB voices we care
 * about. This parser anchors on the trailing locale token instead, so it never loses a voice.
 */
export function parseSayVoices(stdout: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    const hash = raw.indexOf('#');
    const left = (hash >= 0 ? raw.slice(0, hash) : raw).trimEnd();
    // name = everything up to the last whitespace run; locale = the final token (en, en_GB, zh-CN…).
    const m = left.match(/^(.*\S)\s+([a-z]{2}(?:[_-][A-Za-z0-9]+)?)$/);
    if (m) voices.push({ name: m[1].trim(), locale: m[2] });
  }
  return voices;
}

/**
 * Deep British male voices, best-to-worst. Eddy (the maintainers' pick, 2026-10-15) is the trenchscope default; Daniel is the canonical deep British male that
 * ships with every macOS and is the next fallback. Oliver/Arthur are the newer en_GB male voices (present only if the
 * user downloaded them). Matched on normalised base name.
 */
export const BRITISH_MALE_PREFERENCE: readonly string[] = ['eddy', 'daniel', 'oliver', 'arthur'];

/**
 * Per-voice delivery defaults, applied only when the user has not saved their own rate/pitch.
 *
 * task-1411: the old Eddy override (rate 168 + pbas 30) came from an audition sample the maintainers never
 * explicitly picked; it was reported as "crazy bad" and "way too slow", and the pitch shift distorted
 * the voice. It is removed: every voice now uses the engine-wide DEFAULT_RATE (a brisk ~205 wpm) and NO
 * pitch override unless the user sets `voice.pitch` themselves. Keep this map empty rather than deleting
 * the hook, so a future per-voice tweak has a home and the public `voiceStyleDefaults` export is stable.
 */
export const VOICE_STYLE_DEFAULTS: Readonly<Record<string, { rate: number; pitch: number }>> = {};

/** The delivery defaults for a resolved voice name, or undefined to use the engine-wide defaults. */
export function voiceStyleDefaults(name: string | null | undefined): { rate: number; pitch: number } | undefined {
  return name ? VOICE_STYLE_DEFAULTS[normalizeVoiceName(name)] : undefined;
}

/**
 * en_GB voices that read masculine / neutral and are acceptable British fallbacks when no first-class
 * British male is installed (Grandpa is explicitly a male voice; Eddy/Reed/Rocko are the modern
 * expressive voices under audition). Matched on normalised base name, en_GB locale only.
 */
export const BRITISH_FALLBACK: readonly string[] = ['grandpa', 'eddy', 'reed', 'rocko'];

/** Safe English male voices in any English locale, used only when nothing British is installed. */
export const ENGLISH_MALE_ALLOW: readonly string[] = ['daniel', 'oliver', 'arthur', 'alex', 'tom', 'aaron', 'rishi'];

const isEnglish = (locale: string): boolean => /^en([_-]|$)/i.test(locale);
const isBritish = (locale: string): boolean => /^en[_-]gb$/i.test(locale);

/** Pick the best installed match for a base name, preferring an Enhanced/Premium variant and the given locale. */
function bestMatch(installed: VoiceInfo[], base: string, preferLocale?: (l: string) => boolean): VoiceInfo | null {
  const matches = installed.filter((v) => normalizeVoiceName(v.name) === base && !isBannedVoice(v.name));
  if (!matches.length) return null;
  const score = (v: VoiceInfo): number => {
    let s = 0;
    if (/\((enhanced|premium)\)/i.test(v.name)) s += 4; // higher-quality download, if present
    if (preferLocale?.(v.locale)) s += 2;
    return s;
  };
  return matches.slice().sort((a, b) => score(b) - score(a))[0];
}


/**
 * Find the installed voice a saved name refers to. The `,` key saves the FULL name ("Eddy (English (UK))"),
 * and Eddy/Reed/Rocko each exist in many languages, so an exact full-name match must win. Only when the
 * saved name is a bare base name ("Eddy") do we choose among same-base voices: en_GB first, then any
 * English, then anything else (a verifier found "Reed (English (UK))" resolving to the German Reed).
 */
function findConfiguredVoice(installed: VoiceInfo[], configured: string): VoiceInfo | undefined {
  const exact = installed.find((v) => v.name === configured && !isBannedVoice(v.name));
  if (exact) return exact;
  const folded = configured.toLowerCase();
  const ci = installed.find((v) => v.name.toLowerCase() === folded && !isBannedVoice(v.name));
  if (ci) return ci;
  const base = normalizeVoiceName(configured);
  const rank = (v: VoiceInfo): number => (isBritish(v.locale) ? 0 : isEnglish(v.locale) ? 1 : 2);
  return installed
    .filter((v) => normalizeVoiceName(v.name) === base && !isBannedVoice(v.name))
    .sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Resolve the voice `say` should use. The fallback chain, in order:
 *   1. the user's configured voice (if installed and not banned)
 *   2. the chosen default: a British male (Eddy → Daniel → Oliver → Arthur), Enhanced/Premium preferred
 *   3. the next British voice (en_GB Grandpa/Eddy/Reed/Rocko)
 *   4. any safe English male voice (Alex/Tom/…)
 *   5. null → replies stay text-only
 * A banned (novelty) voice is NEVER returned, and the OS system default is NEVER used silently.
 */
export function resolveVoice(opts: { configured?: string | null; installed: VoiceInfo[] }): VoiceResolution {
  const installed = opts.installed ?? [];
  const configured = opts.configured?.trim();

  // 1. Configured voice wins when it is actually installed and safe.
  if (configured) {
    const hit = findConfiguredVoice(installed, configured);
    if (hit && !isBannedVoice(hit.name)) {
      return { voice: hit.name, source: 'config', reason: `your configured voice (${hit.name})` };
    }
    // Configured but missing or banned: fall through to the safe default rather than honour a bad value.
  }

  // 2. Chosen default: British male (Eddy → Daniel → …). en_GB only: Eddy also exists in other locales.
  const britishInstalled = installed.filter((v) => isBritish(v.locale));
  for (const base of BRITISH_MALE_PREFERENCE) {
    const v = bestMatch(britishInstalled, base, isBritish);
    if (v) {
      const isDefault = base === BRITISH_MALE_PREFERENCE[0];
      return {
        voice: v.name,
        source: 'default',
        reason: isDefault ? `${v.name} — deep British male (trenchscope default)` : `${v.name} — British male voice`,
      };
    }
  }

  // 3. Next British voice (en_GB, masculine/neutral).
  for (const base of BRITISH_FALLBACK) {
    const v = installed.find((x) => normalizeVoiceName(x.name) === base && isBritish(x.locale) && !isBannedVoice(x.name));
    if (v) return { voice: v.name, source: 'british', reason: `${v.name} — British voice (no Daniel installed)` };
  }

  // 4. Any safe English male voice, any English locale.
  for (const base of ENGLISH_MALE_ALLOW) {
    const v = installed.find((x) => normalizeVoiceName(x.name) === base && isEnglish(x.locale) && !isBannedVoice(x.name));
    if (v) return { voice: v.name, source: 'english', reason: `${v.name} — English voice (no British male installed)` };
  }

  // 5. Nothing safe: text only. Never the system default.
  return { voice: null, source: 'none', reason: 'no safe voice installed — spoken replies are off (text still works)' };
}

// ------------------------------------------------------------------ speech-text sanitisation

/** Default cap on spoken length. Long analyst answers are summarised upstream; this is a hard backstop. */
export const MAX_SPEAK_CHARS = 600;

const BASE58 = '1-9A-HJ-NP-Za-km-z';
/** A Solana mint / base58 address (32-44 chars) or a 0x… EVM address — never read 44 characters aloud. */
const ADDRESS_RE = new RegExp(`\\b(?:0x[0-9a-fA-F]{40}|[${BASE58}]{32,44})\\b`, 'g');

/** Short, speakable form of an address: "7xKX…Dgkp" reads as a few characters, not forty-four. */
function shortAddress(addr: string): string {
  const body = addr.startsWith('0x') ? addr.slice(2) : addr;
  return `${body.slice(0, 4)}…${body.slice(-4)}`;
}

/**
 * Make arbitrary text safe to hand to `say`. Untrusted text (token names, socials, analyst output) can
 * contain `say`'s own `[[…]]` embedded speech commands — `[[slnc 5000]]`, `[[rate 10]]`, even a voice
 * switch — which `say` INTERPRETS whether the text arrives on argv or stdin. We also never want a
 * leading `-` parsed as a flag. This:
 *   - defuses `[[` / `]]` so no embedded command is ever executed (kept readable, not deleted)
 *   - neutralises a leading `-`/`+` (defence in depth; we also deliver via stdin, not argv)
 *   - collapses control characters and whitespace
 *   - shortens contract addresses to a 4…4 form instead of reading 44 characters
 *   - caps the length on a word boundary
 */
export function sanitizeSpeech(text: string, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? MAX_SPEAK_CHARS;
  let s = String(text ?? '');
  // Defuse `say` embedded commands: a split `[ [` / `] ]` is no longer a command token.
  s = s.replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]');
  // Strip control characters (NUL, ESC, etc.) that could confuse the child or the terminal.
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  // Shorten addresses so we don't read 44 characters aloud.
  s = s.replace(ADDRESS_RE, (m) => shortAddress(m));
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  // A leading dash/plus could be read as a flag if it ever reached argv; neutralise it.
  s = s.replace(/^[-+]+\s*/, '');
  // Cap length on a word boundary.
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const sp = cut.lastIndexOf(' ');
    s = (sp > maxChars * 0.6 ? cut.slice(0, sp) : cut).trim();
  }
  return s;
}
