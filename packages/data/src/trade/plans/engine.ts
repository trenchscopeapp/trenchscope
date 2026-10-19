// task-1355 — the PLAN ENGINE: local trigger engine + signer-side policy + state machine + ledger
// (SPEC §6.13.3/§6.13.5-§6.13.11). Ported from the task-1292 reference simulation
// (research/task-1292/sim/engine.mjs), typed. Behaviour is intended to be identical to the sim; the
// ported test suite (packages/data/test/plans-*.test.ts) is the equivalence check.
//
// Event-sourced: every mutation is `emit(type, fields)` -> journal.append -> reduce(event). The in-memory
// state is a pure function of the journal, so crash recovery is `PlanEngine.recover(journal)` followed by
// settling in-flight sends by signature lookup (never by re-sending). This file holds no keys and does no
// I/O except through the injected journal and executor.
//
// Plan states (card): proposed -> armed -> triggered -> filled -> exiting -> done | failed | cancelled.

import { createHash } from 'node:crypto';
import type { Clock } from '../../clock.ts';
import type { Journal } from './journal.ts';
import { proposePlan, amendPlan, readBack, planHash, PlanError } from './plan.ts';
import type { AmendPatch } from './plan.ts';
import { draftMandate, armMandate as armMandateObj, mandateAlive, capsHash, TIERS, HARD } from './mandate.ts';
import type { GestureProof, Mandate, MandateInput, TierName } from './mandate.ts';
import { gestureTier } from './confirm.ts';
import type { ConfirmGate } from './confirm.ts';
import { RpcOutage } from './executor.ts';
import type { Executor, Quote } from './executor.ts';
import type { OrderPlan, PlanInput, PlanStatus, ProposeCtx, Side } from './types.ts';

export const TERMINAL = new Set<PlanStatus>(['done', 'failed', 'cancelled']);
const LEG_MAX_ATTEMPTS = 3;
const SEND_UNKNOWN_SETTLE_MS = 90_000; // blockhash lifetime: after this an unfound signature is dead

export class PolicyRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PolicyRefusal';
    this.reason = reason;
  }
}

const big = (s: string | bigint): bigint => (typeof s === 'bigint' ? s : BigInt(s));
const str = (b: bigint | string | null): string | null => (typeof b === 'bigint' ? b.toString() : b);

type LegState = 'pending' | 'in-flight' | 'filled' | 'failed' | 'retry' | 'unknown';
interface JournaledFill { tokenDelta: string; solDelta: string; usd: number; priceUsd: number }
interface Leg {
  attempts: number;
  state: LegState;
  side?: Side;
  signature?: string | null;
  usd?: number | null;
  tokenRaw?: bigint | null;
  priceUsd?: number;
  feeLamports?: number;
  sentAt?: number;
  fill?: JournaledFill;
  reason?: string;
  unknownSince?: number;
}
interface Pos { tokenRaw: bigint; entryTokenRaw: bigint; costUsd: number; soldUsd: number; realizedUsd: number }
interface PausedInfo { reason: string; was: number; now: number; newTriggerPriceUsd: number | null }
interface PlanRecord {
  plan: OrderPlan;
  status: PlanStatus;
  mandateId: string | null;
  tier: TierName | null;
  reservedUsd: number;
  legs: Record<string, Leg>;
  pos: Pos;
  paused: PausedInfo | null;
  reason: string | null;
  exitIdx: number;
  ackSupply?: number;
}
interface Ledger { reservedUsd: number; spentUsd: number; realizedUsd: number; lossUsd: number; feeLamports: number; sendTs: number[] }
interface MandateRec { m: Mandate; ledger: Ledger }
interface Batch { id: string; planIds: string[]; hash: string; totalUsd: number }

export interface PriceTick { mint: string; priceUsd: number; supply: number; ts: number; source: string; crossPriceUsd?: number }

export type SafetyFn = (mint: string) => { ok: boolean; why?: string };

export interface EngineDeps {
  clock: Clock;
  journal: Journal;
  executor: Executor;
  gate: ConfirmGate;
  safety?: SafetyFn;
  priceMaxAgeMs?: number;
  debounceTicks?: number;
  confirmBandPct?: number;
  sourceDisagreePct?: number;
}

interface PolicyVerdict { ok: boolean; reason?: string; message?: string; transient?: boolean }

export interface LedgerView { reservedUsd: number; spentUsd: number; realizedUsd: number; lossUsd: number; feeLamports: number; sendTs: undefined; mandateStatus: string }
export interface BatchArmResult { armed: string[]; refused: { id: string; reason: string }[] }

export class PlanEngine {
  private clock: Clock;
  private journal: Journal;
  private ex: Executor;
  private gate: ConfirmGate;
  private safety: SafetyFn;
  private cfg: { priceMaxAgeMs: number; debounceTicks: number; confirmBandPct: number; sourceDisagreePct: number };
  mandates = new Map<string, MandateRec>();
  recs = new Map<string, PlanRecord>();
  private ticks = new Map<string, [PriceTick | null, PriceTick]>();
  private batches = new Map<string, Batch>();
  private panicked: { at: number; reason: string } | null = null;
  private proofs = new Map<string, GestureProof>();
  #issued = new WeakMap<GestureProof, string>();
  #consumed = new WeakSet<GestureProof>();

  #remember(proof: GestureProof): GestureProof {
    // A caller must not install accessors that change the gesture/subject between validation and use.
    for (const key of Object.keys(proof)) Object.defineProperty(proof, key, {
      writable: key === 'consumed', configurable: false,
    });
    Object.preventExtensions(proof);
    this.#issued.set(proof, JSON.stringify({ ...proof, consumed: false }));
    return proof;
  }
  #validateProof(proof: GestureProof): void {
    if (this.#consumed.has(proof) || proof.consumed) throw new PolicyRefusal('proof-consumed', 'proof already used');
    if (this.#issued.get(proof) !== JSON.stringify({ ...proof, consumed: false }))
      throw new PolicyRefusal('unissued-proof', 'proof was not issued unchanged by this engine');
  }
  #consume(proof: GestureProof): void { this.#consumed.add(proof); proof.consumed = true; }

  constructor({ clock, journal, executor, gate, safety = () => ({ ok: true }), priceMaxAgeMs = 3_000, debounceTicks = 2, confirmBandPct = 2, sourceDisagreePct = 5 }: EngineDeps) {
    this.clock = clock; this.journal = journal; this.ex = executor; this.gate = gate; this.safety = safety;
    this.cfg = { priceMaxAgeMs, debounceTicks, confirmBandPct, sourceDisagreePct };
  }

  /** task-1363: the fire path (paper ⇄ live). Gated by PlanService.useLive/usePaper (keypress, no open plans). */
  replaceExecutor(ex: Executor): void { this.ex = ex; }
  get executor(): Executor { return this.ex; }
  /** Plans that are armed, triggered, filled or exiting (anything a fire-path switch would strand). */
  openPlans(): string[] { return [...this.recs.values()].filter((r) => !TERMINAL.has(r.status) && r.status !== 'proposed').map((r) => r.plan.id); }

  // ───────────────────────── event sourcing ─────────────────────────
  emit(type: string, fields: { planId?: string | null; mandateId?: string | null; data?: Record<string, unknown> | null } = {}) {
    const e = this.journal.append(type, fields);
    this.reduce(e);
    return e;
  }

  reduce(e: { type: string; ts: number; planId: string | null; mandateId: string | null; data: Record<string, unknown> | null }): void {
    const d: Record<string, any> = e.data ?? {};
    switch (e.type) {
      case 'mandate.draft': {
        const m = structuredClone(d.mandate) as Mandate;
        Object.freeze((m as any).budget); Object.freeze((m as any).limits); Object.freeze((m as any).fees); Object.freeze((m as any).allowed);
        this.mandates.set(m.id, { m, ledger: { reservedUsd: 0, spentUsd: 0, realizedUsd: 0, lossUsd: 0, feeLamports: 0, sendTs: [] } });
        break;
      }
      case 'mandate.armed': { const x = this.mandates.get(e.mandateId!)!; x.m.status = 'armed'; x.m.armedAt = d.armedAt; x.m.armedBy = d.armedBy; break; }
      case 'mandate.revoked': { const x = this.mandates.get(e.mandateId!)!; x.m.status = d.status ?? 'revoked'; x.m.revokedAt = e.ts; x.m.revokedReason = d.reason; break; }
      case 'plan.proposed': {
        const plan = Object.freeze(structuredClone(d.plan) as OrderPlan);
        this.recs.set(plan.id, { plan, status: 'proposed', mandateId: null, tier: null, reservedUsd: 0, legs: {}, pos: { tokenRaw: 0n, entryTokenRaw: 0n, costUsd: 0, soldUsd: 0, realizedUsd: 0 }, paused: null, reason: null, exitIdx: 0 });
        break;
      }
      case 'plan.armed': { const r = this.recs.get(e.planId!)!; r.status = 'armed'; r.mandateId = e.mandateId; r.tier = d.tier; r.reservedUsd = d.reservedUsd; this.mandates.get(e.mandateId!)!.ledger.reservedUsd += d.reservedUsd; break; }
      case 'plan.status': {
        const r = this.recs.get(e.planId!)!; r.status = d.status; if (d.reason) r.reason = d.reason;
        if (d.release && r.reservedUsd) { this.mandates.get(r.mandateId!)!.ledger.reservedUsd -= r.reservedUsd; r.reservedUsd = 0; }
        break;
      }
      case 'plan.paused': { this.recs.get(e.planId!)!.paused = d as unknown as PausedInfo; break; }
      case 'plan.resumed': { const r = this.recs.get(e.planId!)!; r.paused = null; if (typeof d.supply === 'number') r.ackSupply = d.supply; break; }
      case 'leg.sent': {
        const r = this.recs.get(e.planId!)!;
        r.legs[d.legKey] = { ...(r.legs[d.legKey] ?? { attempts: 0, state: 'pending' as LegState }), state: 'in-flight', side: d.side, signature: d.signature, usd: d.usd, tokenRaw: d.tokenRaw == null ? null : big(d.tokenRaw), priceUsd: d.priceUsd, feeLamports: d.feeLamports, sentAt: e.ts, attempts: (r.legs[d.legKey]?.attempts ?? 0) + 1 };
        const L = this.mandates.get(r.mandateId!)!.ledger; L.feeLamports += d.feeLamports; L.sendTs.push(e.ts);
        break;
      }
      case 'leg.filled': {
        const r = this.recs.get(e.planId!)!; const leg = r.legs[d.legKey]!; leg.state = 'filled'; leg.fill = d.fill;
        const L = this.mandates.get(r.mandateId!)!.ledger; const tok = big(d.fill.tokenDelta);
        if (d.side === 'buy') { r.pos.tokenRaw += tok; r.pos.entryTokenRaw += tok; r.pos.costUsd += d.fill.usd; L.spentUsd += d.fill.usd; L.reservedUsd -= Math.min(r.reservedUsd, d.fill.usd); r.reservedUsd = Math.max(0, r.reservedUsd - d.fill.usd); }
        else { const sold = -tok; const costShare = r.pos.entryTokenRaw > 0n ? r.pos.costUsd * Number(sold) / Number(r.pos.entryTokenRaw) : 0; r.pos.tokenRaw -= sold; r.pos.soldUsd += d.fill.usd; const pnl = d.fill.usd - costShare; r.pos.realizedUsd += pnl; L.realizedUsd += pnl; if (pnl < 0) L.lossUsd += -pnl; }
        break;
      }
      case 'leg.failed': { const r = this.recs.get(e.planId!)!; const leg = r.legs[d.legKey] ?? (r.legs[d.legKey] = { attempts: 0, state: 'pending' }); leg.state = d.final ? 'failed' : 'retry'; leg.reason = d.reason; if (d.refundFeeLamports) this.mandates.get(r.mandateId!)!.ledger.feeLamports -= d.refundFeeLamports; break; }
      case 'leg.unknown': { const r = this.recs.get(e.planId!)!; r.legs[d.legKey]!.state = 'unknown'; r.legs[d.legKey]!.unknownSince = e.ts; break; }
      case 'panic': { this.panicked = { at: e.ts, reason: d.reason }; break; }
      default: break; // audit-only events: confirm.*, settings.*, price.*, policy.refused, trigger.fired, batch.*
    }
  }

  // ───────────────────────── mandates ─────────────────────────
  draftMandate(input: MandateInput): Mandate {
    const m = draftMandate(input, { clock: this.clock });
    this.emit('mandate.draft', { mandateId: m.id, data: { mandate: m, capsHash: capsHash(m) } });
    return this.mandates.get(m.id)!.m;
  }

  /** The signer side observed a physical gesture on the mandate card (TTY key read by the signer process / Phantom approval). */
  issueMandateProof(mandateId: string, gesture: string): GestureProof {
    const x = this.mandates.get(mandateId); if (!x) throw new PolicyRefusal('unknown-mandate', 'no such mandate');
    const p: GestureProof = { id: `mproof_${this.proofs.size + 1}`, kind: 'gesture', signerIssued: true, gesture, subject: `mandate:${mandateId}:${capsHash(x.m)}`, at: this.clock.now(), consumed: false };
    this.proofs.set(p.id, p); return this.#remember(p);
  }

  armMandate(mandateId: string, proof: GestureProof): Mandate {
    const x = this.mandates.get(mandateId); if (!x) throw new PolicyRefusal('unknown-mandate', 'no such mandate');
    if (this.panicked) throw new PolicyRefusal('panicked', 'panic engaged; resume needs the TTY path');
    this.#validateProof(proof);
    armMandateObj(x.m, proof, { clock: this.clock }); // throws MandateError on a voice proof etc.
    this.#consume(proof);
    this.emit('mandate.armed', { mandateId, data: { armedAt: x.m.armedAt, armedBy: x.m.armedBy, capsHash: capsHash(x.m) } });
    return x.m;
  }

  revokeMandate(mandateId: string, reason: string, status: 'revoked' | 'expired' = 'revoked'): void {
    const x = this.mandates.get(mandateId); if (!x || x.m.status !== 'armed') return;
    this.emit('mandate.revoked', { mandateId, data: { reason, status } });
    for (const r of this.recs.values()) if (r.mandateId === mandateId && !TERMINAL.has(r.status)) this.cancelPlan(r.plan.id, `mandate ${status}: ${reason}`);
  }

  // ───────────────────────── plans ─────────────────────────
  propose(input: PlanInput, ctx: Omit<ProposeCtx, 'clock'>): OrderPlan {
    const plan = proposePlan(input, { ...ctx, clock: this.clock });
    this.emit('plan.proposed', { planId: plan.id, data: { plan, by: plan.source.by, ref: plan.source.ref } });
    return this.recs.get(plan.id)!.plan;
  }

  /** A mutated plan is a NEW plan: new id and hash; the old proposal is superseded (any challenge for it is void). */
  amend(planId: string, patch: AmendPatch, ctx: { by?: OrderPlan['source']['by']; ref?: string | null } = {}): OrderPlan {
    const r = this.rec(planId); if (r.status !== 'proposed') throw new PolicyRefusal('plan-not-proposed', `plan is ${r.status}; cancel it and propose again`);
    const next = amendPlan(r.plan, patch, { clock: this.clock, ...ctx });
    this.emit('plan.status', { planId, data: { status: 'cancelled', reason: `superseded by ${next.id}` } });
    this.emit('plan.proposed', { planId: next.id, data: { plan: next, by: next.source.by, ref: next.source.ref, supersedes: planId } });
    return this.recs.get(next.id)!.plan;
  }

  rec(planId: string): PlanRecord { const r = this.recs.get(planId); if (!r) throw new PolicyRefusal('unknown-plan', 'no such plan'); return r; }
  plan(planId: string): OrderPlan | null { return this.recs.get(planId)?.plan ?? null; }
  status(planId: string): PlanStatus | null { return this.recs.get(planId)?.status ?? null; }

  challenge(planId: string, tier: TierName) { const r = this.rec(planId); return this.gate.issue(r.plan, tier, readBack(r.plan)); }
  /** The gate sees the plan AS THE ENGINE HOLDS IT NOW (current hash + current status), never the proposer's copy. */
  confirm(challengeId: string, evidence: Parameters<ConfirmGate['confirm']>[0]['evidence']): GestureProof {
    const c = this.gate.challenges.get(challengeId);
    const r = c ? this.recs.get(c.planId) : null;
    return this.#remember(this.gate.confirm({ challengeId, evidence }, r ? { id: r.plan.id, hash: r.plan.hash, status: r.status } : null));
  }

  /** Trusted host only, at the physical copy opt-in. The returned capability stays inside CopyAuto.
   * It creates NEW copy buys, never adopts an existing proposal or exposes an automation proof.
   * A fresh mandate proof is consumed here; an already-armed mandate id grants no authority.
   */
  authorizeCopy(mandateId: string, proof: GestureProof, wallet: string) {
    if (!this.gate.handsFreeAllowed()) throw new PolicyRefusal('gate-on', 'copy automation needs the less-safe opt-in');
    this.armMandate(mandateId, proof);
    return (input: PlanInput, supply: number, ref: string) => {
      const check = () => {
        if (!this.gate.handsFreeAllowed()) throw new PolicyRefusal('gate-on', 'copy automation opt-in is inactive');
        if (this.panicked) throw new PolicyRefusal('panicked', 'panic engaged');
        const m = this.mandates.get(mandateId)?.m;
        if (!m || !mandateAlive(m, this.clock.now()).ok) throw new PolicyRefusal('dead-mandate', 'copy mandate is not alive');
      };
      check();
      if (input.side !== 'buy') throw new PolicyRefusal('action-not-allowed', 'copy automation is buy-only');
      const plan = this.propose(input, { supply, by: 'copy', ref: `copy-auto:${wallet}:${ref}` });
      const issued = this.#remember({ id: `copy_${plan.id}`, kind: 'gesture', signerIssued: true,
        gesture: 'copy-auto', subject: `plan:${plan.id}:${plan.hash}`, at: this.clock.now(), consumed: false });
      return { plan, arm: () => { check(); return this.armPlan(plan.id, issued, mandateId); } };
    };
  }

  /** Arm a plan INTO a mandate with a proof. The signer-side admission check runs here; a refusal is journaled. */
  armPlan(planId: string, proof: GestureProof | null | undefined, mandateId: string): PlanRecord {
    const r = this.rec(planId);
    const refuse = (reason: string, message: string): never => { this.emit('policy.refused', { planId, mandateId, data: { stage: 'arm', reason, message } }); throw new PolicyRefusal(reason, message); };
    if (this.panicked) refuse('panicked', 'panic engaged');
    if (r.status !== 'proposed') refuse('plan-not-proposed', `plan is ${r.status}`);
    if (!proof || proof.kind !== 'gesture' || !proof.signerIssued) refuse('no-gesture', 'arming needs a signer-issued gesture proof');
    if (proof!.consumed) refuse('proof-consumed', 'proof already used');
    try { this.#validateProof(proof!); } catch (e) { refuse((e as PolicyRefusal).reason, (e as Error).message); }
    if (proof!.subject !== `plan:${planId}:${r.plan.hash}`) refuse('plan-hash-mismatch', 'the proof is bound to a different plan hash');
    const tier = gestureTier(proof!.gesture);
    const x = this.mandates.get(mandateId); if (!x) refuse('unknown-mandate', 'no such mandate');
    const alive = mandateAlive(x!.m, this.clock.now()); if (!alive.ok) refuse(alive.reason, 'mandate is not alive');
    if (TIERS[tier].rank > TIERS[x!.m.maxTier].rank) refuse('tier-not-allowed', `this mandate accepts up to ${x!.m.maxTier}; ${tier} is weaker`);
    const v = this.admit(r, x!, tier); if (!v.ok) refuse(v.reason!, v.message!);
    this.#consume(proof!);
    this.emit('plan.armed', { planId, mandateId, data: { tier, reservedUsd: r.plan.sizeUsd, proofId: proof!.id, planHash: r.plan.hash } });
    return this.recs.get(planId)!;
  }

  /** Arming-time admission (budget is RESERVED here so the total cap is a guarantee, not a race). */
  private admit(r: PlanRecord, x: MandateRec, tier: TierName): PolicyVerdict {
    const p = r.plan, m = x.m, L = x.ledger, now = this.clock.now();
    const no = (reason: string, message: string): PolicyVerdict => ({ ok: false, reason, message });
    if (now > p.expiresAt) return no('plan-expired', 'the plan expired before arming');
    if (!m.allowed.actions.includes(p.side)) return no('action-not-allowed', `${p.side} is not in the mandate`);
    const safe = this.safety(p.mint); if (!safe.ok) return no('mint-not-allowed', `mint fails the safety filter: ${safe.why}`);
    if (m.allowed.mints && !m.allowed.mints.includes(p.mint)) return no('mint-not-allowed', 'mint not in the mandate allow-list');
    if (p.slippageBps > m.limits.maxSlippageBps) return no('slippage', `slippage ${p.slippageBps} > mandate max ${m.limits.maxSlippageBps}`);
    const armed = [...this.recs.values()].filter((q) => q.mandateId === m.id && !TERMINAL.has(q.status) && q.status !== 'proposed');
    if (armed.length >= m.limits.maxArmedPlans) return no('concurrent-cap', `mandate already has ${armed.length} armed plans`);
    if (p.side === 'buy') {
      const perTrade = m.budget.perTradeUsd * TIERS[tier].perTradeMultiplier;
      if (p.sizeUsd > perTrade + 1e-9) return no('per-trade-cap', `$${p.sizeUsd} exceeds the ${tier} per-trade cap $${perTrade.toFixed(2)}`);
      const coin = armed.filter((q) => q.plan.mint === p.mint).reduce((s, q) => s + q.reservedUsd + q.pos.costUsd, 0);
      if (coin + p.sizeUsd > m.budget.perCoinUsd + 1e-9) return no('per-coin-cap', `$${(coin + p.sizeUsd).toFixed(2)} on this coin exceeds $${m.budget.perCoinUsd}`);
      if (L.reservedUsd + L.spentUsd + p.sizeUsd > m.budget.totalUsd + 1e-9) return no('total-cap', `budget: reserved $${L.reservedUsd.toFixed(2)} + spent $${L.spentUsd.toFixed(2)} + $${p.sizeUsd} > $${m.budget.totalUsd}`);
    }
    return { ok: true };
  }

  /** A batch = many plans proposed together; ONE keypress arms them all (per-plan admission still runs). */
  proposeBatch(inputs: PlanInput[], ctx: Omit<ProposeCtx, 'clock'> & { idPrefix?: string }): Batch {
    const batchId = ctx.batchId ?? `batch_${this.batches.size + 1}`;
    const plans = inputs.map((inp, i) => this.propose(inp, { ...ctx, batchId, id: ctx.idPrefix ? `${ctx.idPrefix}${i}` : undefined }));
    const batchHash = createHash('sha256').update(plans.map((p) => p.hash).join('|')).digest('hex');
    const b: Batch = { id: batchId, planIds: plans.map((p) => p.id), hash: batchHash, totalUsd: plans.reduce((s, p) => s + p.sizeUsd, 0) };
    this.batches.set(batchId, b);
    this.emit('batch.proposed', { data: { batchId, count: plans.length, totalUsd: b.totalUsd, batchHash } });
    return b;
  }
  issueBatchProof(batchId: string, gesture: string): GestureProof {
    const b = this.batches.get(batchId); if (!b) throw new PolicyRefusal('unknown-batch', 'no such batch');
    const p: GestureProof = { id: `bproof_${this.proofs.size + 1}`, kind: 'gesture', signerIssued: true, gesture, subject: `batch:${batchId}:${b.hash}`, at: this.clock.now(), consumed: false };
    this.proofs.set(p.id, p); return this.#remember(p);
  }
  armBatch(batchId: string, proof: GestureProof | null | undefined, mandateId: string): BatchArmResult {
    const b = this.batches.get(batchId); if (!b) throw new PolicyRefusal('unknown-batch', 'no such batch');
    const tier = gestureTier(proof?.gesture ?? '');
    if (!proof || proof.consumed || proof.subject !== `batch:${batchId}:${b.hash}`) throw new PolicyRefusal('proof-mismatch', 'proof is not for this batch');
    this.#validateProof(proof);
    if (!TIERS[tier].canArmBatch) throw new PolicyRefusal('tier-not-allowed', 'a batch can only be armed by keypress or Phantom approval');
    this.#consume(proof);
    const out: BatchArmResult = { armed: [], refused: [] };
    for (const id of b.planIds) {
      const r = this.recs.get(id)!;
      const per: GestureProof = { id: `bproof_${batchId}_${id}`, kind: 'gesture', signerIssued: true, gesture: proof.gesture, subject: `plan:${id}:${r.plan.hash}`, consumed: false };
      this.#remember(per);
      try { this.armPlan(id, per, mandateId); out.armed.push(id); } catch (e) { out.refused.push({ id, reason: (e as PolicyRefusal).reason }); }
    }
    this.emit('batch.armed', { data: { batchId, armed: out.armed.length, refused: out.refused } });
    return out;
  }

  cancelPlan(planId: string, reason: string): PlanStatus {
    const r = this.rec(planId); if (TERMINAL.has(r.status)) return r.status;
    const holding = r.pos.tokenRaw > 0n;
    this.emit('plan.status', { planId, data: { status: 'cancelled', reason, release: true, positionHeld: holding ? str(r.pos.tokenRaw) : null } });
    return 'cancelled';
  }

  /** PANIC: one-way. Revokes every mandate, cancels every non-terminal plan, refuses every send. Positions are NOT sold. */
  panic(reason = 'panic key'): void {
    this.emit('panic', { data: { reason } });
    for (const x of this.mandates.values()) if (x.m.status === 'armed') this.revokeMandate(x.m.id, reason, 'revoked');
    for (const r of this.recs.values()) if (!TERMINAL.has(r.status)) this.cancelPlan(r.plan.id, reason);
  }

  resumePlan(planId: string, proof: { gesture?: string } | null | undefined): void {
    const r = this.rec(planId); if (!r.paused) return;
    if (proof?.gesture !== 'keypress' && proof?.gesture !== 'phantom') throw new PolicyRefusal('no-gesture', 'resuming a paused plan needs a keypress');
    // the keypress acknowledges the NEW supply (the mc trigger now means a different price; the card showed it)
    this.emit('plan.resumed', { planId, data: { by: proof.gesture, supply: r.paused.now } });
  }

  // ───────────────────────── ticks & triggers ─────────────────────────
  /** A price tick for one mint: {mint, priceUsd, supply, ts, source, crossPriceUsd?}. Drives everything. */
  tick(t: PriceTick): void {
    const now = this.clock.now();
    const prev = this.ticks.get(t.mint)?.[1] ?? null;
    this.ticks.set(t.mint, [prev, t]);
    this.sweep(now);
    for (const r of this.recs.values()) {
      if (r.plan.mint !== t.mint || TERMINAL.has(r.status) || r.status === 'proposed') continue;
      this.settleUnknown(r, now);
      if (this.hasInFlight(r)) continue;
      const fresh = this.freshness(t, prev, now);
      if (!fresh.ok) { this.emit('price.unusable', { planId: r.plan.id, data: { reason: fresh.reason, ageMs: now - t.ts, source: t.source } }); continue; }
      if (r.paused) continue;
      const knownSupply = r.ackSupply ?? r.plan.supplyAtProposal;
      if (Math.abs(t.supply - knownSupply) / knownSupply > 0.01) { this.emit('plan.paused', { planId: r.plan.id, data: { reason: 'supply-changed', was: knownSupply, now: t.supply, newTriggerPriceUsd: r.plan.entry.kind !== 'immediate' ? r.plan.entry.value / t.supply : null } }); continue; }
      const mc = (tk: PriceTick) => tk.priceUsd * tk.supply;
      if (r.status === 'armed' || r.status === 'triggered') { // triggered = an entry chunk is waiting to retry
        if (this.cond(r.plan.entry, t, prev, mc)) this.fire(r, 'entry', 'buy', t);
      } else if (r.status === 'filled') {
        if (r.plan.stop && this.cond(r.plan.stop, t, prev, mc)) { this.fire(r, 'stop', 'sell', t); continue; }
        const leg = r.plan.exits[r.exitIdx];
        if (leg && this.cond(leg.at, t, prev, mc)) this.fire(r, `exit#${r.exitIdx}`, 'sell', t);
      }
    }
  }

  private freshness(t: PriceTick, prev: PriceTick | null, now: number): { ok: true } | { ok: false; reason: string } {
    if (now - t.ts > this.cfg.priceMaxAgeMs) return { ok: false, reason: 'stale' };
    if (typeof t.crossPriceUsd === 'number' && Math.abs(t.crossPriceUsd - t.priceUsd) / t.priceUsd * 100 > this.cfg.sourceDisagreePct) return { ok: false, reason: 'sources-disagree' };
    if (this.cfg.debounceTicks > 1 && (!prev || now - prev.ts > this.cfg.priceMaxAgeMs * 2)) return { ok: false, reason: 'need-consecutive-tick' };
    return { ok: true };
  }

  private cond(trig: OrderPlan['entry'], t: PriceTick, prev: PriceTick | null, mc: (tk: PriceTick) => number): boolean {
    const test = (tk: PriceTick): boolean => {
      switch (trig.kind) {
        case 'immediate': return true;
        case 'mc-below': return mc(tk) <= trig.value;
        case 'mc-above': return mc(tk) >= trig.value;
        case 'price-below': return tk.priceUsd <= trig.value;
        case 'price-above': return tk.priceUsd >= trig.value;
        default: return false;
      }
    };
    if (trig.kind === 'immediate') return true;
    return test(t) && (this.cfg.debounceTicks < 2 || (prev !== null && test(prev)));
  }

  private hasInFlight(r: PlanRecord): boolean { return Object.values(r.legs).some((l) => l.state === 'in-flight' || l.state === 'unknown'); }

  private sweep(now: number): void {
    for (const x of this.mandates.values()) if (x.m.status === 'armed' && now > x.m.expiresAt) this.revokeMandate(x.m.id, 'ttl', 'expired');
    for (const r of this.recs.values()) {
      if (TERMINAL.has(r.status) || now <= r.plan.expiresAt) continue;
      if (r.status === 'proposed' || r.status === 'armed') this.emit('plan.status', { planId: r.plan.id, data: { status: 'cancelled', reason: 'expired', release: true } });
      else if (r.status === 'filled') this.emit('plan.status', { planId: r.plan.id, data: { status: 'done', reason: 'expired-holding', release: true } });
    }
  }

  /** Fire one leg: quote -> re-confirm the trigger against the quote -> signer policy -> journal signature -> send -> settle. */
  private fire(r: PlanRecord, legKey: string, side: Side, t: PriceTick): void {
    const p = r.plan, now = this.clock.now();
    // a chunked entry is N independent legs (entry#i), each with its own signature, attempts and outcome
    const chunks = side === 'buy' && p.chunkUsd ? Math.ceil(p.sizeUsd / p.chunkUsd) : 1;
    if (chunks > 1 && legKey === 'entry') {
      for (let i = 0; i < chunks; i++) r.legs[`entry#${i}`] ??= { attempts: 0, state: 'pending' }; // all chunks exist before any settles
      for (let i = 0; i < chunks; i++) this.fire(r, `entry#${i}`, 'buy', t);
      return;
    }
    const leg = r.legs[legKey] ?? (r.legs[legKey] = { attempts: 0, state: 'pending' });
    if (leg.state === 'filled' || leg.state === 'failed') return;
    if (leg.attempts >= LEG_MAX_ATTEMPTS) { this.legFinalFail(r, legKey, side, 'max-attempts'); return; }
    // sizes
    let usd: number | null = null, tokenRaw: bigint | null = null;
    if (side === 'buy') {
      const idx = /^entry#(\d+)$/.exec(legKey)?.[1];
      usd = idx == null ? p.sizeUsd : Math.min(p.chunkUsd!, p.sizeUsd - Number(idx) * p.chunkUsd!);
    } else {
      const remaining = r.pos.tokenRaw;
      if (legKey === 'stop') tokenRaw = remaining;
      else {
        const frac = p.exits[r.exitIdx].fraction;
        let want = BigInt(Math.round(Number(r.pos.entryTokenRaw) * frac));
        if (want > remaining) want = remaining;
        if (remaining - want < r.pos.entryTokenRaw / 100n) want = remaining;
        tokenRaw = want;
      }
      if (tokenRaw <= 0n) { this.legFinalFail(r, legKey, side, 'nothing-to-sell'); return; }
    }
    this.emit('trigger.fired', { planId: p.id, mandateId: r.mandateId, data: { legKey, side, priceUsd: t.priceUsd, mcUsd: t.priceUsd * t.supply, source: t.source, ageMs: now - t.ts } });
    let q: Quote;
    try { q = this.ex.quote({ plan: p, legKey, side, usd, tokenRaw, priceUsd: t.priceUsd }); }
    catch (e) { if (e instanceof RpcOutage) { this.emit('price.unusable', { planId: p.id, data: { reason: 'rpc-outage', stage: 'quote' } }); return; } throw e; }
    const v = this.policy(r, this.mandates.get(r.mandateId!)!, legKey, side, q, usd, tokenRaw, t);
    if (!v.ok) {
      this.emit('policy.refused', { planId: p.id, mandateId: r.mandateId, data: { stage: 'fire', legKey, reason: v.reason, message: v.message } });
      if (v.transient) return; // queued: re-evaluated on the next tick, no attempt consumed
      leg.attempts += 1; if (leg.attempts >= LEG_MAX_ATTEMPTS) this.legFinalFail(r, legKey, side, v.reason!);
      return;
    }
    if (legKey.startsWith('entry') && r.status === 'armed') this.emit('plan.status', { planId: p.id, data: { status: 'triggered' } });
    if (side === 'sell') this.emit('plan.status', { planId: p.id, data: { status: 'exiting', legKey } });
    const signature = this.ex.nextSignature();
    // CL-03: the signature is journaled BEFORE the send so a crash here is recoverable by lookup, never by resend.
    this.emit('leg.sent', { planId: p.id, mandateId: r.mandateId, data: { legKey, side, signature, usd, tokenRaw: str(tokenRaw), priceUsd: q.priceUsd, feeLamports: q.feeLamports + q.tipLamports, impactPct: q.impactPct } });
    let out;
    try { out = this.ex.submit({ plan: p, legKey, quote: q, signature, usd, tokenRaw }); }
    catch (e) { if (e instanceof RpcOutage) { this.emit('leg.unknown', { planId: p.id, data: { legKey, signature, why: 'rpc-outage after send' } }); return; } throw e; }
    this.settle(r, legKey, side, signature, out);
  }

  /** The signer-side policy at fire time. `transient` refusals are queue-and-retry (rate/in-flight caps), not attempts. */
  private policy(r: PlanRecord, x: MandateRec, legKey: string, side: Side, q: Quote, usd: number | null, _tokenRaw: bigint | null, t: PriceTick): PolicyVerdict {
    const p = r.plan, m = x.m, L = x.ledger, now = this.clock.now();
    const no = (reason: string, message: string, transient = false): PolicyVerdict => ({ ok: false, reason, message, transient });
    if (this.panicked) return no('panicked', 'panic engaged');
    const alive = mandateAlive(m, now); if (!alive.ok) return no(alive.reason, 'mandate not alive');
    if (now > p.expiresAt) return no('plan-expired', 'plan expired');
    if (!m.allowed.actions.includes(side)) return no('action-not-allowed', `${side} not allowed`);
    // task-1363: a live executor carries the SIGNER's own refusal reason (caps, policy, no fast wallet…) so the
    // journal says why; a plain failed simulation stays 'simulation-failed'.
    if (!q.simOk) return no(q.refusal?.reason ?? 'simulation-failed', q.refusal?.message ?? q.simError ?? 'simulation failed');
    const impactCap = legKey === 'stop' ? (m.limits.stopMaxPriceImpactPct ?? 10) : Math.min(p.maxPriceImpactPct, m.limits.maxPriceImpactPct);
    if (q.impactPct > impactCap) return no('price-impact', `impact ${q.impactPct}% > ${impactCap}%`);
    if (p.slippageBps > m.limits.maxSlippageBps) return no('slippage', 'slippage above mandate max');
    // the quote must still satisfy the trigger (the tick is a hint; the route's implied price is the truth)
    const band = this.cfg.confirmBandPct / 100, impliedMc = q.priceUsd * t.supply;
    const trig = legKey.startsWith('entry') ? p.entry : legKey === 'stop' ? p.stop! : p.exits[r.exitIdx].at;
    const val = trig.kind.startsWith('mc') ? impliedMc : q.priceUsd;
    const trigValue = trig.kind === 'immediate' ? 0 : trig.value;
    if ((trig.kind.endsWith('below') && val > trigValue * (1 + band)) || (trig.kind.endsWith('above') && val < trigValue * (1 - band))) return no('trigger-not-confirmed', `quote-implied ${trig.kind} ${val.toFixed(0)} is outside the ${this.cfg.confirmBandPct}% band of ${trigValue}`, true);
    if (side === 'buy') {
      const perTrade = m.budget.perTradeUsd * TIERS[r.tier!].perTradeMultiplier;
      if (usd! > perTrade + 1e-9) return no('per-trade-cap', `$${usd} > $${perTrade}`);
      if (usd! > r.reservedUsd + 1e-9) return no('total-cap', 'more than the reserved budget');
      const open = [...this.recs.values()].filter((z) => z.mandateId === m.id && (z.status === 'filled' || z.status === 'exiting')).length;
      if (open >= m.limits.maxOpenPositions && r.status === 'armed') return no('open-positions-cap', `${open} open positions`, true);
    }
    const fee = q.feeLamports + q.tipLamports;
    if (q.tipLamports > m.fees.maxTipLamportsPerTx) return no('tip-cap', 'tip above per-tx ceiling');
    if (q.feeLamports > m.fees.maxPriorityFeeLamportsPerTx + 5_000) return no('priority-fee-cap', 'priority fee above per-tx ceiling');
    if (L.feeLamports + fee > m.fees.tipBudgetLamports) return no('fee-budget', `fee budget exhausted (${L.feeLamports} + ${fee} > ${m.fees.tipBudgetLamports} lamports)`);
    const inflight = [...this.recs.values()].filter((z) => z.mandateId === m.id).reduce((s, z) => s + Object.values(z.legs).filter((l) => l.state === 'in-flight' || l.state === 'unknown').length, 0);
    if (inflight >= m.limits.maxInFlight) return no('in-flight-cap', `${inflight} sends in flight`, true);
    const recent = L.sendTs.filter((ts) => now - ts < 1000).length;
    if (recent >= m.limits.maxSendsPerSec) return no('rate-limit', `${recent} sends in the last second`, true);
    return { ok: true };
  }

  private settle(r: PlanRecord, legKey: string, side: Side, signature: string, out: ReturnType<Executor['submit']>): void {
    const p = r.plan;
    switch (out.kind) {
      case 'filled':
        this.emit('leg.filled', { planId: p.id, mandateId: r.mandateId, data: { legKey, side, signature, fill: { ...out.fill, tokenDelta: str(out.fill.tokenDelta), solDelta: str(out.fill.solDelta) }, feeLamports: out.feeLamports, roundTripMs: out.roundTripMs } });
        this.advance(r); this.lossCheck(r); return;
      case 'send-failed': { const leg = r.legs[legKey]!; const final = leg.attempts >= LEG_MAX_ATTEMPTS; this.emit('leg.failed', { planId: p.id, data: { legKey, side, signature, reason: 'send-failed', error: out.error, refundFeeLamports: leg.feeLamports, final } }); break; }
      case 'send-unknown': this.emit('leg.unknown', { planId: p.id, data: { legKey, signature, why: out.error } }); return;
      default: throw new Error(`bad outcome ${(out as { kind: string }).kind}`);
    }
    this.advance(r);
  }

  /** Daily loss limit: realized losses inside the mandate reaching the limit auto-revoke it (positions held). */
  private lossCheck(r: PlanRecord): void {
    const x = this.mandates.get(r.mandateId!)!;
    if (x.m.status === 'armed' && x.ledger.lossUsd >= x.m.budget.dailyLossUsd) this.revokeMandate(x.m.id, `daily-loss-limit: $${x.ledger.lossUsd.toFixed(2)} >= $${x.m.budget.dailyLossUsd}`);
  }

  private legFinalFail(r: PlanRecord, legKey: string, side: Side, reason: string): void {
    const leg = r.legs[legKey] ?? (r.legs[legKey] = { attempts: 0, state: 'pending' });
    if (leg.state !== 'failed') this.emit('leg.failed', { planId: r.plan.id, data: { legKey, side, signature: null, reason, final: true } });
    this.advance(r);
  }

  /** Derive the plan status from its legs after a leg settles. */
  private advance(r: PlanRecord): void {
    const p = r.plan, legs = r.legs;
    const entryLegs = Object.entries(legs).filter(([k]) => k.startsWith('entry'));
    const allDone = (ls: [string, Leg][]) => ls.every(([, l]) => l.state === 'filled' || l.state === 'failed');
    if (r.status === 'triggered' || (r.status === 'armed' && entryLegs.length)) { // armed + legs = refused before anything was sent
      if (!allDone(entryLegs)) return;
      const filled = entryLegs.filter(([, l]) => l.state === 'filled').length;
      if (filled === 0) { const why = [...new Set(entryLegs.map(([, l]) => l.reason).filter(Boolean))].join(','); this.emit('plan.status', { planId: p.id, data: { status: 'failed', reason: `entry-failed: ${why}`, release: true } }); return; }
      const fraction = Math.round(r.pos.costUsd / p.sizeUsd * 1000) / 1000;
      this.emit('plan.status', { planId: p.id, data: { status: 'filled', reason: fraction < 1 ? `partial ${fraction}` : null, release: true, filledFraction: fraction, entryTokenRaw: str(r.pos.entryTokenRaw) } });
      return;
    }
    if (r.status === 'exiting' || r.status === 'filled') {
      const stop = legs.stop;
      if (stop?.state === 'filled') { this.emit('plan.status', { planId: p.id, data: { status: 'done', reason: 'stopped', realizedUsd: r.pos.realizedUsd } }); return; }
      // a stop the signer will not let through (rug: impact over every ceiling) = the position is unrealizable within policy
      if (stop?.state === 'failed') { this.emit('plan.status', { planId: p.id, data: { status: 'failed', reason: `unrealizable: stop ${stop.reason}; position held`, positionHeld: str(r.pos.tokenRaw) } }); return; }
      const key = `exit#${r.exitIdx}`, leg = legs[key];
      if (leg?.state === 'filled') {
        r.exitIdx += 1;
        if (r.exitIdx >= p.exits.length || r.pos.tokenRaw <= 0n) this.emit('plan.status', { planId: p.id, data: { status: 'done', reason: 'ladder-complete', moonBagTokenRaw: str(r.pos.tokenRaw), moonBagFraction: p.moonBagFraction, realizedUsd: r.pos.realizedUsd } });
        else this.emit('plan.status', { planId: p.id, data: { status: 'filled', reason: `leg ${r.exitIdx} of ${p.exits.length} done` } });
        return;
      }
      if (r.status !== 'exiting') return; // nothing in flight changed
      if (leg?.state === 'failed') { this.emit('plan.status', { planId: p.id, data: { status: 'filled', reason: `exit ${key} failed (${leg.reason}); holding, alert` } }); return; }
      if (leg?.state === 'retry') { this.emit('plan.status', { planId: p.id, data: { status: 'filled', reason: `exit ${key} will retry` } }); return; }
    }
  }

  /** A leg in 'unknown' (sent, outcome unknown): look the signature up; never resend. */
  private settleUnknown(r: PlanRecord, now: number): void {
    for (const [legKey, leg] of Object.entries(r.legs)) {
      if (leg.state !== 'unknown') continue;
      let res;
      try { res = this.ex.lookup(leg.signature!); } catch (e) { if (e instanceof RpcOutage) return; throw e; }
      const confirmed = res === 'confirmed' || (typeof res === 'object' && res.status === 'confirmed');
      const failed = res === 'failed' || (typeof res === 'object' && res.status === 'failed');
      if (confirmed) {
        const fill = (typeof res === 'object' && res.status === 'confirmed' ? res.fill : null) ?? this.ex.chainFill(leg.signature!)!;
        this.emit('leg.filled', { planId: r.plan.id, mandateId: r.mandateId, data: { legKey, side: leg.side, signature: leg.signature, fill: { ...fill, tokenDelta: str(fill.tokenDelta), solDelta: str(fill.solDelta) }, feeLamports: leg.feeLamports, recovered: true } });
        this.advance(r);
        this.lossCheck(r);
      } else if (failed || now - leg.unknownSince! > SEND_UNKNOWN_SETTLE_MS) {
        const final = leg.attempts >= LEG_MAX_ATTEMPTS;
        this.emit('leg.failed', { planId: r.plan.id, data: { legKey, side: leg.side, signature: leg.signature, reason: failed ? 'failed-on-chain' : 'expired-unseen', final, refundFeeLamports: 0 } });
        this.advance(r);
      }
    }
  }

  // ───────────────────────── recovery ─────────────────────────
  /** Rebuild from a journal, then settle anything in flight by signature lookup. */
  static recover(deps: EngineDeps): PlanEngine {
    const eng = new PlanEngine(deps);
    const v = deps.journal.verify(); if (!v.ok) throw new Error(`journal chain broken at seq ${v.atSeq}: ${v.why}`);
    for (const e of deps.journal.events) eng.reduce(e);
    eng.emit('recovered', { data: { events: deps.journal.events.length - 1, plans: eng.recs.size, mandates: eng.mandates.size } });
    const now = eng.clock.now();
    for (const r of eng.recs.values()) {
      for (const [legKey, leg] of Object.entries(r.legs)) if (leg.state === 'in-flight') { eng.emit('leg.unknown', { planId: r.plan.id, data: { legKey, signature: leg.signature, why: 'in flight at crash' } }); }
      eng.settleUnknown(r, now);
    }
    return eng;
  }

  // ───────────────────────── views ─────────────────────────
  ledger(mandateId: string): LedgerView { const x = this.mandates.get(mandateId)!; return { reservedUsd: x.ledger.reservedUsd, spentUsd: x.ledger.spentUsd, realizedUsd: x.ledger.realizedUsd, lossUsd: x.ledger.lossUsd, feeLamports: x.ledger.feeLamports, sendTs: undefined, mandateStatus: x.m.status }; }
  position(planId: string): { tokenRaw: bigint; entryTokenRaw: bigint; costUsd: number; soldUsd: number; realizedUsd: number } { const r = this.rec(planId); return { tokenRaw: r.pos.tokenRaw, entryTokenRaw: r.pos.entryTokenRaw, costUsd: r.pos.costUsd, soldUsd: r.pos.soldUsd, realizedUsd: r.pos.realizedUsd }; }
  summary(planId: string) { const r = this.rec(planId); return { id: planId, status: r.status, reason: r.reason, tier: r.tier, legs: Object.fromEntries(Object.entries(r.legs).map(([k, l]) => [k, l.state])), position: this.position(planId) }; }
}

export { PlanError, HARD };
