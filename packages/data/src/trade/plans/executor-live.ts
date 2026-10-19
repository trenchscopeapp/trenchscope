// task-1363 — the LIVE fire path for the plan engine: an Executor that fills through the REAL signer process
// (devnet only, from the capped FAST WALLET). The engine is synchronous and tick-driven; the signer is a child
// process answered asynchronously. This adapter bridges the two WITHOUT the engine ever waiting:
//
//   quote(leg)      first call starts `signer.fill(...)` (build + policy + simulate + USD pricing in the SIGNER)
//                   and throws RpcOutage (the engine logs price.unusable/rpc-outage and retries on the next
//                   fresh tick, no attempt consumed). Once the signer has answered, the next quote() returns a
//                   Quote carrying the signer's verdict: policy/sim/caps refusals arrive as `simOk:false` with
//                   the signer's own reason, so the engine journals `policy.refused` with that reason.
//   nextSignature() an INTENT id (`live_N`) the engine journals BEFORE anything is sent (CL-03).
//   submit(leg)     starts `signer.confirm(hash)` — the signer re-checks caps, reserves USD, has the fast
//                   wallet sign, verifies + re-simulates the bytes, submits and confirms — and returns
//                   `send-unknown` at once: the engine marks the leg in flight and settles it by `lookup`.
//   lookup(intent)  'not-found' while the confirm runs; {confirmed, fill} / 'failed' once the signer answered;
//                   a transport error at confirm stays 'not-found' (the engine expires it after 90 s, never
//                   resends — the chain may still have it; the fast wallet is capped so exposure is bounded).
//
// What is real on devnet: the lamports the fill moves out of the fast wallet (fees of the wrap-and-unwrap
// sized to the plan's SOL leg), the signature, the on-chain memo naming the plan leg, the signer's USD
// per-trade/daily ledger. What is MODELLED: the token leg (Jupiter has no devnet, so no token changes hands);
// the fill is booked from the planned USD at the fire-time price and labelled `kind:'devnet-fill'` +
// `modelledTokens:true` in the journal. Nothing in this file signs, holds a key, or reaches mainnet: the signer
// refuses `fill` off devnet and never loads a fast wallet there.

import type { Clock } from '../../clock.ts';
import type { SignerPort } from '../signer/client.ts';
import type { PlanView, ConfirmView } from '../signer/protocol.ts';
import { RpcOutage } from './executor.ts';
import type { ChainLookup, Executor, Fill, Quote, QuoteRequest, SubmitOutcome, SubmitRequest } from './executor.ts';

/** How long a signer build is reused before it is rebuilt (the signer's own plan TTL is 90 s). */
export const LIVE_BUILD_TTL_MS = 60_000;

/** Remote refusals the signer formats as `reason: message`; anything else from the client is a transport problem. */
const REMOTE_REFUSAL = /^(network-mismatch|no-fast-wallet|build-failed|bad-request|panicked|no-wallet|signer-mismatch|plan-mismatch):\s*/;

export interface LivePlanExecutorOptions {
  signer: SignerPort;
  clock: Clock;
  /** SOL/USD the terminal shows (sizes a leg's SOL leg from its USD value); null → no quote yet (retry). */
  solUsd: () => number | null;
  buildTtlMs?: number;
  /** Called when an async signer answer lands (a build or a confirm) so the host can re-tick / redraw. */
  onChange?: () => void;
  log?: (line: string) => void;
}

interface Build { state: 'building' | 'built' | 'refused' | 'outage'; view: PlanView | null; error: string | null; at: number; usd: number | null; tokenRaw: bigint | null; priceUsd: number }
interface Pending { legId: string; hash: string; state: 'confirming' | 'filled' | 'failed' | 'unknown'; outcome: ConfirmView | null; error: string | null; fill: Fill | null; signature: string | null }

export class LivePlanExecutor implements Executor {
  readonly kind = 'live' as const;
  private readonly signer: SignerPort;
  private readonly clock: Clock;
  private readonly solUsd: () => number | null;
  private readonly ttl: number;
  private readonly onChange: () => void;
  private readonly log: (line: string) => void;
  private readonly builds = new Map<string, Build>();
  private readonly pending = new Map<string, Pending>();
  private intents = 0;

  constructor(o: LivePlanExecutorOptions) {
    this.signer = o.signer; this.clock = o.clock; this.solUsd = o.solUsd;
    this.ttl = o.buildTtlMs ?? LIVE_BUILD_TTL_MS;
    this.onChange = o.onChange ?? (() => {}); this.log = o.log ?? (() => {});
  }

  /** The signer must be alive, on DEVNET, with a fast wallet loaded. Checked by the host before switching to live. */
  async ready(): Promise<{ ok: true; network: 'devnet'; fastWallet: string; balanceLamports: string | null } | { ok: false; why: string }> {
    if (!this.signer.alive) return { ok: false, why: 'the signer process is not available' };
    let status; try { status = await this.signer.status(); } catch (e) { return { ok: false, why: `signer status: ${msg(e)}` }; }
    if (status.network !== 'devnet') return { ok: false, why: `the signer is on ${status.network}; live plan fills run on devnet only` };
    if (status.panic || status.ledgerLocked) return { ok: false, why: 'live trading is panicked (trenchscope wallet resume)' };
    let fast; try { fast = await this.signer.fast(); } catch (e) { return { ok: false, why: `signer fast: ${msg(e)}` }; }
    if (!fast.loaded || !fast.publicKey) return { ok: false, why: fast.reason ?? 'no fast wallet is loaded in the signer' };
    return { ok: true, network: 'devnet', fastWallet: fast.publicKey, balanceLamports: fast.balanceLamports };
  }

  /** One-line label for banners. */
  describe(fastWallet?: string | null): string { return `LIVE · DEVNET · fast wallet${fastWallet ? ` ${fastWallet.slice(0, 4)}…${fastWallet.slice(-4)}` : ''}`; }

  private legId(req: { plan: { id: string }; legKey: string }): string { return `${req.plan.id}:${req.legKey}`; }

  /** The SOL leg in lamports for this leg (buy: USD / SOL-USD; sell: tokens × price / SOL-USD). Null without a SOL price. */
  private lamportsFor(req: QuoteRequest): bigint | null {
    const sol = this.solUsd();
    if (sol === null || !(sol > 0)) return null;
    const usd = req.side === 'buy' ? (req.usd ?? 0) : req.tokenRaw !== null ? Number(req.tokenRaw) / 10 ** req.plan.decimals * req.priceUsd : 0;
    if (!(usd > 0)) return null;
    return BigInt(Math.round(usd / sol * 1e9));
  }

  quote(req: QuoteRequest): Quote {
    const id = this.legId(req);
    const now = this.clock.now();
    const b = this.builds.get(id);
    if (b && b.state === 'building') throw new RpcOutage();
    if (b && b.state === 'outage') { this.builds.delete(id); throw new RpcOutage(); } // retried: a new build starts on the next quote
    if (b && b.state === 'refused') {
      this.builds.delete(id);
      return this.refusedQuote(req, b.error ?? 'build refused', b.at);
    }
    if (b && b.state === 'built' && b.view && now - b.at < this.ttl && b.view.expiresAt > now) return this.quoteFromView(req, b.view, b.at);
    if (b) this.builds.delete(id);
    // start a build
    const lamports = this.lamportsFor(req);
    if (lamports === null) { this.log(`live plans: no SOL/USD price yet to size ${id}; retrying`); throw new RpcOutage(); }
    const build: Build = { state: 'building', view: null, error: null, at: now, usd: req.usd, tokenRaw: req.tokenRaw, priceUsd: req.priceUsd };
    this.builds.set(id, build);
    void this.signer.fill({ ref: id, mint: req.plan.mint, symbol: req.plan.symbol, decimals: req.plan.decimals, side: req.side, lamports: lamports.toString() })
      .then((view) => { build.state = 'built'; build.view = view; build.at = this.clock.now(); this.onChange(); })
      .catch((e: unknown) => {
        const m = msg(e);
        if (REMOTE_REFUSAL.test(m)) { build.state = 'refused'; build.error = m; }
        else { build.state = 'outage'; build.error = m; this.log(`live plans: signer fill failed (${m}); retrying`); }
        this.onChange();
      });
    throw new RpcOutage();
  }

  private refusedQuote(req: QuoteRequest, error: string, at: number): Quote {
    const m = REMOTE_REFUSAL.exec(error);
    const reason = m ? m[1] : 'signer-refused';
    return {
      side: req.side, priceUsd: req.priceUsd, impactPct: 0, route: ['devnet-fill'], feeLamports: 0, tipLamports: 0,
      simOk: false, simError: error, refusal: { reason, message: error.replace(REMOTE_REFUSAL, '') }, usd: req.usd, tokenRaw: req.tokenRaw, at,
    };
  }

  /** The signer's verdict as a Quote: its policy / simulation / caps refusal (if any) travels with its own reason. */
  private quoteFromView(req: QuoteRequest, v: PlanView, at: number): Quote {
    const bad = !v.policy.ok ? v.policy : !v.sim.ok ? { ok: false, reason: 'simulation-failed', message: v.sim.error ?? 'simulation failed' } : !v.precheck.ok ? v.precheck : null;
    return {
      side: req.side,
      // a devnet fill has no route, so the signer cannot imply a price; the tick's price stands (on a Jupiter
      // route the quote-implied price would come from the signer's view instead)
      priceUsd: req.priceUsd,
      impactPct: v.priceImpactPct ?? 0, route: [...v.route],
      feeLamports: Number(v.feeLamports), tipLamports: 0,
      simOk: bad === null, simError: bad ? `${bad.reason ?? 'refused'}: ${bad.message ?? ''}` : null,
      refusal: bad ? { reason: bad.reason ?? 'signer-refused', message: bad.message ?? 'refused by the signer' } : null,
      usd: req.usd, tokenRaw: req.tokenRaw, at,
    };
  }

  nextSignature(): string { return `live_${++this.intents}`; }

  submit(req: SubmitRequest): SubmitOutcome {
    const id = this.legId(req);
    const b = this.builds.get(id);
    this.builds.delete(id);
    if (!b || b.state !== 'built' || !b.view) return { kind: 'send-failed', signature: req.signature, error: 'no fresh signer plan for this leg (rebuilt on the next tick)', feeLamports: 0 };
    const view = b.view;
    const p: Pending = { legId: id, hash: view.hash, state: 'confirming', outcome: null, error: null, fill: null, signature: null };
    this.pending.set(req.signature, p);
    void this.signer.confirm(view.hash)
      .then((out) => {
        p.outcome = out;
        if (out.kind === 'filled') {
          p.state = 'filled'; p.signature = out.signature;
          p.fill = this.modelFill(req, out);
        } else if (out.kind === 'refused' || out.kind === 'send-failed') { p.state = 'failed'; p.error = out.kind === 'refused' ? `${out.reason}: ${out.message}` : out.error; p.signature = out.kind === 'send-failed' ? out.signature : null; }
        else { p.state = 'unknown'; p.error = out.error; p.signature = out.signature; }
        this.onChange();
      })
      .catch((e: unknown) => { p.state = 'unknown'; p.error = msg(e); this.log(`live plans: confirm transport error (${p.error}); outcome unknown, never resent`); this.onChange(); });
    return { kind: 'send-unknown', signature: req.signature, error: 'live confirm in flight (fast wallet, devnet)', feeLamports: req.quote.feeLamports + req.quote.tipLamports };
  }

  /**
   * The fill the engine books. SOL: the real on-chain delta the signer reported (fees of the wrap-and-unwrap).
   * Tokens: MODELLED from the planned USD at the fire-time price (no token moves on devnet) and labelled so.
   */
  private modelFill(req: SubmitRequest, out: Extract<ConfirmView, { kind: 'filled' }>): Fill {
    const dec = req.plan.decimals;
    const usd = req.usd ?? (req.tokenRaw !== null ? Number(req.tokenRaw) / 10 ** dec * req.quote.priceUsd : 0);
    const tokens = req.tokenRaw ?? BigInt(Math.round(usd / req.quote.priceUsd * 10 ** dec));
    return {
      tokenDelta: req.quote.side === 'buy' ? tokens : -tokens,
      solDelta: BigInt(out.fill.solDelta),
      usd, priceUsd: req.quote.priceUsd,
      kind: 'devnet-fill', signature: out.signature, modelledTokens: true, network: out.network,
    };
  }

  lookup(signature: string): ChainLookup {
    const p = this.pending.get(signature);
    if (!p) return 'not-found';
    if (p.state === 'filled' && p.fill) return { status: 'confirmed', fill: p.fill };
    if (p.state === 'failed') return { status: 'failed' };
    return 'not-found'; // confirming, or an unknown outcome: never resent, expires in the engine
  }

  chainFill(signature: string): Fill | null { return this.pending.get(signature)?.fill ?? null; }

  /** Diagnostics for the TUI (what is building / in flight / settled). */
  snapshot(): { builds: { leg: string; state: Build['state']; error: string | null }[]; pending: { leg: string; intent: string; state: Pending['state']; signature: string | null; error: string | null }[] } {
    return {
      builds: [...this.builds.entries()].map(([leg, b]) => ({ leg, state: b.state, error: b.error })),
      pending: [...this.pending.entries()].map(([intent, p]) => ({ leg: p.legId, intent, state: p.state, signature: p.signature, error: p.error })),
    };
  }
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
