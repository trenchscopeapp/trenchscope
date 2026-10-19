// Tier 1 — wallet-dossier ASSEMBLE over a token's IntelAnalysis (offline). SMART can never fire keyless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IntelAnalysis, IntelHolder, IntelCluster } from '@dexterm/data';
import { assembleWalletDossier } from '../src/wallet-dossier.ts';

const SNIPER = 'Sn1per1111111111111111111111111111111111111';
const CLEAN = 'CleanWa11et1111111111111111111111111111111';
const LP = 'LpWa11et11111111111111111111111111111111111';

function analysis(): IntelAnalysis {
  const holder = (owner: string, pct: number, labels: IntelHolder['labels'], fresh: boolean | null = null): IntelHolder => ({
    owner, tokenAccounts: [owner + 'TA'], amount: '1000', pct, ownerKind: 'wallet', programOwner: null,
    labels, funder: { address: 'Funder111', label: null, blockTime: 1, sig: 's' }, walletFirstSeen: 1, freshAtBuy: fresh, createdBeforeLaunch: false,
  });
  const clusters: IntelCluster[] = [
    { name: 'C1', kind: 'bundle', members: [SNIPER, 'Other1'], pct: 22, labels: [], evidence: [] },
  ];
  return {
    mint: 'Mint111111111111111111111111111111111111111',
    holders: [
      holder(SNIPER, 8.2, [{ label: 'sniper', rule: 'S1 bought in first 3 slots', confidence: 'on-chain' }], true),
      holder(CLEAN, 1.1, []),
      { ...holder(LP, 40, [{ label: 'LP', rule: 'Raydium authority', confidence: 'program-authority' }]), ownerKind: 'program-owned', programOwner: 'Raydium' },
    ],
    clusters,
    funding: {}, buyEvents: [],
    insights: {} as IntelAnalysis['insights'],
  };
}

test('a sniper in a bundle cluster is SUSPECT, with its labels restated by rule', () => {
  const d = assembleWalletDossier(SNIPER, analysis());
  assert.equal(d.status, 'OK');
  assert.equal(d.deterministic_verdict, 'SUSPECT');
  assert.ok(d.flags.includes('sniper_window_buy'));
  assert.ok(d.flags.includes('in_bundle_cluster'));
  assert.equal(d.features.cluster_kind, 'bundle');
  assert.equal(d.labels_restated[0]?.label, 'sniper');
  assert.equal(d.labels_restated[0]?.rule, 'S1 bought in first 3 slots');
});

test('the smart-money gate is honestly marked unavailable keyless (SMART never fires)', () => {
  const d = assembleWalletDossier(CLEAN, analysis());
  assert.equal(d.deterministic_verdict, 'NEUTRAL');
  assert.notEqual(d.deterministic_verdict as string, 'SMART');
  assert.ok(d.availability.knownUnavailable.some((s) => /smart-money gate/.test(s)));
  assert.ok(d.availability.knownUnavailable.some((s) => /PnL/.test(s)));
});

test('an LP / program-owned address is INSUFFICIENT_DATA as a trader', () => {
  const d = assembleWalletDossier(LP, analysis());
  assert.equal(d.deterministic_verdict, 'INSUFFICIENT_DATA');
});

test('a wallet not in the scanned token is NOT_IN_SCAN', () => {
  const d = assembleWalletDossier('Nob0dy11111111111111111111111111111111111', analysis());
  assert.equal(d.status, 'NOT_IN_SCAN');
  assert.equal(d.deterministic_verdict, 'INSUFFICIENT_DATA');
});
