// trenchscope T2 — the SIGNER SERVICE (task-1328, SPEC §6.5). The policy-owning side of the trade: it holds
// the caps, the daily-cap ledger, the kill switch, the plan registry, the wallet bridge and the live
// fill ledger, and exposes exactly the small API the protocol names. It is transport-agnostic (the host
// serves it over the authenticated stdio channel; tests call it directly).
//
// What the UI can and cannot do through this surface:
//   * plan(order)   → the signer quotes, builds, decodes, policy-checks, BINDS and simulates ITS OWN
//                     transaction for the linked wallet it reads from ITS OWN link store; the UI gets a
//                     JSON view (no bytes) and a hash.
//   * confirm(hash) → the signer re-checks caps, reserves USD, opens the wallet page (the physical
//                     approval), verifies and re-simulates the signed bytes, submits, confirms, books.
//   * probe()       → the devnet plumbing transaction (never on mainnet).
//   * status / precheck / drop / panic.
//   There is no sign(bytes), no submit(bytes), no setCaps(), no way to name a different wallet.

import type { Clock } from '../../clock.ts';
import { systemClock } from '../../clock.ts';
import { LiveExecutor, PLAN_TTL_MS, LiveLedger, type BuiltPlan, type LiveExecutorDeps, type SubmitOutcome } from '../executor.ts';
import { effectiveCaps, HARD_MAX_SLIPPAGE_BPS, type TradeCaps, type CapRefusal } from '../caps.ts';
import { WalletLinkStore } from '../link-store.ts';
import { rpcNetwork } from '../rpc-exec.ts';
import { resolveSolUsd } from '../sol-usd.ts';
import type { SolUsdFeed } from './sol-usd-feed.ts';
import { FAST_MAX_SOL_PER_FILL, type FastWalletStore } from './fast-wallet.ts';
import type { PaperOrder, Fill } from '../../paper.ts';
import { SOL_MINT } from '../../paper.ts';
import { JupiterRateLimitedError, normalizeSwapQuote, type QuoteRequest } from '../../sources/jupiter-swap.ts';
import type { TradeRpc } from '../rpc-exec.ts';
import { SIGNER_PROTOCOL_VERSION, type PlanView, type ConfirmView, type StatusView, type VerdictView, type SolUsdView, type FillView, type FastView, type FillParams, type QuoteView } from './protocol.ts';

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HASH = /^[0-9a-f]{64}$/;

export class SignerError extends Error {
  readonly reason: CapRefusal | 'bad-request' | 'no-wallet' | 'no-fast-wallet' | 'panicked' | 'build-failed' | 'rate-limited';
  /** task-1368: for `rate-limited`, how long the caller should wait before asking again (ms). */
  readonly retryAfterMs?: number;
  constructor(reason: SignerError['reason'], message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'SignerError';
    this.reason = reason;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * task-1368: a build error that is really Jupiter rate limiting (the data layer's typed error after its bounded
 * retry) becomes `rate-limited` with the honest wait, so the ticket keeps the plan and retries; anything else is
 * `build-failed` as before. Never swallows: the message is the data layer's own.
 */
function buildError(e: unknown): SignerError {
  if (e instanceof JupiterRateLimitedError) return new SignerError('rate-limited', e.message, e.retryAfterMs);
  return new SignerError('build-failed', e instanceof Error ? e.message : String(e));
}

export interface SignerServiceDeps {
  executor: LiveExecutor;
  deps: LiveExecutorDeps;
  linkStore: WalletLinkStore;
  liveLedger: LiveLedger | null;
  solUsdFeed?: SolUsdFeed;
  clock?: Clock;
  /** task-1363: the fast wallet's on-disk record (public fields read for `fast`); the signer itself is in `deps.fastSigner`. */
  fastStore?: FastWalletStore;
  /** task-1368: diagnostics line sink (stderr in the real process → the terminal's app log). Never bytes or keys. */
  log?: (line: string) => void;
}

/** task-1363: validate an untrusted fill request. Anything off-shape is a bad request (never coerced). */
export function parseFillParams(p: unknown): FillParams {
  if (p === null || typeof p !== 'object') throw new SignerError('bad-request', 'fill params must be an object');
  const x = p as Record<string, unknown>;
  if (typeof x.ref !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(x.ref)) throw new SignerError('bad-request', 'ref must be 1..64 printable characters (planId:legKey)');
  if (typeof x.mint !== 'string' || !B58.test(x.mint)) throw new SignerError('bad-request', 'mint must be a base58 address');
  if (x.side !== 'buy' && x.side !== 'sell') throw new SignerError('bad-request', 'side must be buy or sell');
  if (typeof x.decimals !== 'number' || !Number.isInteger(x.decimals) || x.decimals < 0 || x.decimals > 18) throw new SignerError('bad-request', 'decimals must be an integer 0..18');
  if (typeof x.lamports !== 'string' || !/^[0-9]{1,19}$/.test(x.lamports) || BigInt(x.lamports) <= 0n) throw new SignerError('bad-request', 'lamports must be a positive integer string');
  const symbol = typeof x.symbol === 'string' ? x.symbol.replace(/[^\x20-\x7e]/g, '?').slice(0, 16) : '';
  return { ref: x.ref, mint: x.mint, symbol: symbol || x.mint.slice(0, 4), side: x.side, decimals: x.decimals, lamports: x.lamports };
}

export interface PlanParams { mint: string; symbol: string; side: 'buy' | 'sell'; decimals: number; amountRaw: string; slippageBps: number }

/** Validate an untrusted plan request. Anything off-shape is a bad request (never coerced). */
export function parsePlanParams(p: unknown): PlanParams {
  if (p === null || typeof p !== 'object') throw new SignerError('bad-request', 'plan params must be an object');
  const x = p as Record<string, unknown>;
  if (typeof x.mint !== 'string' || !B58.test(x.mint)) throw new SignerError('bad-request', 'mint must be a base58 address');
  if (x.side !== 'buy' && x.side !== 'sell') throw new SignerError('bad-request', 'side must be buy or sell');
  if (typeof x.decimals !== 'number' || !Number.isInteger(x.decimals) || x.decimals < 0 || x.decimals > 18) throw new SignerError('bad-request', 'decimals must be an integer 0..18');
  if (typeof x.amountRaw !== 'string' || !/^[0-9]{1,30}$/.test(x.amountRaw) || BigInt(x.amountRaw) <= 0n) throw new SignerError('bad-request', 'amountRaw must be a positive integer string');
  if (typeof x.slippageBps !== 'number' || !Number.isInteger(x.slippageBps) || x.slippageBps < 0 || x.slippageBps > HARD_MAX_SLIPPAGE_BPS) throw new SignerError('bad-request', `slippageBps must be an integer 0..${HARD_MAX_SLIPPAGE_BPS}`);
  const symbol = typeof x.symbol === 'string' ? x.symbol.replace(/[^\x20-\x7e]/g, '?').slice(0, 16) : '';
  return { mint: x.mint, symbol: symbol || x.mint.slice(0, 4), side: x.side, decimals: x.decimals, amountRaw: x.amountRaw, slippageBps: x.slippageBps };
}

export function parseHashParam(p: unknown): string {
  const h = p !== null && typeof p === 'object' ? (p as Record<string, unknown>).hash : undefined;
  if (typeof h !== 'string' || !HASH.test(h)) throw new SignerError('bad-request', 'hash must be a 64-hex plan hash');
  return h;
}

export class SignerService {
  private readonly ex: LiveExecutor;
  private readonly d: LiveExecutorDeps;
  private readonly links: WalletLinkStore;
  private readonly live: LiveLedger | null;
  private readonly feed: SolUsdFeed | null;
  private readonly clock: Clock;
  private readonly fastStore: FastWalletStore | null;
  private readonly log: (line: string) => void;
  /** Plans this service built, by hash (the executor keeps its own frozen registry too). */
  private readonly plans = new Map<string, BuiltPlan>();
  /** task-1368: per plan hash, whether the order's mint exists on this signer's network (swap plans). */
  private readonly mintOnNet = new Map<string, boolean | null>();
  /** One confirm at a time: a second keypress while the wallet page is open is refused, not queued. */
  private confirming: string | null = null;

  constructor(s: SignerServiceDeps) {
    this.ex = s.executor;
    this.d = s.deps;
    this.links = s.linkStore;
    this.live = s.liveLedger;
    this.feed = s.solUsdFeed ?? null;
    this.clock = s.clock ?? systemClock;
    this.fastStore = s.fastStore ?? null;
    this.log = s.log ?? (() => {});
  }

  /** The network of the RPC endpoint the signer actually talks to. Classified, never a label. */
  network(): 'devnet' | 'mainnet' {
    const rpc = this.d.rpc as { url: string; network?: 'devnet' | 'mainnet' };
    return rpcNetwork(rpc.url, rpc.network ?? null);
  }

  private rpcHost(): string {
    try { return new URL((this.d.rpc as { url: string }).url).hostname; } catch { return '?'; }
  }

  private linked(): { publicKey: string; linkedAt: number } {
    const w = this.links.get();
    if (!w) throw new SignerError('no-wallet', 'no wallet is linked; run `trenchscope wallet link` (or /wallet link)');
    return { publicKey: w.publicKey, linkedAt: w.linkedAt };
  }

  private solUsdView(): SolUsdView {
    const r = resolveSolUsd(this.d.solUsd?.(), this.clock.now(), this.network());
    return r.price === null ? { price: null, reason: r.reason } : { price: r.price, sources: r.sources };
  }

  status(): StatusView {
    const caps = effectiveCaps(this.d.caps);
    const ks = (this.ex as unknown as { killSwitch: { engaged(): { engagedAt: number; reason: string } | null } }).killSwitch;
    const panic = ks.engaged();
    const lock = this.d.ledger.locked();
    this.sweep();
    return {
      version: SIGNER_PROTOCOL_VERSION,
      pid: process.pid,
      linked: this.links.get() ? this.linked() : null,
      fastWallet: this.d.fastSigner ? { publicKey: this.d.fastSigner.publicKey } : null,
      network: this.network(),
      rpcHost: this.rpcHost(),
      caps: { network: caps.network, mainnetEnabled: caps.mainnetEnabled, perTradeUsd: caps.perTradeUsd, dailyUsd: caps.dailyUsd, maxPriceImpactPct: caps.maxPriceImpactPct, maxSolOut: caps.maxSolOut, maxSlippageBps: caps.maxSlippageBps },
      panic,
      ledgerLocked: lock,
      spentTodayUsd: this.d.ledger.spentToday(),
      plans: this.plans.size,
      solUsd: this.solUsdView(),
      probeAvailable: !!this.d.probe && this.network() === 'devnet',
    };
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [h, b] of this.plans) if (now - b.builtAt > PLAN_TTL_MS) { this.plans.delete(h); this.mintOnNet.delete(h); }
  }

  /**
   * task-1368: does the mint account exist on the network the signer talks to? Read-only `getMultipleAccounts`;
   * null when the RPC cannot answer. On a devnet signer a mainnet-only token answers false — the reason the swap's
   * simulation fails there, shown in plain English on the ticket instead of a truncated RPC error.
   */
  private async mintExists(mint: string): Promise<boolean | null> {
    const rpc = this.d.rpc as Partial<TradeRpc>;
    if (typeof rpc.accountsInfo !== 'function') return null;
    try {
      const infos = await rpc.accountsInfo.call(this.d.rpc, [mint]);
      return infos[0] !== null && infos[0] !== undefined;
    } catch {
      return null;
    }
  }

  private quoteRequest(p: PlanParams): QuoteRequest {
    return {
      inputMint: p.side === 'buy' ? SOL_MINT : p.mint,
      outputMint: p.side === 'buy' ? p.mint : SOL_MINT,
      amount: BigInt(p.amountRaw),
      slippageBps: p.slippageBps,
      mode: 'ExactIn',
    };
  }

  /**
   * task-1368: the keyless Jupiter quote for an order, fetched by the signer's own HTTP client (ONE limiter for
   * preview, re-quote and build) and reusable by `plan` for QUOTE_REUSE_MS. Read-only: numbers and strings go
   * back, never a transaction, and nothing is registered. Rate limiting past the retry budget is `rate-limited`.
   */
  async quote(params: unknown): Promise<QuoteView> {
    const p = parsePlanParams(params);
    const req = this.quoteRequest(p);
    const build = this.d.build;
    try {
      const raw = await build.quoteRaw(req);
      const q = normalizeSwapQuote(raw as never, this.clock.now());
      const age = typeof build.quoteAge === 'function' ? build.quoteAge(req) : null;
      return {
        inputMint: q.inputMint, outputMint: q.outputMint, inAmountRaw: q.inAmount.toString(), outAmountRaw: q.outAmount.toString(),
        minOutRaw: q.otherAmountThreshold.toString(), slippageBps: q.slippageBps, priceImpactPct: q.priceImpactPct, route: [...q.route],
        usdValue: q.usdValue, solUsd: this.solUsdView(), host: typeof build.host === 'string' ? build.host : '?', ageMs: Math.max(0, age ?? 0), fetchedAt: this.clock.now(),
      };
    } catch (e) {
      throw buildError(e);
    }
  }

  private view(b: BuiltPlan): PlanView {
    const p = b.plan;
    const pre = this.ex.precheck(b);
    const policy: VerdictView = p.txPolicy.ok ? { ok: true } : { ok: false, reason: p.txPolicy.reason, message: p.txPolicy.message };
    return {
      hash: b.hash, kind: b.kind, lane: b.lane, ref: b.ref, network: this.network(), mint: p.mint, symbol: p.symbol, side: p.side, decimals: b.order.decimals,
      amountInRaw: p.amountInRaw.toString(), amountOutRaw: p.amountOutRaw.toString(), minOutRaw: b.quote.otherAmountThreshold.toString(),
      slippageBps: p.slippageBps, route: [...p.route], priceImpactPct: p.priceImpactPct, notionalUsd: p.notionalUsd,
      solUsd: b.solUsd.price === null ? { price: null, reason: b.solUsd.reason } : { price: b.solUsd.price, sources: b.solUsd.sources },
      sim: { ran: p.simulated, ok: p.simOk, error: p.simError, unitsConsumed: null, solOutLamports: p.solOutLamports === null ? null : p.solOutLamports.toString() },
      mintOnNetwork: this.mintOnNet.get(b.hash) ?? null,
      feeLamports: b.feeLamports.toString(), prioritizationFeeLamports: b.prioritizationFeeLamports, instructions: [...b.instructions],
      policy, precheck: pre.ok ? { ok: true } : { ok: false, reason: pre.reason, message: pre.message },
      userPublicKey: b.userPublicKey, builtAt: b.builtAt, expiresAt: b.builtAt + PLAN_TTL_MS,
    };
  }

  /** Build a SWAP plan for the LINKED wallet. The order comes from the UI; the wallet, caps, tx do not. */
  async plan(params: unknown): Promise<PlanView> {
    const p = parsePlanParams(params);
    const linked = this.linked();
    await this.feed?.ensureFresh();
    const order: PaperOrder = { mint: p.mint, symbol: p.symbol, side: p.side, decimals: p.decimals, amountRaw: BigInt(p.amountRaw), slippageBps: p.slippageBps };
    let built: BuiltPlan;
    try {
      built = await this.ex.buildPlan({ order, userPublicKey: linked.publicKey, network: this.network() });
    } catch (e) {
      throw buildError(e);
    }
    this.plans.set(built.hash, built);
    // task-1368: the mint's existence on THIS network (devnet signer + mainnet token = the sim-failure reason), and
    // the FULL simulation error in the log (the ticket row truncates; `invalid transaction: Tr…` told the user nothing).
    this.mintOnNet.set(built.hash, await this.mintExists(p.mint));
    if (built.plan.simulated && !built.plan.simOk) this.log(`signer: plan ${built.hash.slice(0, 8)} ${p.side} ${p.symbol} simulation failed on ${this.network()} (${this.rpcHost()}): ${built.plan.simError ?? 'unknown error'}`);
    this.sweep();
    return this.view(built);
  }

  /** Build the devnet PROBE plan. Refused unless the RPC is devnet by classification. */
  async probe(): Promise<PlanView> {
    const linked = this.linked();
    if (this.network() !== 'devnet') throw new SignerError('network-mismatch', 'the probe runs only on devnet');
    let built: BuiltPlan;
    try { built = await this.ex.buildProbe({ userPublicKey: linked.publicKey }); } catch (e) { throw new SignerError('build-failed', e instanceof Error ? e.message : String(e)); }
    this.plans.set(built.hash, built);
    return this.view(built);
  }

  /**
   * task-1363: the fast wallet's public status. Loaded only when the signer runs against devnet AND a record
   * exists; the balance is read from the devnet RPC (null when unreadable). Never carries the seed.
   */
  async fast(): Promise<FastView> {
    const signer = this.d.fastSigner ?? null;
    const rec = this.fastStore?.get() ?? null;
    const base = { network: 'devnet' as const, maxSolPerFill: FAST_MAX_SOL_PER_FILL, createdAt: rec?.createdAt ?? null };
    if (!signer) {
      const reason = this.network() !== 'devnet' ? 'the fast wallet exists only on devnet; this signer is not on a devnet RPC'
        : rec ? 'the fast wallet record could not be loaded' : 'no fast wallet: `trenchscope wallet fast create`';
      return { ...base, loaded: false, publicKey: rec?.publicKey ?? null, balanceLamports: null, reason };
    }
    let balance: string | null = null;
    try { balance = (await this.d.rpc.balance(signer.publicKey)).toString(); } catch { balance = null; }
    return { ...base, loaded: true, publicKey: signer.publicKey, balanceLamports: balance, reason: null };
  }

  /**
   * task-1363: build a DEVNET FILL for the fast wallet from an order-plan leg. The engine (in the terminal
   * process) asks; the signer builds its own transaction for ITS fast wallet, applies the probe-shape policy,
   * simulates, prices the SOL leg in USD from its own feed and registers the plan under a hash the engine then
   * confirms. Refused off devnet or without a loaded fast wallet. Caps are decided at precheck/confirm.
   */
  async fill(params: unknown): Promise<PlanView> {
    const p = parseFillParams(params);
    if (this.network() !== 'devnet') throw new SignerError('network-mismatch', 'devnet fills run only on devnet');
    if (!this.d.fastSigner) throw new SignerError('no-fast-wallet', 'no fast wallet is loaded; create one with `trenchscope wallet fast create` (devnet) and restart dexterm');
    await this.feed?.ensureFresh();
    let built: BuiltPlan;
    try {
      built = await this.ex.buildFill({ lamports: BigInt(p.lamports), mint: p.mint, symbol: p.symbol, decimals: p.decimals, side: p.side, ref: p.ref });
    } catch (e) {
      throw new SignerError('build-failed', e instanceof Error ? e.message : String(e));
    }
    this.plans.set(built.hash, built);
    this.sweep();
    return this.view(built);
  }

  precheck(params: unknown): VerdictView {
    const hash = parseHashParam(params);
    const b = this.plans.get(hash);
    if (!b) return { ok: false, reason: 'plan-mismatch', message: 'unknown plan' };
    const r = this.ex.precheck(b);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, message: r.message };
  }

  drop(params: unknown): { dropped: boolean } {
    const hash = parseHashParam(params);
    return { dropped: this.plans.delete(hash) };
  }

  /**
   * The keypress arrived: confirm the plan named by hash. The wallet is re-read from the link store (a
   * link changed since the plan → signer-mismatch). Single-flight: a second confirm while one is in
   * progress is refused rather than queued (the wallet page is already open).
   */
  async confirm(params: unknown): Promise<ConfirmView> {
    const hash = parseHashParam(params);
    const b = this.plans.get(hash);
    if (!b) return { kind: 'refused', reason: 'plan-mismatch', message: 'unknown or expired plan; build it again' };
    if (this.confirming) return { kind: 'refused', reason: 'plan-mismatch', message: 'another confirm is in progress' };
    // task-1363: a fast-lane plan is confirmed for the FAST wallet (no Phantom link needed); a main-lane plan for
    // the linked wallet as before. The executor re-checks the lane against the plan's own public key.
    const signerKey = b.lane === 'fast' ? (this.d.fastSigner?.publicKey ?? null) : this.linked().publicKey;
    if (!signerKey) return { kind: 'refused', reason: 'signer-mismatch', message: 'no fast wallet is loaded for this fill' };
    this.confirming = hash;
    try {
      await this.feed?.ensureFresh();
      const out: SubmitOutcome = await this.ex.confirmAndSubmit(b, hash, signerKey);
      this.plans.delete(hash);
      return toConfirmView(out, this.network());
    } finally {
      this.confirming = null;
    }
  }

  /** PANIC: engage the kill switch, lock the ledger, forget every plan. One-way; resume needs the TTY path. */
  panic(params: unknown): { engaged: true; reason: string } {
    const reason = (params !== null && typeof params === 'object' && typeof (params as Record<string, unknown>).reason === 'string')
      ? String((params as Record<string, unknown>).reason).replace(/[^\x20-\x7e]/g, '?').slice(0, 120) : 'panic';
    const ks = (this.ex as unknown as { killSwitch: { engage(reason: string, now?: number): { reason: string } } }).killSwitch;
    const rec = ks.engage(reason, this.clock.now());
    try { this.d.ledger.lock(reason, this.clock.now()); } catch { /* the kill-switch file alone disables trading */ }
    this.plans.clear();
    return { engaged: true, reason: rec.reason };
  }

  /** Dispatch one protocol method. Unknown methods are refused; errors become `ok:false`. */
  async call(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'status': return this.status();
      case 'plan': return this.plan(params);
      case 'probe': return this.probe();
      case 'precheck': return this.precheck(params);
      case 'confirm': return this.confirm(params);
      case 'drop': return this.drop(params);
      case 'panic': return this.panic(params);
      case 'fast': return this.fast();
      case 'fill': return this.fill(params);
      case 'quote': return this.quote(params);
      default: throw new SignerError('bad-request', `unknown method ${JSON.stringify(String(method).slice(0, 32))}`);
    }
  }

  /** The live fill ledger (for tests / the CLI probe). */
  get liveLedger(): LiveLedger | null { return this.live; }
  get caps(): TradeCaps { return effectiveCaps(this.d.caps); }
}

function fillView(f: Fill): FillView {
  return { t: f.t, mint: f.mint, symbol: f.symbol, side: f.side, decimals: f.decimals, solDelta: f.solDelta.toString(), tokenDelta: f.tokenDelta.toString(), feeLamports: f.feeLamports.toString(), priceSol: f.priceSol, realizedLamports: f.realizedLamports.toString() };
}

export function toConfirmView(out: SubmitOutcome, network: 'devnet' | 'mainnet'): ConfirmView {
  switch (out.kind) {
    case 'filled': return { kind: 'filled', signature: out.signature, fill: fillView(out.fill), roundTripMs: out.roundTripMs, lighthouseTail: out.lighthouseTail, network };
    case 'refused': return { kind: 'refused', reason: out.reason, message: out.message };
    case 'send-failed': return { kind: 'send-failed', signature: out.signature, error: out.error };
    case 'send-unknown': return { kind: 'send-unknown', signature: out.signature, error: out.error };
  }
}
