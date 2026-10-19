// LARP detector — mechanical evidence signals (task-1315). Pure + deterministic
// given fetched bytes; no network except through an injected fetcher. These are
// SIGNALS, never verdicts: the analyst weighs them. HTML is parsed with regex
// only (zero-dep, and we never execute it) because the page is untrusted data.

import { classifyLink, parseHttpUrl } from './links.ts';
import type { SafeFetchResult } from './safe-fetch.ts';
import { base58Decode } from '../sources/pda.ts';

export interface PageSignals {
  fetched: boolean;
  status: number;
  finalUrl: string | null;
  blocked: string | null;
  title: string | null;
  description: string | null;
  /** <meta name=generator> value (site-builder tell). */
  generator: string | null;
  /** Best guess at the hosting/site builder (wix, carrd, framer, vercel, github-pages…). */
  siteBuilder: string | null;
  /** Non-null when the page looks like a parked/placeholder/default/404 page. */
  defaultPage: string | null;
  /**
   * Non-null when the page is a JavaScript-only shell (a Next.js / Vite / Nuxt … app that renders in the browser):
   * the framework name. A no-JS fetch cannot read such a page, so its near-empty text is MISSING data, not a
   * placeholder page. `shellText` then holds what a no-JS read can still see.
   */
  spaShell: string | null;
  /** For a JS-only shell: meta/og tags, Next.js __NEXT_DATA__ page strings and <noscript> text. '' otherwise. */
  shellText: string;
  /** Rough visible-text length (tags stripped). A near-empty page is a tell. */
  textLength: number;
  linkCount: number;
  externalHosts: string[];
  /** The page links to an app (an app./ host, an /app-style path on the site, or a "Launch app" link/button). */
  hasApp: boolean;
  /** Why hasApp is true: the app link (untrusted URL) or 'button'. null when there is none. */
  appLink: string | null;
  hasDocs: boolean;
  hasWhitepaper: boolean;
  hasGithub: boolean;
  /** github.com links on the page (repo links first): a site-linked repo is checked like an advertised one. */
  githubLinks: string[];
  /** Wallet-connect UI present (expected for a dapp, a flag on a brochure site). */
  walletConnect: boolean;
  /** Heuristic drainer/scam signatures (names only; a flag to investigate, not proof). */
  drainerFlags: string[];
  /** External <script> origins (supply-chain / drainer surface). */
  scriptHosts: string[];
  mentionsSymbol: boolean | null;
  mentionsName: boolean | null;
  /** The page (text, links or inline data) names this token's mint. null when no mint was given. */
  mentionsMint: boolean | null;
  /**
   * Trading/launchpad links on the page to a DIFFERENT address than this token's mint (computed on the raw HTML,
   * before the firewall turns addresses into [addr]). `ambiguous` = the link host takes a pair OR a mint (DexScreener,
   * GeckoTerminal), so it only counts once the caller has excluded the token's own pair addresses.
   */
  foreignMints: Array<{ address: string; host: string; ambiguous: boolean }>;
  /**
   * Other Solana addresses the page names (text and links; not this mint, its pairs, SOL/USDC/USDT or a foreign
   * mint): candidates for program IDs a technical claim can be checked against on-chain (check_programs).
   */
  addresses: string[];
  /** Product claims the page text makes (app, protocol, AI agent, launchpad, …). Claims, not proof. */
  claimTerms: string[];
  /** Heavy technical claims (ZK, layer 2/rollup, own chain, quantum, bridge, …): each needs a checkable artifact. */
  bigTechClaims: string[];
  /** The page presents the coin as a meme/community token (meme, community-driven, no utility, lore, CTO, …). */
  memeTerms: string[];
  /** Short, control-stripped text excerpt for the analyst to read (it wraps as untrusted). */
  excerpt: string;
  /** Advertised navigation only; presence does not prove a functioning product. */
  links: Array<{ url: string; kind: string }>;
  teamClaim: boolean;
  stockTextSignals: string[];
}

const DRAINER_SIGNATURES: Array<[RegExp, string]> = [
  [/setApprovalForAll/i, 'setApprovalForAll (ERC-721/1155 approval drainer)'],
  [/permit2|permit\(/i, 'permit/permit2 signature grab'],
  [/eth_sendTransaction|window\.ethereum/i, 'EVM wallet calls on a Solana token (chain mismatch)'],
  [/eval\s*\(\s*atob\s*\(/i, 'eval(atob( obfuscated script'],
  [/Function\s*\(\s*atob/i, 'Function(atob( obfuscated script'],
  [/drainer|seaport\.js|inferno|monkey-drainer|pink-drainer/i, 'known drainer-kit string'],
  [/signAllTransactions[\s\S]{0,400}(SystemProgram\.transfer|createTransferInstruction)/i, 'sign-all then transfer-all pattern'],
];

const BUILDER_SIGNATURES: Array<[RegExp, string]> = [
  [/\.carrd\.co|data-carrd|cardScript/i, 'carrd'],
  [/static\.wixstatic\.com|X-Wix-|wix\.com/i, 'wix'],
  [/squarespace\.com|static1\.squarespace/i, 'squarespace'],
  [/framerusercontent\.com|framer\.com|data-framer/i, 'framer'],
  [/assets\.website-files\.com|webflow\.(io|com)|data-wf-/i, 'webflow'],
  [/cdn\.durable\.co|durable\.co/i, 'durable'],
  [/\.github\.io|github-pages/i, 'github-pages'],
  [/vercel\.app|_next\/static/i, 'vercel/next'],
  [/netlify\.app|netlify/i, 'netlify'],
  [/dorik|data-dorik/i, 'dorik'],
];

const DEFAULT_PAGE_SIGNATURES: Array<[RegExp, string]> = [
  [/there isn.?t a github pages site here|404\.html/i, 'github-pages 404'],
  [/the deployment could not be found|deployment_not_found|welcome to vercel/i, 'vercel default/missing'],
  [/this (domain|site) is (for sale|parked)|buy this domain|parkingcrew|sedoparking|godaddy\.com\/domainfind/i, 'parked domain'],
  [/future home of something|default web page|it works!|apache2 (ubuntu|debian) default/i, 'web-server default page'],
  [/site not found|no such app|there's nothing here/i, 'host placeholder (missing app)'],
  [/this site can.?t be reached|dns_probe_finished/i, 'unreachable'],
  [/^\s*(coming soon|under construction)\s*$/i, 'coming-soon stub'],
];

/** Product claims (a thing the project says exists). Matched on visible text with the token's own name removed. */
const PRODUCT_CLAIMS: Array<[RegExp, string]> = [
  [/\b(web ?app|mobile app|dapp|our app|the app|launch app|open app|desktop app)\b/, 'app'],
  [/\bplatform\b/, 'platform'],
  [/\bprotocol\b/, 'protocol'],
  [/\blaunchpad\b/, 'launchpad'],
  [/\b(perps?|perpetuals?|exchange|order ?book)\b/, 'exchange'],
  [/\b(ai agents?|agent framework|ai model|language model|llm|machine learning|neural net(work)?s?|agentic)\b/, 'ai'],
  [/\b(trading|sniper|telegram|copy[- ]?trading) bots?\b/, 'bot'],
  [/\b(sdk|api|developer docs|open[- ]source)\b/, 'developer tooling'],
  [/\b(dashboard|analytics|terminal|browser extension|plugin)\b/, 'tool'],
  [/\b(infrastructure|oracle|validators?|staking|yield|vaults?)\b/, 'infrastructure/defi'],
  [/\b(play[- ]to[- ]earn|p2e|web3 game|on-?chain game)\b/, 'game'],
];
/** Heavy technical claims: easy to say, hard to ship. Each needs one checkable artifact (repo, program, explorer). */
const BIG_TECH_CLAIMS: Array<[RegExp, string]> = [
  [/\b(zk|zero[- ]knowledge|zk-?snarks?|zk-?starks?|validity proofs?)\b/, 'zero-knowledge'],
  [/\b(layer[- ]?2|l2|rollups?)\b/, 'layer 2 / rollup'],
  [/\b(layer[- ]?1|l1 blockchain|our own (chain|blockchain)|new blockchain|sovereign chain)\b/, 'own chain'],
  // "quantum realm" / "Nebula Bridge GIF" are theme words, not technology: only the technical phrasings count.
  [/\b(post[- ]quantum|quantum[- ](computing|computer|resistant|secure|safe|proof|encrypt\w*|cryptograph\w*|ai|machine learning|algorithm\w*|key distribution))\b/, 'quantum'],
  [/\b(agi|superintelligence)\b/, 'AGI'],
  [/\b(cross[- ]chain (bridge|transfers?|swaps?|liquidity)|bridg(e|es|ing) (assets|tokens|liquidity|funds) (to|from|between|across)|trustless bridge)\b/, 'bridge'],
  [/\b(fhe|fully homomorphic|homomorphic encryption|mpc|multi[- ]party computation|trusted execution|tee)\b/, 'cryptography (FHE/MPC/TEE)'],
  [/\b(proprietary|our own|in-house) (ai )?(model|llm|engine|algorithm)\b/, 'proprietary model'],
  [/\bconsensus (mechanism|algorithm|protocol)\b/, 'consensus'],
];
/** The page calls the coin a meme / community token. */
const MEME_SELF_LABELS: Array<[RegExp, string]> = [
  [/\b(meme ?coins?|memes?)\b/, 'meme'],
  [/\bcommunity[- ](driven|token|coin|owned|takeover)\b/, 'community token'],
  [/\b(no|zero) (utility|roadmap|promises)\b/, 'no utility'],
  [/\bjust a (meme|dog|cat|frog|coin|token|pigeon|bird)\b/, 'just a meme'],
  [/\bcto\b/, 'CTO'],
  [/\bmascot\b/, 'mascot'],
  [/\blore\b/, 'lore'],
  [/\bfor the culture\b/, 'culture'],
];

/** Claim terms in `text`, ignoring occurrences inside the token's own name ("Quantum Inu" claims no quantum tech). */
function claimMatches(lowerText: string, table: Array<[RegExp, string]>, name: string): string[] {
  const t = name.length >= 3 ? lowerText.split(name).join(' ') : lowerText;
  return allMatches(t, table);
}

/** Solana addresses named in visible text or link URLs (32-byte base58 only), deduplicated, in order. */
function namedAddresses(text: string, urls: readonly string[], exclude: ReadonlySet<string>, max = 10): string[] {
  const out: string[] = [];
  for (const src of [text, urls.join(' ')]) {
    for (const m of src.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g)) {
      const a = m[0];
      if (exclude.has(a) || out.includes(a) || !isSolanaAddress(a)) continue;
      out.push(a);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Wallet-provider / wallet-adapter code on the page (a dapp's connect flow, or an EVM provider call). */
const WALLET_CODE = /@solana\/wallet-adapter|wallet-adapter-|walletconnect|window\.solana\b|window\.phantom|window\.solflare|window\.backpack|window\.ethereum|phantom\.app\/ul\//i;

/** Every <a href> and <button> on the page with its visible text (tags stripped). */
function linkControls(html: string, baseUrl: string | null): Array<{ href: string | null; text: string }> {
  const out: Array<{ href: string | null; text: string }> = [];
  const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80);
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const raw = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] ?? null;
    let href: string | null = null;
    if (raw) { try { const u = parseHttpUrl(new URL(raw, baseUrl ?? undefined).toString()); href = u ? u.toString() : null; } catch { href = null; } }
    out.push({ href, text: strip(m[2]) });
    if (out.length >= 400) return out;
  }
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) { out.push({ href: null, text: strip(m[1]) }); if (out.length >= 450) break; }
  return out;
}

/** A control that names an app outright ("Launch app", "Open the dapp", "Mobile app"). */
const APP_TEXT = /^(launch|open|enter|use|try|go to)\s+(the\s+)?(app|dapp|demo|platform|terminal|studio|beta)\b|\b(launch app|open app|web app|mobile app|dapp)\b/i;
/** An action verb on a LINK ("Try Zeno Check", "Open swarms.world", "Start building"); never "Get started" or "Buy". */
const APP_ACTION = /^(launch|open|enter|try|use|play|start (building|trading|creating|chatting))\b/i;
const APP_PATH = /^\/(app|dapp|demo|swap|trade|launch|dashboard|play|studio|console|terminal|beta)(\/|$)/i;
/** Hosts a "buy"/"chart"/social link points at: not the project's app. */
const NOT_APP_HOSTS = /(^|\.)(pump\.fun|dexscreener\.com|birdeye\.so|raydium\.io|gmgn\.ai|axiom\.trade|dextools\.io|geckoterminal\.com|solscan\.io|coingecko\.com|coinmarketcap\.com|moonshot\.money|letsbonk\.fun|bonk\.fun|x\.com|twitter\.com|t\.me|telegram\.me|discord\.gg|discord\.com|youtube\.com|tiktok\.com|instagram\.com|linktr\.ee|github\.com|medium\.com|gitbook\.io)$/i;

/** The app a page links to: an app.* host or an /app-style path on the same site, or a "Launch app"-style control. */
function appEvidence(controls: ReadonlyArray<{ href: string | null; text: string }>, siteHost: string | null): string | null {
  const root = siteHost ? siteHost.split('.').slice(-2).join('.') : null;
  const target = (href: string | null) => {
    const u = href ? parseHttpUrl(href) : null;
    if (!u) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return { u, host, sameSite: !!root && (host === root || host.endsWith(`.${root}`)), external: NOT_APP_HOSTS.test(host) };
  };
  for (const c of controls) {
    const t = target(c.href);
    if (t?.sameSite && (t.host.startsWith('app.') || APP_PATH.test(t.u.pathname))) return c.href;
  }
  for (const c of controls) {
    const t = target(c.href);
    if (APP_TEXT.test(c.text) && (!t || !t.external)) return c.href ?? 'button';
    if (t && !t.external && APP_ACTION.test(c.text)) return c.href;
  }
  return null;
}

/** Client-rendered app frameworks, by the markers their HTML shell carries. */
const SPA_SIGNATURES: Array<[RegExp, string]> = [
  [/\/_next\/static|__NEXT_DATA__|self\.__next_f/, 'next.js'],
  [/__nuxt|\/_nuxt\//, 'nuxt'],
  [/__sveltekit|data-sveltekit/, 'sveltekit'],
  [/___gatsby/, 'gatsby'],
  [/ng-version=|<app-root[\s>]/i, 'angular'],
  [/flutter(?:_bootstrap)?\.js|main\.dart\.js/, 'flutter'],
  [/<div[^>]+id=["'](?:root|app)["'][^>]*>\s*<\/div>|<script[^>]+type=["']module["'][^>]*\ssrc=/i, 'vite/spa'],
  [/<noscript[^>]*>[^<]{0,200}(?:enable|need|requires?)\s+javascript/i, 'js-required'],
];
/** Below this much visible text a page carrying a framework marker is read as a JS-only shell. */
const SPA_TEXT_MAX = 400;

/** The framework of a JS-only shell, or null when the page has readable server-rendered text. */
export function spaShellOf(html: string, textLength: number): string | null {
  // Readable server-rendered text means the page is not a shell, even when one section bails out to the client.
  if (textLength >= SPA_TEXT_MAX) return null;
  const fw = firstMatch(html, SPA_SIGNATURES);
  if (!fw) return null;
  return /BAILOUT_TO_CLIENT_SIDE_RENDERING/.test(html) ? `${fw} (client-rendered)` : fw;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'nbsp') return ' ';
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos' || k === '#39') return "'";
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
  });
}

/** <meta> content by name/property, attribute order-insensitive. */
function metaContent(html: string, key: string): string | null {
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tagText = m[0];
    const k = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tagText)?.[1]?.toLowerCase();
    if (k !== key) continue;
    const c = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tagText);
    const v = c ? decodeEntities(c[1] ?? c[2] ?? '').replace(/\s+/g, ' ').trim() : '';
    if (v) return v;
  }
  return null;
}

/** String leaves of Next.js __NEXT_DATA__.props.pageProps that read as words (not ids, urls or paths). */
function nextDataStrings(html: string, max = 30): string[] {
  const m = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return [];
  let data: unknown;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= max || depth > 12) return;
    if (typeof v === 'string') {
      const s = v.replace(/\s+/g, ' ').trim();
      if (s.length >= 3 && s.length <= 300 && /\p{L}{2,}\s+\p{L}{2,}/u.test(s) && !/^(https?:|\/|data:)/i.test(s)) out.push(s);
    } else if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); } else if (v && typeof v === 'object') { for (const x of Object.values(v)) walk(x, depth + 1); }
  };
  walk((data as { props?: { pageProps?: unknown } })?.props?.pageProps, 0);
  return out;
}

/** What a no-JS read can still see in a JS-only shell: meta/og tags, __NEXT_DATA__ page strings, <noscript>. */
export function shellExtract(html: string): string {
  const parts: string[] = [];
  for (const k of ['og:site_name', 'og:title', 'twitter:title', 'description', 'og:description', 'twitter:description', 'keywords']) {
    const v = metaContent(html, k);
    if (v && !parts.includes(v)) parts.push(v);
  }
  for (const s of nextDataStrings(html)) if (!parts.includes(s)) parts.push(s);
  const ns = [...html.matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi)].map((x) => decodeEntities(x[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const s of ns) if (!parts.includes(s)) parts.push(s);
  return parts.join(' · ').slice(0, 1200);
}

/** Same-site page paths listed by a sitemap.xml body (a real <urlset>/<sitemapindex> only, never an SPA fallback page). */
export function parseSitemap(body: string, baseUrl: string, max = 25): string[] {
  if (!/<(?:urlset|sitemapindex)\b/i.test(body)) return [];
  const base = parseHttpUrl(baseUrl);
  if (!base) return [];
  const site = base.hostname.toLowerCase().replace(/^www\./, '');
  const out: string[] = [];
  for (const m of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const u = parseHttpUrl(decodeEntities(m[1]));
    if (!u || u.hostname.toLowerCase().replace(/^www\./, '') !== site) continue;
    const p = u.pathname.slice(0, 120);
    if (!out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

function firstMatch(html: string, table: Array<[RegExp, string]>): string | null {
  for (const [re, name] of table) if (re.test(html)) return name;
  return null;
}
function allMatches(html: string, table: Array<[RegExp, string]>): string[] {
  const out: string[] = [];
  for (const [re, name] of table) if (re.test(html)) out.push(name);
  return out;
}

function tag(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** Strip tags/scripts/styles to a rough visible-text approximation. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every absolute http(s) href/src on the page. */
export function extractUrls(html: string, baseUrl: string | null): string[] {
  const out = new Set<string>();
  const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    let abs: string | null;
    try { abs = new URL(raw, baseUrl ?? undefined).toString(); } catch { abs = null; }
    const p = abs ? parseHttpUrl(abs) : null;
    if (p) out.add(p.toString());
  }
  return [...out];
}

function hostOf(url: string): string | null {
  const u = parseHttpUrl(url);
  return u ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
}

/**
 * Compute mechanical signals from a fetched page. `symbol`/`name` enable the "does the site even
 * mention this token" check. Returns a `fetched:false` bundle (with the block reason) when the
 * fetch failed, so the analyst can report it as a missing-data fact rather than guess.
 */
export function pageSignals(res: SafeFetchResult, opts: { symbol?: string | null; name?: string | null; mint?: string | null; ownAddresses?: readonly string[] } = {}): PageSignals {
  const base: PageSignals = {
    fetched: res.ok, status: res.status, finalUrl: res.ok ? res.finalUrl : null, blocked: res.blocked,
    title: null, description: null, generator: null, siteBuilder: null, defaultPage: null, spaShell: null, shellText: '',
    textLength: 0, linkCount: 0, externalHosts: [], hasApp: false, appLink: null, hasDocs: false, hasWhitepaper: false,
    hasGithub: false, githubLinks: [], walletConnect: false, drainerFlags: [], scriptHosts: [], mentionsSymbol: null, mentionsName: null, mentionsMint: null, foreignMints: [], addresses: [], claimTerms: [], bigTechClaims: [], memeTerms: [], excerpt: '',
    links: [], teamClaim: false, stockTextSignals: [],
  };
  if (!res.ok || !res.body) return base;
  const html = res.body;
  const finalHost = hostOf(res.finalUrl);
  const title = tag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = tag(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    ?? tag(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  const generator = tag(html, /<meta[^>]+name=["']generator["'][^>]*content=["']([^"']*)["']/i);
  const text = visibleText(html);
  const urls = extractUrls(html, res.finalUrl);
  const externalHosts = [...new Set(urls.map(hostOf).filter((h): h is string => !!h && h !== finalHost))];
  const scriptRe = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
  const scriptHosts = new Set<string>();
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) { const h = hostOf(sm[1].startsWith('http') ? sm[1] : new URL(sm[1], res.finalUrl ?? 'https://x/').toString()); if (h && h !== finalHost) scriptHosts.add(h); }

  const kinds = new Set(urls.map((u) => { const p = parseHttpUrl(u); return p ? classifyLink(p) : 'other'; }));
  const lowerHtml = html.toLowerCase();
  const controls = linkControls(html, res.finalUrl);
  const appLink = appEvidence(controls, finalHost);
  const sym = (opts.symbol ?? '').replace(/^\$/, '').trim().toLowerCase();
  const name = (opts.name ?? '').trim().toLowerCase();
  const lowerText = text.toLowerCase();
  const spaShell = spaShellOf(html, text.length);
  const mint = opts.mint && isSolanaAddress(opts.mint) ? opts.mint : null;
  const foreignMints = foreignMintLinks(urls, mint, opts.ownAddresses ?? []);
  const shellText = spaShell ? shellExtract(html) : '';
  // Claims are read from the visible text (plus the no-JS extract of a shell), minus the token's own name.
  const claimText = `${lowerText} ${shellText.toLowerCase()}`;

  return {
    ...base,
    title: title ? title.slice(0, 160) : null,
    description: description ? description.slice(0, 300) : null,
    generator: generator ? generator.slice(0, 80) : null,
    siteBuilder: firstMatch(html, BUILDER_SIGNATURES) ?? (generator ? generator.split(/[\s(]/)[0].toLowerCase() : null),
    // A JS-only shell's near-empty text is missing data (no JS ran), not a placeholder page.
    defaultPage: firstMatch(text, DEFAULT_PAGE_SIGNATURES) ?? (text.length < 40 && !spaShell ? 'near-empty page' : null),
    spaShell,
    shellText,
    textLength: text.length,
    linkCount: urls.length,
    externalHosts: externalHosts.slice(0, 30),
    hasApp: appLink !== null,
    appLink,
    hasDocs: kinds.has('docs') || /\bdocs?\b|documentation|whitepaper|litepaper/i.test(text),
    hasWhitepaper: /whitepaper|litepaper/i.test(lowerHtml),
    hasGithub: kinds.has('github'),
    githubLinks: urls.filter((u) => parseGithubTarget(u)).sort((a, b) => Number(!!parseGithubRepo(b)) - Number(!!parseGithubRepo(a))).slice(0, 5),
    // Wallet-connect code or a "connect wallet" control, not the word "phantom" in a how-to-buy paragraph.
    walletConnect: WALLET_CODE.test(html) || controls.some((c) => /\bconnect\s*(your\s*)?wallet\b/i.test(c.text)),
    drainerFlags: allMatches(html, DRAINER_SIGNATURES),
    scriptHosts: [...scriptHosts].slice(0, 20),
    mentionsSymbol: sym ? mentionsTerm(lowerText, sym) : null,
    mentionsName: name ? mentionsTerm(lowerText, name) : null,
    mentionsMint: mint ? html.includes(mint) : null,
    foreignMints,
    addresses: namedAddresses(text, urls, new Set([...(mint ? [mint] : []), ...(opts.ownAddresses ?? []), ...QUOTE_MINTS, ...foreignMints.map((f) => f.address)])),
    claimTerms: claimMatches(claimText, PRODUCT_CLAIMS, name),
    bigTechClaims: claimMatches(claimText, BIG_TECH_CLAIMS, name),
    memeTerms: claimMatches(claimText, MEME_SELF_LABELS, name),
    excerpt: text.slice(0, 1200),
    links: urls.slice(0, 24).map((url) => ({ url, kind: classifyLink(new URL(url)) })),
    teamClaim: /\b(our team|founder|co-founder|meet the team)\b/i.test(text),
    stockTextSignals: allMatches(text, [[/lorem ipsum/i, 'lorem ipsum placeholder'], [/your (company|brand|business) (name|here)/i, 'template placeholder'], [/insert (text|copy|title) here/i, 'unfilled template']]),
  };
}

/** Whole-word, case-insensitive mention ("SIR" must not match "desire"); an optional leading $ is allowed. */
export function mentionsTerm(lowerText: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])\\$?${esc}(?![\\p{L}\\p{N}])`, 'u').test(lowerText);
}

/** A base58 string that decodes to exactly 32 bytes (a Solana public key). Inert: only base58 characters. */
export function isSolanaAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { return base58Decode(s).length === 32; } catch { return false; }
}

/** Quote/base mints a swap link names alongside the coin (never "a different mint"). */
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/** Hosts whose path or query names a token MINT (unambiguous) vs a pair-or-mint (ambiguous). */
function addressesInTradeLink(u: URL): Array<{ address: string; ambiguous: boolean; host: string }> {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const q = (k: string) => u.searchParams.get(k);
  const out: Array<{ address: string; ambiguous: boolean; host: string }> = [];
  // `canon` is the fixed host name reported (never the page's own subdomain text, which could carry prose).
  const add = (a: string | null | undefined, ambiguous: boolean, canon: string) => { if (a) for (const x of a.split(/[-_,]/)) out.push({ address: x, ambiguous, host: canon }); };
  if (host === 'pump.fun' || host.endsWith('.pump.fun')) add(parts[0] === 'coin' ? parts[1] : parts[0], false, 'pump.fun');
  else if (host === 'birdeye.so' && parts[0] === 'token') add(parts[1], false, 'birdeye.so');
  else if (host === 'solscan.io' && parts[0] === 'token') add(parts[1], false, 'solscan.io');
  else if (host === 'gmgn.ai' && parts[1] === 'token') add(parts[2], false, 'gmgn.ai');
  else if (host === 'jup.ag' || host.endsWith('.jup.ag')) { if (parts[0] === 'swap' || parts[0] === 'tokens') add(parts[1], false, 'jup.ag'); add(q('sell'), false, 'jup.ag'); add(q('buy'), false, 'jup.ag'); }
  else if (host === 'raydium.io' || host.endsWith('.raydium.io')) { add(q('outputMint') ?? q('outputCurrency'), false, 'raydium.io'); add(q('inputMint') ?? q('inputCurrency'), false, 'raydium.io'); }
  else if (host === 'dexscreener.com' && parts[0] === 'solana') add(parts[1], true, 'dexscreener.com');
  else if (host === 'geckoterminal.com' && parts[0] === 'solana') add(parts[2], true, 'geckoterminal.com');
  return out;
}

/** Links on the page that point a trading/launchpad page at another address than this token's mint. */
export function foreignMintLinks(urls: readonly string[], mint: string | null, ownAddresses: readonly string[]): Array<{ address: string; host: string; ambiguous: boolean }> {
  const own = new Set([...(mint ? [mint] : []), ...ownAddresses, ...QUOTE_MINTS]);
  const seen = new Set<string>();
  const out: Array<{ address: string; host: string; ambiguous: boolean }> = [];
  for (const raw of urls) {
    const u = parseHttpUrl(raw);
    if (!u) continue;
    for (const { address, ambiguous, host } of addressesInTradeLink(u)) {
      if (!isSolanaAddress(address) || own.has(address) || seen.has(address)) continue;
      seen.add(address);
      out.push({ address, host, ambiguous });
    }
  }
  return out.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Network-backed helpers. They take an injected text fetcher so they are unit-testable offline.
export type TextFetch = (url: string) => Promise<{ ok: boolean; status: number; body: string }>;

export interface DomainAge {
  domain: string;
  registeredAt: string | null;
  ageDays: number | null;
  registrar: string | null;
  /** The registrant's organisation or name when the registry publishes one that is not a privacy proxy. Untrusted. */
  registrant: string | null;
  /** True when the registrant contact is redacted/privacy-protected (common, mild signal). null = not published. */
  privacy: boolean | null;
  source: 'rdap';
  error: string | null;
}

/** Exact advertised domain, stripping only www. Without a PSL, never attribute
 * a public suffix's registration (co.uk) to a project (docs.coin.co.uk).
 * RDAP may refuse a subdomain; that is missing data, not an invented age. */
export function registrableDomain(url: string): string | null {
  const u = parseHttpUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (/^\d/.test(host) || host.includes(':')) return null; // IP literal
  const parts = host.split('.');
  if (parts.length < 2) return null;
  return host;
}

/** Domain registration age + registrar via RDAP (rdap.org bootstrap). Keyless. */
export async function domainAgeViaRdap(url: string, fetchText: TextFetch, now = () => Date.now()): Promise<DomainAge> {
  const domain = registrableDomain(url);
  const base: DomainAge = { domain: domain ?? '', registeredAt: null, ageDays: null, registrar: null, registrant: null, privacy: null, source: 'rdap', error: null };
  if (!domain) return { ...base, error: 'no registrable domain' };
  let r: { ok: boolean; status: number; body: string };
  try { r = await fetchText(`https://rdap.org/domain/${encodeURIComponent(domain)}`); } catch (e) { return { ...base, error: `rdap fetch failed: ${(e as Error).message}` }; }
  if (!r.ok) return { ...base, error: `rdap status ${r.status}` };
  let data: Record<string, unknown>;
  try { data = JSON.parse(r.body) as Record<string, unknown>; } catch { return { ...base, error: 'rdap: invalid json' }; }
  const events = (data.events as Array<{ eventAction?: string; eventDate?: string }> | undefined) ?? [];
  const reg = events.find((e) => e.eventAction === 'registration')?.eventDate ?? null;
  const entities = flattenEntities(data.entities);
  const registrarEntity = entities.find((e) => e.roles?.includes('registrar'));
  const registrar = registrarEntity ? vcardField(registrarEntity.vcardArray, 'fn') ?? vcardField(registrarEntity.vcardArray, 'org') : null;
  const { registrant, privacy } = registrantOf(entities, data.redacted);
  const ageDays = reg ? Math.max(0, Math.round((now() - Date.parse(reg)) / 86_400_000)) : null;
  return { domain, registeredAt: reg, ageDays: Number.isFinite(ageDays as number) ? ageDays : null, registrar, registrant, privacy, source: 'rdap', error: null };
}

type RdapEntity = { roles?: string[]; vcardArray?: unknown; remarks?: Array<{ title?: string; description?: string[] }>; entities?: unknown };

/** Every entity, nested ones included (a registrar's abuse contact, a registrant under a reseller…). */
function flattenEntities(raw: unknown, depth = 0, out: RdapEntity[] = []): RdapEntity[] {
  if (!Array.isArray(raw) || depth > 4) return out;
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    out.push(e as RdapEntity);
    flattenEntities((e as RdapEntity).entities, depth + 1, out);
  }
  return out;
}

/** A jCard property value: ["vcard", [ ["fn", {}, "text", "Name"], ["org", {}, "text", "Org"] ] ]. */
function vcardField(vcardArray: unknown, key: string): string | null {
  try {
    const entries = (vcardArray as unknown[])[1] as Array<[string, unknown, string, unknown]>;
    const hit = entries.find((e) => e[0] === key);
    const v = hit ? (Array.isArray(hit[3]) ? hit[3].join(' ') : hit[3]) : null;
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    return s ? s.slice(0, 80) : null;
  } catch { return null; }
}

/** Names registrars and proxy services put in place of the real registrant. */
const PRIVACY_NAME = /redact|privacy|private|proxy|protect|withheld|gdpr|whoisguard|not disclosed|statutory masking|masked|anonymi[sz]|data protected|identity (shield|guard)|domains by proxy|contact privacy|registrant of /i;

/**
 * The registrant and whether it is privacy-protected. Privacy = a proxy/redacted registrant name or org, a
 * "REDACTED" remark on the registrant, or an RFC 9537 `redacted` entry for the registrant's name/org. Unknown (null)
 * when the registry publishes no registrant at all (thin registries such as .com leave it to the registrar).
 */
function registrantOf(entities: RdapEntity[], redacted: unknown): { registrant: string | null; privacy: boolean | null } {
  const redactedRegistrant = Array.isArray(redacted) && redacted.some((r) => {
    const name = (r as { name?: { description?: unknown; type?: unknown } })?.name;
    return /registrant/i.test(String(name?.description ?? name?.type ?? ''));
  });
  const ent = entities.find((e) => e.roles?.includes('registrant'));
  if (!ent) return { registrant: null, privacy: redactedRegistrant ? true : null };
  const name = vcardField(ent.vcardArray, 'fn');
  const org = vcardField(ent.vcardArray, 'org');
  const remarks = (ent.remarks ?? []).map((r) => `${r.title ?? ''} ${(r.description ?? []).join(' ')}`).join(' ');
  const privacy = redactedRegistrant || [name, org].some((v) => v !== null && PRIVACY_NAME.test(v)) || /redact|privacy|withheld/i.test(remarks) || (!name && !org);
  return { registrant: privacy ? null : (org ?? name), privacy };
}

export interface GithubActivity {
  owner: string;
  repo: string;
  /** 'url' = the link named this repo; 'owner' = an org/user link, the repo was picked from its public repos. */
  resolvedFrom?: 'url' | 'owner';
  createdAt: string | null;
  pushedAt: string | null;
  daysSincePush: number | null;
  stars: number | null;
  openIssues: number | null;
  archived: boolean | null;
  fork: boolean | null;
  /** owner/repo this fork was copied from (a fork is someone else's code until shown otherwise). */
  forkParent?: string | null;
  homepage?: string | null;
  description: string | null;
  commits?: Array<{ sha: string; date: string | null }>;
  /** Commits since the token was created (null when the creation time or history is unknown); counted up to 10. */
  commitsSinceToken?: number | null;
  /** True when commitsSinceToken hit the 10 cap (there are at least that many). */
  commitsSinceCapped?: boolean;
  /** Distinct contributors (capped at 100). */
  contributors?: number | null;
  /**
   * Is this repo tied to THIS token? Only a repo homepage that matches the token's site, or a README that names the
   * symbol, name or mint, counts. null when there was nothing to compare (no site/symbol/name/mint given).
   */
  relevant?: boolean | null;
  relevance?: string[];
  /** True only for a relevant, non-fork, non-archived repo: the bar for "a real GitHub" in the LARP check. */
  countsAsEvidence?: boolean;
  historyError?: string | null;
  error: string | null;
}

/** What the repo is checked against: the token's site, symbol, name, mint and creation time (ms). */
export interface GithubContext { site?: string | null; symbol?: string | null; name?: string | null; mint?: string | null; since?: number | null }

const COMMITS_SINCE_CAP = 10;
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const GH_RESERVED = /^(orgs|sponsors|features|about|topics|collections|marketplace|login|signup|settings|explore|search|pricing|enterprise|apps|site|security|customer-stories|readme|trending|notifications|new)$/i;

/** Parse github.com/<owner>[/<repo>] from a URL. `repo` is null for an org/user page. Names are charset-checked. */
export function parseGithubTarget(url: string): { owner: string; repo: string | null } | null {
  const u = parseHttpUrl(url);
  if (!u || u.hostname.toLowerCase().replace(/^www\./, '') !== 'github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 1) return null;
  const owner = parts[0];
  if (GH_RESERVED.test(owner) || !GH_OWNER.test(owner)) return null;
  if (parts.length < 2) return { owner, repo: null };
  const repo = parts[1].replace(/\.git$/, '');
  return GH_REPO.test(repo) && repo !== '.' && repo !== '..' ? { owner, repo } : null;
}

/** Parse github.com/<owner>/<repo> from a URL (null for an org/user page). */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const t = parseGithubTarget(url);
  return t && t.repo ? { owner: t.owner, repo: t.repo } : null;
}

const bareHostOf = (raw: string | null | undefined): string | null => {
  const u = raw ? parseHttpUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`) : null;
  return u ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
};

/** Does `text` name the token? A short (< 3 char) symbol only counts as "$SYM". */
function namesToken(text: string, ctx: GithubContext): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  const sym = (ctx.symbol ?? '').replace(/^\$/, '').trim().toLowerCase();
  if (sym && (sym.length >= 3 ? mentionsTerm(lower, sym) : lower.includes(`$${sym}`))) out.push('README names the symbol');
  const name = (ctx.name ?? '').trim().toLowerCase();
  if (name.length >= 3 && name !== sym && mentionsTerm(lower, name)) out.push('README names the token name');
  if (ctx.mint && text.includes(ctx.mint)) out.push('README names the mint');
  return out;
}

async function getJson(fetchText: TextFetch, url: string): Promise<{ status: number; json: unknown } | null> {
  try {
    const r = await fetchText(url);
    if (!r.ok) return { status: r.status, json: null };
    return { status: r.status, json: r.body ? JSON.parse(r.body) : null };
  } catch { return null; }
}

/** Pick the repo an org/user link most likely means: homepage on the site, then a name/description naming the token, then the latest push. */
function pickOwnerRepo(list: unknown[], ctx: GithubContext): string | null {
  const site = bareHostOf(ctx.site);
  const repos = list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' && GH_REPO.test(String((x as { name: string }).name)));
  const score = (r: Record<string, unknown>): number => {
    let s = 0;
    if (site && bareHostOf(typeof r.homepage === 'string' ? r.homepage : null) === site) s += 4;
    if (namesToken(`${r.name} ${typeof r.description === 'string' ? r.description : ''}`, { symbol: ctx.symbol, name: ctx.name }).length) s += 2;
    if (r.fork !== true) s += 1;
    return s;
  };
  const best = [...repos].sort((a, b) => score(b) - score(a) || Date.parse(String(b.pushed_at ?? 0)) - Date.parse(String(a.pushed_at ?? 0)))[0];
  return best ? String(best.name) : null;
}

/**
 * Repo activity via the keyless GitHub REST API (60 req/hr unauth): creation/last push/stars, recent commits, commits
 * since the token launched, contributors, fork parent, and whether the repo is tied to this token at all (homepage on
 * the token's site, or a README naming its symbol/name/mint). An org/user URL resolves to its most likely repo.
 */
export async function githubRepoActivity(url: string, fetchText: TextFetch, now = () => Date.now(), ctx: GithubContext = {}): Promise<GithubActivity | null> {
  const t = parseGithubTarget(url);
  if (!t) return null;
  const api = 'https://api.github.com';
  let repoName = t.repo;
  const resolvedFrom: 'url' | 'owner' = t.repo ? 'url' : 'owner';
  const base = (repo: string): GithubActivity => ({ owner: t.owner, repo, resolvedFrom, createdAt: null, pushedAt: null, daysSincePush: null, stars: null, openIssues: null, archived: null, fork: null, description: null, error: null });
  if (!repoName) {
    const list = await getJson(fetchText, `${api}/users/${encodeURIComponent(t.owner)}/repos?sort=pushed&per_page=30`);
    if (!list) return { ...base(''), error: 'github fetch failed' };
    if (!Array.isArray(list.json)) return { ...base(''), error: list.status === 404 ? 'owner not found' : `github status ${list.status}` };
    repoName = pickOwnerRepo(list.json, ctx);
    if (!repoName) return { ...base(''), error: 'owner has no public repos' };
  }
  const path = `${api}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(repoName)}`;
  let res: { ok: boolean; status: number; body: string };
  try { res = await fetchText(path); } catch (e) { return { ...base(repoName), error: `github fetch failed: ${(e as Error).message}` }; }
  if (!res.ok) return { ...base(repoName), error: res.status === 404 ? 'repo not found' : `github status ${res.status}` };
  let d: Record<string, unknown>;
  try { d = JSON.parse(res.body) as Record<string, unknown>; } catch { return { ...base(repoName), error: 'github: invalid json' }; }
  const pushedAt = typeof d.pushed_at === 'string' ? d.pushed_at : null;
  const daysSincePush = pushedAt ? Math.max(0, Math.round((now() - Date.parse(pushedAt)) / 86_400_000)) : null;
  const commits: Array<{ sha: string; date: string | null }> = [];
  let historyError: string | null = null;
  const history = await getJson(fetchText, `${path}/commits?per_page=5`);
  if (!history || !Array.isArray(history.json)) historyError = `commit history unavailable${history ? ` (${history.status})` : ''}`;
  else for (const item of history.json.slice(0, 5)) {
    if (typeof item?.sha === 'string' && /^[a-f0-9]{40}$/.test(item.sha)) commits.push({ sha: item.sha, date: typeof item.commit?.committer?.date === 'string' ? item.commit.committer.date : null });
  }
  let commitsSinceToken: number | null = null;
  if (typeof ctx.since === 'number' && Number.isFinite(ctx.since) && ctx.since > 0) {
    // 10 full commit objects stay under the text fetch cap (signed commits run ~9 KiB each; 30 or 100 overflowed
    // 256 KiB and parsed as nothing). The signal is none vs some since launch, so a cap is enough.
    const since = await getJson(fetchText, `${path}/commits?since=${encodeURIComponent(new Date(ctx.since).toISOString())}&per_page=${COMMITS_SINCE_CAP}`);
    if (since && Array.isArray(since.json)) commitsSinceToken = since.json.length;
  }
  const contrib = await getJson(fetchText, `${path}/contributors?per_page=100`);
  const contributors = contrib && Array.isArray(contrib.json) ? contrib.json.length : contrib && contrib.status === 204 ? 0 : null;
  // Relevance: a homepage on the token's own site, or a README that names the token.
  const relevance: string[] = [];
  const homepage = typeof d.homepage === 'string' && d.homepage.trim() ? d.homepage.trim().slice(0, 200) : null;
  const site = bareHostOf(ctx.site);
  if (site && bareHostOf(homepage) === site) relevance.push('repo homepage is the token site');
  if (ctx.symbol || ctx.name || ctx.mint) {
    const readme = await getJson(fetchText, `${path}/readme`);
    const content = readme?.json && typeof (readme.json as { content?: unknown }).content === 'string' ? (readme.json as { content: string }).content : null;
    if (content) {
      let text = '';
      try { text = Buffer.from(content, 'base64').toString('utf8').slice(0, 200_000); } catch { text = ''; }
      relevance.push(...namesToken(text, ctx));
    }
  }
  const comparable = !!(site || ctx.symbol || ctx.name || ctx.mint);
  const relevant = comparable ? relevance.length > 0 : null;
  const fork = typeof d.fork === 'boolean' ? d.fork : null;
  const archived = typeof d.archived === 'boolean' ? d.archived : null;
  const parent = d.parent && typeof d.parent === 'object' ? (d.parent as { full_name?: unknown }).full_name : null;
  return {
    owner: t.owner, repo: repoName, resolvedFrom,
    createdAt: typeof d.created_at === 'string' ? d.created_at : null,
    pushedAt, daysSincePush,
    stars: typeof d.stargazers_count === 'number' ? d.stargazers_count : null,
    openIssues: typeof d.open_issues_count === 'number' ? d.open_issues_count : null,
    archived, fork,
    forkParent: typeof parent === 'string' ? parent.slice(0, 140) : null,
    homepage,
    description: typeof d.description === 'string' ? d.description.slice(0, 200) : null,
    commits, commitsSinceToken, commitsSinceCapped: commitsSinceToken !== null && commitsSinceToken >= COMMITS_SINCE_CAP, contributors,
    relevant, relevance,
    countsAsEvidence: relevant === true && fork !== true && archived !== true,
    historyError,
    error: null,
  };
}

export interface LinkProbe { url: string; ok: boolean; status: number; blocked: string | null }

/** Reachability of a small set of advertised links (broken-link signal). Caller caps the list. */
export async function probeLinks(urls: string[], fetchProbe: (url: string) => Promise<SafeFetchResult>, max = 8): Promise<LinkProbe[]> {
  const out: LinkProbe[] = [];
  for (const url of urls.slice(0, max)) {
    try { const r = await fetchProbe(url); out.push({ url, ok: r.ok, status: r.status, blocked: r.blocked }); }
    catch (e) { out.push({ url, ok: false, status: 0, blocked: (e as Error).message }); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// larp_check's checklist, as a pure function so the offline eval asserts exactly what the tool emits.

/** A fixed-vocabulary reason for a page that was not read (the raw reason can echo a hostname). */
export function blockedReason(blocked: string | null, status: number): string {
  if (!blocked) return `status ${status}`;
  if (/robots/i.test(blocked)) return 'robots.txt disallows or is unavailable';
  if (/timeout|timed out/i.test(blocked)) return 'timed out';
  if (/dns|no addresses|blocked address|resolves to blocked/i.test(blocked)) return 'DNS failed or a blocked address';
  if (/redirect/i.test(blocked)) return 'redirect refused';
  return status ? `status ${status}` : 'fetch failed';
}

export interface LarpEvidence {
  /** The advertised (or directly vetted) website; null when the coin advertises none. */
  website: string | null;
  /** The token's mint is known (foreign-mint links only count against a known mint). */
  mintKnown: boolean;
  /** A url was vetted directly (no coin): "no GitHub advertised" does not apply. */
  direct?: boolean;
  page: PageSignals | null;
  domain: DomainAge | null;
  /** The repo checked (advertised or linked from the site), or null when there was none. */
  github: GithubActivity | null;
  githubUrl: string | null;
  programs?: ReadonlyArray<{ address: string; executable: boolean }> | null;
}

/**
 * The soft LARP flags (each innocent on its own), the limits (missing data, never a LARP signal) and the artifacts
 * a product claim can be checked against. The big-claim flag mirrors the skill's hard rule: a heavy technical claim
 * with no checkable artifact on a domain under 7 days old.
 */
export function larpFlags(e: LarpEvidence): { flags: string[]; limits: string[]; artifacts: string[] } {
  const flags: string[] = [];
  const limits: string[] = [];
  const artifacts: string[] = [];
  const sig = e.page;
  if (!e.website) flags.push('no website advertised');
  if (sig && !sig.fetched) limits.push(`website not read (${blockedReason(sig.blocked, sig.status)})`);
  if (sig?.spaShell) limits.push(`website is a JavaScript-only ${sig.spaShell} shell: its content is not readable without JavaScript (see page.shell for the meta/sitemap extract)`);
  if (sig?.fetched) {
    if (sig.defaultPage) flags.push('website is a default/placeholder page');
    if (sig.walletConnect) flags.push('website asks to connect a wallet');
    if (sig.drainerFlags.length) flags.push('wallet-drainer markers on the page');
    if (sig.mentionsSymbol === false && sig.mentionsName === false) flags.push('website does not mention the token symbol or name');
    if (e.mintKnown) {
      const hosts = (ambiguous: boolean) => [...new Set(sig.foreignMints.filter((f) => f.ambiguous === ambiguous).map((f) => f.host))];
      if (hosts(false).length) flags.push(`website links a different token mint (${hosts(false).join(', ')}): strong LARP signal`);
      if (hosts(true).length) flags.push(`website links a ${hosts(true).join(', ')} page for an address that is neither this mint nor one of its pairs`);
    }
  }
  const ageDays = e.domain && !e.domain.error ? e.domain.ageDays : null;
  if (typeof ageDays === 'number' && ageDays < 30) flags.push(`domain registered ${ageDays}d ago`);
  if (e.domain && !e.domain.error && e.domain.privacy === true) flags.push('domain behind registrant privacy');
  const gh = e.github;
  if (gh && !gh.error && gh.countsAsEvidence) artifacts.push('a GitHub repo tied to this token');
  for (const p of e.programs ?? []) if (p.executable) artifacts.push(`an executable on-chain program the site names (${p.address})`);
  if (sig?.bigTechClaims.length && !artifacts.length && typeof ageDays === 'number' && ageDays < 7) {
    flags.push(`big technical claim (${sig.bigTechClaims.join(', ')}) with no checkable artifact (no repo tied to the token, no executable program named on the site) on a domain registered ${ageDays}d ago`);
  }
  if (gh && !gh.error) {
    if (gh.archived) flags.push('github repo is archived');
    if (gh.fork) flags.push(`github repo is a fork${gh.forkParent ? ' of another project' : ''}`);
    if (typeof gh.daysSincePush === 'number' && gh.daysSincePush > 180) flags.push(`github repo last pushed ${gh.daysSincePush}d ago`);
    if (gh.relevant === false) flags.push('github repo is not tied to this token (no homepage on its site, no README mention): not evidence of its product');
    if (gh.commitsSinceToken === 0) flags.push('github repo has no commits since the token launched');
  } else if (!e.githubUrl && !e.direct) {
    flags.push('no GitHub repo advertised');
  }
  return { flags, limits, artifacts };
}
