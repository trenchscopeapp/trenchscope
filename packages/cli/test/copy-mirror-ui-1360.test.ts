// task-1360 Tier 2 — the one-key MIRROR TICKET on the follows screen: m previews (checks + size), m again PROPOSES
// an inert order plan and lands on the O screen; a refused preview proposes nothing; esc closes; the proposal is
// armable only through the existing hold-to-arm gate (which needs an armed mandate), so applyAction alone never
// arms, and no voice/agent decision kind reaches `follows.mirror`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction } from '../src/main.ts';
import { makeFixtureState, newFollowsUi, type AppState } from '../src/state.ts';
import { screenerView } from '../src/screener/view.ts';
import { Canvas, THEMES } from '@dexterm/tui';
import { renderFollows } from '../src/screens/follows.ts';
import { CopyLive } from '../src/live/copy.ts';
import { PlanService } from '@dexterm/data/plans';
import { SimClock, FakeHistory, mkTx, sig, LEADER } from '../../data/test/copy-helpers.ts';

const SOL = 1_000_000_000;
const tick = () => new Promise((r) => setImmediate(r));

/** A follows screen whose followed wallet just BOUGHT the top screener row's mint (so the screen knows its price). */
async function scenario(opts: { solOut?: number; priceBump?: number } = {}) {
  const clock = new SimClock();
  const state = makeFixtureState({ screen: 'follows' });
  state.copyUi = newFollowsUi();
  state.plansSvc = new PlanService({ clock }); // in-memory; never the on-disk journal
  const row = screenerView(state.screener)[0];
  const mint = row.mint;
  const price = row.price!;
  // the leader buys 2 whole tokens (6 decimals) at the screen price (so drift = 0) for solOut SOL at $100/SOL
  const tokens = 2_000_000n;
  const usd = price * 2;
  const solOut = opts.solOut ?? usd / 100;
  const history = new FakeHistory(clock, { [LEADER]: [mkTx({ slot: 10, blockTime: Math.floor(clock.now() / 1000) - 600, sig: sig(1), wallet: LEADER, tokens: [{ mint: 'So11111111111111111111111111111111111111112', pre: 0n, post: 1n }], lamports: [10 * SOL, 10 * SOL - 5000] })] });
  const copy = new CopyLive(null, { followsPath: null, history, clock, solUsd: () => 100 });
  copy.store.add(LEADER, 'leader');
  state.copy = copy;
  await copy.tracker.pollOnce(); // backfill (no alerts)
  clock.advance(5_000);
  history.push(LEADER, mkTx({ slot: 20, blockTime: Math.floor(clock.now() / 1000) - 4, sig: sig(2), wallet: LEADER, tokens: [{ mint, pre: 0n, post: tokens }], lamports: [10 * SOL, 10 * SOL - Math.round(solOut * SOL)] }));
  await copy.tracker.pollOnce();
  state.now = new Date(clock.now());
  if (opts.priceBump) { (row as { price: number | null }).price = price * (1 + opts.priceBump); }
  return { state, copy, clock, mint, row, usd };
}
function render(state: AppState): string { const c = new Canvas(140, 44, THEMES.cyberspace); renderFollows(c, state); return c.toPlain(); }

test('m previews the mirror of the latest buy, m again proposes an INERT plan sized by the cap and opens the O screen on it', async () => {
  const { state, copy, mint, usd } = await scenario();
  assert.equal(copy.alerts()[0].trade.side, 'buy');
  applyAction(state, 'follows.mirror', []);
  assert.ok(state.copyUi!.mirror); assert.equal(state.copyUi!.mirror!.pending, true);
  assert.match(render(state), /resolving price, liquidity/);
  await tick();
  const mr = state.copyUi!.mirror!;
  assert.equal(mr.pending, false); assert.ok(mr.result?.ok, JSON.stringify(mr.result));
  const r = mr.result!;
  assert.ok(r.ok);
  assert.equal(r.sizeUsd, Math.min(20, Math.floor(usd * 100) / 100, Math.floor((screenerView(state.screener)[0].liq ?? 0) * 0.01 * 100) / 100));
  assert.ok(Math.abs(r.driftPct!) < 0.01, 'bought at the screen price → no drift');
  assert.equal(r.lagMs, 4_000);
  const txt = render(state);
  assert.match(txt, /MIRROR TICKET — proposal only/); assert.match(txt, /✓ lag/); assert.match(txt, /✓ drift/); assert.match(txt, /\? leader-dev/); assert.match(txt, /m again = PROPOSE/);
  // j/k are frozen while the preview is up; the plan service holds nothing yet
  applyAction(state, 'move.down', []); assert.equal(state.copyUi!.selected, 0);
  assert.equal(state.plansSvc!.listPlans().length, 0);
  // second m: proposal lands, screen = plans on the new row, status proposed, by copy
  applyAction(state, 'follows.mirror', []);
  assert.equal(state.screen, 'plans');
  const plans = state.plansSvc!.listPlans();
  assert.equal(plans.length, 1); assert.equal(plans[0].status, 'proposed'); assert.equal(plans[0].mint, mint); assert.equal(plans[0].side, 'buy');
  assert.equal(state.plansSvc!.engine.plan(plans[0].id)!.source.by, 'copy');
  assert.match(state.plansUi!.notice!, /MIRROR PROPOSAL .* inert until you hold a/);
  assert.equal(state.copyUi!.mirror, null);
  // the existing arm path: no mandate → the screen refuses to even raise the modal; nothing armed
  applyAction(state, 'plans.arm', []);
  assert.equal(state.plansUi!.arming, null); assert.match(state.plansUi!.notice!, /no mandate/);
  assert.equal(state.plansSvc!.listPlans()[0].status, 'proposed');
});

test('a refused preview (drift) proposes nothing; esc and m close it; no alert → a plain notice', async () => {
  const { state } = await scenario({ priceBump: 0.2 });
  applyAction(state, 'follows.mirror', []);
  await tick();
  const mr = state.copyUi!.mirror!;
  assert.equal(mr.result!.ok, false); assert.equal((mr.result as { reason: string }).reason, 'drift');
  assert.match(render(state), /REFUSED: refused: drift/);
  applyAction(state, 'follows.mirror', []);
  assert.equal(state.copyUi!.mirror, null); assert.equal(state.screen, 'follows'); assert.equal(state.plansSvc!.listPlans().length, 0);
  applyAction(state, 'follows.mirror', []); await tick();
  assert.ok(state.copyUi!.mirror);
  applyAction(state, 'back', []);
  assert.equal(state.copyUi!.mirror, null); assert.equal(state.screen, 'follows', 'esc closes the preview before leaving the screen');
  // a wallet with no buy alert
  const quiet = makeFixtureState({ screen: 'follows' });
  quiet.copyUi = newFollowsUi(); quiet.copy = new CopyLive(null, { followsPath: null }); quiet.copy.store.add(LEADER);
  applyAction(quiet, 'follows.mirror', []);
  assert.equal(quiet.copyUi!.mirror, null); assert.match(quiet.copyUi!.notice!, /no buy alert/);
  // off the screen the action is inert
  const other = makeFixtureState({ screen: 'screener' });
  applyAction(other, 'follows.mirror', []);
  assert.equal(other.copyUi ?? null, null);
});

test('a mirror bigger than the cap is clipped to the cap; the plan engine still re-checks the mandate at arming', async () => {
  const { state } = await scenario({ solOut: 5 }); // $500 leader buy
  applyAction(state, 'follows.mirror', []); await tick();
  const r = state.copyUi!.mirror!.result!;
  assert.ok(r.ok); assert.ok(r.sizeUsd <= 20, `clipped to the $20 cap (got ${r.sizeUsd})`);
});
