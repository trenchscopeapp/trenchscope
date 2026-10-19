// Shared fixture for the task-1340 bubble-map tests (tui, cli, popup): the mock's "fresh pump.fun launch with every
// rule present" (research/wallet-intel/mock/fixture.mjs) in the analysis shape the renderer consumes.
import type { AnalysisLike } from '../src/index.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function addr(seed: number): string { let s = ''; let x = (seed * 2654435761) >>> 0; for (let i = 0; i < 44; i++) { x = (x * 1103515245 + 12345) >>> 0; s += B58[(x >>> 8) % 58]; } return s; }

/** The mock's fixture (research/wallet-intel/mock/fixture.mjs): a fresh pump.fun launch with every rule present. */
export function fixture(): AnalysisLike {
  const DEV = addr(1), FUNDER_B = addr(2), POOL = addr(3), CEX = addr(4), SNIPER = addr(5), FUNDER_F = addr(6);
  const holders: AnalysisLike['holders'] = [];
  const push = (owner: string, pct: number, labels: AnalysisLike['holders'][number]['labels'] = [], extra: Partial<AnalysisLike['holders'][number]> = {}) => holders.push({ owner, pct, labels, funder: null, walletFirstSeen: null, ...extra });
  const L = (label: string, rule: string, confidence = 'on-chain') => ({ label, rule, confidence });
  push(POOL, 21.8, [L('pool', 'selling counterparty in 287 of 300 launch-window txs (P1 pool)')]);
  push(DEV, 4.1, [L('dev', 'fee payer of the first transaction referencing the mint (D1 creator)')]);
  for (const [i, p] of [[7, 2.2], [8, 1.9], [9, 1.4]] as Array<[number, number]>) push(addr(i), p, [L('fresh-at-buy', 'created to hold it (F1)')], { funder: { address: DEV, label: null, blockTime: 1 } });
  for (const [i, p] of [[10, 2.6], [11, 2.4], [12, 2.1], [13, 1.8], [14, 1.6], [15, 1.5]] as Array<[number, number]>) push(addr(i), p, [L('sniper', 'first 3 slots (S1)'), L('fresh-at-buy', 'F1')], { funder: { address: FUNDER_B, label: null, blockTime: 1 } });
  push(SNIPER, 3.2, [L('sniper', 'S1')]);
  push(CEX, 2.8, [L('cex', 'exchange hot wallet: Binance (seed list, unverified by a second source)', 'seed')]);
  for (const [i, p] of [[16, 1.1], [17, 1.0]] as Array<[number, number]>) push(addr(i), p, [], { funder: { address: FUNDER_F, label: null, blockTime: 1 } });
  push(addr(18), 1.2); push(addr(19), 0.8);
  [1.9, 1.7, 1.5, 1.3, 1.2, 1.1, 0.9, 0.9, 0.8, 0.7, 0.7, 0.6, 0.5, 0.5].forEach((p, k) => push(addr(20 + k), p, k === 2 ? [L('multi-token-top20', 'X1', 'derived')] : []));
  const clusters: AnalysisLike['clusters'] = [
    { name: 'C1', kind: 'bundle', members: [10, 11, 12, 13, 14, 15].map(addr), pct: 12.0, labels: ['sniper'], evidence: [{ a: addr(10), b: addr(11), rule: 'same-slot buy AND shared funder (R2 bundle)', linked: true }] },
    { name: 'C2', kind: 'dev-linked', members: [DEV, addr(7), addr(8), addr(9)], pct: 9.6, labels: ['dev'], evidence: [{ a: DEV, b: addr(7), rule: 'funded by the creator wallet (R4 dev-linked)', linked: true }] },
    { name: 'C3', kind: 'funder', members: [addr(16), addr(17)], pct: 2.1, labels: [], evidence: [] },
    { name: 'C4', kind: 'transfer', members: [addr(18), addr(19)], pct: 2.0, labels: [], evidence: [] },
  ];
  const inCluster = new Set(clusters.flatMap((c) => c.members));
  let n = clusters.length;
  for (const h of holders) if (!inCluster.has(h.owner)) clusters.push({ name: `C${++n}`, kind: 'single', members: [h.owner], pct: h.pct, labels: h.labels.map((l) => l.label), evidence: [] });
  return { holders, clusters, insights: { coverage: { topHoldersFetched: 32, supplyCoveredPct: 68.4, fundingLookups: 18, launchTxs: 300 } } };
}

