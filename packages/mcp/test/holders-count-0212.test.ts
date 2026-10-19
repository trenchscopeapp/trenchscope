// 2026-10-12: get_holders used to report the LENGTH of the fetched list (<=20, or 0 for the keyless aggregate)
// as `holderCount`, and the analyst quoted it as the token's holder count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpTools } from '../src/server.ts';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ok = <T>(value: T) => ({ value, fetchedAt: Date.now(), stale: false });
const ranked = Array.from({ length: 20 }, (_, i) => ({ address: `A${i}`, owner: `O${i}`, pct: 1, amount: '1', label: null }));
const data = (aggregate: boolean) => ({
  detail: { holders: async () => ok(aggregate
    ? { holders: [], top10Pct: 38, supply: '1', decimals: 5, source: 'jupiter-tokens', aggregateOnly: true, holderCount: 1795 }
    : { holders: ranked, top10Pct: 38, supply: '1', decimals: 5, source: 'helius' }) },
  jupiter: { search: async () => [{ token: { mint: MINT }, stats: { holderCount: 1795 } }] },
}) as never;

test('get_holders: a ranked top-20 list does NOT make the holder count 20; the total comes from Jupiter', async () => {
  const r = await new McpTools(data(false), () => ({ screen: 'token' })).call('get_holders', { mint: MINT });
  assert.equal(r.holderCount, 1795);
  assert.equal(r.listedHolders, 20);
});

test('get_holders: the keyless aggregate (empty list) reports the real count, not 0', async () => {
  const r = await new McpTools(data(true), () => ({ screen: 'token' })).call('get_holders', { mint: MINT });
  assert.equal(r.holderCount, 1795);
  assert.equal(r.listedHolders, 0);
});
