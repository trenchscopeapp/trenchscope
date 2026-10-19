// task-1290 follow-up: the popup URL pin is a PARSED origin comparison, not a string prefix. These are the
// bypass attempts from the re-verify (userinfo `http://127.0.0.1:1@evil.example/`, `@`, backslashes,
// percent-encoded hosts, uppercase scheme, trailing dot, other ports) against the shared TS rule
// (loopback.ts), assertLoopbackUrl, openInBrowser and the browser fallback host. The Rust shell has the
// same table in shell/wry/src/main.rs (`cargo test`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loopbackUrlProblem, assertLoopbackUrl, isLoopbackUrl } from '../src/loopback.ts';
import { openInBrowser, BrowserPopupHost } from '../src/host.ts';

const P = 5000;
const ok = (s: string) => assert.equal(loopbackUrlProblem(s, P), null, `${s} should be allowed`);
const no = (s: string, re: RegExp) => {
  const problem = loopbackUrlProblem(s, P);
  assert.ok(problem !== null, `${s} should be refused`);
  assert.match(problem, re, s);
  assert.throws(() => assertLoopbackUrl(s, P), re, s);
  assert.equal(isLoopbackUrl(s, P), false, s);
};

test('userinfo tricks are refused: the host after @ is the real host, and userinfo is never allowed at all', () => {
  // the reported bypass: "127.0.0.1:1" parses as userinfo, the host is evil.example — refused on the
  // userinfo rule first (it runs before the host rule); the host rule would refuse it too (asserted below)
  no('http://127.0.0.1:1@evil.example/phish', /userinfo/);
  assert.equal(new URL('http://127.0.0.1:1@evil.example/phish').hostname, 'evil.example');
  no(`http://127.0.0.1:${P}@evil.example/`, /userinfo/);
  no('http://127.0.0.1:80@evil.example:443/', /userinfo/);
  no('http://localhost:x@evil.example/', /userinfo/);
  no('http://[::1]:1@evil.example/', /userinfo/);
  no('http://evil.example#@127.0.0.1:5000/', /host must be 127\.0\.0\.1, got evil\.example/);
  // userinfo on our own host: still refused (no credential-shaped prefix ever reaches a launcher/shell)
  no(`http://user@127.0.0.1:${P}/`, /userinfo/);
  no(`http://user:pw@127.0.0.1:${P}/`, /userinfo/);
  no(`http://:pw@127.0.0.1:${P}/`, /userinfo/);
  // a bare `@` is EMPTY userinfo per WHATWG and the host is ours → allowed (and normalised away)
  ok(`http://@127.0.0.1:${P}/`);
  assert.equal(assertLoopbackUrl(`http://@127.0.0.1:${P}/x`, P), `http://127.0.0.1:${P}/x`);
});

test('other hosts, schemes, [::1], localhost and domain suffixes are refused', () => {
  no(`https://127.0.0.1:${P}/`, /must be an http/);
  no('HTTPS://evil.example/', /must be an http/);
  no('http://evil.example/', /host must be/);
  no(`http://localhost:${P}/`, /host must be/);
  no(`http://[::1]:${P}/`, /host must be/);
  no(`http://127.0.0.1.evil.example:${P}/`, /host must be/);
  no(`http://127.0.0.1%2Eevil.example:${P}/`, /host must be/);
  no('file:///etc/passwd', /must be an http/);
  no('javascript:alert(1)', /must be an http/);
  no('data:text/html,hi', /must be an http/);
  no('', /not a valid URL/);
  no('not a url', /not a valid URL/);
  no(`http://127.0.0.1%40evil.example:${P}/`, /not a valid URL/);
});

test('the port is pinned to the server (no port means 80)', () => {
  no(`http://127.0.0.1:${P + 1}/`, /port must be/);
  no('http://127.0.0.1:9/other-local-service', /port must be/);
  no('http://127.0.0.1/', /port must be .*got \(default\)/);
  no('http://127.0.0.1:65536/', /not a valid URL/);
  assert.equal(loopbackUrlProblem('http://127.0.0.1/', 80), null);
  assert.equal(loopbackUrlProblem('http://127.0.0.1:80/', 80), null);
  assert.equal(isLoopbackUrl('http://127.0.0.1:631/'), true, 'with no port given, any loopback port passes isLoopbackUrl');
  assert.equal(isLoopbackUrl('http://127.0.0.1:631/', P), false);
});

test('spellings that normalise to our origin pass; backslashes never move the host', () => {
  ok(`HTTP://127.0.0.1:${P}/`);
  ok(`http://127.0.0.1.:${P}/`);            // trailing dot: the IPv4 parser strips it → 127.0.0.1
  ok(`http://2130706433:${P}/`);
  ok(`http://0x7f.1:${P}/`);
  ok(`http://127.0.0.%31:${P}/`);
  ok(`http://%31%32%37.0.0.1:${P}/`);
  // `\` is `/` for http in WHATWG: these are our origin with an odd path, so the normalised form is ours…
  assert.equal(assertLoopbackUrl(`http:\\\\127.0.0.1:${P}\\x`, P), `http://127.0.0.1:${P}/x`);
  assert.equal(assertLoopbackUrl(`http://127.0.0.1:${P}\\@evil.example/`, P), `http://127.0.0.1:${P}/@evil.example/`);
  // …and a backslash cannot smuggle our host into the path of a remote URL
  no(`http://evil.example\\@127.0.0.1:${P}/`, /host must be 127\.0\.0\.1, got evil\.example/);
});

// The browser fallback: with a pinned port it launches only our origin (platform linux → xdg-open, absent
// on the test box, harmless); every bypass form is refused before any launcher is spawned.
test('openInBrowser / BrowserPopupHost: refuse the bypass forms, launch only our origin', () => {
  for (const s of ['http://127.0.0.1:1@evil.example/', `http://user@127.0.0.1:${P}/`, `http://localhost:${P}/`, `http://[::1]:${P}/`,
    `https://127.0.0.1:${P}/`, `http://evil.example\\@127.0.0.1:${P}/`, 'http://127.0.0.1:631/']) {
    assert.equal(openInBrowser(s, 'linux', P), false, s);
  }
  assert.equal(openInBrowser(`http://127.0.0.1:${P}/popup/chart?p=x`, 'linux', P), true);
  // the pre-existing laxity (D2): localhost / [::1] are refused even with no port given
  assert.equal(openInBrowser('http://localhost:8080/admin', 'linux'), false);
  assert.equal(openInBrowser('http://[::1]:8080/', 'linux'), false);

  const h = new BrowserPopupHost('linux', P);
  const errors: string[] = [];
  h.on('error', (e: Error) => errors.push(e.message));
  h.open('p1', 'http://127.0.0.1:1@evil.example/');
  h.open('p2', `http://127.0.0.1:${P + 1}/`);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /refused/);
  h.open('p3', `http://127.0.0.1:${P}/popup/chart?p=x`);
  assert.equal(errors.length, 2, 'our origin launches without error');
  h.quit();
});
