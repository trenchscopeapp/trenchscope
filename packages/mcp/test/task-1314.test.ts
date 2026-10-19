// task-1314: the pre-assembled dossier and its availability block. These golden tests pin the rule that
// killed the spurious INSUFFICIENT_DATA answers: a verdict is warranted whenever price OR liquidity
// exists; missing holders / candles / tape and the always-null keyless creator-history Tier-1 fields go
// into `missing_data`, they never force a refusal. INSUFFICIENT_DATA is correct only with no market at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDossier, McpTools } from '../src/index.ts';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** A get_token-shaped section with the given market numbers. */
function market(priceUsd: number | null, liquidityUsd: number | null, withAudit = true) {
  return {
    token: { symbol: 'BONK', name: 'Bonk', mint: MINT },
    pair: { priceUsd, liquidityUsd, fetchedAt: Date.now(), ageSec: 2 },
    stats: { holderCount: 1000 },
    audit: withAudit ? { mintAuthority: false, freezeAuthority: false, top10Pct: 36 } : undefined,
    now: Date.now(),
  };
}
const holdersOk = { mint: MINT, holders: [], top10PctExLp: 38.4, holderCount: 1024386, supply: '1', decimals: 5, fetchedAt: Date.now() };
const rugOk = { mint: MINT, score: 1200, scoreNormalised: 20, lpLockedPct: 100, tokenProgram: 'spl-token', risks: [], fetchedAt: Date.now() };
const candlesOk = { mint: MINT, interval: '1h', bars: 120, summary: { last: 1, high: 2, low: 1 }, candles: [], fetchedAt: Date.now() };
const tapeOk = { mint: MINT, window: 'h1', count: 80, buys: 50, sells: 30, top2WalletVolumeSharePct: 12, distinctWallets: 40, fetchedAt: Date.now() };
const devKeyless = { mint: MINT, creator: null, creators: [], devHistory: null, snipers: null, bundledPct: null, tier: 'needs-key', note: 'prior-launch forensics need a Helius/Birdeye key' };

test('buildDossier: full data -> canVerdict, nothing missing, Tier-1 listed as knownUnavailable', () => {
  const d = buildDossier({ mint: MINT, interval: '1h', token: market(0.0000377, 423751), holders: holdersOk, rugcheck: rugOk, trades: tapeOk, candles: candlesOk, devHistory: devKeyless });
  const a = d.availability as Record<string, unknown>;
  assert.equal(a.canVerdict, true);
  assert.equal(a.hasPrice, true);
  assert.equal(a.hasLiquidity, true);
  assert.deepEqual(a.missing, []);
  assert.deepEqual(a.present, ['market', 'holders/concentration', 'security', 'candles', 'tape']);
  assert.ok((a.knownUnavailable as string[]).some((s) => /dev-history/.test(s)), 'Tier-1 forensics named as a known gap');
  assert.match(a.note as string, /Do NOT answer INSUFFICIENT_DATA/);
});

test('buildDossier: holders + candles fail and creator is null -> still canVerdict, listed in missing', () => {
  const d = buildDossier({
    mint: MINT, interval: '1h',
    token: market(0.0000377, 423751),
    holders: { error: 'holders need an RPC that answers getTokenLargestAccounts' },
    rugcheck: rugOk,
    trades: tapeOk,
    candles: { error: 'no pool found for this mint on GeckoTerminal' },
    devHistory: devKeyless,
  });
  const a = d.availability as Record<string, unknown>;
  assert.equal(a.canVerdict, true, 'price + liquidity exist, so a verdict is required');
  const missing = a.missing as string[];
  assert.ok(missing.some((m) => m.startsWith('holders/concentration')));
  assert.ok(missing.some((m) => m.startsWith('candles')));
  assert.ok(!missing.some((m) => m.startsWith('market')));
  assert.ok((a.present as string[]).includes('security'));
});

test('buildDossier: no price and no liquidity -> canVerdict false (the only INSUFFICIENT_DATA case)', () => {
  const d = buildDossier({
    mint: MINT, interval: '1h',
    token: { error: 'no source could describe this mint' },
    holders: { error: 'x' }, rugcheck: { error: 'x' }, trades: { error: 'x' }, candles: { error: 'x' }, devHistory: devKeyless,
  });
  const a = d.availability as Record<string, unknown>;
  assert.equal(a.canVerdict, false);
  assert.equal(a.hasPrice, false);
  assert.equal(a.hasLiquidity, false);
  assert.match(a.note as string, /only case where INSUFFICIENT_DATA is correct/);
});

test('buildDossier: price present but liquidity null still warrants a verdict', () => {
  const d = buildDossier({ mint: MINT, interval: '1h', token: market(0.0000377, null), holders: holdersOk, rugcheck: rugOk, trades: tapeOk, candles: candlesOk, devHistory: devKeyless });
  const a = d.availability as Record<string, unknown>;
  assert.equal(a.hasPrice, true);
  assert.equal(a.hasLiquidity, false);
  assert.equal(a.canVerdict, true);
});

test('buildDossier: liquidity present but price zero still warrants a verdict (fresh pool, no first trade)', () => {
  const d = buildDossier({ mint: MINT, interval: '1h', token: market(0, 15000), holders: holdersOk, rugcheck: rugOk, trades: tapeOk, candles: candlesOk, devHistory: devKeyless });
  const a = d.availability as Record<string, unknown>;
  assert.equal(a.hasPrice, false);
  assert.equal(a.hasLiquidity, true);
  assert.equal(a.canVerdict, true);
});

// ---- get_dossier tool: one parallel pass over the data layer, firewalled, memoised.

/** A compact DataLayer stub covering only the methods get_dossier touches. `fail` names sections to error. */
function fakeData(fail: Set<string> = new Set()) {
  const ok = <T>(value: T) => ({ value, fetchedAt: Date.now(), stale: false });
  const pool = { address: 'POOL1111111111111111111111111111111111111111', source: 'geckoterminal', fetchedAt: Date.now() };
  return {
    store: {
      enrich: async () => ({
        rows: [{
          mint: MINT,
          token: { symbol: 'BONK', name: 'Bonk', mint: MINT, launchpad: 'unknown', socials: { x: false, tg: false, web: false }, verified: true, sus: false, createdAt: Date.now() - 86400000 },
          pair: { priceUsd: 0.0000377, liquidityUsd: 423751, fetchedAt: Date.now(), priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, volume: { m5: 0, h1: 0, h6: 0, h24: 0 }, mcap: 3300000, fdv: 3300000, pairAddress: pool.address },
          stats: { holderCount: 1000, fetchedAt: Date.now() },
          audit: { mintAuthority: false, freezeAuthority: false, top10Pct: 36, lpLockedPct: 100, rugScore: 1, fetchedAt: Date.now() },
          mcap: { value: 3300000, flagged: false }, sources: ['dexscreener', 'jupiter-tokens'], stale: false, sparkline: null, price: { usdPrice: 0.0000377 },
        }],
        errors: {},
      }),
    },
    detail: {
      holders: async () => { if (fail.has('holders')) throw new Error('rpc 429'); return ok({ holders: [], top10Pct: 38.4, supply: '1', decimals: 5, source: 'jupiter-tokens', aggregateOnly: true, holderCount: 1024386 }); },
      rugcheck: async () => { if (fail.has('rugcheck')) throw new Error('rugcheck down'); return ok({ score: 1200, scoreNormalised: 20, lpLockedPct: 100, tokenProgram: 'spl-token', tokenType: 'spl', risks: [] }); },
      topPool: async () => (fail.has('pool') ? null : pool),
      trades: async () => ok([{ t: Date.now(), side: 'buy', usd: 100, price: 1, wallet: 'w1' }]),
      candles: async () => { if (fail.has('candles')) throw new Error('no candles'); return { candles: [{ t: Date.now(), o: 1, h: 2, l: 1, c: 1, v: 10 }], fetchedAt: Date.now(), stale: false }; },
      security: async () => ok({ creators: ['Creator11111111111111111111111111111111111'], mintable: false, freezable: false, holderCount: 1000 }),
      mintInfo: async () => ok({ mintAuthority: null, freezeAuthority: null, program: 'spl-token', riskyExtensions: [] }),
    },
    jupiter: { search: async () => [] },
  } as never;
}

test('get_dossier: one call assembles every present section with sources and firewalled strings', async () => {
  const tools = new McpTools(fakeData(), () => ({ screen: 'token' }));
  const d = await tools.call('get_dossier', { mint: MINT });
  assert.equal(d.mint, MINT);
  const a = d.availability as Record<string, unknown>;
  assert.equal(a.canVerdict, true);
  assert.deepEqual(a.present, ['market', 'holders/concentration', 'security', 'candles', 'tape']);
  // the market symbol came back through the firewall
  const sym = ((d.market as Record<string, Record<string, unknown>>).token.symbol) as string;
  assert.match(sym, /^<untrusted /);
});

test('get_dossier: a failing section is listed in missing, the rest still assemble (no all-or-nothing)', async () => {
  const tools = new McpTools(fakeData(new Set(['holders', 'candles'])), () => ({ screen: 'token' }));
  const d = await tools.call('get_dossier', { mint: MINT });
  const a = d.availability as Record<string, unknown>;
  assert.equal(a.canVerdict, true);
  const missing = a.missing as string[];
  assert.ok(missing.some((m) => m.startsWith('holders/concentration')), 'holders failure surfaced');
  assert.ok(missing.some((m) => m.startsWith('candles')), 'candles failure surfaced');
  assert.ok((a.present as string[]).includes('market'));
});

test('get_dossier: memoised within the window (same object on the second call)', async () => {
  const tools = new McpTools(fakeData(), () => ({ screen: 'token' }));
  const a = await tools.call('get_dossier', { mint: MINT, interval: '1h' });
  const b = await tools.call('get_dossier', { mint: MINT, interval: '1h' });
  assert.equal(a, b, 'the second call returns the memoised dossier');
});
