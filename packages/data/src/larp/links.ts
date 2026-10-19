// LARP detector — link extraction (task-1315). Pure, offline, deterministic.
// Collects every website/social link a coin advertises from the three keyless
// sources we already read — DexScreener token `info` (websites[] + socials[]),
// Jupiter token metadata (website/twitter/telegram) and the pump.fun metadata
// URI JSON — then classifies and de-duplicates them. No network here: callers
// pass already-fetched raw shapes. Only http/https links survive; mailto:,
// javascript:, data: and relative links are dropped.

/** Where a link came from (provenance for the UI / analyst). */
export type LinkSource = 'dexscreener' | 'jupiter' | 'pumpfun';

/** Coarse classification used for the open-in-browser keys and the link list. */
export type LinkKind =
  | 'website' | 'x' | 'telegram' | 'discord' | 'github' | 'docs'
  | 'medium' | 'youtube' | 'reddit' | 'instagram' | 'tiktok' | 'facebook'
  | 'linktree' | 'other';

export interface CoinLink {
  kind: LinkKind;
  url: string;
  /** Human label (DexScreener website labels, else the host). */
  label: string;
  source: LinkSource;
}

export interface TokenLinks {
  /** Best primary website (first non-social http(s) site), or null. */
  website: string | null;
  /** Best X / Twitter link, or null. */
  x: string | null;
  /** Best Telegram link, or null. */
  telegram: string | null;
  /** Every distinct valid link, in source priority order (DexScreener → Jupiter → pump.fun). */
  all: CoinLink[];
}

/** Raw inputs, each optional — pass whatever is available for the mint. */
export interface RawLinkSources {
  dexscreener?: {
    info?: {
      websites?: Array<{ label?: string; url?: string }> | null;
      socials?: Array<{ type?: string; label?: string; url?: string }> | null;
    } | null;
  } | null;
  /** Jupiter token metadata (the flat website/twitter/telegram fields). */
  jupiter?: { website?: string | null; twitter?: string | null; telegram?: string | null } | null;
  /** Parsed pump.fun metadata URI JSON (same flat fields; also `x`). */
  pumpfun?: { website?: string | null; twitter?: string | null; telegram?: string | null; x?: string | null } | null;
}

const MAX_LINKS = 24;

/** Parse to a URL only if it is a syntactically valid absolute http(s) link. */
export function parseHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  return u;
}

/** Lower-cased host with any leading `www.` removed. */
function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

/** Classify a link by host (and path for docs). Host is the source of truth, not any label. */
export function classifyLink(u: URL): LinkKind {
  const host = bareHost(u);
  const path = u.pathname.toLowerCase();
  if (host === 'twitter.com' || host === 'x.com' || host === 'fxtwitter.com' || host === 'nitter.net' || host === 't.co') return 'x';
  if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') return 'telegram';
  if (host === 'discord.gg' || host === 'discord.com' || host === 'discordapp.com') return 'discord';
  if (host === 'github.com' || host === 'raw.githubusercontent.com') return 'github';
  if (host === 'medium.com' || host.endsWith('.medium.com')) return 'medium';
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'facebook.com' || host === 'fb.com' || host.endsWith('.facebook.com')) return 'facebook';
  if (host === 'linktr.ee' || host === 'linktree.com') return 'linktree';
  if (host.endsWith('.gitbook.io') || host === 'gitbook.io' || host.startsWith('docs.') || path.startsWith('/docs') || path.startsWith('/whitepaper')) return 'docs';
  return 'website';
}

/** A short, injection-inert label for the link list (host; DexScreener website labels when sane). */
function labelFor(u: URL, rawLabel: string | undefined, kind: LinkKind): string {
  const host = bareHost(u);
  if (kind === 'website' && rawLabel) {
    const clean = rawLabel.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (clean) return clean;
  }
  return host;
}

/** Map a DexScreener social `type` to our kind when the host is ambiguous (host still wins). */
function socialTypeKind(type: string | undefined): LinkKind | null {
  switch ((type ?? '').toLowerCase()) {
    case 'twitter': case 'x': return 'x';
    case 'telegram': return 'telegram';
    case 'discord': return 'discord';
    case 'github': return 'github';
    case 'medium': return 'medium';
    case 'youtube': return 'youtube';
    case 'reddit': return 'reddit';
    case 'instagram': return 'instagram';
    case 'tiktok': return 'tiktok';
    case 'facebook': return 'facebook';
    default: return null;
  }
}

/** De-dup key: scheme-insensitive host + path (ignores trailing slash and query). */
function dedupKey(u: URL): string {
  return `${bareHost(u)}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
}

/**
 * Extract and classify every advertised link for a token. Source order sets priority for the
 * primary website/x/telegram picks and for de-duplication (the first occurrence wins its label).
 */
export function extractLinks(src: RawLinkSources): TokenLinks {
  const out: CoinLink[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown, source: LinkSource, typeHint?: string, rawLabel?: string): void => {
    if (out.length >= MAX_LINKS) return;
    const u = parseHttpUrl(raw);
    if (!u) return;
    const key = dedupKey(u);
    if (seen.has(key)) return;
    seen.add(key);
    // Host classification wins; the DexScreener `type` only disambiguates a generic host.
    let kind = classifyLink(u);
    if (kind === 'website') { const hinted = socialTypeKind(typeHint); if (hinted) kind = hinted; }
    out.push({ kind, url: u.toString(), label: labelFor(u, rawLabel, kind), source });
  };

  // 1) DexScreener info: explicit websites[] then socials[].
  for (const w of src.dexscreener?.info?.websites ?? []) add(w?.url, 'dexscreener', undefined, w?.label);
  for (const s of src.dexscreener?.info?.socials ?? []) add(s?.url, 'dexscreener', s?.type, s?.label);
  // 2) Jupiter flat fields.
  add(src.jupiter?.website, 'jupiter');
  add(src.jupiter?.twitter, 'jupiter', 'twitter');
  add(src.jupiter?.telegram, 'jupiter', 'telegram');
  // 3) pump.fun metadata URI JSON.
  add(src.pumpfun?.website, 'pumpfun');
  add(src.pumpfun?.twitter ?? src.pumpfun?.x, 'pumpfun', 'twitter');
  add(src.pumpfun?.telegram, 'pumpfun', 'telegram');

  const first = (k: LinkKind): string | null => out.find((l) => l.kind === k)?.url ?? null;
  return { website: first('website'), x: first('x'), telegram: first('telegram'), all: out };
}
