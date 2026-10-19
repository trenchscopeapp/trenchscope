// task-1367 holder classification: every top holder gets POOL / CURVE / VAULT / LOCK / CEX / BURN / DEV / LINKED
// or UNLABELLED with the reason, from the owner + the owner account's program (data the wallet-intel scan already
// fetches). The top-10 is reported raw and ex-pool, and an unlabelled owner above 30 % is the called-out risk.
// Fixtures: test/fixtures/holders-1367.json (recorded RPC shape: a Meteora DBC launchpad vault, a Jupiter Lock
// escrow, an Orca + a Raydium CPMM pool, an Alpha Vault, the incinerator, an unknown program, plain wallets) and
// the task-1286 spike recordings of WIF / POPCAT / FARTCOIN (real mainnet captures, a Raydium AMM v4 pool).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyze, classifyHolder, onCurve, slimTx, AUTHORITY_CLASS, PROGRAM_CLASS, EX_POOL_TAGS, INCINERATOR,
  WalletIntel, Cache, HealthRegistry, FakeClock,
  type IntelRaw, type OwnerMeta, type RawTx, type TopHolders,
} from '../src/index.ts';
import { findProgramAddress, base58Decode, pumpBondingCurve, PUMP_PROGRAM_ID } from '../src/sources/pda.ts';
import { SYSTEM_PROGRAM } from '../src/trade/tx-decode.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Fx {
  mint: string; supply: string; decimals: number;
  calls: Record<string, { body: { result: { value: unknown[] } } }>;
  expect: Array<{ owner: string; pct: number; what: string }>;
}
const FX = JSON.parse(readFileSync(resolve(HERE, 'fixtures', 'holders-1367.json'), 'utf8')) as Fx;

/** IntelRaw from a recording in the spike's call-key shape (no launch window: the classes need none). */
function rawFrom(fx: { mint: string; supply: string; decimals: number; calls: Record<string, { body: { result?: unknown } }> }, launch: RawTx[] = [], funding: Record<string, RawTx[]> = {}): IntelRaw {
  const body = <T>(k: string): T => (fx.calls[k]?.body as { result?: T })?.result as T;
  const largest = body<{ value: Array<{ address: string; amount: string }> }>('rpc.getTokenLargestAccounts').value;
  const ta = body<{ value: Array<{ data?: { parsed?: { info?: { owner?: string } } } } | null> }>('rpc.getMultipleAccounts.tokenAccounts').value;
  const owners: Record<string, string> = {};
  largest.forEach((a, i) => { const o = ta[i]?.data?.parsed?.info?.owner; if (o) owners[a.address] = o; });
  const list = [...new Set(Object.values(owners))];
  const om = body<{ value: Array<{ owner?: string; lamports?: number } | null> }>('rpc.getMultipleAccounts.owners').value;
  const ownerMeta: Record<string, OwnerMeta> = {};
  list.forEach((o, i) => { const m = om[i]; ownerMeta[o] = m ? { programOwner: m.owner ?? null, exists: true, lamports: m.lamports ?? 0 } : { programOwner: null, exists: false, lamports: 0 }; });
  return { mint: fx.mint, supply: fx.supply, decimals: fx.decimals, largest, owners, ownerMeta, funding, launch, launchMore: false };
}

const tagOf = (a: ReturnType<typeof analyze>, owner: string) => a.holders.find((h) => h.owner === owner)!.cls!;

test('constant pool authorities are re-derived with findProgramAddress (a typo can never ship) and are PDAs', () => {
  for (const [addr, e] of Object.entries(AUTHORITY_CLASS)) {
    assert.equal(findProgramAddress([new TextEncoder().encode(e.seed)], base58Decode(e.program)).address, addr, `${e.name} ${e.what}`);
    assert.equal(onCurve(addr), false, `${addr} is off-curve`);
    assert.ok(PROGRAM_CLASS[e.program], `${e.name} program is also in the program table`);
  }
  for (const id of Object.keys(PROGRAM_CLASS)) assert.equal(base58Decode(id).length, 32, `${id} decodes to 32 bytes`);
  assert.equal(PROGRAM_CLASS[PUMP_PROGRAM_ID].tag, 'CURVE');
});

test('fixture: launchpad vault / lock / AMM pools / alpha vault / burn / unknown program / plain wallets classified with reasons', () => {
  const a = analyze(rawFrom(FX));
  const [dbc, lock, whale, orca, cpmm, alpha, burn, unk, orphan, w2] = FX.expect.map((e) => e.owner);
  // launchpad vault: the Meteora DBC pool authority (a PDA with no account: only the derived table can see it)
  assert.equal(tagOf(a, dbc).tag, 'CURVE');
  assert.match(tagOf(a, dbc).reason, /Meteora DBC pool authority/);
  // lock: an escrow account owned by Jupiter Lock; the unlock schedule is NOT invented
  const l = tagOf(a, lock);
  assert.equal(l.tag, 'LOCK');
  assert.match(l.reason, /Jupiter Lock/);
  assert.deepEqual({ escrow: l.lock?.escrow, program: l.lock?.program, unlock: l.lock?.unlock, authority: l.lock?.authority }, { escrow: lock, program: 'Jupiter Lock', unlock: null, authority: null });
  assert.match(l.lock!.note, /not decoded/);
  // normal AMM pools: an Orca pool account (program-owned) and the Raydium CPMM vault authority (derived PDA)
  assert.equal(tagOf(a, orca).tag, 'POOL');
  assert.match(tagOf(a, orca).reason, /Orca Whirlpool/);
  assert.equal(tagOf(a, cpmm).tag, 'POOL');
  assert.match(tagOf(a, cpmm).reason, /Raydium CPMM vault authority/);
  assert.equal(tagOf(a, alpha).tag, 'VAULT');
  assert.equal(tagOf(a, alpha).lock?.program, 'Meteora Alpha Vault');
  assert.equal(tagOf(a, burn).tag, 'BURN');
  // never a guess: an unlisted program and an orphan PDA stay UNLABELLED (and are counted)
  assert.equal(tagOf(a, unk).tag, 'UNLABELLED');
  assert.match(tagOf(a, unk).reason, /not in dexterm's program list/);
  assert.equal(tagOf(a, orphan).tag, 'UNLABELLED');
  assert.match(tagOf(a, orphan).reason, /PDA \(off-curve, no account\)/);
  // plain wallets
  assert.equal(tagOf(a, whale).tag, 'UNLABELLED');
  assert.match(tagOf(a, whale).reason, /plain wallet \(System-owned, a keypair address\)/);
  assert.equal(tagOf(a, w2).tag, 'UNLABELLED');
  // every holder has a non-empty reason
  assert.ok(a.holders.every((h) => h.cls && h.cls.reason.length > 10));
});

test('fixture: top-10 raw vs ex-pool; the 70 % launchpad vault is not the main risk, an unlabelled whale would be', () => {
  const a = analyze(rawFrom(FX));
  const T = a.insights.top10;
  // raw = what explorers show (the vault + lock + pools included)
  assert.ok(Math.abs(T.byTokenAccount - 88.8) < 0.02, `raw ${T.byTokenAccount}`);
  // ex-pool drops CURVE + LOCK + 2×POOL + VAULT + BURN; the next ten owners are the six counted ones
  assert.equal(T.exPoolDropped, 6);
  assert.ok(Math.abs(T.exPoolDroppedPct - 82.2) < 0.02, `dropped ${T.exPoolDroppedPct}`);
  assert.ok(Math.abs(T.exPool - (4.5 + 0.8 + 0.7 + 0.6 + 0.5 + 0.4)) < 0.02, `exPool ${T.exPool}`);
  assert.equal(a.insights.bigHolder, null, 'no counted owner above 30 %');
  // the same 70 % in a plain wallet IS the risk, by name
  // the token account the launchpad vault used is now owned by a plain wallet (the DBC authority drops out)
  const raw2 = rawFrom(FX as never);
  raw2.owners[raw2.largest[0].address] = FX.expect[2].owner;
  delete raw2.ownerMeta[FX.expect[0].owner];
  const b = analyze(raw2);
  assert.equal(b.insights.bigHolder?.owner, FX.expect[2].owner);
  assert.equal(b.insights.bigHolder?.tag, 'UNLABELLED');
  assert.ok(b.insights.bigHolder!.pct > 70);
  assert.ok(Math.abs(b.insights.top10.exPool - 77.5) < 0.02, `exPool ${b.insights.top10.exPool}`);
});

test('classifyHolder order: burn and derived authorities first; DEV / LINKED / CEX from the rules; P1 pool last', () => {
  const mint = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
  const base = { mint, tokenAccounts: [], cex: null, dev: null, poolRule: null, linked: null };
  const sys: OwnerMeta = { programOwner: SYSTEM_PROGRAM, exists: true, lamports: 1 };
  assert.equal(classifyHolder({ ...base, owner: INCINERATOR, meta: sys }).tag, 'BURN');
  assert.equal(classifyHolder({ ...base, owner: SYSTEM_PROGRAM, meta: sys }).tag, 'BURN');
  const curve = pumpBondingCurve(mint);
  assert.equal(classifyHolder({ ...base, owner: curve, meta: undefined }).tag, 'CURVE', 'pump curve derived from the mint even without the owner lookup');
  const w = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS';
  assert.equal(classifyHolder({ ...base, owner: w, meta: sys, dev: 'fee payer of the first tx (D1 creator)', cex: 'Coinbase' }).tag, 'DEV');
  assert.equal(classifyHolder({ ...base, owner: w, meta: sys, linked: 'linked to 1 other top holder: …' }).tag, 'LINKED');
  const cex = classifyHolder({ ...base, owner: w, meta: sys, cex: 'Coinbase' });
  assert.equal(cex.tag, 'CEX');
  assert.match(cex.reason, /seed list, unverified/);
  assert.equal(classifyHolder({ ...base, owner: w, meta: sys, poolRule: 'selling counterparty in 9 of 20 launch-window txs (P1 pool)' }).tag, 'POOL');
  // a program-owned owner of a listed program beats the launch rules (the curve is never "the dev")
  assert.equal(classifyHolder({ ...base, owner: w, meta: { programOwner: PUMP_PROGRAM_ID, exists: true, lamports: 1 }, dev: 'x' }).tag, 'CURVE');
  // lookup missing → unlabelled, and it says so
  assert.match(classifyHolder({ ...base, owner: w, meta: undefined }).reason, /not resolved/);
  // a token account that is its own authority: escrow, program unknown → counted
  const self = classifyHolder({ ...base, owner: w, tokenAccounts: [w], meta: { programOwner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', exists: true, lamports: 1 } });
  assert.equal(self.tag, 'UNLABELLED');
  assert.match(self.reason, /its own token account/);
  assert.ok(!EX_POOL_TAGS.has('UNLABELLED') && !EX_POOL_TAGS.has('CEX') && !EX_POOL_TAGS.has('DEV') && !EX_POOL_TAGS.has('LINKED'));
});

// ---------------------------------------------------------------- real recordings (task-1286 spike captures)
const SPIKE = resolve(HERE, '..', '..', '..', '..', 'research', 'wallet-intel', 'prototype');
const loadRec = (sym: string): { calls: Record<string, { body: { result?: unknown } }> } | null => {
  const p = resolve(SPIKE, 'recorded', `${sym}.json.gz`);
  return existsSync(p) ? JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) : null;
};

for (const [sym, mint] of [['POPCAT', '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'], ['FARTCOIN', '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump']] as const) {
  test(`recorded ${sym}: the Raydium AMM v4 vault is POOL and leaves the ex-pool top-10; wallets are UNLABELLED or CEX`, { skip: !loadRec(sym) && 'spike recording not present' }, () => {
    const rec = loadRec(sym)!;
    const body = <T>(k: string): T => rec.calls[k]?.body?.result as T;
    const asset = body<{ token_info?: { supply?: string | number; decimals?: number } }>('das.getAsset');
    const launch = (body<{ data?: RawTx[] }>('rpc.getTransactionsForAddress.launch')?.data ?? []).map(slimTx);
    const funding: Record<string, RawTx[]> = {};
    for (const k of Object.keys(rec.calls)) if (k.startsWith('rpc.getTransactionsForAddress.first:')) funding[k.slice('rpc.getTransactionsForAddress.first:'.length)] = (body<{ data?: RawTx[] }>(k)?.data ?? []).map(slimTx);
    const a = analyze(rawFrom({ mint, supply: String(asset?.token_info?.supply ?? '0'), decimals: asset?.token_info?.decimals ?? 0, calls: rec.calls }, launch, funding));
    const amm = a.holders.find((h) => h.owner === '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
    assert.equal(amm?.cls?.tag, 'POOL');
    assert.ok(a.insights.top10.exPool < a.insights.top10.byOwner, 'pool dropped from the ex-pool figure');
    assert.ok(a.holders.filter((h) => h.cls?.tag === 'UNLABELLED').every((h) => /plain wallet|PDA|program/.test(h.cls!.reason)));
    assert.ok(a.holders.some((h) => h.cls?.tag === 'CEX'));
    assert.equal(a.insights.bigHolder, null);
  });
}

test('scan path: the fixture through WalletIntel (owner lookup = getMultipleAccounts meta) yields the classes', async () => {
  const clock = new FakeClock(1_000_000);
  const raw = rawFrom(FX);
  const top: TopHolders = {
    mint: FX.mint, supply: FX.supply, decimals: FX.decimals, source: 'helius', fetchedAt: 1, top10Pct: 88.8,
    holders: raw.largest.map((l, i) => ({ address: raw.owners[l.address], tokenAccount: l.address, owner: raw.owners[l.address], amount: Number(BigInt(l.amount) / 1_000_000n), pct: FX.expect[i].pct })),
  };
  const pool = { hasKeyed: true, heliusUrl: null, primary: { source: 'helius' }, accountMeta: async (accts: string[]) => new Map(accts.map((x) => [x, raw.ownerMeta[x] ?? { programOwner: null, exists: false, lamports: 0 }])) };
  const detail = { holders: async () => ({ value: top, fetchedAt: 1, source: 'helius', fromCache: false, stale: false }) };
  const intel = new WalletIntel({ cache: new Cache({ clock }), http: {} as never, pool: pool as never, detail: detail as never, health: new HealthRegistry({ clock }), clock, history: null });
  const r = await intel.scan(FX.mint);
  assert.equal(r.state, 'ok');
  if (r.state !== 'ok') return;
  const tags = r.analysis.holders.map((h) => h.cls?.tag);
  assert.deepEqual(tags.slice(0, 7), ['CURVE', 'LOCK', 'UNLABELLED', 'POOL', 'POOL', 'VAULT', 'BURN']);
  assert.equal(r.analysis.insights.top10.exPoolDropped, 6);
});
