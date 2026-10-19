// task-1367 on the token screen: holder classes in the HOLDERS panel, top-10 raw + ex-pool on the ON-CHAIN row
// (the colour reads ex-pool), the main-risk line, the bubble popup VM carrying class + reason, and the snipers /
// bundled cells telling the TRUE reason the launch window is missing ("needs Helius key" only without a key).
// Fixture: packages/data/test/fixtures/holders-1367.json (recorded RPC shape; no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, Cache, type IntelRaw, type OwnerMeta, type ScanResult, type WalletIntel, type DataLayer, type IntelAnalysis } from '@dexterm/data';
import { Canvas, THEMES } from '@dexterm/tui';
import { makeFixtureState } from '../src/state.ts';
import { emptyView, type TokenView } from '../src/live/token.ts';
import { renderTokenLive } from '../src/live/screens/token-live.ts';
import { IntelLive, launchIntelCells, launchRetryable, holderTags, popupBubbleVM } from '../src/live/intel.ts';
import type { LiveContext } from '../src/live/index.ts';

globalThis.fetch = (async (input: unknown) => { throw new Error(`network access blocked in tests: ${String(input)}`); }) as typeof fetch;

const HERE = dirname(fileURLToPath(import.meta.url));
interface Fx { mint: string; supply: string; decimals: number; calls: Record<string, { body: { result: { value: Array<Record<string, unknown> | null> } } }>; expect: Array<{ owner: string; pct: number }> }
const FX = JSON.parse(readFileSync(resolve(HERE, '..', '..', 'data', 'test', 'fixtures', 'holders-1367.json'), 'utf8')) as Fx;
const NOW = 1_760_000_000_000;

function rawFrom(fx: Fx): IntelRaw {
  const v = (k: string) => fx.calls[k].body.result.value;
  const largest = v('rpc.getTokenLargestAccounts') as Array<{ address: string; amount: string }>;
  const ta = v('rpc.getMultipleAccounts.tokenAccounts') as Array<{ data: { parsed: { info: { owner: string } } } }>;
  const owners: Record<string, string> = {};
  largest.forEach((a, i) => { owners[a.address] = ta[i].data.parsed.info.owner; });
  const list = [...new Set(Object.values(owners))];
  const om = v('rpc.getMultipleAccounts.owners') as Array<{ owner: string; lamports: number } | null>;
  const ownerMeta: Record<string, OwnerMeta> = {};
  list.forEach((o, i) => { const m = om[i]; ownerMeta[o] = m ? { programOwner: m.owner, exists: true, lamports: m.lamports } : { programOwner: null, exists: false, lamports: 0 }; });
  return { mint: fx.mint, supply: fx.supply, decimals: fx.decimals, largest, owners, ownerMeta, funding: {}, launch: [], launchMore: false };
}

function ok(analysis: IntelAnalysis, over: Partial<Extract<ScanResult, { state: 'ok' }>> = {}): ScanResult {
  return { state: 'ok', depth: 'light', analysis, via: { holders: 'helius', history: 'helius' }, degraded: null, fetchedAt: 1, fromCache: false, ...over };
}

async function intelWith(r: ScanResult, history: { ok: true } | { ok: false; why: string } = { ok: true }): Promise<IntelLive> {
  const intel = { scan: async () => r, historyAvailable: () => history } as unknown as WalletIntel;
  const live = new IntelLive({} as DataLayer, { intel, now: () => 1 });
  await live.scan({ mint: FX.mint, symbol: 'LOAD' });
  return live;
}

function viewFrom(a: IntelAnalysis): TokenView {
  const v = emptyView({ mint: FX.mint, symbol: 'LOAD', name: 'Load Test', launchpad: 'dbc', price: 0.005 });
  v.holdersTop = a.holders.map((h) => ({ address: h.owner, pct: h.pct, amount: h.pct * 1e7, label: null, tokenAccountOnly: false }));
  v.holdersSample = `top ${a.holders.length} · 90.0% of supply`;
  v.top10 = 88.8;
  v.panels.holders = { state: 'ok', via: 'helius', reason: null, fetchedAt: NOW, stale: false };
  return v;
}

function render(intel: IntelLive | null, v: TokenView, w = 176, h = 48): string {
  const cache = new Cache({ path: ':memory:' });
  const dl = { cache } as unknown as DataLayer;
  const live = { dl, intel, token: { dl, view: v }, rpc: { provider: 'helius', basis: 'test' }, fastLane: null, badgeFor: () => 'POLL', livePrice: () => null, watch: { has: () => false }, creditsStatus: () => undefined } as unknown as LiveContext;
  const state = makeFixtureState({ screen: 'token', theme: THEMES.midnight, calm: true });
  state.screener.source = 'live';
  state.live = live;
  state.now = new Date(NOW);
  const c = new Canvas(w, h, THEMES.midnight);
  c.fill(0, 0, w, h, ' ', { bg: THEMES.midnight.bg });
  renderTokenLive(c, state, v);
  return c.toPlain();
}

test('token screen: HOLDERS rows carry CURVE / LOCK / POOL / VAULT / BURN / UNLABELLED; top-10 shows ex-pool + raw, coloured by ex-pool', async () => {
  const a = analyze(rawFrom(FX));
  const intel = await intelWith(ok(a));
  const out = render(intel, viewFrom(a));
  const row = (owner: string) => out.split('\n').find((l) => l.includes(`${owner.slice(0, 4)}…${owner.slice(-4)}`)) ?? '';
  const [dbc, lock, whale, orca, cpmm, alpha, burn] = FX.expect.map((e) => e.owner);
  assert.match(row(dbc), / CURVE /);
  assert.match(row(lock), / LOCK /);
  assert.match(row(whale), / UNLABELLED /);
  assert.match(row(orca), / POOL /);
  assert.match(row(cpmm), / POOL /);
  assert.match(row(alpha), / VAULT /);
  assert.match(row(burn), / BURN /);
  assert.match(out, /Top 10 ex-pool\s+7\.5%/);
  assert.match(out, /Top 10 raw\s+88\.8%/);
  // the 70 % launchpad vault is explained, not flagged
  assert.match(out, /· top holder 70\.0% is CURVE \(Meteora DBC\): not counted in ex-pool/);
  assert.doesNotMatch(out, /main risk/);
  // the ex-pool figure drives the level (7.5 % → ok): the old raw-driven red flag is gone
  const tags = holderTags(intel, FX.mint);
  assert.deepEqual(tags.top10, { raw: 88.8, exPool: 7.5, dropped: 6, droppedPct: 82.2 });
});

test('token screen: an UNLABELLED owner above 30 % is called out as the main risk (and the ex-pool figure goes red)', async () => {
  // the token account the launchpad vault used is now owned by a plain wallet (the DBC authority drops out)
  const raw2 = rawFrom(FX as never);
  raw2.owners[raw2.largest[0].address] = FX.expect[2].owner;
  delete raw2.ownerMeta[FX.expect[0].owner];
  const a = analyze(raw2);
  const intel = await intelWith(ok(a));
  const out = render(intel, viewFrom(a));
  const short = `${FX.expect[2].owner.slice(0, 4)}…${FX.expect[2].owner.slice(-4)}`;
  assert.ok(out.includes(`⚠ main risk: UNLABELLED ${short} holds 74.5%`), out.split('\n').filter((l) => /risk/.test(l)).join('\n'));
  assert.match(out, /Top 10 ex-pool\s+77\.5%/);
});

test('token screen before the scan lands: no class badges, the old top-10 cell, the same layout as before', () => {
  const a = analyze(rawFrom(FX));
  const out = render(null, viewFrom(a));
  assert.doesNotMatch(out, / (CURVE|UNLABELLED|LOCK) /);
  assert.match(out, /Top 10 holders\s+88\.8%/);
});

test('snipers / bundled: the real reason the launch window is missing; "needs Helius key" only when there is no key', async () => {
  const a = analyze(rawFrom(FX)); // launch window empty
  const cell = async (r: ScanResult, h: { ok: true } | { ok: false; why: string } = { ok: true }) => launchIntelCells(await intelWith(r, h), FX.mint).snipers.text;
  assert.equal(await cell(ok(a, { via: { holders: 'solana-rpc', history: null }, degraded: 'funders and launch window need a free Helius key → …' }), { ok: false, why: 'funders and launch window need a free Helius key → …' }), 'needs Helius key');
  assert.equal(await cell(ok(a, { via: { holders: 'helius', history: null }, degraded: 'Helius is cooling (rate limited or down); funders and launch window paused' }), { ok: false, why: 'Helius is cooling (rate limited or down); funders and launch window paused' }), 'Helius paused · r');
  assert.equal(await cell(ok(a, { via: { holders: 'helius', history: null }, degraded: 'Helius is disabled (daily credit budget spent); funders and launch window paused' }), { ok: false, why: 'Helius is disabled (daily credit budget spent); funders and launch window paused' }), 'Helius cap today');
  assert.equal(await cell(ok(a, { degraded: 'history partial (launch window: rpc getTransactionsForAddress: no result)' })), 'history failed · r');
  assert.equal(await cell(ok(a)), 'no launch txs read');
  // paused at scan time, available now → retry hint, and `r` re-runs the scan
  const recovered = await intelWith(ok(a, { via: { holders: 'helius', history: null }, degraded: 'Helius is cooling (rate limited or down); funders and launch window paused' }));
  assert.equal(launchIntelCells(recovered, FX.mint).snipers.text, 'Helius paused · r');
  assert.equal(launchRetryable(recovered, FX.mint), true);
  assert.equal(launchRetryable(await intelWith(ok(a), { ok: false, why: 'funders and launch window need a free Helius key' }), FX.mint), false, 'keyless: r never spends public-RPC calls for a dash');
  // the dev-history row no longer blames the key once the launch window was read
  const measured = analyze(rawFrom(FX));
  (measured.insights.coverage as { launchTxs: number }).launchTxs = 100;
  const out = render(await intelWith(ok(measured)), viewFrom(measured));
  assert.match(out, /Dev history\s+not reported \(jup\)/);
  assert.doesNotMatch(out, /needs Helius key/);
});

test('bubble popup VM: every holder carries its class + reason, lock escrow facts, and insights raw / ex-pool / big holder', async () => {
  const a = analyze(rawFrom(FX));
  const intel = await intelWith(ok(a));
  const vm = popupBubbleVM(intel.entry(FX.mint), { mint: FX.mint, symbol: 'LOAD' }, 1);
  assert.equal(vm.state, 'ok');
  assert.equal(vm.holders[0].cls?.tag, 'CURVE');
  assert.equal(vm.holders[1].cls?.tag, 'LOCK');
  assert.deepEqual(vm.holders[1].cls?.lock && { program: vm.holders[1].cls.lock.program, unlock: vm.holders[1].cls.lock.unlock }, { program: 'Jupiter Lock', unlock: null });
  assert.ok(vm.holders.every((h) => h.cls && h.cls.reason.length > 0));
  assert.equal(vm.insights?.top10ExPool, 7.5);
  assert.equal(vm.insights?.top10Raw, 88.8);
  assert.equal(vm.insights?.exPoolDropped, 6);
  assert.equal(vm.insights?.bigHolder, null);
  // the VM stays text-only (no URL, no key-shaped field)
  assert.doesNotMatch(JSON.stringify(vm), /https?:|api-key/);
});
