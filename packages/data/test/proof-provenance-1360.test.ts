import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanService } from '../src/trade/plans/service.ts';
import { SimClock, MINT_A } from './copy-helpers.ts';
import type { GestureProof } from '../src/trade/plans/mandate.ts';
import type { PlanInput } from '../src/trade/plans/types.ts';

const input: PlanInput = { mint: MINT_A, symbol: 'TEST', decimals: 6, side: 'buy', sizeUsd: 5, entry: { kind: 'immediate' } };
const setup = () => new PlanService({ clock: new SimClock(), journalPath: null });
const fake = (subject: string, gesture = 'keypress'): GestureProof => ({ id: 'never-issued', kind: 'gesture', signerIssued: true, gesture, subject, consumed: false });

test('verifier repro: valid-shape fabricated keypress and copy-auto proofs cannot arm any proposal', () => {
  const s = setup(), m = s.draftMandate({ totalUsd: 100, perTradeUsd: 20 });
  s.armMandateByKeypress(m.id);
  for (const by of ['copy', 'voice', 'claude'] as const) {
    const p = s.propose(input, { supply: 1e6, by });
    for (const gesture of ['keypress', 'phantom', 'copy-auto']) {
      assert.throws(() => s.armPlan(p.id, fake(`plan:${p.id}:${p.hash}`, gesture), m.id), { reason: 'unissued-proof' });
    }
    assert.equal(s.summary(p.id).status, 'proposed');
  }
  assert.equal(s.ledger(m.id).reservedUsd, 0);
  assert.equal(s.journal.events.filter(e => e.type === 'confirm.accepted').length, 0);
});

test('issued proof identity, immutable contents, engine ownership and internal consumption are enforced', () => {
  const s = setup(), m = s.draftMandate({ totalUsd: 100, perTradeUsd: 20 }); s.armMandateByKeypress(m.id);
  const p = s.propose(input, { supply: 1e6 });
  const proof = s.confirm(s.challenge(p.id).id, { kind: 'keypress', holdMs: 500 });
  assert.throws(() => s.armPlan(p.id, { ...proof }, m.id), { reason: 'unissued-proof' });
  assert.throws(() => { proof.gesture = 'copy-auto'; }, TypeError);
  assert.throws(() => Object.defineProperty(proof, 'gesture', { get: () => 'copy-auto' }), TypeError);
  assert.throws(() => Object.defineProperty(proof, 'subject', { get: () => 'other-plan' }), TypeError);
  const other = setup(), om = other.draftMandate({ totalUsd: 100, perTradeUsd: 20 }); other.armMandateByKeypress(om.id);
  const op = other.propose(input, { supply: 1e6 });
  assert.throws(() => other.armPlan(op.id, proof, om.id), { reason: 'unissued-proof' });
  s.armPlan(p.id, proof, m.id);
  proof.consumed = false;
  const next = s.propose(input, { supply: 1e6 });
  assert.throws(() => s.armPlan(next.id, proof, m.id), { reason: 'proof-consumed' });
});

test('mandate and batch proofs reject clones and forgeries; legitimate batch still arms', () => {
  const s = setup(), m = s.draftMandate({ totalUsd: 100, perTradeUsd: 20 });
  const proof = s.engine.issueMandateProof(m.id, 'keypress');
  assert.throws(() => s.engine.armMandate(m.id, { ...proof }), { reason: 'unissued-proof' });
  s.engine.armMandate(m.id, proof);
  proof.consumed = false;
  assert.throws(() => s.engine.armMandate(m.id, proof), { reason: 'proof-consumed' });
  const b = s.engine.proposeBatch([input], { supply: 1e6, by: 'user' });
  assert.throws(() => s.engine.armBatch(b.id, fake(`batch:${b.id}:${b.hash}`), m.id), { reason: 'unissued-proof' });
  assert.equal(s.engine.armBatch(b.id, s.engine.issueBatchProof(b.id, 'keypress'), m.id).armed.length, 1);
});

test('copy authority needs fresh mandate confirmation; cannot adopt voice plans; gate, caps and revocation enforced inside engine', () => {
  const s = setup(), m = s.draftMandate({ totalUsd: 100, perTradeUsd: 20, maxTier: 'hands-free', actions: ['buy'] });
  const proof = s.engine.issueMandateProof(m.id, 'keypress');
  assert.throws(() => s.engine.authorizeCopy(m.id, proof, 'fixture'), { reason: 'gate-on' });
  s.acceptRisk({ gesture: 'keypress' });
  assert.throws(() => s.engine.authorizeCopy(m.id, { ...proof }, 'fixture'), { reason: 'unissued-proof' });
  const run = s.engine.authorizeCopy(m.id, proof, 'fixture');
  assert.throws(() => s.engine.authorizeCopy(m.id, proof, 'fixture'), { reason: 'proof-consumed' });
  const voice = s.propose(input, { supply: 1e6, by: 'voice' });
  assert.throws(() => s.armPlan(voice.id, fake(`plan:${voice.id}:${voice.hash}`, 'copy-auto'), m.id), { reason: 'unissued-proof' });
  assert.equal(s.summary(voice.id).status, 'proposed');
  assert.throws(() => run({ ...input, side: 'sell' }, 1e6, 'fixture'), { reason: 'action-not-allowed' });
  assert.throws(() => run({ ...input, sizeUsd: 6 }, 1e6, 'fixture').arm(), { reason: 'per-trade-cap' });
  const pending = run(input, 1e6, 'fixture');
  s.restoreGate();
  assert.throws(() => pending.arm(), { reason: 'gate-on' });
  s.acceptRisk({ gesture: 'keypress' });
  pending.arm();
  assert.equal(s.summary(pending.plan.id).tier, 'hands-free');
  assert.throws(() => pending.arm());
  s.revokeMandate(m.id);
  assert.throws(() => run(input, 1e6, 'fixture'), { reason: 'dead-mandate' });
});
