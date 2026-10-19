// task-1355 — shared types for the order-plan + mandate engine (SPEC §6.13).
//
// These are the money-safe object shapes. Material plan fields are hashed (SHA-256 over canonical
// JSON); any change to a material field is a new plan with a new hash and voids every outstanding
// confirmation. Display/provenance fields are never read by policy.

import type { Clock } from '../../clock.ts';

export type Side = 'buy' | 'sell';
export type ProposerKind = 'voice' | 'claude' | 'user' | 'batch' | 'copy';

export type TriggerKind = 'immediate' | 'mc-below' | 'mc-above' | 'price-below' | 'price-above';
export type Trigger =
  | { kind: 'immediate' }
  | { kind: Exclude<TriggerKind, 'immediate'>; value: number };

export interface Exit {
  /** take-profit level; must be an above-trigger (mc-above | price-above) */
  at: Trigger;
  /** fraction of the ORIGINAL filled position (not of what remains) */
  fraction: number;
}

export interface PlanSource {
  by: ProposerKind;
  /** utterance / session ref — audit only */
  ref: string | null;
  batchId: string | null;
}

export type PlanStatus =
  | 'proposed' | 'armed' | 'triggered' | 'filled' | 'exiting' | 'done' | 'failed' | 'cancelled';

export interface OrderPlan {
  v: 1;
  id: string;
  /** base58 mint — the mint, never the symbol (§5.7 clarify-first binds to mint) */
  mint: string;
  /** display only; sanitized; never used in policy */
  symbol: string;
  decimals: number;
  side: Side;
  /** entry size in USD */
  sizeUsd: number;
  entry: Trigger;
  exits: Exit[];
  /** derived 1 − Σfraction; the remainder the ladder never sells */
  moonBagFraction: number;
  stop: Trigger | null;
  slippageBps: number;
  maxPriceImpactPct: number;
  /** the supply the market-cap targets were read back against */
  supplyAtProposal: number;
  /** optional entry chunking (each chunk = its own tx/signature) */
  chunkUsd: number | null;
  createdAt: number;
  expiresAt: number;
  source: PlanSource;
  /** always 'proposed' on a freshly-proposed plan; runtime status is tracked by the engine */
  status: PlanStatus;
  /** the binding every proof and every signer check uses */
  hash: string;
}

export interface ProposeCtx {
  /** token supply snapshot the mc targets are read back against (the proposer does not control it) */
  supply: number;
  clock: Clock;
  id?: string;
  by?: ProposerKind;
  ref?: string | null;
  batchId?: string | null;
}

/** Untrusted proposal input: anything the proposer sends. Unknown fields are dropped, never coerced. */
export interface PlanInput {
  mint?: unknown;
  symbol?: unknown;
  decimals?: unknown;
  side?: unknown;
  sizeUsd?: unknown;
  entry?: unknown;
  exits?: unknown;
  stop?: unknown;
  slippageBps?: unknown;
  maxPriceImpactPct?: unknown;
  ttlMs?: unknown;
  chunkUsd?: unknown;
  // any other field (status, armed, caps, mandateId, …) is ignored by construction
  [k: string]: unknown;
}
