// task-1355 — order-plan + mandate engine (SPEC §6.13). Front-end agnostic; lives in the signer trust
// domain alongside caps/killswitch/executor. Voice and agents can only PROPOSE; arming needs a
// signer-issued keypress/Phantom gesture proof; caps are frozen and the signer re-checks every fill.

export { PLAN_SCHEMA_VERSION, MATERIAL_FIELDS, PlanError, proposePlan, canonicalPlan, planHash, amendPlan, displayText, readBack, fmtUsd, priceForMc } from './plan.ts';
export type { AmendPatch } from './plan.ts';
export { HARD, TIERS, MandateError, draftMandate, armMandate, revokeMandate, capsHash, mandateAlive } from './mandate.ts';
export type { Mandate, MandateInput, MandateBudget, MandateLimits, MandateFees, MandateAllowed, MandateStatus, GestureProof, TierName, TierSpec } from './mandate.ts';
export { HOLD_MS, CHALLENGE_TTL_MS, ECHO_GUARD_MS, RISK_ACCEPT_TTL_MS, ConfirmError, Settings, ConfirmGate, gestureTier } from './confirm.ts';
export type { ConfirmEvidence, KeypressEvidence, PhantomEvidence, SpokenEvidence, Challenge, CurrentPlan } from './confirm.ts';
export { Journal, redact, eventHash } from './journal.ts';
export type { JournalEvent, AppendFields, VerifyResult } from './journal.ts';
export { RpcOutage } from './executor.ts';
export type { Executor, Quote, QuoteRequest, SubmitRequest, SubmitOutcome, ChainLookup, Fill } from './executor.ts';
export { PaperPlanExecutor } from './executor-paper.ts';
export type { PaperPlanExecutorOptions } from './executor-paper.ts';
export { LivePlanExecutor, LIVE_BUILD_TTL_MS } from './executor-live.ts';
export type { LivePlanExecutorOptions } from './executor-live.ts';
export { PlanEngine, PolicyRefusal, TERMINAL } from './engine.ts';
export type { EngineDeps, PriceTick, SafetyFn, LedgerView, BatchArmResult } from './engine.ts';
export { PlanService, parseAmount, parseTrigger, parseExit, planStatusLabel, defaultPlansJournalPath } from './service.ts';
export type { PlanServiceOptions, PlanRow, MandateRow } from './service.ts';
export type { OrderPlan, PlanInput, PlanStatus, ProposeCtx, Trigger, TriggerKind, Exit, Side, ProposerKind, PlanSource } from './types.ts';
