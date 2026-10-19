// task-1326: the popup server's ONE image route — our cached PNG by 32-hex key, exact path only, from the
// injected provider (never the filesystem by URL), and the page CSP that opens img-src to exactly that
// path prefix (and stays 'none' without a provider). Loopback only, like everything else here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPopupServer, IMAGE_ROUTE_RE, IMAGE_ROUTE_PREFIX, type ServerEvent } from '../src/index.ts';

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const KEY = 'a'.repeat(32);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test('image route: serves the provider PNG for an exact key; every other shape is an empty 404 and reported', async () => {
  const events: ServerEvent[] = [];
  const asked: string[] = [];
  const server = await createPopupServer({ onEvent: (e) => events.push(e), imageProvider: (k) => { asked.push(k); return k === KEY ? PNG : null; } });
  try {
    const ok = await get(server.port, `/img/${KEY}.png`);
    assert.equal(ok.status, 200); assert.equal(ok.headers['content-type'], 'image/png'); assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['cross-origin-resource-policy'], 'same-origin');
    assert.deepEqual(Array.from(ok.body), Array.from(PNG));
    for (const p of [`/img/${'b'.repeat(32)}.png`, `/img/${KEY}.png?x=1`, `/img/${KEY}.PNG`, `/img/${KEY}`, `/img/../${KEY}.png`, `/img/${'A'.repeat(32)}.png`, `/img/${KEY}.png/`, '/img/', `/IMG/${KEY}.png`]) {
      const r = await get(server.port, p);
      assert.equal(r.status, 404, p); assert.equal(r.body.length, 0, p);
    }
    assert.deepEqual(asked, [KEY, 'b'.repeat(32)], 'only well-formed keys reach the provider');
    assert.ok(events.filter((e) => e.ev === 'probe.rejected').length >= 7);
    // a request from the wrong Host never reaches the provider either
    const bad = await get(server.port, `/img/${KEY}.png`, { host: 'localhost' });
    assert.equal(bad.status, 404);
    assert.equal(asked.length, 2);
  } finally { await server.close(); }
});

test('image route: without a provider the route does not exist and the page CSP keeps img-src none; with one it opens exactly the /img/ prefix', async () => {
  const plain = await createPopupServer({});
  try {
    assert.equal((await get(plain.port, `/img/${KEY}.png`)).status, 404);
    const url = plain.issueTicket('chart', 'p1');
    const page = await get(plain.port, new URL(url).pathname + new URL(url).search);
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /img-src 'none'/);
  } finally { await plain.close(); }
  const withImages = await createPopupServer({ imageProvider: () => PNG });
  try {
    const url = withImages.issueTicket('chart', 'p2');
    const page = await get(withImages.port, new URL(url).pathname + new URL(url).search);
    const csp = String(page.headers['content-security-policy']);
    assert.match(csp, new RegExp(`img-src http://127\\.0\\.0\\.1:${withImages.port}/img/;`));
    assert.ok(!/img-src 'none'/.test(csp));
    assert.ok(!/img-src[^;]*(https:|\*|'self')/.test(csp), 'no wildcard, no https, no self');
    assert.equal(IMAGE_ROUTE_PREFIX, '/img/');
    assert.ok(IMAGE_ROUTE_RE.test(`/img/${KEY}.png`)); assert.ok(!IMAGE_ROUTE_RE.test(`/img/${KEY}.png?x`));
    // the page's slot is an empty element the script fills with a same-origin <img>; no third-party URL anywhere
    assert.ok(page.body.toString('utf8').includes('id="coin-img-slot"'));
    assert.ok(!/https?:\/\/(cdn\.dexscreener|ipfs)/.test(page.body.toString('utf8')));
  } finally { await withImages.close(); }
});
