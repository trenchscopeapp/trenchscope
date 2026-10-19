// trenchscope T1 — the live (non-custodial) trade executor (SPEC §6.1, §6.2, §6.5). Orchestrates the safe
// pipeline and enforces the invariants the UI/model/voice cannot bypass:
//
//   quote -> bind quote to order -> build unsigned tx -> DECODE + §6.2 policy -> simulate with balance
//   deltas -> PLAN (+ plan-hash, registered in-process)   [UI shows plan, user presses key]
//   -> look the plan up by hash (single-use, expiring) -> re-check CAPS + reserve USD atomically
//   -> wallet bridge SIGNS -> decode the SIGNED tx: same message, valid Ed25519 signature by the linked
//   wallet, same policy -> RE-SIMULATE and compare the SOL delta AND the wallet's TOKEN balances to the
//   plan -> submit -> confirm -> record
//
// Refusals (no sign, no submit) when: the quote does not match the order, the tx calls a program off
// the allow-list or carries a forbidden instruction, simulation failed, the simulated SOL out exceeds
// the plan or the SOL cap, a token account of the wallet that the plan does not spend loses tokens in
// the simulation (task-1337, token-delta.ts), price impact / slippage exceed their ceilings, the plan
// is unknown/expired/mutated, the signed bytes differ, or any cap (network / per-trade USD / daily USD)
// is exceeded, or the panic switch is engaged. trenchscope never holds a key; the browser approval IS the
// physical confirmation. The AI has no path here — the executor is constructed only inside the
// interactive context and called only from a keypress handler.

import { createHash } from 'node:crypto';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { SOL_MINT, computeFill, lamportsToSol, emptyPosition, applyBuy, applySell, type PaperOrder, type Fill, type Position, type TradeRecord } from '../paper.ts';
import { normalizeSwapQuote, type QuoteRequest, type SwapQuote } from '../sources/jupiter-swap.ts';
import { base58 } from '../sources/solana-rpc.ts';
import { base58Decode } from '../sources/pda.ts';
import { JupiterSwapBuild, type RawQuote } from './swap-build.ts';
import { TradeRpc, RpcRejectedError, rpcNetwork, type SimResult } from './rpc-exec.ts';
import { WalletBridge } from './bridge.ts';
import {
  checkCaps, effectiveCaps, planHash, CapLedger, SOL_OVERHEAD_ALLOWANCE_LAMPORTS,
  type TradeCaps, type TradePlan, type TradeNetwork, type CapRefusal, type TxPolicyVerdict,
} from './caps.ts';
import {
  decodeTransaction, checkTxPolicy, checkTxPolicyWith, checkSwapBinding, compareApprovedMessage, verifyEd25519, ALLOWED_PROGRAMS, WSOL_MINT,
  LIGHTHOUSE_PROGRAM, SYSTEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM, JUPITER_V6_PROGRAM, JUPITER_ROUTE_DISCRIMINATORS,
  TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
  type DecodedTransaction, type SwapExpectation,
} from './tx-decode.ts';
import { resolveSolUsd, type SolUsdResolution } from './sol-usd.ts';
import { KillSwitch } from './kill-switch.ts';
import { buildTokenWatch, referencedAccounts, parseLookupTable, checkTokenDeltas, postBalances, refreshWatch, referencedOverCap, checkWsolBound, MAX_TOKEN_WATCH, type TokenWatch, type TokenDeltaResult } from './token-delta.ts';
import { FAST_MAX_SOL_PER_FILL, FAST_MAX_SOL_PER_FILL_LAMPORTS } from './signer/fast-wallet.ts';

/** How long a built plan stays confirmable. A stale quote/tx is refused ('plan-expired'); rebuild. */
export const PLAN_TTL_MS = 90_000;

/**
 * What a plan is: a Jupiter swap, the devnet PROBE (wrap-and-unwrap, no route, fees only), or — task-1363 — a
 * DEVNET FILL: the probe shape sized to an order plan's SOL leg, signed by the capped fast wallet when an armed
 * mandate fires. Jupiter has no devnet, so this is the only transaction a devnet mandate can execute; it moves
 * real devnet lamports (fees) through the whole decode → policy → simulate → sign → re-simulate → submit path.
 */
export type PlanKind = 'swap' | 'probe' | 'devnet-fill';
/** Which wallet a plan is built for: the user's linked main wallet (Phantom signs) or the capped fast wallet. */
export type PlanLane = 'main' | 'fast';
/** The transaction-policy shape a plan kind must have (a devnet fill IS the probe shape). */
export function policyKind(kind: PlanKind): 'swap' | 'probe' { return kind === 'swap' ? 'swap' : 'probe'; }

/** One top-level instruction as the PLAN screen lists it ("what will be signed"). */
export interface InstructionSummary { program: string; op: string }

export interface BuiltPlan {
  kind: PlanKind;
  plan: TradePlan;
  /**
   * sha256 binding the confirm to BOTH the plan's material fields AND the exact transaction MESSAGE
   * that was built and simulated (DEFECT 2). If either the plan or the tx bytes change after the user
   * saw them, this hash changes and the confirm is void.
   */
  hash: string;
  /** sha256 of the unsigned transaction's message bytes; re-checked against the signed tx at submit. */
  txDigest: string;
  unsignedTxBase64: string;
  order: PaperOrder;
  quote: SwapQuote;
  /** The wallet the plan was built for; the confirm must name the same one. */
  userPublicKey: string;
  /** task-1363: 'main' = the linked wallet signs in Phantom; 'fast' = the capped fast wallet signs locally (devnet). */
  lane: PlanLane;
  /** task-1363: the order-plan leg a devnet fill belongs to (`planId:legKey`), part of its hash; null otherwise. */
  ref: string | null;
  /** How the SOL/USD price was resolved (for the ticket to show which sources agreed, or why not). */
  solUsd: SolUsdResolution;
  builtAt: number;
  /** The decoded APPROVED transaction (what the user saw); the signed bytes are compared against it. */
  decoded: DecodedTransaction | null;
  /** The swap the route must be bound to (swap plans only). */
  expect: SwapExpectation | null;
  /** Top-level instructions, for the PLAN screen. */
  instructions: InstructionSummary[];
  /** Fee estimate in lamports: base signature fee(s) + Jupiter's prioritization fee (when reported). */
  feeLamports: bigint;
  /** Jupiter's reported prioritization fee (lamports) or null. */
  prioritizationFeeLamports: number | null;
  /**
   * task-1337: the wallet's token accounts watched through the simulation (pre-balances at build). The
   * confirm step re-reads their balances and re-simulates the SIGNED bytes against them.
   */
  tokenWatch: readonly TokenWatch[];
}

export type SubmitOutcome =
  | { kind: 'refused'; reason: CapRefusal; message: string }
  | { kind: 'filled'; signature: string; fill: Fill; roundTripMs: number; /** Lighthouse assertions Phantom appended (0 = none). */ lighthouseTail: number }
  /** Definitely NOT broadcast (or definitely failed on chain). The reservation was refunded when nothing left. */
  | { kind: 'send-failed'; signature: string | null; error: string }
  /**
   * The transaction MAY have been broadcast (transport error / timeout after a send, or a confirm that
   * could not be read). The daily reservation STAYS charged. The UI must show the signature and must
   * NOT offer a blind retry — a retry could buy twice.
   */
  | { kind: 'send-unknown'; signature: string; error: string };

/** Builds the devnet PROBE transaction (wrap-and-unwrap a few lamports for the wallet). Injected; devnet only. */
export interface ProbeBuilder {
  build(userPublicKey: string, opts?: { lamports?: bigint; memo?: string }): Promise<{ txBase64: string; lamports: bigint }>;
}

/** task-1363: the capped fast wallet's signer (signer/fast-wallet.ts) — same call shape as the Phantom bridge. */
export interface FastLaneSigner {
  readonly publicKey: string;
  signTransaction(args: { unsignedTxBase64: string; expectPublicKey?: string; label?: string }): Promise<{ signedTxBase64: string; provider: string; roundTripMs: number }>;
}

export interface LiveExecutorDeps {
  build: JupiterSwapBuild;
  /** Devnet plumbing probe builder; absent → probe plans are refused. */
  probe?: ProbeBuilder;
  rpc: TradeRpc;
  bridge: WalletBridge;
  caps: TradeCaps;
  ledger: CapLedger;
  liveLedger?: LiveLedger;
  clock?: Clock;
  /**
   * SOL/USD SAMPLES (`{price, fetchedAt, source}` or an array of them) from dexterm's own keyless
   * feeds. Resolved by `resolveSolUsd`: stale (> 60 s), implausible (outside $1–$10,000) or
   * vendor-dependent (Jupiter) samples are dropped; MAINNET needs two independent non-Jupiter
   * sources agreeing within 3%. Anything else (a bare number, null) yields no price, and a mainnet
   * trade is refused ('no-usd-value'). The quote's own `swapUsdValue` is never used.
   */
  solUsd?: () => unknown;
  /** The panic switch; defaults to the real ~/.dexterm file. Engaged → every plan and confirm refused. */
  killSwitch?: KillSwitch;
  /** Program allow-list override (tests). Default: SPEC §6.2 list in tx-decode.ts. */
  allowedPrograms?: ReadonlySet<string>;
  /**
   * task-1363: the capped fast wallet (devnet only), present only when the signer process loaded one against a
   * devnet RPC. Signs fast-lane plans locally; never a main-lane plan. Absent → `buildFill` refuses.
   */
  fastSigner?: FastLaneSigner;
}

interface Registered { built: BuiltPlan; at: number; used: boolean }

export class LiveExecutor {
  private readonly d: LiveExecutorDeps;
  private readonly clock: Clock;
  private readonly killSwitch: KillSwitch;
  private readonly allowed: ReadonlySet<string>;
  /** DEFECT 5: serializes the check+reserve critical section so concurrent trades can't both pass. */
  private capGate: Promise<void> = Promise.resolve();
  /**
   * Plans THIS executor built, by hash. A confirm is honoured only for a registered, unused, unexpired
   * plan, and the executor works from its OWN frozen copy — an in-process caller that rebinds the
   * digest/hash on the object it holds gets 'plan-mismatch' (first verifier's design gap #8).
   */
  private readonly plans = new Map<string, Registered>();

  constructor(deps: LiveExecutorDeps) {
    this.d = deps;
    this.clock = deps.clock ?? systemClock;
    this.killSwitch = deps.killSwitch ?? new KillSwitch();
    this.allowed = deps.allowedPrograms ?? ALLOWED_PROGRAMS;
  }

  /** Run `fn` with exclusive access to the daily-cap ledger (promise-chain mutex). */
  private async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const prior = this.capGate;
    let release!: () => void;
    this.capGate = new Promise<void>((r) => { release = r; });
    await prior;
    try { return await fn(); } finally { release(); }
  }

  private effectiveNetwork(requested: TradeNetwork | undefined): TradeNetwork {
    // DEFECT 4: the network that gates USD caps is the MORE DANGEROUS of {requested, actual RPC}. A
    // trade is devnet-exempt ONLY when both the requested label AND the configured RPC endpoint are
    // devnet; a devnet label over a mainnet RPC is treated as mainnet so caps are enforced on real funds.
    const rpcNet = rpcNetworkOf(this.d.rpc);
    return (requested === 'mainnet' || rpcNet === 'mainnet') ? 'mainnet' : 'devnet';
  }

  /**
   * Step 1: quote -> bind -> build -> decode/policy -> simulate -> plan. No signing. The plan carries
   * its hash so the UI can show it and bind the later confirm to it. Does NOT itself refuse on caps
   * (the UI shows the plan even when it will be refused, so the user understands why); refusal happens
   * at submit. Throws when live trading is panicked or the quote/tx cannot be parsed (fail closed).
   */
  async buildPlan(args: { order: PaperOrder; userPublicKey: string; network?: TradeNetwork; signal?: AbortSignal }): Promise<BuiltPlan> {
    const panic = this.killSwitch.engaged();
    if (panic) throw new Error(`live trading is PANICKED (${panic.reason}); run \`trenchscope wallet resume\` to re-enable`);
    const order = args.order;
    const user = args.userPublicKey;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(user)) throw new Error('buildPlan needs a base58 wallet public key');
    const network = this.effectiveNetwork(args.network ?? this.d.caps.network);
    const req: QuoteRequest = {
      inputMint: order.side === 'buy' ? SOL_MINT : order.mint,
      outputMint: order.side === 'buy' ? order.mint : SOL_MINT,
      amount: order.amountRaw,
      slippageBps: order.slippageBps,
      mode: 'ExactIn',
    };
    const raw: RawQuote = await this.d.build.quoteRaw(req, args.signal);
    const now = this.clock.now();
    const quote = normalizeSwapQuote(raw as never, now); // throws on a non-integer amount (round 2)

    // Round 2 HIGH #1: the quote must be the quote for THIS order. A hostile/changed API response that
    // reprices the SOL leg or swaps a mint is refused before anything is built.
    const bind = bindQuote(quote, req);
    const solUsd = resolveSolUsd(this.d.solUsd?.(), now, network);
    let txPolicy: TxPolicyVerdict = bind;
    let unsignedTxBase64 = '';
    let txDigest = '';
    let sim: SimResult | null = null;
    let solOut: bigint | null = null;
    let wsolLost = 0n;
    let decodedTx: DecodedTransaction | null = null;
    let prioFee: number | null = null;
    let tokenWatch: TokenWatch[] = [];
    const expect: SwapExpectation = { user, inputMint: req.inputMint, outputMint: req.outputMint, inAmount: quote.inAmount, outAmount: quote.outAmount, slippageBps: quote.slippageBps };
    if (bind.ok) {
      const built = await this.d.build.buildSwap({ quote: raw, userPublicKey: user, signal: args.signal });
      unsignedTxBase64 = built.swapTransactionBase64;
      const decoded = decodeTransaction(Buffer.from(unsignedTxBase64, 'base64')); // throws → fail closed
      txDigest = digest(decoded.message);
      const pol = checkTxPolicy(decoded, user, this.allowed);
      txPolicy = pol.ok ? { ok: true } : { ok: false, reason: pol.reason, message: pol.message };
      // task-1328: the one route must BE this plan (amounts, slippage, no fee, the wallet's own ATAs).
      if (pol.ok) {
        const bound = checkSwapBinding(decoded, expect);
        if (!bound.ok) txPolicy = { ok: false, reason: bound.reason, message: bound.message };
      }
      if (txPolicy.ok) {
        // task-1337: the wallet's token accounts ride along in the simulation; a route that drains one the
        // plan does not spend is refused here, before the user ever sees a plan to confirm.
        const tw = await this.tokenWatchFor(user, decoded);
        if (!tw.ok) txPolicy = { ok: false, reason: 'token-delta-unknown', message: tw.message };
        else {
          tokenWatch = tw.watch;
          const r = await this.simulateWithDelta(unsignedTxBase64, user, tokenWatch, { side: order.side, mint: order.mint, amountRaw: order.amountRaw });
          sim = r.sim;
          solOut = r.solOut;
          if (r.sim.ok && !r.tokens.ok) txPolicy = { ok: false, reason: r.tokens.reason, message: r.tokens.message };
          else if (r.sim.ok && r.tokens.ok) wsolLost = r.tokens.wsolLost;
        }
      }
      decodedTx = decoded;
      prioFee = built.prioritizationFeeLamports;
    }

    const solLeg = solLegLamports(order, quote, solOut);
    // task-1337 F2: wrapped SOL that left the wallet is SOL-value out; bound it against the plan's SOL leg
    // (the per-account token check deliberately lets WSOL through, so this is where a WSOL drain is caught).
    if (txPolicy.ok && sim?.ok && wsolLost > 0n) {
      const wb = checkWsolBound(order.side, solOut, wsolLost, solLeg, SOL_OVERHEAD_ALLOWANCE_LAMPORTS);
      if (!wb.ok) txPolicy = { ok: false, reason: wb.reason, message: wb.message };
    }
    const plan: TradePlan = {
      network,
      mint: order.mint,
      symbol: order.symbol,
      side: order.side,
      amountInRaw: quote.inAmount,
      amountOutRaw: quote.outAmount,
      slippageBps: quote.slippageBps,
      route: Object.freeze([...quote.route]) as string[],
      priceImpactPct: quote.priceImpactPct,
      // DEFECT 3 / round 2: priced LOCALLY from the larger of the planned SOL leg and the SIMULATED SOL
      // out, times a resolved multi-source SOL/USD. Never the quote's swapUsdValue.
      notionalUsd: notionalUsd(order.side, solLeg, solOut, solUsd),
      simulated: sim !== null,
      simOk: sim?.ok ?? false,
      simError: sim === null ? null : sim.ok ? null : safeErr(sim.err),
      solOutLamports: solOut,
      solLegLamports: solLeg,
      txPolicy,
    };
    Object.freeze(plan);
    const hash = txDigest ? bindHash(plan, txDigest) : bindHash(plan, 'no-tx');
    const built: BuiltPlan = Object.freeze({
      kind: 'swap' as const, lane: 'main' as const, ref: null, plan, hash, txDigest, unsignedTxBase64, order, quote, userPublicKey: user, solUsd, builtAt: now,
      decoded: decodedTx, expect, instructions: decodedTx ? summarize(decodedTx) : [],
      feeLamports: BigInt(5000 * (decodedTx?.numRequiredSignatures ?? 1)) + BigInt(prioFee ?? 0),
      prioritizationFeeLamports: prioFee,
      tokenWatch: Object.freeze(tokenWatch.map((w) => Object.freeze({ ...w }))),
    });
    this.plans.set(hash, { built, at: now, used: false });
    this.sweep(now);
    return built;
  }

  /**
   * task-1328: the devnet PROBE plan — the wrap-and-unwrap shape (fund the wallet's own wrapped-SOL
   * account, SyncNative, CloseAccount back to the wallet) with NO route. It moves nothing but fees, and
   * it exercises the same keypress → Phantom sign → verify → re-simulate → submit → confirm path as a
   * swap. Refused unless the RPC endpoint is devnet by classification (never a mainnet probe).
   */
  async buildProbe(args: { userPublicKey: string; symbol?: string }): Promise<BuiltPlan> {
    const panic = this.killSwitch.engaged();
    if (panic) throw new Error(`live trading is PANICKED (${panic.reason}); run \`trenchscope wallet resume\` to re-enable`);
    const user = args.userPublicKey;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(user)) throw new Error('buildProbe needs a base58 wallet public key');
    if (!this.d.probe) throw new Error('no probe builder configured');
    if (rpcNetworkOf(this.d.rpc) !== 'devnet') throw new Error('the devnet probe runs only against a devnet RPC endpoint');
    const now = this.clock.now();
    const built = await this.d.probe.build(user);
    const decoded = decodeTransaction(Buffer.from(built.txBase64, 'base64'));
    const txDigest = digest(decoded.message);
    const pol = checkTxPolicyWith(decoded, user, this.allowed, { kind: 'probe' });
    let txPolicy: TxPolicyVerdict = pol.ok ? { ok: true } : { ok: false, reason: pol.reason, message: pol.message };
    let sim: SimResult | null = null;
    let solOut: bigint | null = null;
    let tokenWatch: TokenWatch[] = [];
    if (pol.ok) {
      const tw = await this.tokenWatchFor(user, decoded);
      if (!tw.ok) txPolicy = { ok: false, reason: 'token-delta-unknown', message: tw.message };
      else {
        tokenWatch = tw.watch;
        const r = await this.simulateWithDelta(built.txBase64, user, tokenWatch, { side: 'buy', mint: WSOL_MINT, amountRaw: built.lamports });
        sim = r.sim; solOut = r.solOut;
        if (r.sim.ok && !r.tokens.ok) txPolicy = { ok: false, reason: r.tokens.reason, message: r.tokens.message };
        else if (r.sim.ok && r.tokens.ok && r.tokens.wsolLost > 0n) {
          // task-1337 F2: a probe only wraps/unwraps the wallet's own SOL; it must not drain pre-existing WSOL.
          const wb = checkWsolBound('buy', solOut, r.tokens.wsolLost, built.lamports, SOL_OVERHEAD_ALLOWANCE_LAMPORTS);
          if (!wb.ok) txPolicy = { ok: false, reason: wb.reason, message: wb.message };
        }
      }
    }
    const plan: TradePlan = Object.freeze({
      network: 'devnet' as const, mint: WSOL_MINT, symbol: args.symbol ?? 'SOL', side: 'buy' as const,
      amountInRaw: built.lamports, amountOutRaw: built.lamports, slippageBps: 0, route: Object.freeze([]) as unknown as string[],
      priceImpactPct: 0, notionalUsd: null, simulated: sim !== null, simOk: sim?.ok ?? false,
      simError: sim === null ? null : sim.ok ? null : safeErr(sim.err), solOutLamports: solOut, solLegLamports: built.lamports, txPolicy,
    });
    const hash = createHash('sha256').update(`probe|${bindHash(plan, txDigest)}`).digest('hex');
    const order: PaperOrder = { mint: WSOL_MINT, symbol: plan.symbol, side: 'buy', decimals: 9, amountRaw: built.lamports, slippageBps: 0 };
    const quote: SwapQuote = {
      inputMint: WSOL_MINT, outputMint: WSOL_MINT, inAmount: built.lamports, outAmount: built.lamports, otherAmountThreshold: built.lamports,
      mode: 'ExactIn', slippageBps: 0, priceImpactPct: 0, route: [], platformFeeBps: null, platformFeeAmount: null, usdValue: null, contextSlot: 0,
      source: 'jupiter-swap', fetchedAt: now,
    };
    const out: BuiltPlan = Object.freeze({
      kind: 'probe' as const, lane: 'main' as const, ref: null, plan, hash, txDigest, unsignedTxBase64: built.txBase64, order, quote, userPublicKey: user,
      solUsd: resolveSolUsd(this.d.solUsd?.(), now, 'devnet'), builtAt: now, decoded, expect: null, instructions: summarize(decoded),
      feeLamports: BigInt(5000 * decoded.numRequiredSignatures), prioritizationFeeLamports: null,
      tokenWatch: Object.freeze(tokenWatch.map((w) => Object.freeze({ ...w }))),
    });
    this.plans.set(hash, { built: out, at: now, used: false });
    this.sweep(now);
    return out;
  }

  /**
   * task-1363: a DEVNET FILL for the capped FAST WALLET — what an armed order plan executes when it fires on
   * devnet. Jupiter has no devnet, so the transaction is the probe's wrap-and-unwrap shape sized to the plan's
   * SOL leg (`lamports`), with a memo naming the plan leg; it runs the SAME pipeline as a swap or probe
   * (decode → probe-shape policy → simulate with token deltas → WSOL bound → hash; at confirm: fast-wallet
   * signature → compare → verify → policy → re-simulate → caps → submit → confirm → book), and the fast lane
   * enforces the USD per-trade/daily caps even on devnet plus a hard SOL-per-fill ceiling.
   * Refused (throws, fail closed) without a fast signer, off devnet, or without a probe builder; an over-ceiling
   * size is built with a `sol-out-cap` policy refusal so the caller can see why, and is never confirmable.
   */
  async buildFill(args: { lamports: bigint; mint: string; symbol: string; decimals: number; side: PaperOrder['side']; ref: string }): Promise<BuiltPlan> {
    const panic = this.killSwitch.engaged();
    if (panic) throw new Error(`live trading is PANICKED (${panic.reason}); run \`trenchscope wallet resume\` to re-enable`);
    const fast = this.d.fastSigner;
    if (!fast) throw new Error('no fast wallet: create one with `trenchscope wallet fast create` (devnet)');
    if (!this.d.probe) throw new Error('no probe builder configured');
    if (rpcNetworkOf(this.d.rpc) !== 'devnet') throw new Error('devnet fills run only against a devnet RPC endpoint');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(args.mint)) throw new Error('buildFill needs a base58 mint');
    if (!(args.lamports > 0n)) throw new Error('buildFill needs a positive SOL leg');
    const user = fast.publicKey;
    const ref = args.ref.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
    const now = this.clock.now();
    const overCap = args.lamports > FAST_MAX_SOL_PER_FILL_LAMPORTS;
    // An over-ceiling leg is never built as a signable transaction: the plan carries the refusal and no bytes.
    const built = overCap ? null : await this.d.probe.build(user, { lamports: args.lamports, memo: `trenchscope devnet fill ${ref}` });
    const decoded = built ? decodeTransaction(Buffer.from(built.txBase64, 'base64')) : null;
    const txDigest = decoded ? digest(decoded.message) : 'no-tx';
    let txPolicy: TxPolicyVerdict = overCap
      ? { ok: false, reason: 'sol-out-cap', message: `a fast-wallet fill may move at most ${FAST_MAX_SOL_PER_FILL} SOL (asked ${lamportsToSol(args.lamports).toFixed(4)})` }
      : { ok: true };
    let sim: SimResult | null = null;
    let solOut: bigint | null = null;
    let tokenWatch: TokenWatch[] = [];
    if (decoded && built) {
      const pol = checkTxPolicyWith(decoded, user, this.allowed, { kind: 'probe' });
      if (!pol.ok) txPolicy = { ok: false, reason: pol.reason, message: pol.message };
      else {
        const tw = await this.tokenWatchFor(user, decoded);
        if (!tw.ok) txPolicy = { ok: false, reason: 'token-delta-unknown', message: tw.message };
        else {
          tokenWatch = tw.watch;
          const r = await this.simulateWithDelta(built.txBase64, user, tokenWatch, { side: 'buy', mint: WSOL_MINT, amountRaw: built.lamports });
          sim = r.sim; solOut = r.solOut;
          if (r.sim.ok && !r.tokens.ok) txPolicy = { ok: false, reason: r.tokens.reason, message: r.tokens.message };
          else if (r.sim.ok && r.tokens.ok && r.tokens.wsolLost > 0n) {
            const wb = checkWsolBound('buy', solOut, r.tokens.wsolLost, built.lamports, SOL_OVERHEAD_ALLOWANCE_LAMPORTS);
            if (!wb.ok) txPolicy = { ok: false, reason: wb.reason, message: wb.message };
          }
        }
      }
    }
    const solUsd = resolveSolUsd(this.d.solUsd?.(), now, 'devnet');
    const plan: TradePlan = Object.freeze({
      network: 'devnet' as const, mint: args.mint, symbol: args.symbol.replace(/[^\x20-\x7e]/g, '?').slice(0, 16) || args.mint.slice(0, 4), side: args.side,
      amountInRaw: args.lamports, amountOutRaw: args.lamports, slippageBps: 0, route: Object.freeze(['devnet-fill']) as unknown as string[],
      priceImpactPct: 0, notionalUsd: notionalUsd('buy', args.lamports, solOut, solUsd), simulated: sim !== null, simOk: sim?.ok ?? false,
      simError: sim === null ? null : sim.ok ? null : safeErr(sim.err), solOutLamports: solOut, solLegLamports: args.lamports, txPolicy,
    });
    const hash = createHash('sha256').update(`fill|${ref}|${bindHash(plan, txDigest)}`).digest('hex');
    const order: PaperOrder = { mint: args.mint, symbol: plan.symbol, side: args.side, decimals: args.decimals, amountRaw: args.lamports, slippageBps: 0 };
    const quote: SwapQuote = {
      inputMint: WSOL_MINT, outputMint: WSOL_MINT, inAmount: args.lamports, outAmount: args.lamports, otherAmountThreshold: args.lamports,
      mode: 'ExactIn', slippageBps: 0, priceImpactPct: 0, route: [], platformFeeBps: null, platformFeeAmount: null, usdValue: null, contextSlot: 0,
      source: 'jupiter-swap', fetchedAt: now,
    };
    const out: BuiltPlan = Object.freeze({
      kind: 'devnet-fill' as const, lane: 'fast' as const, ref, plan, hash, txDigest, unsignedTxBase64: built?.txBase64 ?? '', order, quote, userPublicKey: user,
      solUsd, builtAt: now, decoded, expect: null, instructions: decoded ? summarize(decoded) : [],
      feeLamports: BigInt(5000 * (decoded?.numRequiredSignatures ?? 1)), prioritizationFeeLamports: null,
      tokenWatch: Object.freeze(tokenWatch.map((w) => Object.freeze({ ...w }))),
    });
    this.plans.set(hash, { built: out, at: now, used: false });
    this.sweep(now);
    return out;
  }

  /** task-1363: the fast lane's own ceiling on the SOL a fill may move, checked at precheck and on the signed bytes. */
  private fastLaneCheck(plan: TradePlan): { ok: true } | { ok: false; reason: CapRefusal; message: string } {
    if (plan.network !== 'devnet') return { ok: false, reason: 'network-mismatch', message: 'the fast wallet fills only on devnet' };
    if (plan.solLegLamports > FAST_MAX_SOL_PER_FILL_LAMPORTS) return { ok: false, reason: 'sol-out-cap', message: `a fast-wallet fill may move at most ${FAST_MAX_SOL_PER_FILL} SOL` };
    if (typeof plan.solOutLamports === 'bigint' && plan.solOutLamports > FAST_MAX_SOL_PER_FILL_LAMPORTS + SOL_OVERHEAD_ALLOWANCE_LAMPORTS) return { ok: false, reason: 'sol-out-cap', message: `the simulation moves ${lamportsToSol(plan.solOutLamports).toFixed(4)} SOL out of the fast wallet; ceiling ${FAST_MAX_SOL_PER_FILL} SOL` };
    return { ok: true };
  }

  /**
   * Pre-balance + simulate with the user's post-balance → SOL that left the wallet (negative = came in),
   * plus (task-1337) the post-balances of the watched token accounts, diffed against the order.
   */
  private async simulateWithDelta(txBase64: string, user: string, watch: readonly TokenWatch[], order: { side: PaperOrder['side']; mint: string; amountRaw: bigint }): Promise<{ sim: SimResult; solOut: bigint | null; tokens: TokenDeltaResult }> {
    const pre = await this.d.rpc.balance(user);
    let sim: SimResult;
    try {
      sim = await this.d.rpc.simulate(txBase64, { accounts: [user, ...watch.map((w) => w.address)] });
    } catch (e) {
      // task-1337 (seen in the real app on devnet): the node may answer simulateTransaction with a JSON-RPC
      // error instead of `value.err` (e.g. "invalid transaction" when a mainnet Jupiter route is simulated
      // against devnet). That IS a failed simulation: record it so the PLAN screen shows it and the caps
      // refuse it ('simulation-failed'), rather than surfacing as an opaque build error. Transport errors
      // still throw (fail closed).
      if (!(e instanceof RpcRejectedError)) throw e;
      sim = { ok: false, err: e.message, logs: null, unitsConsumed: null, accounts: null, accountsData: null };
    }
    const post = sim.accounts?.[0] ?? null;
    const solOut = sim.ok && typeof pre === 'bigint' && typeof post === 'bigint' ? pre - post : null;
    const tokens = checkTokenDeltas(order.side, order.mint, order.amountRaw, watch, postBalances(watch, sim.accountsData ?? null, 1));
    return { sim, solOut, tokens };
  }

  /**
   * task-1337: the wallet's token accounts (both token programs) to watch through the simulation, and the
   * transaction's full account set (static keys + resolved address-lookup tables) so "referenced by the
   * transaction" is exact. Anything that cannot be read is a refusal (fail closed), never a shrug.
   */
  private async tokenWatchFor(user: string, decoded: DecodedTransaction): Promise<{ ok: true; watch: TokenWatch[] } | { ok: false; message: string }> {
    const rpc = this.d.rpc as Partial<TradeRpc>;
    if (typeof rpc.tokenAccountsByOwner !== 'function' || typeof rpc.accountsInfo !== 'function') return { ok: false, message: 'the RPC client cannot read token accounts; refusing' };
    try {
      const [spl, t22] = await Promise.all([
        rpc.tokenAccountsByOwner.call(this.d.rpc, user, TOKEN_PROGRAM),
        rpc.tokenAccountsByOwner.call(this.d.rpc, user, TOKEN_2022_PROGRAM),
      ]);
      // Nothing to protect (the wallet holds no token account besides wrapped SOL) → nothing to watch;
      // the lookup tables only matter for deciding what a watched account's missing post-state means.
      if (buildTokenWatch(user, [...spl, ...t22], new Set()).length === 0) return { ok: true, watch: [] };
      const tables = new Map<string, string[]>();
      const tableKeys = [...new Set(decoded.lookups.map((l) => l.table))];
      if (tableKeys.length > 0) {
        const infos = await rpc.accountsInfo.call(this.d.rpc, tableKeys);
        tableKeys.forEach((t, i) => { const parsed = parseLookupTable(infos[i]?.data); if (parsed) tables.set(t, parsed); });
      }
      const referenced = referencedAccounts(decoded, tables);
      if (!referenced) return { ok: false, message: 'an address-lookup table the transaction loads could not be read; refusing' };
      const watch = buildTokenWatch(user, [...spl, ...t22], referenced);
      // task-1337 F3: if the transaction references more of the wallet's own token accounts than one
      // simulation can carry, the watch list cannot cover them all — refuse rather than drop any.
      if (referencedOverCap(watch)) return { ok: false, message: `the transaction references more of the wallet's token accounts than one simulation can watch (${MAX_TOKEN_WATCH}); refusing` };
      return { ok: true, watch };
    } catch (e) {
      return { ok: false, message: `could not read the wallet's token accounts: ${safeErr(e)}` };
    }
  }

  /** The confirm step re-reads the watched accounts' balances (they may have moved since the plan). */
  private async refreshTokenWatch(watch: readonly TokenWatch[]): Promise<TokenWatch[] | null> {
    if (watch.length === 0) return [];
    const rpc = this.d.rpc as Partial<TradeRpc>;
    if (typeof rpc.accountsInfo !== 'function') return null;
    try {
      return refreshWatch(watch, await rpc.accountsInfo.call(this.d.rpc, watch.map((w) => w.address)));
    } catch {
      return null;
    }
  }

  private sweep(now: number): void {
    for (const [h, r] of this.plans) if (r.used || now - r.at > PLAN_TTL_MS) this.plans.delete(h);
  }

  /** The caps/plan verdict for a built plan, so the UI can show "will be refused: …" before the keypress. */
  precheck(built: BuiltPlan): { ok: boolean; reason?: CapRefusal; message?: string } {
    const reg = this.plans.get(built.hash);
    const b = reg ? reg.built : built;
    if (this.killSwitch.engaged() || this.d.ledger.locked()) return { ok: false, reason: 'panicked', message: 'live trading is panicked' };
    const fast = b.lane === 'fast';
    if (fast) {
      if (!this.d.fastSigner || b.userPublicKey !== this.d.fastSigner.publicKey) return { ok: false, reason: 'signer-mismatch', message: 'the fast wallet is not available for this plan' };
      const f = this.fastLaneCheck(b.plan); if (!f.ok) return f;
    }
    return checkCaps(b.plan, this.d.caps, this.d.ledger.spentToday(), { enforceUsd: fast });
  }

  /**
   * Step 2 (after the physical keypress): look the plan up, re-check caps + reserve, then sign via the
   * wallet bridge, verify + re-simulate the signed bytes, submit and confirm, and record the fill.
   * `confirmedHash` is the hash the UI showed the user; it must name a plan THIS executor built.
   */
  async confirmAndSubmit(built: BuiltPlan, confirmedHash: string, userPublicKey: string): Promise<SubmitOutcome> {
    const started = this.clock.now();
    const refusal = (reason: CapRefusal, message: string): SubmitOutcome => ({ kind: 'refused', reason, message });

    // Plan-hash binding (incl. tx bytes, DEFECT 2) against the executor's OWN registry: an edited or
    // rebuilt plan, a rebound digest, an unknown or already-used hash → refuse.
    const reg = this.plans.get(confirmedHash);
    if (!reg || built.hash !== confirmedHash || reg.used) {
      return refusal('plan-mismatch', 'the plan changed after it was shown (or was already confirmed); confirm again');
    }
    const b = reg.built; // trusted frozen copy; `built` is not used past this point
    if (started - reg.at > PLAN_TTL_MS) {
      this.plans.delete(confirmedHash);
      return refusal('plan-expired', `the plan is older than ${PLAN_TTL_MS / 1000} s; rebuild it`);
    }
    const expectHash = b.kind === 'probe' ? createHash('sha256').update(`probe|${bindHash(b.plan, b.txDigest)}`).digest('hex')
      : b.kind === 'devnet-fill' ? createHash('sha256').update(`fill|${b.ref ?? ''}|${bindHash(b.plan, b.txDigest || 'no-tx')}`).digest('hex')
      : bindHash(b.plan, b.txDigest || 'no-tx');
    if (expectHash !== b.hash) return refusal('plan-mismatch', 'plan binding broken');
    if (userPublicKey !== b.userPublicKey) return refusal('signer-mismatch', 'the confirm names a different wallet than the plan');

    // task-1363: lane routing. A fast-lane plan is signed ONLY by the fast wallet it was built for, and the
    // fast wallet NEVER signs a main-lane plan (the user's wallet approves those in Phantom). Either mismatch
    // is a refusal before caps, reservation or signing.
    const fast = b.lane === 'fast';
    const fastSigner = this.d.fastSigner ?? null;
    if (fast && (!fastSigner || fastSigner.publicKey !== b.userPublicKey)) return refusal('signer-mismatch', 'this fast-lane plan is not for the loaded fast wallet');
    if (!fast && fastSigner && fastSigner.publicKey === b.userPublicKey) return refusal('signer-mismatch', 'the fast wallet never signs a main-lane plan');
    if (fast) { const f = this.fastLaneCheck(b.plan); if (!f.ok) return refusal(f.reason, f.message); }

    const panic = this.killSwitch.engaged();
    if (panic) return refusal('panicked', `live trading is panicked (${panic.reason})`);
    const lock = this.d.ledger.locked();
    if (lock) return refusal('panicked', `the cap ledger is locked (${lock.reason})`);

    // Round 2: the network is re-derived at submit, not trusted from the plan.
    if (b.plan.network === 'devnet' && rpcNetworkOf(this.d.rpc) === 'mainnet') {
      return refusal('network-mismatch', 'the RPC endpoint is mainnet but the plan was built as devnet');
    }

    // DEFECT 5 / round 2: re-check caps AND reserve the USD atomically (ledger transaction) under the
    // in-process mutex. The reserve is charged BEFORE signing/submitting; it is refunded ONLY when the
    // send definitely never left.
    const caps = effectiveCaps(this.d.caps);
    // USD is reserved on mainnet, and (task-1363) on the fast lane even on devnet: a mandate fill counts against
    // the signer's per-trade and daily USD caps exactly as a real swap would.
    const usdLane = b.plan.network === 'mainnet' || fast;
    const reserveUsd = (usdLane && b.plan.notionalUsd !== null && b.plan.notionalUsd > 0) ? b.plan.notionalUsd : 0;
    const gate = await this.runExclusive<{ ok: true; day: string } | { ok: false; reason: CapRefusal; message: string }>(() => {
      if (reg.used) return { ok: false, reason: 'plan-mismatch', message: 'the plan was already confirmed' };
      const check = checkCaps(b.plan, this.d.caps, this.d.ledger.spentToday(), { enforceUsd: fast });
      if (!check.ok) return { ok: false, reason: check.reason as CapRefusal, message: check.message ?? 'refused by caps' };
      const res = this.d.ledger.tryReserve(reserveUsd, caps.dailyUsd, this.clock.now());
      if (!res.ok) {
        return res.reason === 'panicked'
          ? { ok: false, reason: 'panicked', message: 'the cap ledger is locked' }
          : { ok: false, reason: 'daily-cap', message: `trade $${reserveUsd.toFixed(2)} would exceed today's remaining budget ($${Math.max(0, caps.dailyUsd - res.spent).toFixed(2)} of $${caps.dailyUsd.toFixed(2)})` };
      }
      reg.used = true; // single-use from here on (a double keypress gets 'plan-mismatch')
      this.plans.delete(confirmedHash);
      return { ok: true, day: res.day };
    });
    if (!gate.ok) return refusal(gate.reason, gate.message);

    let reserved = reserveUsd;
    const refund = () => { if (reserved > 0) { this.d.ledger.refund(reserved, gate.day); reserved = 0; } };

    // Hand the unsigned tx to the wallet for signing. Main lane: Phantom in the browser (the physical
    // confirmation; keys never enter dexterm). Fast lane (task-1363): the capped devnet fast wallet signs
    // locally — the keypress that armed the plan into its mandate was the physical confirmation.
    let signedTxBase64: string;
    try {
      const signer = fast ? fastSigner! : this.d.bridge;
      const signed = await signer.signTransaction({ unsignedTxBase64: b.unsignedTxBase64, expectPublicKey: userPublicKey, label: `${b.plan.side} ${b.plan.symbol}` });
      signedTxBase64 = signed.signedTxBase64;
    } catch (e) {
      refund();
      return { kind: 'send-failed', signature: null, error: `wallet sign failed: ${safeErr(e)}` };
    }

    // DEFECT 2 + round 2: the signed tx must carry the SAME message that was simulated and approved, a
    // VALID Ed25519 signature by the linked wallet, and pass the same static policy. A wallet (or a
    // compromised bridge) that returns anything else is refused — the bytes never reach the chain.
    let signedTx: DecodedTransaction;
    try {
      signedTx = decodeTransaction(Buffer.from(signedTxBase64, 'base64'));
    } catch (e) {
      refund();
      return refusal('tx-mismatch', `the signed transaction could not be decoded: ${safeErr(e)}`);
    }
    // task-1328: exact bytes, or the approved message plus an APPENDED Lighthouse assertion tail (what
    // Phantom may add). Anything else is a different transaction.
    if (!b.decoded) { refund(); return refusal('tx-mismatch', 'the plan carries no approved transaction'); }
    const cmp = compareApprovedMessage(b.decoded, signedTx);
    if (!cmp.ok) {
      refund();
      return refusal('tx-mismatch', `the signed transaction does not match the approved plan: ${cmp.message}`);
    }
    const sigCheck = verifyUserSignature(signedTx, userPublicKey);
    if (!sigCheck.ok) {
      refund();
      return refusal('bad-signature', sigCheck.message);
    }
    const pol = checkTxPolicyWith(signedTx, userPublicKey, this.allowed, { kind: policyKind(b.kind), lighthouseTail: cmp.lighthouseTail > 0 });
    if (!pol.ok) {
      refund();
      return refusal(pol.reason, pol.message);
    }
    if (b.kind === 'swap' && b.expect) {
      const bound = checkSwapBinding(signedTx, b.expect);
      if (!bound.ok) { refund(); return refusal(bound.reason, bound.message); }
    }

    // Round 2 (SPEC §6.2 "re-simulates every transaction it is asked to sign"): simulate the SIGNED
    // bytes and compare the SOL delta with the plan. More SOL out than planned (+ fee allowance), or
    // more than the SOL cap, or a now-failing simulation → refuse, nothing submitted.
    let resim: { sim: SimResult; solOut: bigint | null; tokens: TokenDeltaResult };
    try {
      // task-1337: fresh token pre-balances (the wallet may have moved since the plan), then the same diff.
      const watch = await this.refreshTokenWatch(b.tokenWatch);
      if (watch === null) { refund(); return refusal('token-delta-unknown', 'could not re-read the wallet\'s token accounts before signing off'); }
      resim = await this.simulateWithDelta(signedTxBase64, userPublicKey, watch, { side: b.order.side, mint: b.order.mint, amountRaw: b.order.amountRaw });
    } catch (e) {
      refund();
      return refusal('simulation-failed', `re-simulation failed: ${safeErr(e)}`);
    }
    if (!resim.sim.ok) { refund(); return refusal('simulation-failed', `re-simulation failed: ${safeErr(resim.sim.err)}`); }
    if (resim.solOut === null) { refund(); return refusal('sol-delta-unknown', 're-simulation reported no wallet balance change'); }
    if (!resim.tokens.ok) { refund(); return refusal(resim.tokens.reason, `re-simulation: ${resim.tokens.message}`); }
    // task-1337 F2: the signed bytes must not drain pre-existing wrapped SOL beyond the plan's SOL leg.
    const wsolBound = checkWsolBound(b.plan.side, resim.solOut, resim.tokens.wsolLost, b.plan.solLegLamports, SOL_OVERHEAD_ALLOWANCE_LAMPORTS);
    if (!wsolBound.ok) { refund(); return refusal(wsolBound.reason, `re-simulation: ${wsolBound.message}`); }
    if (resim.solOut > b.plan.solLegLamports + SOL_OVERHEAD_ALLOWANCE_LAMPORTS) {
      refund();
      return refusal('sol-out-cap', `re-simulation moves ${lamportsToSol(resim.solOut).toFixed(4)} SOL out but the plan is ${lamportsToSol(b.plan.solLegLamports).toFixed(4)} SOL`);
    }
    if (resim.solOut > BigInt(Math.round(caps.maxSolOut * 1e9))) {
      refund();
      return refusal('sol-out-cap', `re-simulation moves ${lamportsToSol(resim.solOut).toFixed(4)} SOL out; cap ${caps.maxSolOut} SOL`);
    }
    if (fast && resim.solOut > FAST_MAX_SOL_PER_FILL_LAMPORTS + SOL_OVERHEAD_ALLOWANCE_LAMPORTS) {
      refund();
      return refusal('sol-out-cap', `re-simulation moves ${lamportsToSol(resim.solOut).toFixed(4)} SOL out of the fast wallet; ceiling ${FAST_MAX_SOL_PER_FILL} SOL`);
    }
    // Mainnet (and the fast lane): re-price with the CURRENT feed; if the trade now prices higher, the extra must also fit.
    if (usdLane) {
      const nowUsd = notionalUsd(b.plan.side, b.plan.solLegLamports, resim.solOut, resolveSolUsd(this.d.solUsd?.(), this.clock.now(), b.plan.network));
      if (nowUsd === null) { refund(); return refusal('no-usd-value', 'the SOL/USD feed is no longer trustworthy'); }
      if (nowUsd > caps.perTradeUsd) { refund(); return refusal('per-trade-cap', `trade now $${nowUsd.toFixed(2)} exceeds the per-trade cap $${caps.perTradeUsd.toFixed(2)}`); }
      if (nowUsd > reserved) {
        const extra = nowUsd - reserved;
        const more = this.d.ledger.tryReserve(extra, caps.dailyUsd, this.clock.now());
        if (!more.ok) { refund(); return refusal(more.reason === 'panicked' ? 'panicked' : 'daily-cap', 'the re-priced trade no longer fits today\'s budget'); }
        reserved += extra;
      }
    }

    // Submit. Round 2 (re-verify MEDIUM #4): refund ONLY on a definite JSON-RPC rejection. On a
    // transport error the node may already have the tx; keep the reservation and ask about the
    // signature we know from the signed bytes before deciding.
    const knownSignature = base58(signedTx.signatures[0]);
    let signature: string;
    try {
      signature = await this.d.rpc.submit(signedTxBase64);
    } catch (e) {
      if (e instanceof RpcRejectedError) {
        refund();
        return { kind: 'send-failed', signature: null, error: `rejected before broadcast: ${safeErr(e)}` };
      }
      const seen = await this.lookup(knownSignature);
      if (seen === 'unknown' || seen === null) {
        return { kind: 'send-unknown', signature: knownSignature, error: `submit did not complete (${safeErr(e)}); the transaction may still land — do not resend` };
      }
      signature = knownSignature; // the node has it: continue to confirmation
    }

    // Past this point the tx IS (or may be) broadcast: the USD charge stands even if confirmation times
    // out (DEFECT 5 — a timed-out send must still count against the daily budget; funds may have moved).
    let conf;
    try {
      conf = await this.d.rpc.confirm(signature);
    } catch (e) {
      return { kind: 'send-unknown', signature, error: `could not read confirmation: ${safeErr(e)}` };
    }
    if (!conf.confirmed) {
      const timedOut = typeof conf.err === 'string' && /timed out/.test(conf.err);
      return timedOut
        ? { kind: 'send-unknown', signature, error: 'confirmation timed out; the transaction may still land — do not resend' }
        : { kind: 'send-failed', signature, error: `failed on chain: ${safeErr(conf.err)}` };
    }

    // Record the fill (positions/PnL). The daily USD was already reserved at send; do NOT charge twice.
    // The SOL leg is what the RE-SIMULATION of the signed bytes moved (not the quote); the token leg is
    // the quoted amount. True on-chain deltas (getTransaction) are a follow-up noted in the handoff.
    const fill = computeFill(b.order, b.quote, this.clock.now());
    // A probe or a devnet fill moves no tokens: what left the fast/main wallet is fees (the wrap is closed back).
    const booked: Fill = b.kind === 'probe' || b.kind === 'devnet-fill'
      ? { ...fill, tokenDelta: 0n, solDelta: -resim.solOut, grossLamports: 0n, feeLamports: resim.solOut, route: [...b.plan.route] }
      : { ...fill, solDelta: b.plan.side === 'buy' ? -resim.solOut : -resim.solOut, feeLamports: b.plan.side === 'buy' ? (resim.solOut > fill.grossLamports ? resim.solOut - fill.grossLamports : 0n) : fill.feeLamports };
    this.d.liveLedger?.record({ fill: booked, network: b.plan.network, signature, usd: b.plan.notionalUsd, kind: b.kind });
    return { kind: 'filled', signature, fill: booked, roundTripMs: this.clock.now() - started, lighthouseTail: cmp.lighthouseTail };
  }

  /** Did the node see this signature? 'unknown' when the lookup itself failed. */
  private async lookup(signature: string): Promise<'unknown' | null | { confirmationStatus: string | null }> {
    const rpc = this.d.rpc as Partial<TradeRpc>;
    if (typeof rpc.signatureStatus !== 'function') return 'unknown';
    try {
      return await rpc.signatureStatus.call(this.d.rpc, signature);
    } catch {
      return 'unknown';
    }
  }
}

// --------------------------------------------------------------------------- helpers (pure)

function rpcNetworkOf(rpc: TradeRpc): TradeNetwork {
  const explicit = (rpc as Partial<TradeRpc>).network;
  return rpcNetwork(rpc.url, explicit === 'devnet' || explicit === 'mainnet' ? explicit : null);
}

/** Round 2 HIGH #1: the normalized quote must describe exactly the order's swap (mints, mode, amount). */
function bindQuote(quote: SwapQuote, req: QuoteRequest): TxPolicyVerdict {
  const bad = (message: string): TxPolicyVerdict => ({ ok: false, reason: 'quote-mismatch', message });
  if (quote.inputMint !== req.inputMint) return bad(`quote input mint ${quote.inputMint} is not ${req.inputMint}`);
  if (quote.outputMint !== req.outputMint) return bad(`quote output mint ${quote.outputMint} is not ${req.outputMint}`);
  if (quote.mode !== 'ExactIn') return bad(`quote mode ${quote.mode} is not ExactIn`);
  if (quote.inAmount !== req.amount) return bad(`quote inAmount ${quote.inAmount} is not the order amount ${req.amount}`);
  if (quote.outAmount <= 0n) return bad('quote outAmount is not positive');
  return { ok: true };
}

/** The SOL leg in lamports: the order amount for a buy; for a sell the larger of quoted and simulated SOL in. */
function solLegLamports(order: PaperOrder, quote: SwapQuote, solOut: bigint | null): bigint {
  if (order.side === 'buy') return order.amountRaw;
  const simIn = solOut !== null && solOut < 0n ? -solOut : 0n;
  return quote.outAmount > simIn ? quote.outAmount : simIn;
}

/**
 * USD notional priced LOCALLY: the larger of the planned SOL leg and what the simulation actually moved
 * out of the wallet (a buy), times the resolved SOL/USD. null when no trustworthy price → refused on mainnet.
 */
function notionalUsd(side: PaperOrder['side'], solLeg: bigint, solOut: bigint | null, usd: SolUsdResolution): number | null {
  if (usd.price === null) return null;
  let lamports = solLeg;
  if (side === 'buy' && solOut !== null && solOut > lamports) lamports = solOut;
  const sol = lamportsToSol(lamports);
  if (!Number.isFinite(sol) || sol < 0) return null;
  const out = sol * usd.price;
  return Number.isFinite(out) ? out : null;
}

/** Ed25519-verify the user's signature slot over the message. The fee payer (key 0) is the user. */
function verifyUserSignature(tx: DecodedTransaction, userPublicKey: string): { ok: true } | { ok: false; message: string } {
  const idx = tx.staticKeys.indexOf(userPublicKey);
  if (idx < 0 || idx >= tx.numRequiredSignatures) return { ok: false, message: 'the linked wallet is not a signer of this transaction' };
  const sig = tx.signatures[idx];
  if (!sig || sig.length !== 64 || sig.every((x) => x === 0)) return { ok: false, message: 'the wallet returned no signature' };
  let pk: Buffer;
  try { pk = Buffer.from(base58Decode(userPublicKey)); } catch { return { ok: false, message: 'bad wallet public key' }; }
  if (pk.length !== 32) return { ok: false, message: 'bad wallet public key' };
  let good = false;
  try { good = verifyEd25519(pk, tx.message, sig); } catch { good = false; }
  return good ? { ok: true } : { ok: false, message: 'the signature does not verify against the linked wallet' };
}

/**
 * Bind the confirm to both the trade's material fields and the exact transaction message (DEFECT 2).
 * planHash covers mint/size/route/side/network/SOL deltas; the tx digest covers the actual bytes.
 */
function bindHash(plan: TradePlan, txDigest: string): string {
  return createHash('sha256').update(`${planHash(plan)}|${txDigest}`).digest('hex');
}

const PROGRAM_NAMES: Readonly<Record<string, string>> = Object.freeze({
  [SYSTEM_PROGRAM]: 'System', [COMPUTE_BUDGET_PROGRAM]: 'ComputeBudget', [MEMO_PROGRAM]: 'Memo', [JUPITER_V6_PROGRAM]: 'Jupiter',
  [ASSOCIATED_TOKEN_PROGRAM]: 'AssociatedToken', [LIGHTHOUSE_PROGRAM]: 'Lighthouse',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token', TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
});
const TOKEN_OPS: Readonly<Record<number, string>> = Object.freeze({ 1: 'InitializeAccount', 9: 'CloseAccount→wallet', 16: 'InitializeAccount2', 17: 'SyncNative', 18: 'InitializeAccount3' });

/** Human summary of the top-level instructions ("what will be signed"), for the PLAN screen. */
export function summarize(tx: DecodedTransaction): InstructionSummary[] {
  return tx.instructions.map((ix) => {
    const program = ix.programId ? (PROGRAM_NAMES[ix.programId] ?? `${ix.programId.slice(0, 4)}…${ix.programId.slice(-4)}`) : 'lookup-table program';
    let op = '';
    if (ix.programId === JUPITER_V6_PROGRAM) op = JUPITER_ROUTE_DISCRIMINATORS.get(ix.data.subarray(0, 8).toString('hex')) ?? 'unknown';
    else if (ix.programId === SYSTEM_PROGRAM) op = ix.data.length >= 4 && ix.data.readUInt32LE(0) === 2 ? 'Transfer→own WSOL' : `op ${ix.data.length >= 4 ? ix.data.readUInt32LE(0) : '?'}`;
    else if (ix.programId === COMPUTE_BUDGET_PROGRAM) op = ix.data[0] === 2 ? 'SetComputeUnitLimit' : ix.data[0] === 3 ? 'SetComputeUnitPrice' : `op ${ix.data[0]}`;
    else if (ix.programId === ASSOCIATED_TOKEN_PROGRAM) op = ix.data.length === 0 || ix.data[0] === 0 ? 'Create' : 'CreateIdempotent';
    else if (program === 'Token' || program === 'Token-2022') op = TOKEN_OPS[ix.data[0]] ?? `op ${ix.data[0]}`;
    else if (ix.programId === LIGHTHOUSE_PROGRAM) op = 'assertion';
    else if (ix.programId === MEMO_PROGRAM) op = 'memo';
    return { program, op };
  });
}

function digest(message: Buffer): string {
  return createHash('sha256').update(message).digest('hex');
}

function safeErr(e: unknown): string {
  if (e === null || e === undefined) return 'unknown';
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e).slice(0, 200); } catch { return String(e); }
}

// --------------------------------------------------------------------------- live fill ledger
// Confirmed REAL fills, kept separate from the paper wallet so they never mix. Reuses the paper
// fill math for display. This card books devnet-first and no real mainnet trade runs here, so this
// is a thin record + history; deeper live PnL aggregation is a follow-up (noted in the handoff).

export interface LiveFillRow {
  id: number; t: number; network: TradeNetwork; signature: string;
  mint: string; symbol: string; side: string; solDelta: string; tokenDelta: string;
  priceSol: number; usd: number | null;
  decimals: number; feeLamports: string; realizedLamports: string; kind: PlanKind;
}

/** Where the signer keeps confirmed REAL fills (the UI reads it read-only for positions). */
export function defaultLiveLedgerPath(): string {
  return join(homedir(), '.dexterm', 'live-trades.sqlite');
}

export class LiveLedger {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(opts: { path?: string; clock?: Clock; readOnly?: boolean } = {}) {
    const path = opts.path ?? ':memory:';
    if (path !== ':memory:' && !opts.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = opts.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    this.clock = opts.clock ?? systemClock;
    if (!opts.readOnly) {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS live_trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, network TEXT NOT NULL, signature TEXT NOT NULL,
          mint TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
          sol_delta TEXT NOT NULL, token_delta TEXT NOT NULL, price_sol REAL NOT NULL, usd REAL
        );
        CREATE INDEX IF NOT EXISTS live_trades_mint ON live_trades(mint, id);
      `);
      // task-1328 columns (positions need decimals + fee; realized is booked per sell). Additive migration.
      const cols = new Set((this.db.prepare('PRAGMA table_info(live_trades)').all() as { name: string }[]).map((c) => c.name));
      if (!cols.has('decimals')) this.db.exec('ALTER TABLE live_trades ADD COLUMN decimals INTEGER NOT NULL DEFAULT 9');
      if (!cols.has('fee_lamports')) this.db.exec("ALTER TABLE live_trades ADD COLUMN fee_lamports TEXT NOT NULL DEFAULT '0'");
      if (!cols.has('realized_lamports')) this.db.exec("ALTER TABLE live_trades ADD COLUMN realized_lamports TEXT NOT NULL DEFAULT '0'");
      if (!cols.has('kind')) this.db.exec("ALTER TABLE live_trades ADD COLUMN kind TEXT NOT NULL DEFAULT 'swap'");
    }
  }

  /** Book a confirmed fill. A sell's realized PnL is computed against the position this ledger holds. */
  record(args: { fill: Fill; network: TradeNetwork; signature: string; usd: number | null; kind?: PlanKind }): void {
    const f = args.fill;
    let realized = 0n;
    if (f.side === 'sell' && (args.kind ?? 'swap') === 'swap') {
      const pos = this.position(f.mint) ?? emptyPosition(f.mint, f.symbol, f.decimals, f.t);
      realized = applySell(pos, f).realizedLamports;
    }
    this.db.prepare(`INSERT INTO live_trades (t, network, signature, mint, symbol, side, sol_delta, token_delta, price_sol, usd, decimals, fee_lamports, realized_lamports, kind)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.t || this.clock.now(), args.network, args.signature, f.mint, f.symbol, f.side, f.solDelta.toString(), f.tokenDelta.toString(), f.priceSol, args.usd,
        f.decimals, f.feeLamports.toString(), realized.toString(), args.kind ?? 'swap');
  }

  trades(limit = 100): LiveFillRow[] {
    const rows = this.db.prepare('SELECT * FROM live_trades ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id), t: Number(r.t), network: String(r.network) as TradeNetwork, signature: String(r.signature),
      mint: String(r.mint), symbol: String(r.symbol), side: String(r.side),
      solDelta: String(r.sol_delta), tokenDelta: String(r.token_delta), priceSol: Number(r.price_sol),
      usd: r.usd === null ? null : Number(r.usd),
      decimals: Number(r.decimals ?? 9), feeLamports: String(r.fee_lamports ?? '0'), realizedLamports: String(r.realized_lamports ?? '0'),
      kind: (r.kind === 'probe' ? 'probe' : r.kind === 'devnet-fill' ? 'devnet-fill' : 'swap') as PlanKind,
    }));
  }

  /** Fills as TradeRecords (the shape the positions screen / popup fills already consume). Probes are excluded. */
  records(limit = 100, mint?: string): TradeRecord[] {
    return this.trades(limit * 2).filter((r) => r.kind === 'swap' && (mint === undefined || r.mint === mint)).slice(0, limit).map((r) => ({
      id: r.id, t: r.t, mint: r.mint, symbol: r.symbol, side: r.side as Fill['side'], decimals: r.decimals,
      solDelta: BigInt(r.solDelta), tokenDelta: BigInt(r.tokenDelta),
      grossLamports: (BigInt(r.solDelta) < 0n ? -BigInt(r.solDelta) : BigInt(r.solDelta)) - (r.side === 'buy' ? BigInt(r.feeLamports) : -BigInt(r.feeLamports)),
      feeLamports: BigInt(r.feeLamports), priceSol: r.priceSol, priceUsd: null, priceImpactPct: null, slippageBps: 0, route: [],
      realizedLamports: BigInt(r.realizedLamports), paper: true as const,
    }));
  }

  /** Open + closed positions aggregated from the fills (oldest → newest), swaps only. */
  positions(): Position[] {
    const rows = this.db.prepare("SELECT * FROM live_trades WHERE kind = 'swap' ORDER BY id ASC").all() as Record<string, unknown>[];
    const by = new Map<string, Position>();
    for (const r of rows) {
      const mint = String(r.mint);
      const fill: Fill = {
        t: Number(r.t), mint, symbol: String(r.symbol), side: String(r.side) as Fill['side'], decimals: Number(r.decimals ?? 9),
        solDelta: BigInt(String(r.sol_delta)), tokenDelta: BigInt(String(r.token_delta)), grossLamports: 0n, feeLamports: BigInt(String(r.fee_lamports ?? '0')),
        priceSol: Number(r.price_sol), priceUsd: null, priceImpactPct: null, slippageBps: 0, route: [], realizedLamports: 0n, paper: true,
      };
      const pos = by.get(mint) ?? emptyPosition(mint, fill.symbol, fill.decimals, fill.t);
      by.set(mint, fill.side === 'buy' ? applyBuy(pos, fill) : applySell(pos, fill).pos);
    }
    return [...by.values()];
  }

  position(mint: string): Position | null {
    return this.positions().find((p) => p.mint === mint) ?? null;
  }

  /** Net SOL moved across all recorded live fills (quick sanity surface for the status bar). */
  netSol(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(CAST(sol_delta AS INTEGER)),0) AS s FROM live_trades').get() as { s?: number };
    return lamportsToSol(BigInt(Math.trunc(Number(row?.s ?? 0))));
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}
