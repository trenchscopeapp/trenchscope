// task-1355 — the CONFIRM GATE: three confirmation tiers, all bound to the plan hash (SPEC §6.13.4).
//
//   tier 1  keypress    (DEFAULT)  hold a physical key >= HOLD_MS on the plan card, or a Phantom approval
//   tier 2  ptt-held               speak "send it <code>" WHILE the push-to-talk key is physically held
//   tier 3  hands-free             speak "send it <code>" with the key up — only after the "this is less
//                                  safe" risk popup was accepted by keypress (local, logged, reversible,
//                                  expires), and with lower caps
//
// The signer side issues a CHALLENGE for one plan hash: {code, readBack, expiresAt}. The read-back is
// what is spoken/rendered; the two-digit code inside it is what the user must echo. A confirmation is
// accepted only if the challenge is unconsumed, unexpired, for the CURRENT plan hash, and the evidence
// satisfies the tier. On success the gate returns a GESTURE PROOF (single-use) that the engine's `arm`
// consumes. Nothing in this file can execute anything; it only decides whether a proof exists.
// Ported from the task-1292 reference simulation (research/task-1292/sim/confirm.mjs), typed.

import type { Clock } from '../../clock.ts';
import type { Journal } from './journal.ts';
import type { GestureProof, TierName } from './mandate.ts';
import type { OrderPlan, PlanStatus } from './types.ts';

export const HOLD_MS = 400;
export const CHALLENGE_TTL_MS: Record<TierName, number> = { 'keypress': 90_000, 'ptt-held': 20_000, 'hands-free': 12_000 };
/** The mic is muted while the read-back is spoken; a "confirm" that lands inside this window after it is echo. */
export const ECHO_GUARD_MS = 300;
export const RISK_ACCEPT_TTL_MS = 24 * 3600_000;
const PHRASE_RE = /^\s*send it[,\s]+(\d{2})\s*$/i;

export class ConfirmError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ConfirmError';
    this.reason = reason;
  }
}

export interface KeypressEvidence { kind: 'keypress'; holdMs: number; synthetic?: boolean }
export interface PhantomEvidence { kind: 'phantom-approval'; approvedPlanHash: string }
export interface SpokenEvidence {
  kind: 'spoken';
  phrase: string;
  speakerCount: number;
  echoFlag?: boolean;
  utteranceStart: number;
  utteranceEnd: number;
  pttDownAt?: number;
  pttUpAt?: number;
  pttHeld?: boolean;
}
export type ConfirmEvidence = KeypressEvidence | PhantomEvidence | SpokenEvidence;

export interface Challenge {
  id: string;
  planId: string;
  planHash: string;
  tier: TierName;
  code: string;
  issuedAt: number;
  expiresAt: number;
  readBack: string;
  readBackSpokenUntil: number;
  consumed: boolean;
}

/** The plan as the engine holds it NOW (hash may have moved since the challenge was issued). */
export interface CurrentPlan { id: string; hash: string; status: PlanStatus }

export class Settings {
  private clock: Clock;
  private journal: Journal | null;
  gateOff = false;
  risk: { acceptedAt: number; expiresAt: number; text: string } | null = null;

  constructor(clock: Clock, journal: Journal | null) { this.clock = clock; this.journal = journal; }

  /** Turning the keypress gate off needs the risk popup accepted BY KEYPRESS. Logged. Expires. Reversible. */
  acceptRiskPopup(gesture: { gesture?: string } | null | undefined): void {
    if (gesture?.gesture !== 'keypress') throw new ConfirmError('risk-needs-keypress', 'the "less safe" popup can only be accepted with a keypress');
    const now = this.clock.now();
    this.risk = { acceptedAt: now, expiresAt: now + RISK_ACCEPT_TTL_MS, text: 'this is less safe' };
    this.gateOff = true;
    this.journal?.append('settings.gate-off', { data: { acceptedAt: now, expiresAt: this.risk.expiresAt, by: 'keypress' } });
  }
  restoreGate(): void { this.gateOff = false; this.risk = null; this.journal?.append('settings.gate-on', {}); }
  handsFreeAllowed(now: number): boolean { return this.gateOff && this.risk !== null && now <= this.risk.expiresAt; }
}

export class ConfirmGate {
  private clock: Clock;
  private journal: Journal | null;
  private settings: Settings;
  private rng: () => number;
  challenges = new Map<string, Challenge>();
  proofs = new Map<string, GestureProof>();
  private n = 0;

  handsFreeAllowed(): boolean { return this.settings.handsFreeAllowed(this.clock.now()); }

  constructor({ clock, journal, settings, rng = Math.random }: { clock: Clock; journal: Journal | null; settings: Settings; rng?: () => number }) {
    this.clock = clock; this.journal = journal; this.settings = settings; this.rng = rng;
  }

  /** Issue a challenge for a plan at a tier. The code is random per challenge so a recording cannot be replayed. */
  issue(plan: OrderPlan, tier: TierName, readBackText: string): Challenge {
    if (!(tier in CHALLENGE_TTL_MS)) throw new ConfirmError('bad-tier', 'unknown tier');
    const now = this.clock.now();
    const code = String(10 + Math.floor(this.rng() * 90)); // 10..99
    const c: Challenge = {
      id: `ch_${++this.n}`, planId: plan.id, planHash: plan.hash, tier, code, issuedAt: now, expiresAt: now + CHALLENGE_TTL_MS[tier],
      readBack: `${readBackText} Confirm code ${code}.`, readBackSpokenUntil: now + 2500, consumed: false,
    };
    this.challenges.set(c.id, c);
    this.journal?.append('confirm.challenge', { planId: plan.id, data: { challengeId: c.id, planHash: plan.hash, tier, expiresAt: c.expiresAt } });
    return c;
  }

  /**
   * Try to confirm. `currentPlan` is the plan the engine holds NOW for that id (hash may have moved).
   * Returns a gesture proof, or throws ConfirmError with a typed reason. Every outcome is journaled.
   */
  confirm({ challengeId, evidence }: { challengeId: string; evidence: ConfirmEvidence }, currentPlan: CurrentPlan | null): GestureProof {
    const c = this.challenges.get(challengeId);
    const now = this.clock.now();
    const journal = this.journal;
    // function declaration (not an arrow) so its `never` return narrows `c`/`currentPlan` below.
    function fail(reason: string, message: string): never {
      journal?.append('confirm.refused', { planId: c?.planId ?? null, data: { challengeId, reason } });
      throw new ConfirmError(reason, message);
    }
    if (!c) fail('unknown-challenge', 'no such challenge');
    if (c.consumed) fail('challenge-consumed', 'this confirmation was already used (replay)');
    if (now > c.expiresAt) fail('challenge-expired', 'the confirmation window closed; re-read the plan');
    if (!currentPlan || currentPlan.id !== c.planId) fail('plan-gone', 'the plan no longer exists');
    if (currentPlan.hash !== c.planHash) fail('plan-hash-mismatch', 'the plan changed since it was read back; confirm the new one');
    if (currentPlan.status !== 'proposed') fail('plan-not-proposed', `plan is ${currentPlan.status}`);
    const gesture = this.checkEvidence(c, evidence, now, fail);
    c.consumed = true;
    const proof: GestureProof = { id: `proof_${c.id}`, kind: 'gesture', signerIssued: true, gesture, tier: c.tier, subject: `plan:${c.planId}:${c.planHash}`, at: now, consumed: false };
    this.proofs.set(proof.id, proof);
    this.journal?.append('confirm.accepted', { planId: c.planId, data: { challengeId: c.id, tier: c.tier, gesture, planHash: c.planHash } });
    return proof;
  }

  private checkEvidence(c: Challenge, ev: ConfirmEvidence | null | undefined, now: number, fail: (reason: string, message: string) => never): string {
    if (!ev || typeof ev !== 'object') fail('no-evidence', 'no confirmation evidence');
    const e = ev as ConfirmEvidence;
    if (c.tier === 'keypress') {
      if (e.kind === 'phantom-approval' && e.approvedPlanHash === c.planHash) return 'phantom';
      if (e.kind !== 'keypress') fail('tier-mismatch', 'a keypress-tier challenge needs a keypress (or Phantom approval)');
      const kp = e as KeypressEvidence;
      if (!(kp.holdMs >= HOLD_MS)) fail('hold-too-short', `hold the key for at least ${HOLD_MS} ms`);
      if (kp.synthetic) fail('synthetic-key', 'synthetic key events are not a gesture');
      return 'keypress';
    }
    // spoken tiers
    if (e.kind !== 'spoken') fail('tier-mismatch', 'this challenge needs a spoken confirmation');
    const sp = e as SpokenEvidence;
    if (sp.speakerCount !== 1) fail('multiple-speakers', 'more than one speaker');
    if (sp.echoFlag) fail('echo', 'the recogniser flagged echo of our own audio');
    if (sp.utteranceStart < c.readBackSpokenUntil + ECHO_GUARD_MS) fail('echo-window', 'confirmation arrived while the read-back was still being spoken');
    const m = PHRASE_RE.exec(sp.phrase ?? '');
    if (!m) fail('bad-phrase', 'say "send it" followed by the two-digit code');
    if (m![1] !== c.code) fail('bad-code', 'wrong confirmation code');
    if (c.tier === 'ptt-held') {
      if (!(typeof sp.pttDownAt === 'number' && typeof sp.pttUpAt === 'number')) fail('ptt-not-held', 'push-to-talk was not held');
      if (!(sp.pttDownAt! <= sp.utteranceStart && sp.utteranceEnd <= sp.pttUpAt!)) fail('ptt-not-held', 'the confirmation must be spoken entirely while the talk key is held');
      return 'spoken-ptt';
    }
    // hands-free
    if (!this.settings.handsFreeAllowed(now)) fail('gate-on', 'hands-free confirm is off: the keypress gate is on (accept the "less safe" popup first)');
    if (sp.pttHeld) return 'spoken-ptt'; // holding the key is always at least as good
    return 'spoken-free';
  }
}

/** The caps multiplier a gesture earns (keypress/phantom = full mandate caps; spoken = less). */
export function gestureTier(gesture: string): TierName {
  return gesture === 'keypress' || gesture === 'phantom' ? 'keypress' : gesture === 'spoken-ptt' ? 'ptt-held' : 'hands-free';
}
