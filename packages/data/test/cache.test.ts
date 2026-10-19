import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Cache, TTL, defaultDbPath } from '../src/cache.ts';
import { FakeClock, flushMicrotasks } from '../src/clock.ts';
import './helpers.ts';

test('trim bounds a public cache by newest entries and prune removes expired entries', () => {
  const c = new Cache({ clock: new FakeClock(1000) });
  try {
    for (let i = 0; i < 20; i++) c.set('public', String(i), i, { ttlMs: 10, fetchedAt: i });
    assert.equal(c.trim(5), 15); assert.equal(c.count(), 5);
    assert.equal(c.get('public', '0'), undefined); assert.equal(c.get('public', '19')?.value, 19);
    assert.equal(c.prune(0), 5); assert.equal(c.count(), 0);
    assert.throws(() => c.trim(-1));
  } finally { c.close(); }
});

test('get/set with TTL: fresh, then stale, with age and source', async () => {
  const clock = new FakeClock(1_000);
  const c = new Cache({ clock });
  c.set('pair', 'MINT', { p: 1 }, { ttlMs: TTL.pairs, source: 'dexscreener' });
  let e = c.get<{ p: number }>('pair', 'MINT')!;
  assert.deepEqual(e.value, { p: 1 });
  assert.equal(e.stale, false);
  assert.equal(e.source, 'dexscreener');
  await clock.advance(TTL.pairs);
  e = c.get('pair', 'MINT')!;
  assert.equal(e.stale, true);
  assert.equal(e.ageMs, TTL.pairs);
  assert.equal(c.get('pair', 'OTHER'), undefined);
  c.close();
});

test('fetch(): coalesces concurrent loads of the same key', async () => {
  const c = new Cache({ clock: new FakeClock(0) });
  let calls = 0;
  let release!: (v: number) => void;
  const loader = () => {
    calls++;
    return new Promise<number>((r) => (release = r));
  };
  const a = c.fetch('ns', 'k', loader, { ttlMs: 1_000 });
  const b = c.fetch('ns', 'k', loader, { ttlMs: 1_000 });
  await flushMicrotasks();
  release(42);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(ra.value, 42);
  assert.equal(rb.value, 42);
  assert.equal(ra.fromCache, false);
  const rc = await c.fetch('ns', 'k', loader, { ttlMs: 1_000 });
  assert.equal(rc.fromCache, true);
  assert.equal(calls, 1);
  c.close();
});

test('fetch(): stale-while-revalidate serves stale immediately and refreshes in the background', async () => {
  const clock = new FakeClock(0);
  const c = new Cache({ clock });
  c.set('ns', 'k', 'old', { ttlMs: 1_000, source: 'jupiter-tokens' });
  await clock.advance(5_000);
  const r = await c.fetch('ns', 'k', async () => 'new', { ttlMs: 1_000, source: 'jupiter-tokens' });
  assert.equal(r.value, 'old');
  assert.equal(r.stale, true);
  await r.refreshing;
  const e = c.get<string>('ns', 'k')!;
  assert.equal(e.value, 'new');
  assert.equal(e.stale, false);
  c.close();
});

test('fetch(): loader failure serves stale with the error; with nothing cached it throws', async () => {
  const clock = new FakeClock(0);
  const c = new Cache({ clock });
  c.set('ns', 'k', 'old', { ttlMs: 1_000 });
  await clock.advance(2_000);
  const boom = async () => {
    throw new Error('boom');
  };
  const r = await c.fetch('ns', 'k', boom, { ttlMs: 1_000, swr: false });
  assert.equal(r.value, 'old');
  assert.equal(r.stale, true);
  assert.equal(r.error?.message, 'boom');
  await assert.rejects(c.fetch('ns', 'missing', boom, { ttlMs: 1_000 }), /boom/);
  c.close();
});

test('persists across reopen on disk and prunes long-expired entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-cache-'));
  try {
    const path = join(dir, 'nested', 'dexterm.db');
    const clock = new FakeClock(0);
    const c1 = new Cache({ path, clock });
    c1.set('audit', 'A', { ok: true }, { ttlMs: TTL.audit });
    c1.set('pair', 'B', { ok: true }, { ttlMs: TTL.pairs });
    c1.close();
    const c2 = new Cache({ path, clock });
    assert.deepEqual(c2.get('audit', 'A')?.value, { ok: true });
    assert.equal(c2.count(), 2);
    await clock.advance(TTL.pairs + 1_000);
    assert.equal(c2.prune(0), 1, 'only the expired pair entry goes');
    assert.equal(c2.count('pair'), 0);
    assert.equal(c2.count('audit'), 1);
    c2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultDbPath follows XDG_DATA_HOME', () => {
  if (process.platform === 'win32') return;
  assert.equal(defaultDbPath({ XDG_DATA_HOME: '/x/data' }), '/x/data/dexterm/dexterm.db');
  assert.match(defaultDbPath({}), /\.local\/share\/dexterm\/dexterm\.db$/);
});
