// task-1315 — LARP detector: link extraction, SSRF-safe fetch, evidence signals.
// All offline: DNS and fetch are injected. These lock down the security-critical
// bits (SSRF refusals, redirect-into-private, caps) and the deterministic parsers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyLink, extractLinks, parseHttpUrl, type RawLinkSources,
} from '../src/larp/links.ts';
import {
  assertPublicUrl, blockedIp, safeFetch, SsrfError, type DnsResolver,
} from '../src/larp/safe-fetch.ts';
import {
  domainAgeViaRdap, githubRepoActivity, pageSignals, parseGithubRepo,
  probeLinks, registrableDomain, extractUrls, type TextFetch,
} from '../src/larp/evidence.ts';
import type { SafeFetchResult } from '../src/larp/safe-fetch.ts';

// ---------------------------------------------------------------------------
// links.ts
test('parseHttpUrl accepts only absolute http(s)', () => {
  assert.ok(parseHttpUrl('https://a.com'));
  assert.ok(parseHttpUrl('http://a.com/x'));
  assert.equal(parseHttpUrl('mailto:a@b.com'), null);
  assert.equal(parseHttpUrl('javascript:alert(1)'), null);
  assert.equal(parseHttpUrl('data:text/html,x'), null);
  assert.equal(parseHttpUrl('/relative'), null);
  assert.equal(parseHttpUrl('ftp://a.com'), null);
  assert.equal(parseHttpUrl(''), null);
  assert.equal(parseHttpUrl(123 as unknown), null);
  assert.equal(parseHttpUrl('https://a.com/' + 'x'.repeat(3000)), null);
});

test('classifyLink is host-driven', () => {
  const k = (u: string) => classifyLink(parseHttpUrl(u)!);
  assert.equal(k('https://x.com/foo'), 'x');
  assert.equal(k('https://twitter.com/foo'), 'x');
  assert.equal(k('https://t.me/foo'), 'telegram');
  assert.equal(k('https://discord.gg/foo'), 'discord');
  assert.equal(k('https://github.com/a/b'), 'github');
  assert.equal(k('https://docs.foo.com'), 'docs');
  assert.equal(k('https://foo.gitbook.io'), 'docs');
  assert.equal(k('https://foo.com/docs/intro'), 'docs');
  assert.equal(k('https://linktr.ee/foo'), 'linktree');
  assert.equal(k('https://myproject.io'), 'website');
});

test('extractLinks dedups, orders by source, picks primaries', () => {
  const src: RawLinkSources = {
    dexscreener: {
      info: {
        websites: [{ label: 'Website', url: 'https://proj.io/' }, { label: 'bad', url: 'javascript:x' }],
        socials: [{ type: 'twitter', url: 'https://x.com/proj' }, { type: 'telegram', url: 'https://t.me/proj' }],
      },
    },
    jupiter: { website: 'https://proj.io', twitter: 'https://twitter.com/proj', telegram: null },
    pumpfun: { website: null, x: 'https://x.com/proj', telegram: 'https://t.me/other' },
  };
  const links = extractLinks(src);
  assert.equal(links.website, 'https://proj.io/');
  assert.equal(links.x, 'https://x.com/proj');
  assert.equal(links.telegram, 'https://t.me/proj');
  // proj.io (trailing slash) and x.com/proj dedup across sources; t.me/other is distinct.
  const urls = links.all.map((l) => l.url);
  assert.equal(urls.filter((u) => u.includes('proj.io')).length, 1);
  assert.equal(urls.filter((u) => u.includes('x.com/proj')).length, 1);
  assert.ok(links.all.some((l) => l.url === 'https://t.me/other'));
  assert.ok(!links.all.some((l) => l.url.startsWith('javascript')));
  // Website label sanitised and kept.
  assert.equal(links.all.find((l) => l.kind === 'website')?.label, 'Website');
});

test('extractLinks drops control chars from labels and caps count', () => {
  const websites = Array.from({ length: 40 }, (_, i) => ({ label: `s\u0000ite${i}`, url: `https://d${i}.com` }));
  const links = extractLinks({ dexscreener: { info: { websites, socials: [] } } });
  assert.ok(links.all.length <= 24);
  assert.ok(!links.all.some((l) => l.label.includes('\u0000')));
});

// ---------------------------------------------------------------------------
// safe-fetch.ts — blockedIp
test('blockedIp flags IPv4 private/loopback/link-local/CGNAT/reserved', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.1.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.5', '198.18.0.1', '224.0.0.1', '240.0.0.1']) {
    assert.ok(blockedIp(ip), `${ip} should be blocked`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
    assert.equal(blockedIp(ip), null, `${ip} should be allowed`);
  }
});

test('blockedIp flags IPv6 loopback/ula/link-local/mapped/nat64', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2001:db8::1', '100::1']) {
    assert.ok(blockedIp(ip), `${ip} should be blocked`);
  }
  assert.equal(blockedIp('2606:4700:4700::1111'), null); // cloudflare dns, public
});

// ---------------------------------------------------------------------------
// safe-fetch.ts — assertPublicUrl
const allow: DnsResolver = async () => ['93.184.216.34'];
const toPrivate: DnsResolver = async () => ['10.0.0.5'];

test('assertPublicUrl rejects bad schemes and credentials', async () => {
  await assert.rejects(() => assertPublicUrl('ftp://a.com', allow), SsrfError);
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd', allow), SsrfError);
  await assert.rejects(() => assertPublicUrl('https://user:pw@a.com', allow), SsrfError);
});

test('assertPublicUrl blocks IP literals including decimal/hex forms', async () => {
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/', allow), SsrfError);
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data', allow), SsrfError);
  // WHATWG URL normalises these to 127.0.0.1 before we see them:
  await assert.rejects(() => assertPublicUrl('http://2130706433/', allow), SsrfError); // decimal 127.0.0.1
  await assert.rejects(() => assertPublicUrl('http://0x7f000001/', allow), SsrfError); // hex 127.0.0.1
  await assert.rejects(() => assertPublicUrl('http://[::1]/', allow), SsrfError);
});

test('assertPublicUrl refuses when DNS resolves to a blocked IP', async () => {
  await assert.rejects(() => assertPublicUrl('https://evil.example', toPrivate), SsrfError);
  const u = await assertPublicUrl('https://good.example', allow);
  assert.equal(u.hostname, 'good.example');
});

test('assertPublicUrl refuses when host has no addresses', async () => {
  await assert.rejects(() => assertPublicUrl('https://nx.example', async () => []), SsrfError);
});

// ---------------------------------------------------------------------------
// safe-fetch.ts — safeFetch (injected fetch)
function resp(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers(init.headers ?? { 'content-type': 'text/html' });
  return new Response(body, { status: init.status ?? 200, headers });
}

test('safeFetch returns body on success', async () => {
  const r = await safeFetch('https://good.example/page', {
    resolve: allow,
    fetchImpl: async () => resp('<html>hi</html>'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.blocked, null);
  assert.match(r.body, /hi/);
});

test('safeFetch refuses scheme/private before calling fetch', async () => {
  let called = 0;
  const r = await safeFetch('http://127.0.0.1/', { resolve: allow, fetchImpl: async () => { called++; return resp(''); } });
  assert.equal(r.ok, false);
  assert.match(r.blocked!, /blocked address/);
  assert.equal(called, 0);
});

test('safeFetch re-validates redirects and blocks a bounce into private space', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('start')) return resp('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
    return resp('secret');
  };
  const r = await safeFetch('https://good.example/start', { resolve: allow, fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.blocked!, /169\.254|blocked/);
});

test('safeFetch caps body size', async () => {
  const big = 'a'.repeat(5000);
  const r = await safeFetch('https://good.example/big', {
    resolve: allow, maxBytes: 1000,
    fetchImpl: async () => resp(big),
  });
  assert.equal(r.truncated, true);
  assert.equal(r.bytes, 1000);
  assert.equal(r.body.length, 1000);
});

test('safeFetch enforces the redirect cap', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const n = Number(/n=(\d+)/.exec(String(input))?.[1] ?? '0');
    return resp('', { status: 302, headers: { location: `https://good.example/x?n=${n + 1}` } });
  };
  const r = await safeFetch('https://good.example/x?n=0', { resolve: allow, maxRedirects: 2, fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.blocked!, /too many redirects/);
});

test('safeFetch surfaces a timed-out fetch as blocked, never throws', async () => {
  const r = await safeFetch('https://good.example/slow', {
    resolve: allow,
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; },
  });
  assert.equal(r.ok, false);
  assert.match(r.blocked!, /timed out/);
});

test('safeFetch skips non-textual content types', async () => {
  const r = await safeFetch('https://good.example/img', {
    resolve: allow,
    fetchImpl: async () => resp('binary', { headers: { 'content-type': 'image/png' } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.body, '');
});

test('safeFetch keeps application/rdap+json (and other +json/+xml) bodies', async () => {
  // Authoritative RDAP servers answer with application/rdap+json; without the structured-suffix arm
  // the body was dropped and check_domain saw empty JSON. Guard the decode here.
  const rdap = await safeFetch('https://rdap.example/domain/x.io', {
    resolve: allow,
    fetchImpl: async () => resp('{"events":[]}', { headers: { 'content-type': 'application/rdap+json' } }),
  });
  assert.equal(rdap.ok, true);
  assert.equal(rdap.body, '{"events":[]}', 'rdap+json body is decoded, not discarded');
  const atom = await safeFetch('https://feed.example/x', {
    resolve: allow,
    fetchImpl: async () => resp('<feed/>', { headers: { 'content-type': 'application/atom+xml' } }),
  });
  assert.equal(atom.body, '<feed/>', '+xml structured suffix is decoded too');
});

// ---------------------------------------------------------------------------
// evidence.ts — pageSignals
function okRes(body: string, finalUrl = 'https://proj.io/'): SafeFetchResult {
  return { ok: true, status: 200, finalUrl, contentType: 'text/html', body, bytes: body.length, truncated: false, redirects: [], blocked: null, elapsedMs: 5 };
}

test('pageSignals reports a fetch failure as not-fetched', () => {
  const s = pageSignals({ ok: false, status: 0, finalUrl: '', contentType: null, body: '', bytes: 0, truncated: false, redirects: [], blocked: 'dns failed', elapsedMs: 1 });
  assert.equal(s.fetched, false);
  assert.equal(s.blocked, 'dns failed');
});

test('pageSignals extracts title/desc/links and mentions', () => {
  const html = `<html><head><title>MyCoin — real app</title>
    <meta name="description" content="The MyCoin protocol">
    <meta name="generator" content="Framer">
    </head><body><h1>MyCoin</h1>
    <a href="https://github.com/myorg/mycoin">code</a>
    <a href="/app">Launch App</a>
    <a href="https://docs.mycoin.io">docs</a>
    <p>Welcome to the MYC token.</p></body></html>`;
  const s = pageSignals(okRes(html), { symbol: '$MYC', name: 'MyCoin' });
  assert.equal(s.fetched, true);
  assert.match(s.title!, /MyCoin/);
  assert.equal(s.description, 'The MyCoin protocol');
  assert.equal(s.siteBuilder, 'framer');
  assert.equal(s.hasGithub, true);
  assert.equal(s.hasApp, true);
  assert.equal(s.hasDocs, true);
  assert.equal(s.mentionsSymbol, true);
  assert.equal(s.mentionsName, true);
  assert.ok(s.linkCount >= 2);
});

test('pageSignals flags drainer patterns and default pages', () => {
  const drain = pageSignals(okRes(`<html><body><script>window.ethereum.request({method:'eth_sendTransaction'})</script>connect wallet</body></html>`));
  assert.ok(drain.drainerFlags.length >= 1);
  assert.equal(drain.walletConnect, true);

  const parked = pageSignals(okRes(`<html><body>This domain is for sale. Buy this domain.</body></html>`));
  assert.match(parked.defaultPage!, /parked/);

  const empty = pageSignals(okRes(`<html><body>  </body></html>`));
  assert.equal(empty.defaultPage, 'near-empty page');
});

test('extractUrls resolves relative against base', () => {
  const urls = extractUrls(`<a href="/x">x</a><a href="https://y.com">y</a>`, 'https://proj.io/');
  assert.ok(urls.includes('https://proj.io/x'));
  assert.ok(urls.includes('https://y.com/'));
});

// evidence.ts — domain/github helpers
test('registrableDomain + parseGithubRepo', () => {
  assert.equal(registrableDomain('https://docs.foo.co.uk/x'), 'docs.foo.co.uk'); // never attribute the suffix's age
  assert.equal(registrableDomain('https://www.foo.co.uk/x'), 'foo.co.uk');
  assert.equal(registrableDomain('https://foo.com'), 'foo.com');
  assert.equal(registrableDomain('http://127.0.0.1'), null);
  assert.deepEqual(parseGithubRepo('https://github.com/myorg/mycoin'), { owner: 'myorg', repo: 'mycoin' });
  assert.deepEqual(parseGithubRepo('https://github.com/myorg/mycoin.git'), { owner: 'myorg', repo: 'mycoin' });
  assert.equal(parseGithubRepo('https://github.com/features'), null);
  assert.equal(parseGithubRepo('https://gitlab.com/a/b'), null);
});

test('domainAgeViaRdap parses registration + privacy', async () => {
  const body = JSON.stringify({
    events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }],
    entities: [
      { roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'NameCheap']]] },
      { roles: ['registrant'], remarks: [{ title: 'REDACTED FOR PRIVACY' }] },
    ],
  });
  const fetchText: TextFetch = async () => ({ ok: true, status: 200, body });
  const d = await domainAgeViaRdap('https://proj.io', fetchText, () => Date.parse('2021-01-01T00:00:00Z'));
  assert.equal(d.registeredAt, '2020-01-01T00:00:00Z');
  assert.equal(d.ageDays, 366); // 2020 leap year
  assert.equal(d.registrar, 'NameCheap');
  assert.equal(d.privacy, true);
  assert.equal(d.error, null);
});

test('domainAgeViaRdap surfaces errors without throwing', async () => {
  const d = await domainAgeViaRdap('https://proj.io', async () => ({ ok: false, status: 404, body: '' }));
  assert.match(d.error!, /404/);
});

test('githubRepoActivity parses repo metadata', async () => {
  const body = JSON.stringify({ created_at: '2023-05-01T00:00:00Z', pushed_at: '2023-06-01T00:00:00Z', stargazers_count: 42, open_issues_count: 3, archived: false, fork: false, description: 'real repo' });
  const g = await githubRepoActivity('https://github.com/myorg/mycoin', async () => ({ ok: true, status: 200, body }), () => Date.parse('2023-06-11T00:00:00Z'));
  assert.ok(g);
  assert.equal(g!.stars, 42);
  assert.equal(g!.daysSincePush, 10);
  assert.equal(g!.description, 'real repo');
});

test('githubRepoActivity returns null for non-github and error for 404', async () => {
  assert.equal(await githubRepoActivity('https://proj.io', async () => ({ ok: true, status: 200, body: '{}' })), null);
  const g = await githubRepoActivity('https://github.com/a/missing', async () => ({ ok: false, status: 404, body: '' }));
  assert.match(g!.error!, /not found/);
});

test('probeLinks reports reachability and caps the list', async () => {
  const fetchProbe = async (url: string): Promise<SafeFetchResult> =>
    ({ ok: !url.includes('dead'), status: url.includes('dead') ? 0 : 200, finalUrl: url, contentType: null, body: '', bytes: 0, truncated: false, redirects: [], blocked: url.includes('dead') ? 'fetch failed' : null, elapsedMs: 1 });
  const probes = await probeLinks(['https://a.com', 'https://dead.com', 'https://b.com'], fetchProbe);
  assert.equal(probes.length, 3);
  assert.equal(probes.find((p) => p.url.includes('dead'))!.ok, false);
});
