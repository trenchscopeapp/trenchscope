import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { COLUMN_SOURCES, FEATURE_SOURCES, HealthRegistry, gate, gateAll } from '../src/health.ts';
import type { SourceState } from '../src/health.ts';
import type { SourceId } from '../src/model.ts';
import { mulberry32 } from './helpers.ts';

const fail = { ok: false, status: 503 } as const;
const ok = { ok: true, status: 200, latencyMs: 80 } as const;
const r429 = { ok: false, status: 429 } as const;

test('three consecutive failures demote a source; it probes after 30 s and recovers on success', async () => {
  const clock = new FakeClock(0);
  const h = new HealthRegistry({ clock });
  h.record('dexscreener', fail);
  h.record('dexscreener', fail);
  assert.equal(h.state('dexscreener'), 'ok');
  h.record('dexscreener', fail);
  assert.equal(h.state('dexscreener'), 'degraded');
  assert.equal(h.isAvailable('dexscreener'), false);
  assert.equal(h.get('dexscreener').backoffMs, 30_000);
  await clock.advance(29_999);
  assert.equal(h.state('dexscreener'), 'degraded');
  await clock.advance(1);
  assert.equal(h.state('dexscreener'), 'probing');
  assert.equal(h.isAvailable('dexscreener'), true);
  h.record('dexscreener', ok);
  assert.equal(h.state('dexscreener'), 'ok');
  assert.equal(h.get('dexscreener').latencyMs, 80);
});

test('a success between failures resets the consecutive count', () => {
  const h = new HealthRegistry({ clock: new FakeClock(0) });
  for (let i = 0; i < 10; i++) {
    h.record('jupiter-tokens', fail);
    h.record('jupiter-tokens', fail);
    h.record('jupiter-tokens', ok);
  }
  assert.equal(h.state('jupiter-tokens'), 'ok');
});

test('two 429s inside a minute demote; two 429s more than a minute apart do not', async () => {
  const clock = new FakeClock(0);
  const h = new HealthRegistry({ clock });
  h.record('jupiter-tokens', r429);
  await clock.advance(59_000);
  h.record('jupiter-tokens', r429);
  assert.equal(h.state('jupiter-tokens'), 'degraded');

  const h2 = new HealthRegistry({ clock });
  h2.record('dexscreener', r429);
  h2.record('dexscreener', ok);
  await clock.advance(61_000);
  h2.record('dexscreener', r429);
  assert.equal(h2.state('dexscreener'), 'ok');
});

test('failure while probing re-demotes with a doubled window, capped at 10 min; recovery resets it', async () => {
  const clock = new FakeClock(0);
  const h = new HealthRegistry({ clock });
  for (let i = 0; i < 3; i++) h.record('geckoterminal', fail);
  const windows: number[] = [h.get('geckoterminal').backoffMs];
  for (let i = 0; i < 7; i++) {
    await clock.advance(h.get('geckoterminal').degradedUntil - clock.now());
    assert.equal(h.state('geckoterminal'), 'probing');
    h.record('geckoterminal', fail); // one failed probe is enough
    assert.equal(h.state('geckoterminal'), 'degraded');
    windows.push(h.get('geckoterminal').backoffMs);
  }
  assert.deepEqual(windows, [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  await clock.advance(600_000);
  h.record('geckoterminal', ok);
  assert.equal(h.state('geckoterminal'), 'ok');
  for (let i = 0; i < 3; i++) h.record('geckoterminal', fail);
  assert.equal(h.get('geckoterminal').backoffMs, 30_000, 'backoff resets after a recovery');
});

test('keyed sources are needs-key until a key is configured; flags disable sources', () => {
  const h = new HealthRegistry({ clock: new FakeClock(0), disabled: ['pumpfun'] });
  assert.equal(h.state('helius'), 'needs-key');
  assert.equal(h.state('birdeye'), 'needs-key');
  assert.equal(h.state('pumpfun'), 'disabled');
  h.record('helius', ok); // a stray success does not bypass the key requirement
  assert.equal(h.state('helius'), 'needs-key');
  h.setKey('helius', true);
  assert.equal(h.state('helius'), 'ok');
  h.setDisabled('pumpfun', false);
  assert.equal(h.state('pumpfun'), 'ok');
});

test('onChange fires on transitions only', async () => {
  const clock = new FakeClock(0);
  const h = new HealthRegistry({ clock });
  const seen: string[] = [];
  h.onChange((s, st) => seen.push(`${s}:${st}`));
  h.record('dexscreener', ok);
  for (let i = 0; i < 3; i++) h.record('dexscreener', fail);
  await clock.advance(30_000);
  h.record('dexscreener', ok);
  assert.deepEqual(seen, ['dexscreener:degraded', 'dexscreener:ok']);
});

test('snapshot() emits SPEC §3.3 Health records, with probing reported as degraded but ok', async () => {
  const clock = new FakeClock(0);
  const h = new HealthRegistry({ clock, usage: (s) => (s === 'dexscreener' ? { rpmUsed: 7, rpmLimit: 300 } : undefined) });
  h.record('dexscreener', ok);
  for (let i = 0; i < 3; i++) h.record('jupiter-tokens', { ok: false, status: 500 });
  let snap = Object.fromEntries(h.snapshot(['dexscreener', 'jupiter-tokens', 'helius']).map((x) => [x.source, x]));
  assert.deepEqual(snap.dexscreener, { source: 'dexscreener', ok: true, state: 'ok', latencyMs: 80, rpmUsed: 7, rpmLimit: 300, lastError: null, since: 0 });
  assert.equal(snap['jupiter-tokens'].state, 'degraded');
  assert.equal(snap['jupiter-tokens'].ok, false);
  assert.equal(snap['jupiter-tokens'].lastError, 'HTTP 500');
  assert.equal(snap.helius.state, 'needs-key');
  await clock.advance(30_000);
  snap = Object.fromEntries(h.snapshot(['jupiter-tokens']).map((x) => [x.source, x]));
  assert.equal(snap['jupiter-tokens'].state, 'degraded');
  assert.equal(snap['jupiter-tokens'].ok, true);
});

test('gating: columns with an alternative source survive; single-source columns go degraded; Tier 1 shows needs-key', () => {
  const h = new HealthRegistry({ clock: new FakeClock(0) });
  for (let i = 0; i < 3; i++) h.record('jupiter-tokens', fail);
  const cols = gateAll(h, COLUMN_SOURCES);
  assert.equal(cols.price.available, true);
  assert.deepEqual(cols.price.via, ['dexscreener', 'jupiter-price']);
  assert.equal(cols.holders.available, false);
  assert.equal(cols.holders.state, 'degraded');
  assert.equal(cols.org.state, 'degraded');
  assert.equal(cols.snipers.state, 'needs-key');
  assert.equal(cols.flags.available, true, 'flags fall back to solana-rpc');

  for (let i = 0; i < 3; i++) h.record('dexscreener', fail);
  const feats = gateAll(h, FEATURE_SOURCES);
  assert.equal(feats.screener.available, false);
  assert.equal(feats.screener.state, 'degraded');
  assert.equal(feats.forensics.state, 'needs-key');
  assert.equal(feats['sol-price'].available, true, 'sol price still via jupiter-price');
  assert.equal(gate(h, 'x', { anyOf: ['pumpfun'] }).available, true);
});

test('property: random outcome streams keep the registry consistent', async () => {
  const sources: SourceId[] = ['dexscreener', 'jupiter-tokens', 'geckoterminal'];
  for (let seed = 1; seed <= 25; seed++) {
    const rng = mulberry32(seed);
    const clock = new FakeClock(0);
    const h = new HealthRegistry({ clock });
    for (let step = 0; step < 400; step++) {
      await clock.advance(Math.floor(rng() * 20_000));
      const s = sources[Math.floor(rng() * sources.length)];
      const before: SourceState = h.state(s);
      const roll = rng();
      const outcome = roll < 0.45 ? ok : roll < 0.8 ? fail : r429;
      // Callers only send requests when the source is available (that is the contract).
      if (!h.isAvailable(s)) {
        assert.equal(before, 'degraded');
        assert.ok(clock.now() < h.get(s).degradedUntil);
        continue;
      }
      h.record(s, outcome);
      const after = h.state(s);
      const g = h.get(s);
      if (outcome.ok) assert.equal(after, 'ok', `seed ${seed}: success must leave ${s} ok`);
      if (after === 'degraded') {
        assert.ok(g.backoffMs >= 30_000 && g.backoffMs <= 600_000, `seed ${seed}: backoff ${g.backoffMs}`);
        assert.equal(g.degradedUntil, clock.now() + g.backoffMs);
        if (before === 'probing') assert.ok(!outcome.ok);
      }
      if (before === 'probing' && !outcome.ok) assert.equal(after, 'degraded', `seed ${seed}: failed probe must re-demote`);
    }
  }
});
