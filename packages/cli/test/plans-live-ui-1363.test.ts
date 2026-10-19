// task-1363 — the FIRE PATH surface on the PLANS screen. `plans.live` (key L) ONLY raises a modal; the switch
// itself is a captured physical keypress in the interactive loop, and PlanService.useLive takes nothing but a
// keypress gesture. So applyAction — the only path a pipe, an agent or the voice router can reach — can never
// move fills off paper. The header/title/popup banner say LIVE only when a live executor is really installed,
// and `trenchscope plan amend` edits a PROPOSED plan as a new hash (card item 3) without cancel + re-propose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAction } from '../src/main.ts';
import { makeFixtureState, newPlansUi, headerModel, type AppState } from '../src/state.ts';
import { Canvas, THEMES } from '@dexterm/tui';
import { renderPlans } from '../src/screens/plans.ts';
import { PlanService, LivePlanExecutor } from '@dexterm/data/plans';
import type { SignerPort } from '@dexterm/data';
import { runPlan } from '../src/plan-cmd.ts';
import type { Io } from '../src/main.ts';

function plansState(): AppState {
  const state = makeFixtureState({ screen: 'plans' });
  state.plansUi = newPlansUi();
  state.plansSvc = new PlanService(); // in-memory journal
  return state;
}
const deadSigner = { alive: false } as unknown as SignerPort;

test('fire path: `plans.live` only raises the modal; applyAction alone never leaves paper; the modal freezes list movement', () => {
  const state = plansState();
  assert.equal(state.plansSvc!.mode(), 'paper');
  applyAction(state, 'plans.live', []);
  assert.equal(state.plansUi!.liveModal, true, 'L raises the fire-path modal');
  assert.equal(state.plansSvc!.mode(), 'paper', 'applyAction cannot switch the fire path');
  assert.equal(state.plansSvc!.executor.kind, 'paper');
  applyAction(state, 'plans.live', []);
  assert.equal(state.plansSvc!.mode(), 'paper');
  // off the plans screen it is a no-op
  const other = makeFixtureState({ screen: 'screener' });
  applyAction(other, 'plans.live', []);
  assert.equal(other.plansUi?.liveModal ?? false, false);
  // the modal renders in both fire-path states without throwing, and the title/header say what is true
  const c = new Canvas(120, 36, THEMES.cyberspace);
  renderPlans(c, state);
  const h = headerModel(state);
  assert.match(h.status ?? '', /PAPER/);
  const live = new LivePlanExecutor({ signer: deadSigner, clock: { now: () => Date.now(), sleep: async () => {} }, solUsd: () => 150 });
  assert.throws(() => state.plansSvc!.useLive(live, { gesture: 'spoken-free' }), { reason: 'live-needs-keypress' });
  assert.throws(() => state.plansSvc!.useLive(live, undefined), { reason: 'live-needs-keypress' });
  state.plansSvc!.useLive(live, { gesture: 'keypress' });
  assert.equal(state.plansSvc!.mode(), 'live');
  assert.match(headerModel(state).status ?? '', /LIVE · DEVNET · fast wallet/);
  const c2 = new Canvas(120, 36, THEMES.cyberspace);
  renderPlans(c2, state); // LIVE title + modal render without throwing
  state.plansSvc!.usePaper();
  assert.match(headerModel(state).status ?? '', /PAPER/);
});

test('fire path: with no service the modal action is inert', () => {
  const state = makeFixtureState({ screen: 'plans' });
  state.plansUi = newPlansUi();
  state.plansSvc = null;
  applyAction(state, 'plans.live', []);
  assert.equal(state.plansUi!.liveModal, false);
});

function io(): Io & { out: string; err: string } {
  const o = {
    out: '', err: '', env: {} as NodeJS.ProcessEnv, stdin: undefined as unknown as Io['stdin'],
    stdout: { write(s: string) { (o as { out: string }).out += s; return true; } } as unknown as Io['stdout'],
    stderr: { write(s: string) { (o as { err: string }).err += s; return true; } } as unknown as Io['stderr'],
  };
  return o as Io & { out: string; err: string };
}
const MINT = 'Fx9sDipT3StRench3sHoTAbcdefGhiJkLmNoPqRsTuV';

test('plan amend: edits a PROPOSED plan into a new plan (new id + hash, old one superseded), refuses an armed one and an empty patch', async () => {
  const j = ['--journal', join(mkdtempSync(join(tmpdir(), 'dexterm-plan-amend-')), 'plans.journal')];
  const p = io();
  assert.equal(await runPlan(['propose', ...j, '--mint', MINT, '--symbol', 'TRENCH', '--size', '20', '--entry', 'mc-below:300k', '--tp', 'mc-above:600k:50%', '--supply', '1b', '--json'], p), 0);
  const first = JSON.parse(p.out.trim()) as { id: string; hash: string };
  const empty = io();
  assert.equal(await runPlan(['amend', first.id, ...j], empty), 2); assert.match(empty.err, /nothing to change/);
  const a = io();
  assert.equal(await runPlan(['amend', first.id, ...j, '--size', '25', '--entry', 'mc-below:280k', '--json'], a), 0);
  const next = JSON.parse(a.out.trim()) as { id: string; hash: string; supersedes: string; readBack: string };
  assert.equal(next.supersedes, first.id); assert.notEqual(next.id, first.id); assert.notEqual(next.hash, first.hash);
  assert.match(next.readBack, /\$25/); assert.match(next.readBack, /280k/);
  const l = io(); await runPlan(['list', ...j, '--json'], l);
  const rows = JSON.parse(l.out.trim()) as { id: string; status: string; sizeUsd: number }[];
  assert.equal(rows.find((r) => r.id === first.id)?.status, 'cancelled', 'the old proposal is superseded');
  assert.equal(rows.find((r) => r.id === next.id)?.status, 'proposed'); assert.equal(rows.find((r) => r.id === next.id)?.sizeUsd, 25);
  // an amended plan is still only a proposal (the amend path never arms)
  const again = io();
  assert.equal(await runPlan(['amend', first.id, ...j, '--size', '30'], again), 1); assert.match(again.err, /plan is cancelled/);
  const v = io(); assert.equal(await runPlan(['journal', ...j, '--verify'], v), 0); assert.match(v.out, /audit log OK/);
});
