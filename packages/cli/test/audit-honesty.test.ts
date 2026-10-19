// The safety column only claims what the audit actually returned: "clean" is earned, collapsed coins are
// flagged DEAD, and a coin still on the pump.fun bonding curve gets no invented "LP locked 100 %".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditState, deriveFlags, isDead, fromSnapshot } from '../src/screener/rows.ts';
import { parseFilter, applyFilter } from '../src/screener/filter.ts';

const base = { mintAuth: false, freezeAuth: false, top10: 12, dev: 0.5, bundled: null, lpLocked: 100 };

test('auditState: clean only when every check came back; missing checks are partial, none is unaudited', () => {
  assert.equal(auditState({ ...base, flags: [] }), 'clean');
  assert.equal(auditState({ ...base, dev: null, flags: [] }), 'partial', 'unknown dev is not a pass');
  assert.equal(auditState({ ...base, top10: null, flags: [] }), 'partial');
  assert.equal(auditState({ mintAuth: null, freezeAuth: null, flags: [] }), 'unaudited');
  assert.equal(auditState({ ...base, flags: ['MINT'] }), null, 'flagged rows show their flags');
});

test('DEAD: under $1K liquidity, or under $15K cap after a 70 %+ fall; a healthy small coin is not dead', () => {
  assert.equal(isDead({ liq: 800 }), true);
  assert.equal(isDead({ liq: 5_000, mcap: 6_000, h24: -82 }), true);
  assert.equal(isDead({ liq: 5_000, mcap: 6_000, h24: -20 }), false);
  assert.equal(isDead({ liq: 50_000, mcap: 400_000, h24: -85 }), false, 'a big coin down hard is not dead');
  assert.equal(isDead({}), false, 'unknown is never dead');
  assert.deepEqual(deriveFlags({ ...base, liq: 5_000, mcap: 6_000, h24: -82 }), ['DEAD']);
});

function snapshot(dex: string, lpLockedPct: number | null = null) {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const row = {
    mint: 'M1', sources: ['dexscreener'], stale: false, mcap: null, sparkline: undefined, price: null, stats: null,
    audit: lpLockedPct === null ? null : { mintAuthority: false, freezeAuthority: false, top10Pct: 10, devPct: 0, devMints: null, lpLockedPct, rugRisks: [], rugScore: null, mint: 'M1', source: 'rugcheck', fetchedAt: now },
    token: { mint: 'M1', symbol: 'X', name: 'X', launchpad: 'pump.fun', createdAt: now - 3_600_000, verified: false, sus: false, image: null, fetchedAt: now },
    pair: { dex, pairAddress: 'P1', priceUsd: 0.001, liquidityUsd: dex === 'pumpfun' ? null : 40_000, mcap: 90_000, fdv: 90_000, createdAt: now - 3_600_000, fetchedAt: now,
      priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 }, volume: { m5: 1, h1: 1, h6: 1, h24: 1 }, txns: { h24: { buys: 1, sells: 1 } } },
  };
  return fromSnapshot(row as unknown as Parameters<typeof fromSnapshot>[0], now);
}

test('LP: a graduated PumpSwap coin is 100 % burned by design; a bonding-curve coin has no LP figure; RugCheck wins when it answers', () => {
  assert.equal(snapshot('pumpswap').lpLocked, 100);
  assert.equal(snapshot('pumpfun').lpLocked, null, 'no LP exists on the curve: no number, not 100');
  assert.equal(snapshot('pumpfun').dex, 'pumpfun');
  assert.equal(snapshot('pumpfun', 100).lpLocked, null, 'RugCheck says 100 on a curve coin too: the curve rule wins');
  assert.equal(snapshot('raydium', 59.6).lpLocked, 59.6);
  assert.ok(snapshot('raydium', 30).flags.includes('LP'));
});

test('flag:clean only matches fully audited rows; flag:dead matches collapsed ones', () => {
  const clean = parseFilter('flag:clean');
  const dead = parseFilter('flag:dead');
  assert.ok(clean.ok && dead.ok);
  if (!clean.ok || !dead.ok) return;
  const full = { ...base, mint: 'A', flags: [] } as never;
  const partial = { ...base, mint: 'B', dev: null, flags: [] } as never;
  const gone = { ...base, mint: 'C', flags: ['DEAD'] } as never;
  assert.deepEqual(applyFilter([full, partial, gone], clean.filter).map((r) => r.mint), ['A']);
  assert.deepEqual(applyFilter([full, partial, gone], dead.filter).map((r) => r.mint), ['C']);
});
