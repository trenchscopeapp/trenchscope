// task-1355 — PlanService + PaperPlanExecutor tests: typed-command parsing, the paper fire path, arming
// only by keypress, persistence/recovery across a restart, and the audit-log export. No network/keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlanService, parseAmount, parseTrigger, parseExit } from '../src/trade/plans/service.ts';
import { PaperPlanExecutor } from '../src/trade/plans/executor-paper.ts';
import { RISK_ACCEPT_TTL_MS } from '../src/trade/plans/confirm.ts';
import { SimClock, SUPPLY, NORTH_STAR_PLAN, DEFAULT_MANDATE, priceAtMc } from './plans-helpers.ts';

test('parsing: amounts (k/m/b), triggers, and exit fractions (0.5 or 50%)', () => {
  assert.equal(parseAmount('300k'), 300_000);
  assert.equal(parseAmount('1.2m'), 1_200_000);
  assert.equal(parseAmount('2b'), 2_000_000_000);
  assert.equal(parseAmount('$600000'), 600_000);
  assert.deepEqual(parseTrigger('mc-below:300k'), { kind: 'mc-below', value: 300_000 });
  assert.deepEqual(parseTrigger('immediate'), { kind: 'immediate' });
  assert.deepEqual(parseExit('mc-above:600k:50%'), { at: { kind: 'mc-above', value: 600_000 }, fraction: 0.5 });
  assert.deepEqual(parseExit('mc-above:1.2m:0.25'), { at: { kind: 'mc-above', value: 1_200_000 }, fraction: 0.25 });
  assert.throws(() => parseTrigger('nonsense'));
  assert.throws(() => parseExit('mc-above:600k'));
});

function mk(path: string | null = null) {
  const clock = new SimClock();
  const svc = new PlanService({ clock, journalPath: path });
  const m = svc.draftMandate(DEFAULT_MANDATE);
  svc.armMandateByKeypress(m.id);
  return { clock, svc, mandateId: m.id };
}

test('paper fire path: propose → keypress arm → dip entry → half exit → done, booked on the paper executor', () => {
  const { clock, svc, mandateId } = mk();
  const plan = svc.propose({ ...NORTH_STAR_PLAN }, { supply: SUPPLY, by: 'user' });
  svc.armPlanByKeypress(plan.id, mandateId);
  assert.equal(svc.summary(plan.id).status, 'armed');
  for (const mc of [320_000, 299_000, 295_000, 400_000, 605_000, 612_000]) { clock.advance(1000); svc.tick({ mint: plan.mint, priceUsd: priceAtMc(mc), supply: SUPPLY, ts: clock.now(), source: 'paper' }); }
  const sum = svc.summary(plan.id);
  assert.equal(sum.status, 'done');
  assert.ok(sum.position.tokenRaw > 0n, 'moon bag held');
  assert.ok(svc.ledger(mandateId).realizedUsd > 0);
  const rows = svc.listPlans();
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'done');
});

test('PaperPlanExecutor fills at the tick price with no scripting', () => {
  const clock = new SimClock();
  const ex = new PaperPlanExecutor({ clock, solUsd: 150 });
  const sig = ex.nextSignature();
  assert.match(sig, /^PAPER\d{6}$/);
  const q = ex.quote({ plan: { decimals: 6, mint: 'm', side: 'buy' } as never, legKey: 'entry', side: 'buy', usd: 20, tokenRaw: null, priceUsd: 0.0003 });
  assert.equal(q.simOk, true);
  const out = ex.submit({ plan: { decimals: 6 } as never, legKey: 'entry', quote: q, signature: sig, usd: 20, tokenRaw: null });
  assert.equal(out.kind, 'filled');
  assert.equal(ex.lookup(sig) !== 'not-found', true);
});

test('typed-command flow via parsing helpers builds a valid north-star plan', () => {
  const { svc, mandateId } = mk();
  const plan = svc.propose({
    mint: NORTH_STAR_PLAN.mint, symbol: 'TRENCH', decimals: 6, side: 'buy', sizeUsd: parseAmount('20'),
    entry: parseTrigger('mc-below:300k'), exits: [parseExit('mc-above:600k:50%')], stop: parseTrigger('mc-below:150k'),
  }, { supply: SUPPLY, by: 'user' });
  assert.equal(plan.moonBagFraction, 0.5);
  assert.match(svc.readBack(plan.id), /dips to \$300k/);
  svc.armPlanByKeypress(plan.id, mandateId);
  assert.equal(svc.summary(plan.id).status, 'armed');
});

test('persistence: a restart recovers armed plans, mandates and the reservation from the on-disk journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-1355-svc-'));
  const path = join(dir, 'plans.journal');
  const a = mk(path);
  const plan = a.svc.propose({ ...NORTH_STAR_PLAN }, { supply: SUPPLY, by: 'user' });
  a.svc.armPlanByKeypress(plan.id, a.mandateId);
  assert.equal(a.svc.ledger(a.mandateId).reservedUsd, 20);

  // "restart": a fresh service over the same journal file replays everything.
  const b = new PlanService({ clock: new SimClock(a.clock.now() + 10_000), journalPath: path });
  assert.equal(b.summary(plan.id).status, 'armed');
  assert.equal(b.ledger(a.mandateId).reservedUsd, 20);
  assert.equal(b.listMandates().find((m) => m.id === a.mandateId)?.status, 'armed');
  assert.equal(b.verifyJournal().ok, true);
  assert.ok(b.exportJournal().split('\n').length > 4, 'audit log exports as JSONL');
});

// ── Tier 4: the "less safe" hands-free opt-in surface (service methods over Settings) ──

test('Tier 4: the keypress gate is ON by default — riskStatus reports gate-on, not hands-free', () => {
  const { svc } = mk();
  const s = svc.riskStatus();
  assert.equal(s.gateOff, false);
  assert.equal(s.active, false);
  assert.equal(s.acceptedAt, null);
  assert.equal(s.expiresAt, null);
});

test('Tier 4: accepting the risk popup needs a keypress gesture — anything else is refused, nothing changes', () => {
  const { svc } = mk();
  for (const bad of [undefined, null, {}, { gesture: 'spoken' }, { gesture: 'agent' }, { gesture: 'phantom' }]) {
    assert.throws(() => svc.acceptRisk(bad as { gesture?: string } | null | undefined), /keypress/i);
  }
  assert.equal(svc.riskStatus().active, false, 'a refused accept never turns hands-free on');
});

test('Tier 4: a keypress accept turns hands-free on, auto-expires after 24h, and is journaled', () => {
  const clock = new SimClock();
  const svc = new PlanService({ clock });
  svc.acceptRisk({ gesture: 'keypress' });
  const s = svc.riskStatus();
  assert.equal(s.gateOff, true);
  assert.equal(s.active, true);
  assert.equal(s.expiresAt, s.acceptedAt! + RISK_ACCEPT_TTL_MS);
  assert.equal(s.expiresAt! - clock.now(), RISK_ACCEPT_TTL_MS);
  assert.ok(svc.exportJournal().includes('settings.gate-off'), 'the opt-in is written to the audit log');

  // still active one second before expiry; inert once the 24h window closes (gate is back on by default).
  clock.advance(RISK_ACCEPT_TTL_MS - 1000);
  assert.equal(svc.riskStatus().active, true);
  clock.advance(2000);
  assert.equal(svc.riskStatus().active, false, 'the opt-in auto-expires — it does not persist forever');
});

test('Tier 4: restoreGate puts the keypress gate back at once and is journaled', () => {
  const clock = new SimClock();
  const svc = new PlanService({ clock });
  svc.acceptRisk({ gesture: 'keypress' });
  assert.equal(svc.riskStatus().active, true);
  svc.restoreGate();
  const s = svc.riskStatus();
  assert.equal(s.gateOff, false);
  assert.equal(s.active, false);
  assert.ok(svc.exportJournal().includes('settings.gate-on'), 'restoring the gate is written to the audit log');
});
