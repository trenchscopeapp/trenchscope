// LARP check — links-only baseline grade (task-1401). Pure, offline, deterministic.
//
// The LARP check (skill `larp-check`) judges a coin's product from fetched pages, the domain and GitHub. That
// model stage cannot be replayed on history: the pages are gone or have changed since. What CAN be replayed is
// the part of the evidence the recorder keeps point-in-time: the website / X / Telegram links a coin advertised
// (DexScreener `info` + Jupiter metadata, the same fields `get_links` reads). This module turns those three links
// into named signals and a baseline grade, so the same function scores the backtest eval set and the live
// `get_links` result the skill starts from.
//
// What the grade is: a RISK FLAG from link shape alone, never a verdict on the product. It uses only the skill's
// verdict names it can honestly reach: `LARP` (the link shape contradicts a product claim: a social or launchpad
// page posing as the website, a placeholder host, a tweet instead of an account), `UNVERIFIABLE` (no website at
// all, nothing to vet) and `EARLY_BUT_REAL` (an own-domain site with nothing contradicting it). It never says
// `REAL_PRODUCT`: links alone cannot show a reachable product. Weights are tuned on the TRAIN split of the
// recorded eval set only (packages/packs/eval/README.md); the measured test-split numbers ship with the rubric.

import { parseHttpUrl } from './links.ts';

export type WebKind = 'none' | 'own-domain' | 'free-host' | 'social' | 'launchpad' | 'linktree' | 'invalid';
export type XKind = 'none' | 'profile' | 'status' | 'community' | 'other';

/** The derived, URL-free link features (what the eval set stores; no URL, name or symbol is kept). */
export interface LinkFeatures {
  web: WebKind;
  x: XKind;
  tg: boolean;
  /** The website's domain contains the token's symbol or name. null when there is no site or no symbol/name. */
  webMatchesToken: boolean | null;
  /** The website is on a throwaway-priced TLD (.fun, .xyz, .lol, ...). null when there is no own-domain site. */
  cheapTld: boolean | null;
}

/** The named signals a rubric weighs. All are LARP-direction (a weight > 0 pushes toward `LARP`). */
export const LINK_SIGNALS = [
  'site_is_social', 'site_is_launchpad', 'site_linktree', 'site_free_host', 'site_no_name_match',
  'cheap_tld', 'x_not_profile', 'no_x', 'no_tg',
] as const;
export type LinkSignal = (typeof LINK_SIGNALS)[number];

export interface LinkRubric {
  id: string;
  /** Integer weight per signal (0 = ignored). */
  weights: Record<LinkSignal, number>;
  /** score ≥ threshold → `LARP` (only when a website is advertised). */
  threshold: number;
  /** Where the weights came from; printed by the backtest and the MCP tool. */
  provenance: string;
}

export type LinkGrade = 'LARP' | 'UNVERIFIABLE' | 'EARLY_BUT_REAL';

export interface LinkBaseline {
  rubric: string;
  grade: LinkGrade;
  score: number;
  signals: LinkSignal[];
}

/**
 * v0: the pre-tuning rubric, written from the larp-check skill text BEFORE any backtest (task-1401): a social or
 * launchpad page posing as the website and a tweet/community link instead of an account are the link-visible
 * LARP signals the skill names; a placeholder host, a link hub, and a site whose domain does not name the coin
 * count one point each. This is the "before" the tuned rubric is compared with.
 */
export const LINK_RUBRIC_V0: LinkRubric = {
  id: 'larp-links-v0',
  weights: { site_is_social: 2, site_is_launchpad: 2, site_linktree: 1, site_free_host: 1, site_no_name_match: 1, cheap_tld: 0, x_not_profile: 1, no_x: 0, no_tg: 0 },
  threshold: 2,
  provenance: 'hand-written from the larp-check skill text before the backtest (task-1401)',
};

/**
 * v1: tuned on the TRAIN split of packages/packs/eval/skills-eval.json (grid search over weights 0..2 and
 * threshold 1..5, objective MCC of LARP→bad, ties to the smaller weight sum). Test-split numbers:
 * packages/packs/eval/skills-backtest.json. Regenerate with `trenchscope backtest --subject skills --tune`.
 */
export const LINK_RUBRIC_V1: LinkRubric = {
  id: 'larp-links-v1',
  weights: { site_is_social: 0, site_is_launchpad: 0, site_linktree: 0, site_free_host: 1, site_no_name_match: 1, cheap_tld: 1, x_not_profile: 2, no_x: 1, no_tg: 1 },
  threshold: 4,
  provenance: 'tuned on the train split of the task-1401 eval set (see packages/packs/eval/README.md)',
};

/**
 * The held-out TEST-split counts for LINK_RUBRIC_V1 (packages/packs/eval/skills-backtest.json `larp.after.test`).
 * A test asserts these match the committed report, so a re-tune cannot ship stale numbers.
 */
export const LINK_RUBRIC_MEASURED = {
  rubric: 'larp-links-v1',
  eval: 'task-1401 eval set, 2026-10-16',
  horizon: '72h',
  test: {
    n: 328, bad: 61,
    by_grade: { LARP: { n: 14, bad: 4 }, UNVERIFIABLE: { n: 130, bad: 38 }, EARLY_BUT_REAL: { n: 184, bad: 19 } } as Record<LinkGrade, { n: number; bad: number }>,
  },
} as const;

/** The rubric the live `get_links` baseline uses. */
export const DEFAULT_LINK_RUBRIC: LinkRubric = LINK_RUBRIC_V1;

const SOCIAL_HOSTS = new Set([
  'x.com', 'twitter.com', 'mobile.twitter.com', 't.me', 'telegram.me', 'telegram.dog', 'discord.gg', 'discord.com',
  'discordapp.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'm.youtube.com', 'youtu.be', 'facebook.com', 'fb.com',
  'reddit.com', 'threads.net', 'warpcast.com', 'truthsocial.com', 'kick.com', 'twitch.tv',
]);
const LAUNCHPAD_HOSTS = new Set([
  'pump.fun', 'dexscreener.com', 'birdeye.so', 'solscan.io', 'jup.ag', 'raydium.io', 'meteora.ag', 'letsbonk.fun',
  'bonk.fun', 'moonshot.money', 'believe.app', 'bags.fm', 'gmgn.ai', 'axiom.trade', 'dextools.io', 'coingecko.com',
  'coinmarketcap.com', 'photon-sol.tinyastro.io', 'geckoterminal.com', 'rugcheck.xyz', 'solana.fm', 'heaven.xyz',
]);
const LINKHUB_HOSTS = new Set(['linktr.ee', 'linktree.com', 'link3.to', 'bio.link', 'beacons.ai', 'campsite.bio', 'solo.to', 'lnk.bio', 'hoo.be', 'allmylinks.com']);
const FREE_HOST_SUFFIXES = [
  'vercel.app', 'netlify.app', 'github.io', 'carrd.co', 'wixsite.com', 'webflow.io', 'framer.website', 'framer.app',
  'framer.ai', 'notion.site', 'gitbook.io', 'substack.com', 'pages.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com',
  'replit.app', 'repl.co', 'glitch.me', 'weebly.com', 'wordpress.com', 'blogspot.com', 'mystrikingly.com',
  'godaddysites.com', 'squarespace.com', 'medium.com', 'durable.co', 'lovable.app', 'onrender.com', 'surge.sh',
  'webnode.page', 'site123.me', 'tilda.ws', 'super.site', 'my.canva.site', 'canva.site', 'bolt.host', 'netlify.com',
];
const FREE_HOST_EXACT = new Set(['sites.google.com', 'docs.google.com', 'drive.google.com', 'telegra.ph', 'pastebin.com', 'medium.com']);
const CHEAP_TLDS = new Set(['fun', 'xyz', 'lol', 'meme', 'site', 'online', 'club', 'top', 'vip', 'wtf', 'space', 'icu', 'buzz', 'cfd', 'sbs', 'click', 'live', 'world', 'today', 'pw', 'cc', 'monster', 'rest', 'bond', 'cyou']);
const X_RESERVED = new Set(['home', 'search', 'explore', 'i', 'hashtag', 'intent', 'share', 'messages', 'notifications', 'settings', 'compose']);

const hostOf = (u: URL): string => u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
const endsWithHost = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`);
const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

function webKind(raw: string | null | undefined): { kind: WebKind; url: URL | null } {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { kind: 'none', url: null };
  const u = parseHttpUrl(raw);
  if (!u) return { kind: 'invalid', url: null };
  const host = hostOf(u);
  if ([...SOCIAL_HOSTS].some((h) => endsWithHost(host, h))) return { kind: 'social', url: u };
  if ([...LAUNCHPAD_HOSTS].some((h) => endsWithHost(host, h))) return { kind: 'launchpad', url: u };
  if (LINKHUB_HOSTS.has(host)) return { kind: 'linktree', url: u };
  if (FREE_HOST_EXACT.has(host) || FREE_HOST_SUFFIXES.some((s) => host.endsWith(`.${s}`))) return { kind: 'free-host', url: u };
  return { kind: 'own-domain', url: u };
}

function xKind(raw: string | null | undefined): XKind {
  if (raw === null || raw === undefined || String(raw).trim() === '') return 'none';
  const u = parseHttpUrl(raw);
  if (!u) return 'other';
  const host = hostOf(u);
  if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(host)) return 'other';
  const parts = u.pathname.split('/').filter(Boolean).map((p) => p.toLowerCase());
  if (parts[0] === 'i' && parts[1] === 'communities') return 'community';
  if (!parts.length || X_RESERVED.has(parts[0])) return 'other';
  if (parts[1] === 'status' || parts[1] === 'statuses') return 'status';
  if (parts.length === 1 && /^[a-z0-9_]{1,15}$/.test(parts[0])) return 'profile';
  return 'other';
}

/** Does the site's domain carry the token's symbol or name? Symbol ≥ 3 chars, name compacted or a ≥ 4-char word. */
function domainMatches(u: URL, symbol: string | null | undefined, name: string | null | undefined): boolean | null {
  const sym = norm(String(symbol ?? '').replace(/^\$/, ''));
  const nm = norm(String(name ?? ''));
  const words = String(name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  if (!sym && !nm) return null;
  const host = hostOf(u);
  const labels = host.split('.');
  const body = norm(labels.length > 1 ? labels.slice(0, -1).join('') : host);
  if (!body) return false;
  if (sym.length >= 3 && body.includes(sym)) return true;
  if (nm.length >= 3 && body.includes(nm)) return true;
  return words.some((w) => body.includes(norm(w)));
}

/**
 * Derive the URL-free features from the three primary links (the store's merge: Jupiter first, then DexScreener's
 * first website / first X / first Telegram). `symbol`/`name` enable the domain-match signal; they are not kept.
 */
export function linkFeatures(input: { web?: string | null; x?: string | null; tg?: string | null; symbol?: string | null; name?: string | null }): LinkFeatures {
  const w = webKind(input.web);
  return {
    web: w.kind,
    x: xKind(input.x),
    tg: !!(input.tg && String(input.tg).trim()),
    webMatchesToken: w.url && (w.kind === 'own-domain' || w.kind === 'free-host') ? domainMatches(w.url, input.symbol, input.name) : null,
    cheapTld: w.url && w.kind === 'own-domain' ? CHEAP_TLDS.has(hostOf(w.url).split('.').pop() ?? '') : null,
  };
}

/** The signals present in a feature set. */
export function linkSignals(f: LinkFeatures): LinkSignal[] {
  const s: LinkSignal[] = [];
  if (f.web === 'social') s.push('site_is_social');
  if (f.web === 'launchpad') s.push('site_is_launchpad');
  if (f.web === 'linktree') s.push('site_linktree');
  if (f.web === 'free-host' || f.web === 'invalid') s.push('site_free_host');
  if (f.webMatchesToken === false) s.push('site_no_name_match');
  if (f.cheapTld === true) s.push('cheap_tld');
  if (f.x === 'status' || f.x === 'community' || f.x === 'other') s.push('x_not_profile');
  if (f.x === 'none') s.push('no_x');
  if (!f.tg) s.push('no_tg');
  return s;
}

/** Grade one coin's links with a rubric. No website at all is `UNVERIFIABLE` (fixed rule, never tuned). */
export function gradeLinks(f: LinkFeatures, rubric: LinkRubric = DEFAULT_LINK_RUBRIC): LinkBaseline {
  const signals = linkSignals(f);
  const score = signals.reduce((a, s) => a + (rubric.weights[s] ?? 0), 0);
  const grade: LinkGrade = f.web === 'none' ? 'UNVERIFIABLE' : score >= rubric.threshold ? 'LARP' : 'EARLY_BUT_REAL';
  return { rubric: rubric.id, grade, score, signals };
}

/**
 * The store's primary-link merge (packages/data/src/store.ts: Jupiter first, then DexScreener), so the live
 * baseline reads the same three links the recorder's cache holds for the eval set.
 */
export function primaryLinks(src: {
  dexscreener?: { info?: { websites?: Array<{ url?: string }> | null; socials?: Array<{ type?: string; url?: string }> | null } | null } | null;
  jupiter?: { website?: string | null; twitter?: string | null; telegram?: string | null } | null;
}): { web: string | null; x: string | null; tg: string | null } {
  const info = src.dexscreener?.info;
  const dsX = info?.socials?.find((s) => s?.type === 'twitter' || s?.type === 'x')?.url ?? null;
  const dsTg = info?.socials?.find((s) => s?.type === 'telegram')?.url ?? null;
  return {
    web: src.jupiter?.website ?? info?.websites?.[0]?.url ?? null,
    x: src.jupiter?.twitter ?? dsX,
    tg: src.jupiter?.telegram ?? dsTg,
  };
}
