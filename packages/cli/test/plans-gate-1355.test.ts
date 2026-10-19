// task-1355 Tier 4 — the "less safe" hands-free opt-in surface on the PLANS screen. The gate is ON by
// default; `plans.gate` (key G) ONLY raises the modal. Accepting (turning the keypress gate off) is a
// physical keypress captured in the interactive loop, never the applyAction path a pipe/agent can drive —
// so this asserts applyAction by itself can never turn hands-free on. Rendering the screen never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction } from '../src/main.ts';
import { makeFixtureState, newPlansUi, type AppState } from '../src/state.ts';
import { Canvas, THEMES } from '@dexterm/tui';
import { renderPlans } from '../src/screens/plans.ts';
import { PlanService } from '@dexterm/data/plans';

function plansState(): AppState {
  const state = makeFixtureState({ screen: 'plans' });
  state.plansUi = newPlansUi();
  state.plansSvc = new PlanService(); // no journalPath → fully in-memory, touches no file on disk
  return state;
}

test('Tier 4: the gate is on by default and `plans.gate` only raises the modal — applyAction never turns hands-free on', () => {
  const state = plansState();
  assert.equal(state.plansSvc!.riskStatus().active, false, 'gate on by default');
  assert.equal(state.plansUi!.riskModal, false);

  applyAction(state, 'plans.gate', []);
  assert.equal(state.plansUi!.riskModal, true, 'G raises the less-safe modal');
  // The decisive invariant: driving applyAction (the only path a pipe/agent could reach) never flips the gate.
  assert.equal(state.plansSvc!.riskStatus().active, false, 'applyAction alone cannot turn hands-free on');
  assert.equal(state.plansSvc!.riskStatus().gateOff, false);

  // Re-issuing G while the modal is up is still inert on the gate.
  applyAction(state, 'plans.gate', []);
  assert.equal(state.plansSvc!.riskStatus().active, false);
});

test('Tier 4: `plans.gate` is a no-op off the plans screen', () => {
  const state = makeFixtureState({ screen: 'screener' });
  applyAction(state, 'plans.gate', []);
  assert.equal(state.plansUi?.riskModal ?? false, false);
});

test('Tier 4: the risk modal renders without throwing in both gate states', () => {
  const state = plansState();
  const c = new Canvas(120, 40, THEMES.cyberspace);
  state.plansUi!.riskModal = true;
  assert.doesNotThrow(() => renderPlans(c, state)); // gate-on wording
  state.plansSvc!.acceptRisk({ gesture: 'keypress' });
  assert.doesNotThrow(() => renderPlans(c, state)); // hands-free wording (restore path)
});
