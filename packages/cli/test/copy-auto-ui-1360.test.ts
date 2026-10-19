// task-1360 Tier 3 — the AUTO-MIRROR surface on the follows screen: A only raises the modal (applyAction can never
// enable), the enable needs a keypress gesture AND the engine's less-safe popup, the screen shows ON/off and the
// requirement line, A while ON turns it off and revokes the copy mandate; with auto ON a tracker alert arms a
// hands-free mirror through the plan engine. Nothing here is reachable by a voice decision or an agent tool.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAction } from '../src/main.ts';
import { makeFixtureState, newFollowsUi, copyAutoService, type AppState } from '../src/state.ts';
import { Canvas, THEMES, DEFAULT_KEYMAP, parseKeys } from '@dexterm/tui';
import { renderFollows } from '../src/screens/follows.ts';
import { CopyLive } from '../src/live/copy.ts';
import { PlanService } from '@dexterm/data/plans';
import { CopyAuto, CopyAutoError, type MirrorMarket } from '@dexterm/data/copy';
import { SimClock, FakeHistory, mkTx, sig, LEADER, MINT_A } from '../../data/test/copy-helpers.ts';

// task-1376: copyAutoService journals to $DEXTERM_HOME/copy.journal. Point it at a temp home that does NOT exist yet
// (a fresh CI runner has no ~/.dexterm): the journal must create its directory, and the developer's real
// ~/.dexterm/copy.journal is never touched.
const TMP = mkdtempSync(join(tmpdir(), 'copy-auto-ui-1360-'));
const HOME = join(TMP, 'dexterm-home');
process.env.DEXTERM_HOME = HOME;
after(() => rmSync(TMP, { recursive: true, force: true }));

const SOL = 1_000_000_000;
const PRICE = 50;
const MARKET: MirrorMarket = { symbol: 'TRENCH', decimals: 6, priceUsd: PRICE, priceAt: null, liqUsd: 80_000, mcapUsd: PRICE * 1e6, ageMs: 3_600_000 };

function render(state: AppState): string { const c = new Canvas(150, 44, THEMES.cyberspace); renderFollows(c, state); return c.toPlain(); }

function scenario() {
  const clock = new SimClock();
  const state = makeFixtureState({ screen: 'follows' });
  state.copyUi = newFollowsUi();
  state.plansSvc = new PlanService({ clock, rng: () => 0.42 });
  const history = new FakeHistory(clock, { [LEADER]: [] });
  const copy = new CopyLive(null, { followsPath: null, history, clock, solUsd: () => 100 });
  copy.store.add(LEADER, 'leader');
  state.copy = copy;
  state.now = new Date(clock.now());
  return { state, copy, clock, history };
}

test('A drafts default caps and only raises the modal; applyAction never enables; the enable needs a keypress AND the less-safe popup', () => {
  const { state, copy } = scenario();
  applyAction(state, 'follows.auto', []);
  assert.deepEqual(state.copyUi!.autoModal, { wallet: LEADER });
  const auto = copyAutoService(state);
  assert.ok(copy.auto === auto, 'the service is attached to the copy binding');
  assert.equal(auto.journal.path, join(HOME, 'copy.journal')); assert.ok(existsSync(auto.journal.path!), 'the journal created its directory');
  const pol = auto.policy(LEADER)!;
  assert.equal(pol.enabled, false); assert.equal(pol.perTradeUsd, 20); assert.equal(pol.dailyUsd, 100);
  let txt = render(state);
  assert.match(txt, /AUTO-MIRROR — capped, default OFF, less safe/); assert.match(txt, /✗ needs the "less safe" hands-free popup first/); assert.match(txt, /mirror-SELL is not built/);
  assert.match(txt, /per mirror ≤ \$5\.00 \(¼ of the \$20 per-trade cap/);
  // driving the action again (what a pipe/agent could do) keeps it OFF
  applyAction(state, 'follows.auto', []); applyAction(state, 'follows.auto', []);
  assert.equal(auto.policy(LEADER)!.enabled, false); assert.equal(state.plansSvc!.listMandates().length, 0);
  // j/k frozen under the modal; esc is the loop's job, `back` on the modal is inert for the screen
  applyAction(state, 'move.down', []); assert.equal(state.copyUi!.selected, 0);
  // the loop's enable gesture: refused until the popup is accepted (keypress-only), then ON
  assert.throws(() => auto.enable(LEADER, { gesture: 'keypress' }), (e: unknown) => e instanceof CopyAutoError && e.reason === 'gate-on');
  assert.throws(() => state.plansSvc!.acceptRisk({ gesture: 'spoken-free' }));
  state.plansSvc!.acceptRisk({ gesture: 'keypress' });
  txt = render(state); assert.match(txt, /✓ the "less safe" hands-free popup is accepted/); assert.match(txt, /Hold and release \[enter\] or \[y\] to turn auto ON/);
  const p = auto.enable(LEADER, { gesture: 'keypress' });
  assert.equal(p.enabled, true);
  state.copyUi!.autoModal = null;
  txt = render(state);
  assert.match(txt, /\bON\b/); assert.match(txt, /A {2}auto OFF/);
  const m = state.plansSvc!.listMandates()[0];
  assert.equal(m.status, 'armed'); assert.equal(m.maxTier, 'hands-free'); assert.equal(m.totalUsd, 100); assert.equal(m.perTradeUsd, 20);
  // A while ON → off at once, mandate revoked
  applyAction(state, 'follows.auto', []);
  assert.equal(auto.policy(LEADER)!.enabled, false); assert.match(state.copyUi!.notice!, /auto-mirror OFF/); assert.equal(state.copyUi!.autoModal, null);
  assert.equal(state.plansSvc!.listMandates()[0].status, 'revoked');
  // keymap: A is follows-only and the only auto key
  assert.equal(DEFAULT_KEYMAP.resolve(parseKeys('A')[0], 'follows'), 'follows.auto');
  assert.equal(DEFAULT_KEYMAP.bindings.filter((b) => b.action === 'follows.auto').length, 1);
  // off the screen the action is inert and creates no policy
  const other = makeFixtureState({ screen: 'screener' }); other.copy = copy;
  applyAction(other, 'follows.auto', []); assert.equal(other.copyUi ?? null, null);
});

test('with auto ON, a tracker buy alert becomes a hands-free mirror armed in the plan engine; OFF, the same alert is only a toast', async () => {
  const { state, copy, clock, history } = scenario();
  const plans = state.plansSvc!;
  const auto = new CopyAuto({ plans, clock, market: async () => MARKET, isFollowed: (w) => copy.store.has(w), trades: (w) => copy.trades(w) });
  copy.auto = auto;
  auto.draft(LEADER, { perTradeUsd: 20, dailyUsd: 100, cooldownMs: 10_000 });
  await copy.tracker.pollOnce(); // prime
  const buy = (n: number) => mkTx({ slot: 100 + n, blockTime: Math.floor(clock.now() / 1000) - 2, sig: sig(n), wallet: LEADER, tokens: [{ mint: MINT_A, pre: 0n, post: 1_000_000n }], lamports: [SOL, SOL - 0.5 * SOL] });
  // OFF: alert → toast queue only
  clock.advance(10_000); history.push(LEADER, buy(1));
  await copy.tracker.pollOnce(); await new Promise((r) => setImmediate(r));
  assert.equal(copy.takeAlerts().length, 1); assert.equal(plans.listPlans().length, 0);
  // ON (keypress + popup) → the next alert is proposed by 'copy' and armed at the hands-free tier
  plans.acceptRisk({ gesture: 'keypress' }); auto.enable(LEADER, { gesture: 'keypress' });
  clock.advance(10_000); history.push(LEADER, buy(2));
  await copy.tracker.pollOnce(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const rows = plans.listPlans();
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'armed'); assert.equal(rows[0].tier, 'hands-free'); assert.equal(rows[0].sizeUsd, 5);
  assert.equal(plans.engine.plan(rows[0].id)!.source.by, 'copy');
  assert.equal(auto.status(LEADER).lastOutcome!.kind, 'armed');
  const txt = render(state);
  assert.match(txt, /\bON\b/); assert.match(txt, /BUY/);
  // panic from the O screen's action revokes the copy mandate; the auto service notices on the next alert and turns off
  applyAction(state, 'screen.plans', []); applyAction(state, 'plans.panic', []);
  clock.advance(10_000); history.push(LEADER, buy(3));
  await copy.tracker.pollOnce(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(auto.policy(LEADER)!.enabled, false); assert.match(auto.policy(LEADER)!.offReason!, /mandate-revoked/);
  assert.equal(plans.listPlans().filter((r) => r.status === 'armed').length, 0);
});
