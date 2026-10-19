// task-1355 — MANDATE schema, arming, and the signer-side admission check (SPEC §6.13.2).
//
// A mandate is a standing authorization. It is DRAFTED by anyone (voice, Claude, a preset, the user) and
// ARMED only by a gesture proof of kind 'keypress' or 'phantom' that the signer side itself issued and
// consumed. There is no `raiseCap()`; a mandate's caps are immutable after arming — a change is a new
// draft that needs a new arming gesture. Hard ceilings clamp every cap regardless of what was asked.
// Ported from the task-1292 reference simulation (research/task-1292/sim/mandate.mjs), typed and frozen.

import { createHash } from 'node:crypto';
import type { Clock } from '../../clock.ts';
import type { Side } from './types.ts';

export const HARD = Object.freeze({
  totalUsd: 2000, perTradeUsd: 500, perCoinUsd: 1000, dailyLossUsd: 2000,
  maxArmedPlans: 200, maxInFlight: 25, maxOpenPositions: 100,
  maxSlippageBps: 1000, maxPriceImpactPct: 3,
  tipBudgetLamports: 500_000_000, maxTipLamportsPerTx: 10_000_000, maxPriorityFeeLamportsPerTx: 10_000_000,
  ttlMs: 24 * 3600_000, maxSendsPerSec: 20,
});

export type TierName = 'keypress' | 'ptt-held' | 'hands-free';
export interface TierSpec { rank: number; perTradeMultiplier: number; canArmMandate: boolean; canArmBatch: boolean }

/** Confirmation tiers and the multiplier they apply to a mandate's per-trade cap for plans confirmed that way. */
export const TIERS: Readonly<Record<TierName, TierSpec>> = Object.freeze({
  'keypress': { rank: 0, perTradeMultiplier: 1.0, canArmMandate: true, canArmBatch: true },
  'ptt-held': { rank: 1, perTradeMultiplier: 0.5, canArmMandate: false, canArmBatch: false },
  'hands-free': { rank: 2, perTradeMultiplier: 0.25, canArmMandate: false, canArmBatch: false },
});

export class MandateError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'MandateError';
    this.reason = reason;
  }
}

export interface MandateBudget { totalUsd: number; perTradeUsd: number; perCoinUsd: number; dailyLossUsd: number }
export interface MandateLimits {
  maxArmedPlans: number; maxInFlight: number; maxOpenPositions: number;
  maxSlippageBps: number; maxPriceImpactPct: number; maxSendsPerSec: number;
  stopMaxPriceImpactPct?: number;
}
export interface MandateFees { tipBudgetLamports: number; maxTipLamportsPerTx: number; maxPriorityFeeLamportsPerTx: number }
export interface MandateAllowed { actions: Side[]; safetyFilter: string; mints: string[] | null }
export type MandateStatus = 'draft' | 'armed' | 'revoked' | 'expired';

export interface Mandate {
  v: 1;
  id: string;
  wallet: 'fast';
  budget: MandateBudget;
  limits: MandateLimits;
  fees: MandateFees;
  allowed: MandateAllowed;
  /** The most permissive confirmation tier that may arm plans INTO this mandate. */
  maxTier: TierName;
  createdAt: number;
  expiresAt: number;
  status: MandateStatus;
  armedAt: number | null;
  armedBy: { gesture: string; proofId: string } | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

/** Untrusted mandate draft input. Unknown fields are ignored. */
export interface MandateInput {
  totalUsd?: unknown; perTradeUsd?: unknown; perCoinUsd?: unknown; dailyLossUsd?: unknown;
  maxArmedPlans?: unknown; maxInFlight?: unknown; maxOpenPositions?: unknown;
  maxSlippageBps?: unknown; maxPriceImpactPct?: unknown; maxSendsPerSec?: unknown;
  tipBudgetLamports?: unknown; maxTipLamportsPerTx?: unknown; maxPriorityFeeLamportsPerTx?: unknown;
  actions?: unknown; safetyFilter?: unknown; mints?: unknown; maxTier?: unknown; ttlMs?: unknown;
  [k: string]: unknown;
}

export interface GestureProof {
  id: string;
  kind: 'gesture';
  signerIssued: boolean;
  gesture: string;
  subject: string;
  at?: number;
  tier?: TierName;
  consumed: boolean;
}

function clamp(v: unknown, dflt: number, hardMax: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!(n > 0) || !Number.isFinite(n)) return dflt;
  return Math.min(n, hardMax);
}

/** Validate an untrusted mandate draft. Every cap is clamped to the hard ceiling; nothing is coerced upward. */
export function draftMandate(input: MandateInput | null | undefined, ctx: { clock: Clock; id?: string }): Mandate {
  const x = input ?? {};
  const now = ctx.clock.now();
  const actions: Side[] = Array.isArray(x.actions) ? (x.actions as unknown[]).filter((a): a is Side => a === 'buy' || a === 'sell') : ['buy', 'sell'];
  if (actions.length === 0) throw new MandateError('bad-request', 'at least one of buy/sell');
  const m: Mandate = {
    v: 1,
    id: ctx.id ?? `mandate_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    wallet: 'fast', // the capped fast wallet; the main wallet is never named here
    budget: {
      totalUsd: clamp(x.totalUsd, 100, HARD.totalUsd),
      perTradeUsd: clamp(x.perTradeUsd, 20, HARD.perTradeUsd),
      perCoinUsd: clamp(x.perCoinUsd, 40, HARD.perCoinUsd),
      dailyLossUsd: clamp(x.dailyLossUsd, 50, HARD.dailyLossUsd),
    },
    limits: {
      maxArmedPlans: clamp(x.maxArmedPlans, 20, HARD.maxArmedPlans),
      maxInFlight: clamp(x.maxInFlight, 5, HARD.maxInFlight),
      maxOpenPositions: clamp(x.maxOpenPositions, 20, HARD.maxOpenPositions),
      maxSlippageBps: clamp(x.maxSlippageBps, 500, HARD.maxSlippageBps),
      maxPriceImpactPct: clamp(x.maxPriceImpactPct, 3, HARD.maxPriceImpactPct),
      maxSendsPerSec: clamp(x.maxSendsPerSec, 5, HARD.maxSendsPerSec),
    },
    fees: {
      tipBudgetLamports: clamp(x.tipBudgetLamports, 50_000_000, HARD.tipBudgetLamports),
      maxTipLamportsPerTx: clamp(x.maxTipLamportsPerTx, 1_000_000, HARD.maxTipLamportsPerTx),
      maxPriorityFeeLamportsPerTx: clamp(x.maxPriorityFeeLamportsPerTx, 2_000_000, HARD.maxPriorityFeeLamportsPerTx),
    },
    allowed: {
      actions,
      safetyFilter: typeof x.safetyFilter === 'string' ? x.safetyFilter.slice(0, 32) : 'safety-v1',
      mints: Array.isArray(x.mints) ? (x.mints as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 500) : null, // optional explicit allow-list
    },
    maxTier: (typeof x.maxTier === 'string' && x.maxTier in TIERS) ? (x.maxTier as TierName) : 'keypress',
    createdAt: now,
    expiresAt: now + clamp(x.ttlMs, 4 * 3600_000, HARD.ttlMs),
    status: 'draft', armedAt: null, armedBy: null, revokedAt: null, revokedReason: null,
  };
  // perTrade can never exceed total; perCoin never exceeds total.
  m.budget.perTradeUsd = Math.min(m.budget.perTradeUsd, m.budget.totalUsd);
  m.budget.perCoinUsd = Math.min(m.budget.perCoinUsd, m.budget.totalUsd);
  // Caps are immutable after drafting: a different cap is a different draft that needs its own gesture.
  Object.freeze(m.budget); Object.freeze(m.limits); Object.freeze(m.fees); Object.freeze(m.allowed);
  return m;
}

/**
 * Arm a mandate. Only a signer-issued, unconsumed 'keypress' or 'phantom' proof bound to THIS mandate's
 * caps hash is accepted. Spoken proofs of any tier are refused: voice can never arm a mandate.
 */
export function armMandate(m: Mandate, proof: GestureProof | null | undefined, ctx: { clock: Clock }): Mandate {
  if (m.status !== 'draft') throw new MandateError('not-draft', `mandate is ${m.status}`);
  if (!proof || proof.kind !== 'gesture' || !proof.signerIssued) throw new MandateError('no-gesture', 'arming needs a signer-issued gesture proof');
  if (proof.gesture !== 'keypress' && proof.gesture !== 'phantom') throw new MandateError('voice-cannot-arm', `a ${proof.gesture} proof cannot arm a mandate`);
  if (proof.subject !== `mandate:${m.id}:${capsHash(m)}`) throw new MandateError('proof-mismatch', 'the proof is for a different mandate or different caps');
  if (proof.consumed) throw new MandateError('proof-consumed', 'this proof was already used');
  proof.consumed = true;
  const now = ctx.clock.now();
  if (now > m.expiresAt) throw new MandateError('expired', 'mandate draft expired');
  m.status = 'armed'; m.armedAt = now; m.armedBy = { gesture: proof.gesture, proofId: proof.id };
  return m;
}

export function revokeMandate(m: Mandate, reason: string, ctx: { clock: Clock }): Mandate {
  if (m.status === 'revoked') return m;
  m.status = 'revoked'; m.revokedAt = ctx.clock.now(); m.revokedReason = String(reason).slice(0, 120);
  return m;
}

/** Hash of the caps a gesture arms — the proof binds to these numbers, not to the mandate id alone. */
export function capsHash(m: Mandate): string {
  return createHash('sha256').update(JSON.stringify({ b: m.budget, l: m.limits, f: m.fees, a: m.allowed, t: m.maxTier, e: m.expiresAt, w: m.wallet })).digest('hex').slice(0, 16);
}

/** Alive = armed and not expired. Expiry is checked on every call, never cached. */
export function mandateAlive(m: Mandate, now: number): { ok: true } | { ok: false; reason: string } {
  if (m.status !== 'armed') return { ok: false, reason: m.status === 'draft' ? 'mandate-not-armed' : `mandate-${m.status}` };
  if (now > m.expiresAt) return { ok: false, reason: 'mandate-expired' };
  return { ok: true };
}
