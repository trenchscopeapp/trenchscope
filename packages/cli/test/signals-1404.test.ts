// task-1404: the CLI live-signals binding (observation built from the token view + intel scan + fast-lane curve),
// and the alert-trigger path — the new RuleRow fields (fresh / mintable / freezable) plus the live overlay drive the
// @dexterm/custom RulesEngine, so a user rule fires on a live holder/rug change. Pure + deterministic, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RulesEngine, type RuleRow } from '@dexterm/custom';
import { buildObservation, LiveSignalsLive, type SignalInputs } from '../src/live/signals.ts';
import { emptyView, type TokenView, type PanelStatus } from '../src/live/token.ts';
import { ruleRowsOf } from '../src/rules.ts';

const MINT = 'EaD4STv3YNLaq2dpKWh6JaZTLLs9MAEHyyNUMfMUpump';

function view(over: Partial<TokenView> = {}): TokenView {
  const v = emptyView({ mint: MINT, symbol: 'WIF', name: 'dogwifhat', launchpad: 'pump.fun' });
  return Object.assign(v, over);
}
function panel(fetchedAt: number, via = 'helius', stale = false): PanelStatus {
  return { state: stale ? 'error' : 'ok', via, reason: null, fetchedAt, stale };
}

test('buildObservation maps the token view + intel + fast-lane curve, each field with its own source + fetch time', () => {
  const v = view({ top10: 40, dev: 6, lpLocked: 100, liq: 50_000, mintAuth: true, freezeAuth: false });
  v.panels.holders = panel(900, 'solana-rpc');
  v.panels.market = panel(950, 'ds');
  v.panels.rugcheck = panel(800, 'rugcheck');
  v.panels.authorities = panel(980, 'helius');
  const inputs: SignalInputs = { view: v, intel: null, curve: { curve: { vToken: 900_000_000, vSol: 30, complete: false } as never, at: 990 } };
  const obs = buildObservation(inputs, 1000);
  assert.equal(obs.top10?.value, 40);
  assert.equal(obs.top10?.source, 'solana-rpc');
  assert.equal(obs.top10?.fetchedAt, 900);
  assert.equal(obs.lpLocked?.source, 'rugcheck');
  assert.equal(obs.liq?.value, 50_000);
  assert.equal(obs.mintAuth?.present, true);
  assert.equal(obs.freezeAuth?.present, false);
  assert.ok(obs.bonding && obs.bonding.source === 'onchain-curve' && obs.bonding.value! > 0);
  assert.equal(obs.migrated?.value, false);
});

test('buildObservation prefers the wallet-intel figures (ex-pool top10, creator %, bundled, snipers, fresh) when the scan landed', () => {
  const v = view({ top10: 40, dev: 6 });
  v.panels.holders = panel(900, 'solana-rpc');
  v.panels.market = panel(950, 'ds');
  const analysis = {
    clusters: [{ pct: 22 }],
    insights: {
      top10: { exPool: 33 },
      dev: { creatorPctNow: 4.2 },
      bundle: { bundlePctOfTopSample: 12 },
      snipers: { count: 7 },
      fresh: { freshAtBuyPctOfTopSample: 18 },
      coverage: { launchTxs: 120, fundingLookups: 7 },
    },
  } as never;
  const inputs: SignalInputs = { view: v, intel: { analysis, fetchedAt: 500, via: 'helius' }, curve: null };
  const obs = buildObservation(inputs, 1000);
  assert.equal(obs.top10?.value, 33, 'ex-pool wins over the panel top10');
  assert.equal(obs.top10?.source, 'helius');
  assert.equal(obs.dev?.value, 4.2);
  assert.equal(obs.bundled?.value, 12);
  assert.equal(obs.snipers?.value, 7);
  assert.equal(obs.fresh?.value, 18);
  assert.equal(obs.cluster?.value, 22);
});

test('LiveSignalsLive emits a dev-sell on a creator-share drop and keeps it in the per-mint log + fields', () => {
  let clock = 1000;
  const emitted: string[] = [];
  const sig = new LiveSignalsLive({ now: () => clock, onSignal: (s) => emitted.push(s.kind) });
  const v1 = view({ dev: 10 }); v1.panels.market = panel(1000, 'jup');
  sig.observe({ view: v1, intel: null, curve: null });
  clock = 50_000;
  const v2 = view({ dev: 3 }); v2.panels.market = panel(50_000, 'jup');
  const out = sig.observe({ view: v2, intel: null, curve: null });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'dev-sell');
  assert.deepEqual(emitted, ['dev-sell']);
  assert.equal(sig.recent(MINT).length, 1);
  assert.equal(sig.fields(MINT).dev, 3);
});

test('ALERT TRIGGER: the live fields drive the RulesEngine — mintable, dev.delta and top10.delta all fire a rule', () => {
  const engine = new RulesEngine();
  engine.load('when mintable > 0 then alert(warn, "mint authority live") scope mint:' + MINT);
  engine.load('when dev.delta < -2 then alert(down, "dev dumping") scope mint:' + MINT);
  engine.load('when top10.delta >= 3 then alert(warn, "concentration climbing") scope mint:' + MINT);

  const row = (over: Partial<RuleRow>): RuleRow => Object.assign({ mint: MINT, symbol: 'WIF' }, over);
  // tick 1: baseline (mint authority on → mintable rule fires immediately; .delta needs two earlier samples).
  const base = row({ mintable: 1, dev: 10, top10: 40 });
  engine.observe([base], 1000);
  let res = engine.evaluate([base], 1000);
  assert.ok(res.alerts.some((a) => /mint authority live/.test(a.text)), 'mintable>0 fires at once');
  // tick 2: a second baseline sample so the ring has two earlier points for .delta.
  engine.observe([base], 2000);
  // tick 3: dev drops 10→6 (delta −4 vs the oldest in-window sample) and top10 40→45 (delta +5).
  const changed = row({ mintable: 1, dev: 6, top10: 45 });
  engine.observe([changed], 3000);
  res = engine.evaluate([changed], 3000);
  assert.ok(res.alerts.some((a) => /dev dumping/.test(a.text)), 'dev.delta < -2 fires');
  assert.ok(res.alerts.some((a) => /concentration climbing/.test(a.text)), 'top10.delta >= 3 fires');
});

test('ruleRowsOf overlays the open token row with the live signal fields (alert-trigger wiring)', () => {
  const sig = new LiveSignalsLive({ now: () => 1000 });
  const v = view({ dev: 9, top10: 50, mintAuth: true, freezeAuth: false });
  v.panels.market = panel(1000, 'jup'); v.panels.holders = panel(1000, 'solana-rpc'); v.panels.authorities = panel(1000, 'helius');
  sig.observe({ view: v, intel: null, curve: null });
  // a minimal AppState shape: the screener row carries stale snapshot values; the overlay replaces them with live.
  const state = {
    screener: { rows: [{ mint: MINT, symbol: 'WIF', dev: 99, top10: 99 }] },
    larpByMint: new Map(),
    live: {
      token: { view: v },
      signals: sig,
      intel: { entry: () => null },
    },
  } as never;
  const rows = ruleRowsOf(state);
  const r = rows.find((x) => x.mint === MINT)!;
  assert.equal(r.dev, 9, 'live dev overlays the stale screener value');
  assert.equal(r.top10, 50);
  assert.equal(r.mintable, 1, 'mintable exposed to rules');
  assert.equal(r.freezable, 0);
});

/** A base64 pump.fun bonding-curve account for the given virtual token reserves (whole tokens). */
function curve(vToken: number, complete = false): { vToken: number; vSol: number; complete: boolean; priceSol: number | null; virtualTokenReserves: bigint; virtualSolReserves: bigint; realTokenReserves: bigint; realSolReserves: bigint; tokenTotalSupply: bigint } {
  return { vToken, vSol: 30, complete, priceSol: 30 / vToken, virtualTokenReserves: 0n, virtualSolReserves: 0n, realTokenReserves: 0n, realSolReserves: 0n, tokenTotalSupply: 0n };
}

test('replaying rising bonding-curve pushes fires bonding steps once each, then migration once; latency = data age', () => {
  let clock = 0;
  const sig = new LiveSignalsLive({ now: () => clock });
  const v = view(); v.panels.market = panel(0, 'ds');
  // a sequence of on-chain pushes (replay): bonding ≈ 50% → 56% → 62% → complete. Each push's `at` is its receipt time.
  const seq: Array<{ vToken: number; complete?: boolean; at: number }> = [
    { vToken: 676_450_000, at: 0 },   // ≈50%
    { vToken: 628_864_000, at: 2000 }, // ≈56% (+6 → fires)
    { vToken: 581_278_000, at: 4000 }, // ≈62% (+6 → fires)
    { vToken: 581_278_000, complete: true, at: 6000 }, // migrated (reserves flat → isolates the migration signal)
  ];
  const fired: string[] = [];
  for (const s of seq) {
    clock = s.at + 300; // the row is observed ~300ms after the push arrives
    const out = sig.observe({ view: v, intel: null, curve: { curve: curve(s.vToken, s.complete) as never, at: s.at } });
    for (const x of out) fired.push(x.kind);
  }
  const bondings = fired.filter((k) => k === 'bonding');
  assert.equal(bondings.length, 2, 'two +6% steps fired');
  assert.equal(fired.filter((k) => k === 'migrated').length, 1, 'migration fired once');
  // the bonding signal's data age reflects the push→observe gap (300ms)
  const bondingSig = sig.recent(MINT).find((s) => s.kind === 'bonding')!;
  assert.equal(bondingSig.source, 'onchain-curve');
  assert.equal(bondingSig.dataAgeMs, 300);
});

test('a stale curve push (older than staleAfterMs) does not fire a signal', () => {
  let clock = 0;
  const sig = new LiveSignalsLive({ now: () => clock, thresholds: { staleAfterMs: 1000 } });
  const v = view(); v.panels.market = panel(0, 'ds');
  clock = 100;
  sig.observe({ view: v, intel: null, curve: { curve: curve(676_450_000) as never, at: 0 } }); // baseline ≈50%
  clock = 100_000; // 100s later
  const out = sig.observe({ view: v, intel: null, curve: { curve: curve(581_278_000) as never, at: 90_000 } }); // push is 10s old > 1s stale
  assert.deepEqual(out.filter((s) => s.kind === 'bonding'), [], 'stale push fires nothing');
});

test('a token opened by --mint (not in the screener feed) still appears as a rule row with its live fields', () => {
  const sig = new LiveSignalsLive({ now: () => 1000 });
  const v = view({ dev: 4, mintAuth: false });
  v.panels.market = panel(1000, 'jup'); v.panels.authorities = panel(1000, 'helius');
  sig.observe({ view: v, intel: null, curve: null });
  const state = {
    screener: { rows: [] },
    larpByMint: new Map(),
    live: { token: { view: v }, signals: sig, intel: { entry: () => null } },
  } as never;
  const rows = ruleRowsOf(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mint, MINT);
  assert.equal(rows[0].mintable, 0);
  assert.equal(rows[0].dev, 4);
});
