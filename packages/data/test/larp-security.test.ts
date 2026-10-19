import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch, blockedIp } from '../src/larp/safe-fetch.ts';
import { fetchPage, robotsAllows } from '../src/larp/robots.ts';

const resolve = async () => ['93.184.216.34'];

test('native socket rejects DNS rebinding after the preliminary public lookup', async () => {
  let calls = 0;
  const r = await safeFetch('https://rebind.invalid/', { resolve: async () => ++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1'] });
  assert.equal(r.ok, false);
  assert.match(r.blocked!, /blocked DNS/);
  assert.equal(calls, 2);
});

test('DNS and stalled response bodies are inside the wall-clock budget', async () => {
  // Keep test runner alive while the production AbortSignal timer is unrefed.
  const keep = setInterval(() => {}, 100);
  try {
    const dns = await safeFetch('https://stall.invalid/', { timeoutMs: 20, resolve: () => new Promise(() => {}) });
    assert.equal(dns.ok, false);
    assert.match(dns.blocked!, /timeout/i);
    const body = await safeFetch('https://body.invalid/', { timeoutMs: 20, resolve,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
    assert.equal(body.ok, false);
    assert.match(body.blocked!, /timeout/i);
  } finally { clearInterval(keep); }
});

test('alternative IPv6 encapsulations and malformed DNS answers fail closed', () => {
  for (const ip of ['::127.0.0.1', '64:ff9b:1::7f00:1', '2002:7f00:1::', '2001:0:1::', 'fec0::1', 'not-an-ip']) assert.ok(blockedIp(ip), ip);
});

test('robots honors product precedence, wildcards, longest allow, and query', () => {
  const url = (p: string) => new URL(p, 'https://example.org');
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', url('/app')), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\nUser-agent: dexterm\nAllow: /', url('/app')), true);
  const rules = 'User-agent: *\nDisallow: /private*\nAllow: /private/public\nDisallow: /*?secret=*';
  assert.equal(robotsAllows(rules, url('/private/data')), false);
  assert.equal(robotsAllows(rules, url('/private/public')), true);
  assert.equal(robotsAllows(rules, url('/app?secret=yes')), false);
});

test('disallowed or unavailable robots never fetches the page', async () => {
  for (const status of [200, 429, 503]) {
    const seen: string[] = [];
    const r = await fetchPage('https://example.org/private', { resolve, fetchImpl: async (u) => {
      seen.push(String(u)); return new Response('User-agent: *\nDisallow: /', { status });
    } });
    assert.equal(r.ok, false);
    assert.match(r.blocked!, /robots/);
    assert.deepEqual(seen, ['https://example.org/robots.txt']);
  }
});

test('redirect origin is robots-checked independently before page fetch', async () => {
  const seen: string[] = [];
  const r = await fetchPage('https://first.example/app', { resolve, fetchImpl: async (input) => {
    const u = String(input); seen.push(u);
    if (u === 'https://first.example/robots.txt') return new Response('', { status: 404 });
    if (u === 'https://first.example/app') return new Response('', { status: 302, headers: { location: 'https://second.example/private' } });
    return new Response('User-agent: *\nDisallow: /private');
  } });
  assert.equal(r.ok, false);
  assert.deepEqual(seen, ['https://first.example/robots.txt', 'https://first.example/app', 'https://second.example/robots.txt']);
});
