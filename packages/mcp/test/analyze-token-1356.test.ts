// task-1356: the analyze_token MCP tool composes buildDossier (the get_dossier assembly) with the
// token-dossier analysis pack. Offline: build a dossier object, run the pack's assemble, assert the
// deterministic verdict/flags. (The full McpTools.call path is exercised by the data-layer replay tests;
// this pins the composition the tool handler does.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDossier } from '../src/index.ts';
import { assembleTokenDossier, buildDigest, tokenRugScorer, h1Model } from '@dexterm/packs';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const now = Date.now();

test('analyze_token composition: a clean dossier assembles to WATCH with no disqualifier flags', () => {
  const dossier = buildDossier({
    mint: MINT, interval: '1h', now,
    token: { token: { symbol: 'BONK', name: 'Bonk', mint: MINT, launchpad: 'raydium', createdAt: now - 86_400_000 }, pair: { priceUsd: 0.00003, liquidityUsd: 400000, mcap: 2_000_000, volume: { h1: 50000 }, txns: { h1: { buys: 100, sells: 80 } }, priceChange: { h1: 5 }, fetchedAt: now, ageSec: 2, source: 'dexscreener' }, stats: { holderCount: 1000, organicScore: 70, perWindow: { h1: {} } }, audit: { mintAuthority: false, freezeAuthority: false, top10Pct: 30, lpLockedPct: 100 }, now },
    holders: { mint: MINT, top10PctExLp: 28, holderCount: 1000, ageSec: 3, source: 'helius' },
    rugcheck: { mint: MINT, scoreNormalised: 20, lpLockedPct: 100, risks: [], ageSec: 60, source: 'rugcheck' },
    trades: { mint: MINT, count: 80, top2WalletVolumeSharePct: 10, buyUsd: 1, sellUsd: 1, distinctWallets: 40, ageSec: 5, source: 'geckoterminal' },
    candles: { mint: MINT, bars: 120, summary: { changePct: 5, drawdownFromHighPct: -5 }, ageSec: 5, source: 'geckoterminal' },
    devHistory: { mint: MINT, tier: 'needs-key', devHistory: null, snipers: null, bundledPct: null },
  });
  const a = assembleTokenDossier(dossier, { now });
  assert.equal(a.status, 'OK');
  assert.equal(a.deterministic_verdict, 'WATCH');
  assert.deepEqual(a.flags, []);
  assert.equal(a.rug_probability, null, 'no scorer passed at Tier 1');
  assert.equal(a.data_ages.market?.source, 'dexscreener');
});

test('analyze_token composition: a freeze-authority dossier assembles to AVOID', () => {
  const dossier = buildDossier({
    mint: MINT, interval: '1h', now,
    token: { token: { symbol: 'RUG', name: 'Rug', mint: MINT, launchpad: 'pump.fun', createdAt: now - 7200_000 }, pair: { priceUsd: 0.00001, liquidityUsd: 7000, mcap: 90000, volume: { h1: 1000 }, txns: { h1: { buys: 5, sells: 9 } }, priceChange: { h1: -20 }, fetchedAt: now, ageSec: 2, source: 'dexscreener' }, stats: { holderCount: 100, organicScore: 5, perWindow: { h1: {} } }, audit: { mintAuthority: false, freezeAuthority: true, top10Pct: 60, lpLockedPct: 100 }, now },
    holders: { error: 'rpc down' }, rugcheck: { mint: MINT, scoreNormalised: 80, risks: [], ageSec: 60, source: 'rugcheck' },
    trades: { error: 'no pool' }, candles: { error: 'no pool' },
    devHistory: { mint: MINT, tier: 'needs-key', devHistory: null },
  });
  const a = assembleTokenDossier(dossier, { now });
  assert.equal(a.deterministic_verdict, 'AVOID');
  assert.ok(a.flags.includes('freeze_authority_enabled'));
});

test('Tier 4/3: with the default H1 scorer the handler fills a labelled p(rug) and a digest', () => {
  // Mirrors the analyze_token handler: assemble WITH the default rug scorer, then build the digest.
  const dossier = buildDossier({
    mint: MINT, interval: '1h', now,
    token: { token: { symbol: 'RUG', name: 'Rug', mint: MINT, launchpad: 'pump.fun', createdAt: now - 7200_000 }, pair: { priceUsd: 0.00001, liquidityUsd: 7000, mcap: 90000, volume: { h1: 1000 }, txns: { h1: { buys: 5, sells: 9 } }, priceChange: { h1: -20 }, fetchedAt: now, ageSec: 2, source: 'dexscreener' }, stats: { holderCount: 100, organicScore: 5, perWindow: { h1: {} } }, audit: { mintAuthority: false, freezeAuthority: true, top10Pct: 60, lpLockedPct: 100 }, now },
    holders: { error: 'rpc down' }, rugcheck: { mint: MINT, scoreNormalised: 80, risks: [], ageSec: 60, source: 'rugcheck' },
    trades: { error: 'no pool' }, candles: { error: 'no pool' },
    devHistory: { mint: MINT, tier: 'needs-key', devHistory: null },
  });
  const a = assembleTokenDossier(dossier, { now, rugScorer: tokenRugScorer(h1Model()) });
  assert.ok(a.rug_probability !== null && a.rug_probability > 0.5, `freeze-authority token should score high, got ${a.rug_probability}`);
  assert.equal(a.rug_model, 'H1-v0.1', 'the probability is labelled with the pre-registered heuristic id, not a learned model');
  const digest = buildDigest(a);
  assert.equal(digest.model_output, false);
  assert.ok(digest.text.startsWith('AVOID'), digest.text);
  assert.ok(/p\(rug\) \d+%/.test(digest.text), digest.text);
});
