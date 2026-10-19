// task-1355 — the EXECUTOR boundary the plan engine fires through.
//
// The engine never signs or sends. It calls an Executor that stands in for "quote -> build -> simulate ->
// sign (fast wallet) -> send -> confirm". In tests this is a scripted FixtureExecutor (no key, no wallet,
// no network; research/task-1292/sim/executor.mjs); in the app it is a live adapter bridging to the real
// signer-side LiveExecutor / PaperExecutor (plans/executor-live.ts). Caps/allow-list/panic are re-checked
// by the signer on every submit — the engine is only the trigger brain, never the key holder.

import type { OrderPlan, Side } from './types.ts';

/** A transient RPC/transport failure: nothing fired, nothing sent; retried on the next fresh tick. */
export class RpcOutage extends Error {
  constructor() { super('rpc outage'); this.name = 'RpcOutage'; }
}

/** The actual on-chain balance change of a fill (CL-11: positions/PnL are booked from this, never a quote). */
export interface Fill {
  tokenDelta: bigint;
  solDelta: bigint;
  usd: number;
  priceUsd: number;
  /** task-1363: how the fill was settled. Absent/`paper` = the paper executor; `devnet-fill` = the real signer on devnet. */
  kind?: 'paper' | 'devnet-fill' | 'swap';
  /** task-1363: the on-chain signature (live fills). */
  signature?: string | null;
  /** task-1363: true when the token leg is modelled (a devnet fill moves SOL fees only; no token exists on devnet). */
  modelledTokens?: boolean;
  network?: 'devnet' | 'mainnet';
}

export interface Quote {
  side: Side;
  /** the route's implied price — what the trigger must re-confirm against (the tick is only a hint) */
  priceUsd: number;
  impactPct: number;
  route: string[];
  feeLamports: number;
  tipLamports: number;
  simOk: boolean;
  simError: string | null;
  /** task-1363: when `simOk` is false, the executor's own typed reason (a signer cap/policy refusal), journaled as-is. */
  refusal?: { reason: string; message: string } | null;
  usd: number | null;
  tokenRaw: bigint | null;
  at: number;
}

export interface QuoteRequest {
  plan: OrderPlan;
  legKey: string;
  side: Side;
  usd: number | null;
  tokenRaw: bigint | null;
  priceUsd: number;
}

export interface SubmitRequest {
  plan: OrderPlan;
  legKey: string;
  quote: Quote;
  signature: string;
  usd: number | null;
  tokenRaw: bigint | null;
}

export type SubmitOutcome =
  | { kind: 'filled'; signature: string; feeLamports: number; fill: Fill; roundTripMs: number }
  | { kind: 'send-failed'; signature: string; error: string; feeLamports: number }
  | { kind: 'send-unknown'; signature: string; error: string; feeLamports: number };

/** What the chain says about a signature during recovery / in-flight settling. */
export type ChainLookup =
  | { status: 'confirmed'; fill?: Fill }
  | { status: 'failed' }
  | 'confirmed'
  | 'failed'
  | 'not-found';

/**
 * The executor the engine fires through. A live implementation re-checks caps/allow-list/panic on every
 * submit (signer-side); a submit must journal its signature BEFORE the bytes leave (CL-03), which the
 * engine does — so a crash mid-submit is recovered by `lookup`, never by resending.
 */
export interface Executor {
  /** Which trust domain this executor settles in. 'paper' is the default; 'live' is a real signer (devnet-only
   *  until the maintainers say otherwise). Surfaces are fail-safe: a surface that cannot prove 'paper' must assume 'live'. */
  readonly kind?: 'paper' | 'live';
  /** A quote at the tick's price; `simOk:false` means the signer would refuse to sign (rug / bad route). */
  quote(req: QuoteRequest): Quote;
  /** Issue the next tx signature (the engine journals it before calling submit). */
  nextSignature(): string;
  /** "Sign with the fast wallet and send"; may throw RpcOutage (outage after send => unknown, settled by lookup). */
  submit(req: SubmitRequest): SubmitOutcome;
  /** Look a signature up on the chain (recovery path): confirmed/failed/not-found; may throw RpcOutage. */
  lookup(signature: string): ChainLookup;
  /** The fill read from the confirmed transaction's balance changes (CL-11). */
  chainFill(signature: string): Fill | null;
}
