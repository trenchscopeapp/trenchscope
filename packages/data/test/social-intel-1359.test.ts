// task-1359: the wallet-intel scan feeds the SOCIAL panel's on-chain rows (the task-1330 handoff gap: "same-slot
// cluster rows never fire today"). Linked clusters + launch-window snipers become rule-written `platform:'chain'`
// posts whose text says which rule linked the wallets; one id per scan, so a cached re-read never duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.ts';
import { SocialFeed, chainSignalsFromIntel, chainSignalToRaw, chainSignalText } from '../src/index.ts';

const MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const W = (i: number) => `Wa11et${String(i).padStart(2, '0')}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.slice(0, 44);
const NOW = 1_790_000_000_000;

const clusters = [
  { name: 'C2', kind: 'funder', members: [W(5), W(6)], pct: 3.1 },
  { name: 'C1', kind: 'bundle', members: [W(1), W(2), W(3), W(4)], pct: 12.04 },
  { name: 'C3', kind: 'dev-linked', members: [W(7), W(8), W(9)], pct: 6.5 },
  { name: 'C4', kind: 'transfer', members: [W(10), W(11)], pct: 1.2 },
  { name: 'C5', kind: 'single', members: [W(12)], pct: 9 },
  { name: 'C6', kind: 'funder', members: [W(13)], pct: 0.4 },
];

test('chainSignalsFromIntel: snipers first, then linked clusters by share; single / one-member clusters skipped; the text names the rule', () => {
  const sigs = chainSignalsFromIntel({ mint: MINT, clusters, snipers: { count: 7, launchWindowSharePct: 18.94 }, t: NOW });
  assert.deepEqual(sigs.map((s) => [s.kind, s.label, s.count]), [['snipers', null, 7], ['cluster', 'bundle', 4], ['cluster', 'dev-linked', 3], ['cluster', 'funder', 2], ['cluster', 'transfer', 2]]);
  assert.equal(chainSignalText(sigs[0]), '7 sniper wallets took 18.9% of the launch window (first 3 slots)');
  assert.equal(chainSignalText(sigs[1]), '12.0% of supply sits in 4 wallets that bought in the same slot and share a funder (bundle, R2)');
  assert.match(chainSignalText(sigs[2]), /6\.5% of supply sits in 3 wallets that were funded by the creator wallet \(dev-linked, R4\)/);
  assert.match(chainSignalText(sigs[3]), /share one funding wallet \(R1\)/);
  assert.match(chainSignalText(sigs[4]), /direct token transfers at launch \(R3\)/);
  // no launch window read (keyless) → no sniper row, never a zero
  assert.ok(!chainSignalsFromIntel({ mint: MINT, clusters, snipers: null, t: NOW }).some((s) => s.kind === 'snipers'));
  assert.ok(!chainSignalsFromIntel({ mint: MINT, clusters: [], snipers: { count: 0, launchWindowSharePct: 0 }, t: NOW }).length, 'zero snipers is not a row');
  assert.equal(chainSignalsFromIntel({ mint: MINT, clusters, snipers: { count: 1, launchWindowSharePct: 2 }, t: NOW, max: 2 }).length, 2);
  assert.equal(chainSignalText(chainSignalsFromIntel({ mint: MINT, clusters: [], snipers: { count: 1, launchWindowSharePct: 2 }, t: NOW })[0]), '1 sniper wallet took 2.0% of the launch window (first 3 slots)');
});

test('intel rows land in the SOCIAL feed as chain posts; re-ingesting the same scan is idempotent', () => {
  const clock = new FakeClock(NOW);
  const feed = new SocialFeed({ clock, board: () => [{ mint: MINT, symbol: 'WIF', name: 'dogwifhat' }] });
  const sigs = chainSignalsFromIntel({ mint: MINT, clusters, snipers: { count: 7, launchWindowSharePct: 18.9 }, t: NOW - 5_000 });
  feed.ingest(sigs.map((s) => chainSignalToRaw(s, NOW)));
  feed.ingest(sigs.map((s) => chainSignalToRaw(s, NOW)));
  const posts = feed.postsFor(MINT);
  assert.equal(posts.length, 5);
  assert.ok(posts.every((p) => p.platform === 'chain' && p.flags.length === 0));
  assert.ok(posts.some((p) => /same slot and share a funder \(bundle, R2\)/.test(p.text)));
  assert.ok(posts.some((p) => p.author.handle === 'snipers' && /7 sniper wallets/.test(p.text)));
});
