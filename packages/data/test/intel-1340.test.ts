// task-1340 wallet intel: the rules engine replays the task-1286 spike recordings and must reproduce the
// spike's analysis (research/wallet-intel/prototype/out/*.analysis.json); a synthetic launch exercises every
// rule (P1 D1 R1 R1b R2 R3 R4 R5 S1 F1 L0) and the label policy; the scan orchestrator degrades honestly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyze, funderOf, tokenDeltasByOwner, visibleLabels, HIDDEN_LABELS, INTEL_KNOWN_OWNERS, knownOwnerRule, slimTx,
  WalletIntel, SCAN_DEPTHS, KEY_FIX, Cache, HealthRegistry, FakeClock,
  type IntelRaw, type RawTx, type OwnerMeta, type TopHolders, type HeliusHistory,
} from '../src/index.ts';
import { SYSTEM_PROGRAM } from '../src/trade/tx-decode.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE = resolve(HERE, '..', '..', '..', '..', 'research', 'wallet-intel', 'prototype');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function addr(seed: number): string { let s = ''; let x = (seed * 2654435761) >>> 0; for (let i = 0; i < 44; i++) { x = (x * 1103515245 + 12345) >>> 0; s += B58[(x >>> 8) % 58]; } return s; }

interface Rec { calls: Record<string, { body: unknown }> }
function loadRec(sym: string): Rec | null {
  const p = resolve(SPIKE, 'recorded', `${sym}.json.gz`);
  if (!existsSync(p)) return null;
  return JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) as Rec;
}

/** Rebuild IntelRaw from a spike recording (the prototype's fetch plan, 14 paced calls). */
function rawFromRec(mint: string, rec: Rec): IntelRaw {
  const body = <T>(k: string): T => (rec.calls[k]?.body as { result?: T })?.result as T;
  const asset = body<{ token_info?: { supply?: string | number; decimals?: number } }>('das.getAsset');
  const largest = body<{ value: Array<{ address: string; amount: string }> }>('rpc.getTokenLargestAccounts').value;
  const taInfos = body<{ value: Array<{ data?: { parsed?: { info?: { owner?: string } } } } | null> }>('rpc.getMultipleAccounts.tokenAccounts').value;
  const owners: Record<string, string> = {};
  largest.forEach((a, i) => { const o = taInfos[i]?.data?.parsed?.info?.owner; if (o) owners[a.address] = o; });
  const ownerList = [...new Set(Object.values(owners))];
  const ownerInfos = body<{ value: Array<{ owner?: string; lamports?: number } | null> }>('rpc.getMultipleAccounts.owners').value;
  const ownerMeta: Record<string, OwnerMeta> = {};
  ownerList.forEach((o, i) => { const inf = ownerInfos[i]; ownerMeta[o] = inf ? { programOwner: inf.owner ?? null, exists: true, lamports: inf.lamports ?? 0 } : { programOwner: null, exists: false, lamports: 0 }; });
  const funding: Record<string, RawTx[]> = {};
  for (const k of Object.keys(rec.calls)) if (k.startsWith('rpc.getTransactionsForAddress.first:')) funding[k.slice('rpc.getTransactionsForAddress.first:'.length)] = (body<{ data?: RawTx[] }>(k)?.data ?? []).map(slimTx);
  const launch = body<{ data?: RawTx[]; paginationToken?: string | null }>('rpc.getTransactionsForAddress.launch');
  return { mint, supply: String(asset?.token_info?.supply ?? '0'), decimals: asset?.token_info?.decimals ?? 0, largest, owners, ownerMeta, funding, launch: (launch?.data ?? []).map(slimTx), launchMore: !!launch?.paginationToken };
}

const TOKENS = [
  { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
];

for (const tk of TOKENS) {
  test(`replay ${tk.symbol}: the rules reproduce the spike's analysis.json (top-10, creator, pools, clusters, funders)`, { skip: !loadRec(tk.symbol) && 'spike recording not present' }, () => {
    const rec = loadRec(tk.symbol)!;
    const expected = JSON.parse(readFileSync(resolve(SPIKE, 'out', `${tk.symbol}.analysis.json`), 'utf8')) as { holders: Array<{ owner: string; pct: number; funder: { address: string } | null; labels: Array<{ label: string }> }>; clusters: Array<{ name: string; kind: string; members: string[]; pct: number }>; insights: { top10: { byTokenAccount: number; byOwner: number; clusterAdjusted: number }; dev: { creator: string | null }; launch: { pools: string[] }; snipers: { count: number }; bundle: { sameSlotCohorts: number }; coverage: { launchTxs: number } } };
    const a = analyze(rawFromRec(tk.mint, rec));
    assert.equal(a.holders.length, expected.holders.length, 'same owner count');
    assert.deepEqual(a.holders.map((h) => h.owner), expected.holders.map((h) => h.owner), 'same owner order');
    for (const [i, h] of a.holders.entries()) assert.ok(Math.abs(h.pct - expected.holders[i].pct) < 0.011, `${h.owner} pct ${h.pct} vs ${expected.holders[i].pct}`);
    assert.ok(Math.abs(a.insights.top10.byTokenAccount - expected.insights.top10.byTokenAccount) < 0.011);
    assert.ok(Math.abs(a.insights.top10.byOwner - expected.insights.top10.byOwner) < 0.011);
    assert.ok(Math.abs(a.insights.top10.clusterAdjusted - expected.insights.top10.clusterAdjusted) < 0.011);
    assert.equal(a.insights.dev.creator, expected.insights.dev.creator);
    assert.deepEqual(a.insights.launch.pools, expected.insights.launch.pools);
    assert.equal(a.insights.coverage.launchTxs, expected.insights.coverage.launchTxs);
    assert.equal(a.insights.bundle.sameSlotCohorts, expected.insights.bundle.sameSlotCohorts);
    // funders: identical address per wallet
    for (const [i, h] of a.holders.entries()) assert.equal(h.funder?.address ?? null, expected.holders[i].funder?.address ?? null, `funder of ${h.owner}`);
    // clusters: same multi-member clusters (name, kind, members)
    const multi = (cs: Array<{ name: string; kind: string; members: string[] }>) => cs.filter((c) => c.members.length > 1).map((c) => `${c.name}:${c.kind}:${[...c.members].sort().join(',')}`);
    assert.deepEqual(multi(a.clusters), multi(expected.clusters));
    // entity labels per holder (LP/cex/contract/pool/dev) agree; the seed-list wording now says "unverified"
    const entity = (ls: Array<{ label: string }>) => ls.map((l) => l.label).filter((l) => ['LP', 'cex', 'contract', 'pool', 'dev', 'fresh-at-buy'].includes(l)).sort().join('+');
    for (const [i, h] of a.holders.entries()) assert.equal(entity(h.labels), entity(expected.holders[i].labels), `labels of ${h.owner}`);
    for (const h of a.holders) for (const l of h.labels) if (l.confidence === 'seed') assert.match(l.rule, /unverified/);
    // S1 now starts at the first POOL trade (design §4.2); for the pump.fun launch both definitions coincide
    if (tk.symbol === 'FARTCOIN') assert.equal(a.insights.snipers.count, expected.insights.snipers.count);
  });
}

// ---------------------------------------------------------------- synthetic launch: every rule fires

const MINT = 'MiNt111111111111111111111111111111111111111';
const POOL = addr(3), DEV = addr(1), FUNDER_B = addr(2), CEX = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', FUNDER_F = addr(6), SNIPER = addr(5), LP_AUTH = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const PROGRAM_X = addr(77);
const W = { b1: addr(10), b2: addr(11), b3: addr(12), d1: addr(7), f1: addr(16), f2: addr(17), t1: addr(18), t2: addr(19), c1: addr(30), c2: addr(31), plain: addr(40), vault: addr(50), pda: addr(51) };

function tx(slot: number, keys: Array<[string, boolean]>, deltas: Array<[string, number, number]>, tokenDeltas: Array<[string, bigint, bigint]>, sig = `sig${slot}${keys[0][0].slice(0, 4)}`, blockTime = 1_700_000_000 + slot): RawTx {
  const idx = (k: string) => keys.findIndex(([p]) => p === k);
  const pre = keys.map(() => 1e9), post = keys.map(() => 1e9);
  for (const [k, p, q] of deltas) { pre[idx(k)] = p; post[idx(k)] = q; }
  const preT = tokenDeltas.map(([owner, a], i) => ({ accountIndex: 100 + i, mint: MINT, owner, uiTokenAmount: { amount: a.toString() } }));
  const postT = tokenDeltas.map(([owner, , b], i) => ({ accountIndex: 100 + i, mint: MINT, owner, uiTokenAmount: { amount: b.toString() } }));
  return { slot, blockTime, transaction: { signatures: [sig], message: { accountKeys: keys.map(([pubkey, signer]) => ({ pubkey, signer })) } }, meta: { preBalances: pre, postBalances: post, preTokenBalances: preT, postTokenBalances: postT } };
}
const fund = (wallet: string, funder: string, slot: number, withMint = false): RawTx => tx(slot, [[funder, true], [wallet, false]], [[funder, 5e9, 4e9], [wallet, 0, 1e9]], withMint ? [[wallet, 0n, 10n]] : []);
const buy = (slot: number, buyer: string, amt: bigint, sig?: string): RawTx => tx(slot, [[buyer, true], [POOL, false]], [[buyer, 2e9, 1e9]], [[POOL, 1_000_000n, 1_000_000n - amt], [buyer, 0n, amt]], sig);

function synthetic(): IntelRaw {
  const supply = 1_000_000n;
  const holdersPct: Array<[string, number]> = [[POOL, 21.8], [DEV, 4.1], [W.d1, 2.2], [W.b1, 2.6], [W.b2, 2.4], [W.b3, 2.1], [SNIPER, 3.2], [CEX, 2.8], [W.f1, 1.1], [W.f2, 1.0], [W.t1, 1.2], [W.t2, 0.8], [W.c1, 1.5], [W.c2, 1.4], [W.plain, 1.9], [W.vault, 1.3], [W.pda, 0.9], [LP_AUTH, 5.0]];
  const largest = holdersPct.map(([o, p], i) => ({ address: addr(200 + i), amount: ((BigInt(Math.round(p * 100)) * supply) / 10_000n).toString() })).sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount)));
  const owners: Record<string, string> = {};
  holdersPct.forEach(([o], i) => { owners[addr(200 + i)] = o; });
  const ownerMeta: Record<string, OwnerMeta> = {};
  for (const [o] of holdersPct) ownerMeta[o] = { programOwner: SYSTEM_PROGRAM, exists: true, lamports: 1e9 };
  ownerMeta[W.vault] = { programOwner: PROGRAM_X, exists: true, lamports: 1e6 };
  ownerMeta[W.pda] = { programOwner: null, exists: false, lamports: 0 };
  ownerMeta[POOL] = { programOwner: PROGRAM_X, exists: true, lamports: 1e6 };
  const S0 = 1000;
  const funding: Record<string, RawTx[]> = {
    [W.d1]: [fund(W.d1, DEV, S0 - 50, true)],                        // R4 dev-linked + F1 fresh
    [W.b1]: [fund(W.b1, FUNDER_B, S0 - 10, true)], [W.b2]: [fund(W.b2, FUNDER_B, S0 - 10, true)], [W.b3]: [fund(W.b3, FUNDER_B, S0 - 9)], // R1/R2 + R5 (b1,b2 same first slot)
    [W.f1]: [fund(W.f1, FUNDER_F, S0 - 500)], [W.f2]: [fund(W.f2, FUNDER_F, S0 - 400)],   // R1 funder
    [W.c1]: [fund(W.c1, CEX, S0 - 300)], [W.c2]: [fund(W.c2, CEX, S0 - 200)],             // CEX veto
    [W.plain]: [tx(S0 - 700, [[W.plain, true]], [[W.plain, 1e9, 0.9e9]], [])],            // no inflow → no funder
    [SNIPER]: [fund(SNIPER, addr(60), S0 - 5000)],
    [W.t1]: [fund(W.t1, addr(61), S0 - 900)],
  };
  // launch: create tx (dev signs; the curve receives the mint; dev buys) then buys over slots
  const launch: RawTx[] = [
    tx(S0, [[DEV, true], [POOL, false]], [[DEV, 5e9, 4e9]], [[POOL, 0n, 1_000_000n], [DEV, 0n, 41_000n]], 'sigCreate'),
    buy(S0 + 1, SNIPER, 32_000n), buy(S0 + 1, W.b1, 26_000n), buy(S0 + 1, W.b2, 24_000n), buy(S0 + 2, W.b3, 21_000n), buy(S0 + 2, W.d1, 22_000n),
    ...Array.from({ length: 12 }, (_, i) => buy(S0 + 3 + i, addr(300 + i), 1_000n)),
    // R3: direct transfer t1 → t2 (no pool in the tx)
    tx(S0 + 20, [[W.t1, true], [W.t2, false]], [[W.t1, 1e9, 0.99e9]], [[W.t1, 20_000n, 12_000n], [W.t2, 0n, 8_000n]], 'sigXfer'),
    ...Array.from({ length: 10 }, (_, i) => buy(S0 + 30 + i, addr(400 + i), 500n)),
  ];
  return { mint: MINT, supply: supply.toString(), decimals: 6, largest, owners, ownerMeta, funding, launch, launchMore: true, crossToken: { [W.plain]: ['WIF', 'POPCAT'] } };
}

test('synthetic launch: every rule fires with its id, evidence and confidence', () => {
  const a = analyze(synthetic());
  const H = (o: string) => a.holders.find((h) => h.owner === o)!;
  const labels = (o: string) => H(o).labels.map((l) => l.label).sort();
  const cl = (o: string) => a.clusters.find((c) => c.members.includes(o))!;
  // P1 pool detected (the curve sold in ≥ 25 % of txs) and excluded from snipers
  assert.deepEqual(labels(POOL), ['contract', 'pool']);
  assert.deepEqual(a.insights.launch.pools, [POOL]);
  // D1 creator = fee payer of the first launch tx
  assert.equal(a.insights.dev.creator, DEV);
  assert.ok(labels(DEV).includes('dev'));
  assert.equal(a.insights.dev.creatorPctNow, 4.1);
  // S1 snipers: first 3 slots after the first pool trade, creator + pool excluded
  assert.ok(labels(SNIPER).includes('sniper'));
  assert.ok(labels(W.b3).includes('sniper'), 'slot +2 is inside the 3-slot window');
  assert.ok(!labels(DEV).includes('sniper'));
  assert.equal(a.insights.snipers.count, 5, 'sniper, b1, b2, b3, d1');
  // R2 bundle: same slot AND shared funder → b1,b2 bundle (b3 joins via R1)
  const bundle = cl(W.b1);
  assert.equal(bundle.kind, 'bundle');
  assert.deepEqual([...bundle.members].sort(), [W.b1, W.b2, W.b3].sort());
  assert.ok(bundle.evidence.some((e) => /R2 bundle/.test(e.rule)));
  assert.equal(a.insights.bundle.bundleClustersFound, 1);
  assert.ok(Math.abs(a.insights.bundle.bundlePctOfTopSample - 7.1) < 0.011);
  // R4 dev-linked: d1 funded by the creator
  assert.equal(cl(W.d1).kind, 'dev-linked');
  assert.ok(cl(W.d1).members.includes(DEV));
  // R1 funder: f1,f2
  assert.equal(cl(W.f1).kind, 'funder');
  assert.ok(cl(W.f1).members.includes(W.f2));
  // R3 transfer: t1 → t2
  assert.equal(cl(W.t1).kind, 'transfer');
  assert.ok(cl(W.t1).members.includes(W.t2));
  // CEX veto: c1,c2 share the Binance seed funder but are NOT linked; the evidence says so, with "unverified"
  assert.equal(cl(W.c1).members.length, 1);
  assert.equal(cl(W.c2).members.length, 1);
  assert.match(H(W.c1).funder?.label ?? '', /seed, unverified/);
  // L0 static: the LP authority and the CEX hot wallet; the seed entry reads "unverified"
  assert.deepEqual(labels(LP_AUTH), ['LP']);
  assert.deepEqual(labels(CEX), ['cex']);
  assert.match(H(CEX).labels[0].rule, /seed list, unverified/);
  assert.equal(H(CEX).labels[0].confidence, 'seed');
  assert.equal(knownOwnerRule(INTEL_KNOWN_OWNERS[CEX]), H(CEX).labels[0].rule);
  // F1 fresh-at-buy (first txs already move the mint) and R5 same-slot-created (b1,b2 first seen in one slot)
  assert.ok(labels(W.d1).includes('fresh-at-buy'));
  assert.ok(labels(W.b1).includes('same-slot-created') && labels(W.b2).includes('same-slot-created'));
  assert.equal(H(W.b1).labels.find((l) => l.label === 'same-slot-created')!.confidence, 'weak');
  // owner kinds: program-owned vault → contract; missing account → unfunded-authority?
  assert.deepEqual(labels(W.vault), ['contract']);
  assert.deepEqual(labels(W.pda), ['unfunded-authority?']);
  // X1 multi-token-top20 from the cross-token input
  assert.ok(labels(W.plain).includes('multi-token-top20'));
  // insights are sample-captioned and the cluster-adjusted top-10 drops LP / cex / contract / pool
  assert.equal(a.insights.coverage.topHoldersFetched, 18);
  assert.equal(a.insights.coverage.fundingLookups, 11);
  assert.equal(a.insights.coverage.launchTxs, 29);
  assert.equal(a.insights.coverage.launchMorePages, true);
  assert.ok(a.insights.top10.clusterAdjusted < a.insights.top10.byTokenAccount);
  assert.equal(a.insights.top10.excludedCount, 4, 'pool, cex, vault, LP authority');
  // clusters are named by share: C1 is the largest
  assert.equal(a.clusters[0].name, 'C1');
  assert.ok(a.clusters.every((c, i) => i === 0 || c.pct <= a.clusters[i - 1].pct));
  // determinism
  assert.deepEqual(analyze(synthetic()), a);
});

test('funderOf: first SOL inflow; funder = the signer whose SOL fell most; no inflow → reason', () => {
  const w = addr(90), f = addr(91), other = addr(92);
  const t = tx(5, [[f, true], [other, true], [w, false]], [[f, 9e9, 7e9], [other, 9e9, 8.5e9], [w, 0, 2e9]], []);
  const r = funderOf(w, [t]);
  assert.equal(r.funder, f);
  assert.equal(r.lamports, 2e9);
  assert.equal(r.firstSlot, 5);
  const none = funderOf(w, [tx(6, [[w, true]], [[w, 2e9, 1e9]], [])]);
  assert.equal(none.funder, null);
  assert.match(none.reason ?? '', /no SOL inflow/);
  assert.match(funderOf(w, []).reason ?? '', /no history/);
});

test('tokenDeltasByOwner sums per owner across token accounts of one tx', () => {
  const t = tx(1, [[addr(1), true]], [], [[addr(1), 10n, 15n], [addr(1), 0n, 5n], [addr(2), 20n, 10n]]);
  const d = tokenDeltasByOwner(t, MINT);
  assert.equal(d.get(addr(1)), 10n);
  assert.equal(d.get(addr(2)), -10n);
});

test('label policy: cabal-class labels are hidden by default and shown only on opt-in', () => {
  const hits = [{ label: 'sniper' as const, rule: 'x', confidence: 'on-chain' as const }, { label: 'cabal-candidate' as const, rule: 'y', confidence: 'derived' as const }, { label: 'bot' as const, rule: 'z', confidence: 'derived' as const }];
  assert.deepEqual(visibleLabels(hits).map((l) => l.label), ['sniper']);
  assert.deepEqual(visibleLabels(hits, true).map((l) => l.label), ['sniper', 'cabal-candidate', 'bot']);
  for (const l of ['cabal-candidate', 'smart', 'bot', 'follower', 'call-group']) assert.ok(HIDDEN_LABELS.has(l as never));
  // the rules never emit a hidden label
  const a = analyze(synthetic());
  for (const h of a.holders) for (const l of h.labels) assert.ok(!HIDDEN_LABELS.has(l.label));
});

test('slimTx keeps only what the rules read and drops the rest of a 10 KB parsed tx', () => {
  const t = tx(7, [[addr(1), true], [addr(2), false]], [[addr(1), 2e9, 1e9]], [[addr(2), 0n, 5n]]) as RawTx & { extra?: unknown };
  t.extra = { logMessages: new Array(50).fill('x'.repeat(100)) };
  (t.transaction as { signatures: string[] }).signatures.push('second');
  const s = slimTx(t);
  assert.equal((s as { extra?: unknown }).extra, undefined);
  assert.deepEqual(s.transaction?.signatures, ['sig7' + addr(1).slice(0, 4)]);
  assert.deepEqual(analyze({ ...synthetic(), launch: synthetic().launch.map(slimTx) }), analyze(synthetic()), 'slimming changes nothing the rules see');
});

// ---------------------------------------------------------------- the scan orchestrator (fakes, no network)

function fakeDeps(opts: { holders: TopHolders | Error; history: HeliusHistory | null; keyed?: boolean }) {
  const clock = new FakeClock(1_000_000);
  const cache = new Cache({ clock });
  const health = new HealthRegistry({ clock, keys: { helius: !!opts.history } });
  let detailCalls = 0, metaCalls = 0;
  const pool = {
    hasKeyed: opts.keyed ?? !!opts.history, heliusUrl: opts.history ? 'https://mainnet.helius-rpc.com/?api-key=REDACTED' : null,
    primary: { source: 'helius' },
    accountMeta: async (accounts: string[]) => { metaCalls++; return new Map(accounts.map((a) => [a, { programOwner: SYSTEM_PROGRAM, exists: true, lamports: 1 }])); },
  };
  const detail = { holders: async () => { detailCalls++; if (opts.holders instanceof Error) throw opts.holders; return { value: opts.holders, fetchedAt: clock.now(), source: opts.holders.source, fromCache: false, stale: false }; } };
  const intel = new WalletIntel({ cache, http: {} as never, pool: pool as never, detail: detail as never, health, clock, history: opts.history });
  return { intel, cache, health, clock, calls: () => ({ detailCalls, metaCalls }) };
}

const TOP: TopHolders = {
  mint: MINT, supply: '1000000', decimals: 6, source: 'helius', fetchedAt: 1,
  holders: [[POOL, 21.8], [DEV, 4.1], [W.b1, 2.6], [W.b2, 2.4]].map(([o, p], i) => ({ address: o as string, tokenAccount: addr(200 + i), owner: o as string, amount: (p as number) * 10_000, pct: p as number })),
  top10Pct: 30.9,
};

function fakeHistory(): { history: HeliusHistory; calls: string[] } {
  const calls: string[] = [];
  const raw = synthetic();
  const history = {
    firstTxs: async (w: string) => { calls.push(`first:${w}`); return { data: raw.funding[w] ?? [], paginationToken: null, fetchedAt: 1 }; },
    launchWindow: async (_m: string, limit: number) => { calls.push(`launch:${limit}`); return { data: raw.launch.slice(0, limit), paginationToken: raw.launch.length > limit ? 'more' : null, fetchedAt: 1 }; },
  } as unknown as HeliusHistory;
  return { history, calls };
}

test('scan: with Helius the light tier looks up ≤ 7 funders + a 100-tx window, caches funders forever and the scan for 60 s', async () => {
  const { history, calls } = fakeHistory();
  const d = fakeDeps({ holders: TOP, history });
  const r = await d.intel.scan(MINT, 'light');
  assert.equal(r.state, 'ok');
  if (r.state !== 'ok') return;
  assert.equal(r.via.history, 'helius');
  assert.equal(r.degraded, null);
  assert.equal(r.analysis.insights.dev.creator, DEV);
  assert.ok(r.analysis.clusters.some((c) => c.kind === 'bundle'));
  assert.ok(calls.filter((c) => c.startsWith('first:')).length <= SCAN_DEPTHS.light.funders);
  assert.ok(calls.includes('launch:100'));
  // second scan within the TTL: no calls at all
  const n = calls.length;
  const again = await d.intel.scan(MINT, 'light');
  assert.equal(again.state, 'ok');
  assert.equal((again as { fromCache: boolean }).fromCache, true);
  assert.equal(calls.length, n);
  // deep tier after the TTL: the funders are cache hits (immutable), only the bigger window is fetched
  d.clock.advance(61_000);
  const deep = await d.intel.scan(MINT, 'deep');
  assert.equal(deep.state, 'ok');
  assert.ok(calls.includes('launch:300'));
  assert.equal(calls.filter((c) => c.startsWith('first:')).length, n - 1, 'no new funder lookups: cached forever');
});

test('scan: keyless → holders + static labels only, degraded says a free Helius key unlocks funders and the launch window', async () => {
  const d = fakeDeps({ holders: { ...TOP, source: 'solana-rpc' }, history: null, keyed: false });
  const r = await d.intel.scan(MINT, 'light');
  assert.equal(r.state, 'ok');
  if (r.state !== 'ok') return;
  assert.equal(r.via.history, null);
  assert.match(r.degraded ?? '', /free Helius key/);
  assert.equal(r.analysis.insights.coverage.launchTxs, 0);
  assert.equal(r.analysis.insights.coverage.fundingLookups, 0);
  assert.ok(r.analysis.clusters.every((c) => c.kind === 'single'));
});

test('scan: no ranked holder list (aggregate / error) → unavailable with the reason and the fix, never a fake picture', async () => {
  const agg = fakeDeps({ holders: { ...TOP, holders: [], aggregateOnly: true, holderCount: 1000, source: 'jupiter-tokens' }, history: null, keyed: false });
  const r1 = await agg.intel.scan(MINT);
  assert.equal(r1.state, 'unavailable');
  if (r1.state === 'unavailable') { assert.match(r1.reason, /ranked holder list/); assert.equal(r1.fix, KEY_FIX); }
  const err = fakeDeps({ holders: new Error('rate limited (429)'), history: null, keyed: false });
  const r2 = await err.intel.scan(MINT);
  assert.equal(r2.state, 'unavailable');
  if (r2.state === 'unavailable') assert.match(r2.reason, /429/);
});

test('scan: Helius disabled by the credit meter → history leg paused, holders still shown, degraded explains', async () => {
  const { history } = fakeHistory();
  const d = fakeDeps({ holders: TOP, history });
  d.health.setDisabled('helius', true);
  const r = await d.intel.scan(MINT);
  assert.equal(r.state, 'ok');
  if (r.state === 'ok') { assert.equal(r.via.history, null); assert.match(r.degraded ?? '', /disabled/); }
});
