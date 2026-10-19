// Offline labelled LARP eval (larp-fixes). The 22 live tokens of the 2026-10-18 review, captured once as fixtures
// (fixtures/larp/<tag>.json: the website HTML as fetched by fetch_page's robots-checked GET, the sitemap, the RDAP and
// GitHub API responses the code requested, and the reviewer's label). The deterministic pass (pageSignals,
// domainAgeViaRdap, githubRepoActivity, larpFlags: exactly what larp_check computes) is replayed with no network, and
// the signals the review found missing or wrong are asserted per token. No model runs here: the reviewer label and
// its acceptable verdicts are recorded for the (paid, manual) analyst sanity run, not scored.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import './helpers.ts';
import { pageSignals, domainAgeViaRdap, githubRepoActivity, larpFlags, parseSitemap, type TextFetch, type PageSignals, type DomainAge, type GithubActivity } from '../src/larp/evidence.ts';
import type { SafeFetchResult } from '../src/larp/safe-fetch.ts';

interface Fixture {
  tag: string; group: string; mint: string; symbol: string; name: string; createdAt: number | null; capturedAt: string;
  label: { reviewer: string; acceptable: string[]; note: string };
  pairs: string[];
  links: { website: string | null; all: Array<{ kind: string; url: string; source: string }> };
  github: { url: string; source: 'advertised' | 'site' } | null;
  page: SafeFetchResult | null;
  sitemap: { status: number; ok: boolean; body: string } | null;
  http: Record<string, { ok: boolean; status: number; body: string }>;
}
interface Evaluated { fx: Fixture; sig: PageSignals | null; domain: DomainAge | null; github: GithubActivity | null; flags: string[]; limits: string[]; artifacts: string[] }

const DIR = new URL('./fixtures/larp/', import.meta.url);
const FIXTURES: Fixture[] = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as Fixture);

async function evaluate(fx: Fixture): Promise<Evaluated> {
  const now = () => Date.parse(fx.capturedAt);
  const replay: TextFetch = async (url) => fx.http[url] ?? { ok: false, status: 404, body: '' };
  const sig = fx.page ? pageSignals(fx.page, { symbol: fx.symbol, name: fx.name, mint: fx.mint, ownAddresses: fx.pairs }) : null;
  const domain = fx.links.website ? await domainAgeViaRdap(fx.links.website, replay, now) : null;
  const github = fx.github ? await githubRepoActivity(fx.github.url, replay, now, { site: sig?.finalUrl ?? fx.links.website, symbol: fx.symbol, name: fx.name, mint: fx.mint, since: fx.createdAt }) : null;
  const { flags, limits, artifacts } = larpFlags({ website: fx.links.website, mintKnown: true, page: sig, domain, github, githubUrl: fx.github?.url ?? null, programs: null });
  return { fx, sig, domain, github, flags, limits, artifacts };
}

let cache: Map<string, Evaluated> | null = null;
async function all(): Promise<Map<string, Evaluated>> {
  if (!cache) cache = new Map(await Promise.all(FIXTURES.map(async (fx) => [fx.tag, await evaluate(fx)] as const)));
  return cache;
}
const tagsWhere = async (pred: (e: Evaluated) => boolean): Promise<string[]> => [...(await all()).values()].filter(pred).map((e) => e.fx.tag).sort();
const has = (e: Evaluated, re: RegExp) => e.flags.some((f) => re.test(f));

test('the eval set is the 22 reviewed tokens, each with a reviewer label and acceptable verdicts', () => {
  assert.equal(FIXTURES.length, 22);
  const verdicts = new Set(['REAL_PRODUCT', 'EARLY_BUT_REAL', 'NO_PRODUCT_CLAIMED', 'LARP', 'UNVERIFIABLE']);
  for (const fx of FIXTURES) {
    assert.ok(fx.label?.reviewer && fx.label.acceptable.length, `${fx.tag}: labelled`);
    for (const v of fx.label.acceptable) assert.ok(verdicts.has(v), `${fx.tag}: ${v} is a verdict`);
    assert.match(fx.mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  }
});

test('JS-only shells are recognised (and listed as a limit), never "near-empty / placeholder"', async () => {
  assert.deepEqual(await tagsWhere((e) => !!e.sig?.spaShell), ['ARC', 'DRIFT', 'GOLD', 'GRIFFAIN', 'PLUTO', 'cartoonmoney'].sort());
  assert.deepEqual(await tagsWhere((e) => !!e.sig?.defaultPage), [], 'no reviewed site is a placeholder page');
  for (const e of (await all()).values()) if (e.sig?.spaShell) assert.ok(e.limits.some((l) => /JavaScript-only/.test(l)), e.fx.tag);
  const drift = (await all()).get('DRIFT')!;
  assert.equal(drift.sig!.spaShell, 'next.js (client-rendered)', 'Drift bails out to client rendering: 16 chars of text is missing data');
  assert.match((await all()).get('PLUTO')!.sig!.shellText, /voice-first/i, 'the meta extract still reads what Pluto claims');
});

test('pages that could not be read are limits, not LARP flags', async () => {
  assert.deepEqual(await tagsWhere((e) => e.sig !== null && !e.sig.fetched), ['FLAME', 'WIF']);
  const flame = (await all()).get('FLAME')!;
  assert.ok(flame.limits.includes('website not read (robots.txt disallows or is unavailable)'));
  assert.deepEqual(await tagsWhere((e) => e.flags.includes('no website advertised')), ['nolinks', 'sir']);
});

test('the meme sites read as memes that claim no product (the NO_PRODUCT_CLAIMED evidence)', async () => {
  for (const tag of ['catonthinice', 'lepigeon']) {
    const e = (await all()).get(tag)!;
    assert.ok(e.sig!.memeTerms.length > 0, `${tag}: calls itself a meme`);
    assert.deepEqual(e.sig!.claimTerms, [], `${tag}: claims no product`);
    assert.deepEqual(e.sig!.bigTechClaims, []);
    assert.equal(e.sig!.walletConnect, false, `${tag}: a how-to-buy paragraph is not wallet-connect`);
  }
});

test('the big-claim rule fires for the two LARP-leaning tokens and nothing else', async () => {
  assert.deepEqual(await tagsWhere((e) => has(e, /^big technical claim/)), ['QINU', 'ultraviolet']);
  const uv = (await all()).get('ultraviolet')!;
  assert.deepEqual(uv.sig!.bigTechClaims, ['zero-knowledge', 'layer 2 / rollup']);
  assert.equal(uv.domain!.ageDays, 0);
  assert.deepEqual(uv.artifacts, []);
  assert.deepEqual((await all()).get('QINU')!.sig!.bigTechClaims, ['quantum'], '"post-quantum cryptography" launchpad claim; "quantum realm" and "Nebula Bridge" are not claims');
  // Every token the reviewer graded real or early has no big-claim flag.
  for (const e of (await all()).values()) if (/^(REAL|early)/.test(e.fx.label.reviewer)) assert.ok(!has(e, /^big technical claim/), e.fx.tag);
});

test('symbol/name mentions are whole-word and the mint is found on the page before any firewall', async () => {
  assert.deepEqual(await tagsWhere((e) => has(e, /does not mention the token/)), ['SQUIRE']);
  assert.deepEqual(await tagsWhere((e) => e.sig?.mentionsMint === true), ['GOLD', 'JUP', 'QINU', 'lepigeon', 'ultraviolet'].sort());
  assert.deepEqual(await tagsWhere((e) => (e.sig?.foreignMints.length ?? 0) > 0), [], 'no reviewed site links a different mint');
});

test('GitHub counts only when tied to the token: rig (ARC) is unrelated, swarms and SQUIRE are tied', async () => {
  const m = await all();
  const arc = m.get('ARC')!.github!;
  assert.equal(arc.repo, 'rig');
  assert.equal(arc.relevant, false);
  assert.equal(arc.countsAsEvidence, false);
  assert.ok(has(m.get('ARC')!, /not tied to this token/));
  const swarms = m.get('SWARMS')!;
  assert.equal(swarms.fx.github!.source, 'site', 'picked up from the website, not advertised');
  assert.equal(swarms.github!.countsAsEvidence, true);
  assert.ok(swarms.github!.contributors! > 10);
  assert.ok(swarms.artifacts.includes('a GitHub repo tied to this token'));
  const squire = m.get('SQUIRE')!.github!;
  assert.equal(squire.resolvedFrom, 'owner', 'an org/user link resolved to its repo');
  assert.ok(squire.relevance!.includes('README names the mint'));
  assert.equal(squire.contributors, 1);
});

test('hasApp needs an app link: the claim-heavy sites have one, the memes do not', async () => {
  assert.deepEqual(await tagsWhere((e) => !!e.sig?.hasApp), ['JUP', 'PIPS', 'SWARMS', 'ZENO', 'startupsi', 'ultraviolet'].sort());
  assert.equal((await all()).get('ultraviolet')!.sig!.appLink, 'https://app.ultravioletnetwork.com/');
});

test('RDAP ages replay from the recorded responses; a 404 registry is missing data', async () => {
  const m = await all();
  assert.equal(m.get('JUP')!.domain!.error, 'rdap status 404');
  assert.ok(m.get('JTO')!.domain!.ageDays! > 1000);
  assert.deepEqual(await tagsWhere((e) => typeof e.domain?.ageDays === 'number' && e.domain.ageDays < 7), ['FLAME', 'MET', 'PIPS', 'QINU', 'catonthinice', 'lepigeon', 'startupsi', 'ultraviolet'].sort());
});

test('recorded sitemaps parse to same-site paths for the shells that have one', () => {
  const arc = FIXTURES.find((f) => f.tag === 'ARC')!;
  assert.ok(arc.sitemap && arc.sitemap.ok);
  assert.ok(parseSitemap(arc.sitemap!.body, arc.page!.finalUrl).length > 0);
  const pluto = FIXTURES.find((f) => f.tag === 'PLUTO')!;
  assert.deepEqual(parseSitemap(pluto.sitemap!.body, pluto.page!.finalUrl), [], 'an SPA fallback served at /sitemap.xml is not a sitemap');
});
