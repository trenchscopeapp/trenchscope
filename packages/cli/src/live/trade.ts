// trenchscope — live bindings for the PAPER trade ticket and the positions screen (task-1310 T0).
// The ticket binding fetches a warm keyless swap quote for the current order, previews the fill, and
// on confirm fetches a FRESH quote and asks the executor to book it (SPEC §6.1 step 6: book from the
// fill, not a stale on-screen quote). The positions binding marks held tokens from the keyless price
// feed. Both go through the data layer's rate limiter + budget meter; neither signs, holds a key, or
// sends a transaction — the only trade op is `executor.execute`, a TradeExecutor the UI holds behind
// an interface (acceptance (d)).
import {
  SOL_MINT, lamportsToSol, rawToTokens, positionPnl, shortPubkey, LiveLedger, withPriority,
  type DataLayer, type Fill, type PaperWallet, type Position, type SwapQuote, type TradeExecutor, type TradeRecord,
  type SignerPort, type StatusView, type PlanView, type ConfirmView, type LinkedWallet, type QuoteView, type LiveFillRow,
} from '@dexterm/data';
import type { SettledTx } from '@dexterm/tui';
import {
  openTicket, ticketKey, toOrder, orderValid, buyNotionalSol, capPreflight, devnetMintWarning, DEFAULT_TYPEBACK_THRESHOLD_SOL,
  type TicketState, type TicketSeed, type TicketContext, type TicketKey, type TicketEffect, type TicketView, type PositionsView, type PositionRowView, type LiveTicketView, type CapPreflight,
} from '../trade.ts';

/** task-1368: bounds on the signer's "retry in Ns" before the ticket retries a rate-limited plan by itself. */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 120_000;
/** When the signer said rate-limited but gave no wait (an older signer), retry after this. */
export const RETRY_DEFAULT_MS = 10_000;

/** The signer's rate-limit refusal, if that is what `e` is: the honest wait and its own line. */
export function rateLimitOf(e: unknown): { ms: number; message: string } | null {
  if (!(e instanceof Error)) return null;
  const reason = (e as { reason?: unknown }).reason;
  const plain = e.message.replace(/^rate-limited:\s*/, '');
  if (reason !== 'rate-limited' && !/^rate-limited:/.test(e.message)) return null;
  const given = (e as { retryAfterMs?: unknown }).retryAfterMs;
  const parsed = /retry in (\d+)s/.exec(plain);
  const ms = typeof given === 'number' && Number.isFinite(given) && given > 0 ? given : parsed ? Number(parsed[1]) * 1000 : RETRY_DEFAULT_MS;
  return { ms: Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, ms)), message: plain };
}

/** A signer QuoteView → the SwapQuote shape the preview fill and the ticket already understand. */
export function quoteFromView(v: QuoteView): SwapQuote {
  return {
    inputMint: v.inputMint, outputMint: v.outputMint, inAmount: BigInt(v.inAmountRaw), outAmount: BigInt(v.outAmountRaw), otherAmountThreshold: BigInt(v.minOutRaw),
    mode: 'ExactIn', slippageBps: v.slippageBps, priceImpactPct: v.priceImpactPct, route: [...v.route], platformFeeBps: null, platformFeeAmount: null,
    usdValue: v.usdValue, contextSlot: null, source: 'jupiter-swap', fetchedAt: v.fetchedAt,
  };
}

/**
 * What a LIVE ticket needs (task-1328): the signer process handle and the linked wallet. Both are
 * read through functions so a link made mid-run and a signer that died are seen at once.
 */
export interface LiveTradeDeps {
  signer: () => SignerPort | null;
  linked: () => LinkedWallet | null;
  /** Called after a confirmed live fill (positions refresh). */
  onFill?: () => void;
}

export interface TradeTicketOptions {
  now?: () => number;
  onChange?: () => void;
  typebackThresholdSol?: number;
  /** Hard ceiling on the confirm-time quote wait before it fails to an error (task-1310 MAJOR fix). */
  confirmQuoteTimeoutMs?: number;
  /** LIVE trading deps; absent = paper only (the `L` key says why). */
  live?: LiveTradeDeps;
  /** Held position lookup for LIVE sells (the live ledger), raw base units; default none. */
  livePositionRaw?: (mint: string) => bigint;
  /**
   * task-1340 trade moments: called ONCE per settled outcome — a booked paper fill, a confirmed live fill, a
   * signer refusal or a send failure — with the outcome itself. Never for a quote, a plan, an in-flight send
   * or a `send-unknown` (an unknown outcome is not a result). The UI fires effects + sound from this and
   * nowhere else.
   */
  onSettled?: (tx: SettledTx) => void;
}

/** Default bound on the confirm-time quote: after this the ticket errors instead of hanging. */
export const CONFIRM_QUOTE_TIMEOUT_MS = 8_000;

/** A live PAPER trade ticket over one mint. */
export class TradeTicketLive {
  readonly ticket: TicketState;
  private readonly dl: DataLayer;
  private readonly wallet: PaperWallet;
  private readonly exec: TradeExecutor;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly threshold: number;
  private readonly confirmTimeoutMs: number;
  private quote: SwapQuote | null = null;
  private quoteAt = 0;
  private loading = false;
  private error: string | null = null;
  private receipt: Fill | null = null;
  private decimalsKnown: boolean;
  private seq = 0;
  private quoteTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight confirm quote; aborting it (timeout or esc) unblocks the `filling` phase. */
  private confirmAbort: AbortController | null = null;
  /** Set when the user cancels (esc) during `filling`, so confirm() leaves the ticket in editing. */
  private cancelled = false;
  // ---- LIVE (task-1328)
  private readonly liveDeps: LiveTradeDeps | null;
  private readonly livePositionRaw: (mint: string) => bigint;
  private readonly onSettled: ((tx: SettledTx) => void) | null;
  private signerStatus: StatusView | null = null;
  private livePlan: PlanView | null = null;
  private liveOutcome: ConfirmView | null = null;
  private liveError: string | null = null;
  private liveProbe = false;
  private planSeq = 0;
  // ---- task-1368: rate-limited plan → wait + auto-retry (never an error phase); the signer's SOL/USD for the preflight
  private liveRetryAt: number | null = null;
  private liveRetryMsg: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private liveSolUsd: number | null = null;

  constructor(dl: DataLayer, wallet: PaperWallet, exec: TradeExecutor, seed: TicketSeed, opts: TradeTicketOptions = {}) {
    this.dl = dl;
    this.wallet = wallet;
    this.exec = exec;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange ?? (() => {});
    this.threshold = opts.typebackThresholdSol ?? DEFAULT_TYPEBACK_THRESHOLD_SOL;
    this.confirmTimeoutMs = opts.confirmQuoteTimeoutMs ?? CONFIRM_QUOTE_TIMEOUT_MS;
    this.liveDeps = opts.live ?? null;
    this.livePositionRaw = opts.livePositionRaw ?? (() => 0n);
    this.onSettled = opts.onSettled ?? null;
    this.decimalsKnown = typeof seed.decimals === 'number' && Number.isFinite(seed.decimals) && seed.decimals > 0;
    this.ticket = openTicket(seed);
    void this.ensureDecimals();
    this.refreshQuote();
  }

  private positionTokensRaw(): bigint {
    if (this.ticket.mode === 'live') return this.livePositionRaw(this.ticket.mint);
    return this.wallet.position(this.ticket.mint)?.tokensRaw ?? 0n;
  }

  // ------------------------------------------------------------------------------------ LIVE (task-1328)

  /** Is LIVE mode available right now? A reason string when not. */
  liveUnavailable(): string | null {
    if (!this.liveDeps) return 'LIVE trading is not available in this run';
    if (!this.liveDeps.linked()) return 'no wallet linked — /wallet link first';
    const s = this.liveDeps.signer();
    if (!s) return 'the signer process is not available';
    if (!s.alive) return 'the signer process died — restart trenchscope to trade live';
    return null;
  }

  /**
   * Flip PAPER ⇄ LIVE (the user's `L`). Entering LIVE reads the signer's status (its network + caps,
   * which the banner shows — never the UI's own flags) and refuses when no wallet is linked or the
   * signer is down. Leaving LIVE drops any plan.
   */
  setMode(mode: TicketState['mode']): void {
    if (this.ticket.phase !== 'editing') return;
    if (mode === this.ticket.mode) return;
    if (mode === 'live') {
      const why = this.liveUnavailable();
      if (why) { this.ticket.message = why; this.onChange(); return; }
      this.ticket.mode = 'live';
      this.liveOutcome = null; this.liveError = null; this.livePlan = null; this.liveProbe = false;
      this.ticket.message = 'LIVE: ⏎ builds the plan in the signer · Y on the plan signs in Phantom';
      void this.refreshSignerStatus();
    } else {
      this.dropPlan();
      this.ticket.mode = 'paper';
      this.liveProbe = false;
      this.ticket.message = 'PAPER';
    }
    this.refreshQuote();
    this.onChange();
  }

  /** Re-read the signer's status (network, caps, panic). Null when it cannot be reached. */
  async refreshSignerStatus(): Promise<StatusView | null> {
    const s = this.liveDeps?.signer() ?? null;
    if (!s) { this.signerStatus = null; return null; }
    try { this.signerStatus = await s.status(); } catch (e) { this.signerStatus = null; this.liveError = msg(e); }
    this.onChange();
    return this.signerStatus;
  }

  /** LIVE ⏎: ask the signer to quote → build → decode → simulate the plan for this order. */
  async planLive(): Promise<void> {
    const s = this.liveDeps?.signer() ?? null;
    const my = ++this.planSeq;
    this.livePlan = null; this.liveOutcome = null; this.liveError = null;
    this.clearRetryTimer(); this.liveRetryAt = null; this.liveRetryMsg = null;
    this.onChange();
    try {
      if (!s || !s.alive) throw new Error(this.liveUnavailable() ?? 'signer unavailable');
      const ctx = this.ctx();
      const order = toOrder(this.ticket, ctx);
      if (!this.liveProbe && !orderValid(this.ticket, ctx)) throw new Error('order is no longer valid');
      const [plan, status] = await Promise.all([
        this.liveProbe ? s.probe() : s.plan({ mint: order.mint, symbol: order.symbol, side: order.side, decimals: order.decimals, amountRaw: order.amountRaw.toString(), slippageBps: order.slippageBps }),
        s.status().catch(() => null),
      ]);
      if (my !== this.planSeq) { void s.drop(plan.hash).catch(() => {}); return; } // cancelled meanwhile
      this.signerStatus = status;
      this.livePlan = plan;
      if (this.ticket.phase === 'planning') this.ticket.phase = 'plan';
    } catch (e) {
      if (my !== this.planSeq) return;
      // task-1368: Jupiter rate limiting is NOT a dead end. The ticket stays in `planning`, shows the signer's own
      // line with the countdown, retries by itself when the wait is over, and `r` retries now / esc cancels.
      const rl = this.ticket.phase === 'planning' ? rateLimitOf(e) : null;
      if (rl) {
        this.liveRetryAt = this.now() + rl.ms;
        this.liveRetryMsg = rl.message;
        this.ticket.message = `${rl.message} · r retries now · esc cancels`;
        this.scheduleRetry(rl.ms, my);
        return;
      }
      this.liveError = msg(e);
      this.ticket.phase = 'error';
      this.ticket.message = `plan failed: ${this.liveError}`;
    } finally {
      this.onChange();
    }
  }

  /** task-1368: the auto-retry after a rate-limited plan. Fires only if the ticket is still waiting on that very attempt. */
  private scheduleRetry(ms: number, seq: number): void {
    this.clearRetryTimer();
    const h = setTimeout(() => {
      this.retryTimer = null;
      if (this.ticket.phase === 'planning' && this.planSeq === seq && this.liveRetryAt !== null) void this.planLive();
    }, Math.max(0, ms));
    if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref();
    this.retryTimer = h;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  /** task-1368: `r` while rate limited — retry the plan now instead of waiting out the countdown. No-op otherwise. */
  retryPlan(): void {
    if (this.ticket.phase !== 'planning' || this.liveRetryAt === null) return;
    void this.planLive();
  }

  /** Ms until the automatic retry (0 when due, null when not waiting). */
  retryInMs(): number | null {
    return this.liveRetryAt === null ? null : Math.max(0, this.liveRetryAt - this.now());
  }

  /** LIVE Y on the plan: the signer re-checks caps, opens Phantom, verifies, re-simulates, submits. */
  async confirmLive(): Promise<void> {
    const s = this.liveDeps?.signer() ?? null;
    const plan = this.livePlan;
    try {
      if (!s || !s.alive) throw new Error(this.liveUnavailable() ?? 'signer unavailable');
      if (!plan) throw new Error('no plan to confirm');
      const out = await s.confirm(plan.hash);
      this.liveOutcome = out;
      if (out.kind === 'filled') { this.ticket.phase = 'filled'; this.ticket.message = null; this.liveDeps?.onFill?.(); }
      else if (out.kind === 'refused') { this.ticket.phase = 'refused'; this.ticket.message = `${out.reason}: ${out.message}`; }
      else { this.ticket.phase = 'error'; this.ticket.message = out.error; }
      // task-1340: the settled outcome (and only that) reaches the effects. `send-unknown` is deliberately
      // excluded: the chain may still confirm it, so there is no verdict to show.
      const settled = settledFromConfirm(out, this.ticket.symbol, this.ticket.mint, this.liveProbe);
      if (settled) this.settle(settled);
    } catch (e) {
      this.liveError = msg(e);
      this.ticket.phase = 'error';
      this.ticket.message = `confirm failed: ${this.liveError}`;
      this.settle({ status: 'failed', side: this.ticket.side, symbol: this.ticket.symbol, mint: this.ticket.mint, sig: null, solDelta: null, pnlSol: null, pnlPct: null, ledger: 'live', reason: this.liveError });
    } finally {
      void this.refreshSignerStatus();
      this.onChange();
    }
  }

  /** Esc while planning: forget the in-flight plan (it is dropped when it lands), or stop a rate-limit wait. */
  cancelPlan(): void {
    if (this.ticket.phase !== 'planning') return;
    this.planSeq++;
    this.clearRetryTimer(); this.liveRetryAt = null; this.liveRetryMsg = null;
    this.ticket.phase = 'editing';
    this.ticket.message = 'plan cancelled';
    this.onChange();
  }

  /**
   * task-1368: the order's size against the signer's caps, priced at the SIGNER's SOL/USD (the preview quote carries
   * it; the status does too). Null on PAPER, without signer status, or for the probe.
   */
  preflight(): CapPreflight | null {
    if (this.ticket.mode !== 'live' || this.liveProbe) return null;
    const st = this.signerStatus;
    if (!st) return null;
    const sizeSol = this.ticket.side === 'buy'
      ? buyNotionalSol(this.ticket, this.wallet.balance())
      : (this.quote && this.quote.inputMint === this.ticket.mint ? lamportsToSol(this.quote.outAmount) : 0);
    return capPreflight({
      side: this.ticket.side, sizeSol, solUsd: this.liveSolUsd ?? st.solUsd.price,
      perTradeUsd: st.caps.perTradeUsd, dailyUsd: st.caps.dailyUsd, spentTodayUsd: st.spentTodayUsd,
    });
  }

  /** task-1368 `f`: size a LIVE buy to the cap (SOL unit). Says why when it cannot. */
  private fitToCap(): void {
    const pf = this.preflight();
    if (!pf) { this.ticket.message = 'fit to cap needs the signer status (press L again to re-read it)'; return; }
    if (pf.fitSizeSol === null) { this.ticket.message = pf.sizeUsd === null && pf.sizeSol > 0 ? 'fit to cap needs the signer\'s SOL/USD price (not available yet)' : 'nothing fits: the cap is spent for today'; return; }
    this.ticket.sizeUnit = 'sol';
    this.ticket.sizeInput = String(pf.fitSizeSol);
    this.ticket.typeback = '';
    this.receipt = null; this.liveOutcome = null;
    this.ticket.message = `fit to cap: ${pf.fitSizeSol} SOL (≤ $${pf.capUsd.toFixed(2)} with room for fees + rent)`;
    this.scheduleQuote(0);
  }

  private dropPlan(): void {
    const plan = this.livePlan;
    this.livePlan = null;
    if (plan) { const s = this.liveDeps?.signer(); if (s?.alive) void s.drop(plan.hash).catch(() => {}); }
  }

  /** Make this LIVE ticket the devnet PROBE (wrap-and-unwrap, fees only). The plan comes from the signer. */
  startProbe(): string | null {
    const why = this.liveUnavailable();
    if (why) return why;
    this.ticket.mode = 'live';
    this.liveProbe = true;
    this.ticket.phase = 'planning';
    this.ticket.message = 'devnet probe: building the wrap-and-unwrap plan…';
    void this.planLive();
    return null;
  }

  private liveView(): LiveTicketView | undefined {
    if (this.ticket.mode !== 'live') return undefined;
    const st = this.signerStatus;
    return {
      signer: st, plan: this.livePlan, outcome: this.liveOutcome, error: this.liveError,
      linked: this.liveDeps?.linked()?.publicKey ? shortPubkey(this.liveDeps.linked()!.publicKey) : null, probe: this.liveProbe,
      preflight: this.preflight(),
      retryAt: this.liveRetryAt, retryMessage: this.liveRetryMsg,
      devnetWarning: devnetMintWarning({ network: st?.network ?? null, probe: this.liveProbe, mint: this.ticket.mint, perTradeUsd: st?.caps.perTradeUsd, dailyUsd: st?.caps.dailyUsd }),
    };
  }

  private notionalSol(): number {
    if (this.ticket.side === 'buy') return buyNotionalSol(this.ticket, this.wallet.balance());
    // sell: SOL the warm quote would return, else mark the held slice of the position
    if (this.quote && this.quote.inputMint === this.ticket.mint) return lamportsToSol(this.quote.outAmount);
    return 0;
  }

  private ctx(): TicketContext {
    return {
      balanceLamports: this.wallet.balance(),
      positionTokensRaw: this.positionTokensRaw(),
      notionalSol: this.notionalSol(),
      typebackThresholdSol: this.threshold,
    };
  }

  /** Apply a key; refetch the warm quote on a change. Returns 'confirm'/'close' for the loop. */
  key(k: TicketKey): TicketEffect {
    const eff = ticketKey(this.ticket, k, this.ctx());
    if (eff === 'confirm' || eff === 'close' || eff === 'plan') this.clearQuoteTimer();
    if (eff === 'changed') { this.receipt = null; this.liveOutcome = null; this.scheduleQuote(); }
    if (eff === 'toggle-live') this.setMode(this.ticket.mode === 'live' ? 'paper' : 'live');
    if (eff === 'fit-cap') this.fitToCap();
    if (eff === 'drop-plan') this.dropPlan();
    if (eff === 'close') this.dropPlan();
    if (eff === 'plan') void this.planLive();
    if (eff === 'confirm-live') void this.confirmLive();
    return eff;
  }

  private clearQuoteTimer(): void {
    if (this.quoteTimer) { clearTimeout(this.quoteTimer); this.quoteTimer = null; }
  }

  /**
   * Debounce the warm quote so a size typed digit-by-digit fires ONE request, not one per key — the
   * keyless `jupiter` bucket is shared with token enrichment and must not be flooded (SPEC §6.3 warm
   * quote stream, free-forever limiter). The timer is unref'd so a pending fetch never blocks quit.
   */
  private scheduleQuote(delayMs = 300): void {
    this.clearQuoteTimer();
    const h = setTimeout(() => { this.quoteTimer = null; this.refreshQuote(); }, delayMs);
    if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref();
    this.quoteTimer = h;
  }

  /** Token decimals drive display + SOL/token price. Pull from the enrichment cache (usually a hit). */
  private async ensureDecimals(): Promise<void> {
    if (this.decimalsKnown) return;
    try {
      const r = await this.dl.store.enrich([this.ticket.mint]);
      const d = r.rows[0]?.token.decimals;
      if (typeof d === 'number' && d > 0) { this.ticket.decimals = d; this.decimalsKnown = true; this.refreshQuote(); this.onChange(); }
    } catch { /* keep the default; display may be approximate until known */ }
  }

  /** Fetch a warm quote for the current order (debounced by a sequence guard). */
  refreshQuote(): void {
    const ctx = this.ctx();
    if (!orderValid(this.ticket, ctx) || this.ticket.phase === 'filling' || this.liveProbe) { this.quote = null; return; }
    const order = toOrder(this.ticket, ctx);
    const my = ++this.seq;
    this.loading = true;
    this.error = null;
    const req = { inputMint: order.side === 'buy' ? SOL_MINT : order.mint, outputMint: order.side === 'buy' ? order.mint : SOL_MINT, amount: order.amountRaw, slippageBps: order.slippageBps, mode: 'ExactIn' as const };
    // task-1368: a LIVE preview is quoted BY THE SIGNER (its own limiter paces preview, re-quote and build as one,
    // and the build reuses this very quote); PAPER keeps the terminal's keyless adapter. A fake signer without
    // `quote` falls back to the terminal's adapter. task-1387: the terminal quote runs at `high`
    // priority so a user-initiated trade quote preempts the background screener/token enrichment on
    // the shared 0.5 rps keyless `jupiter` bucket — otherwise the warm quote queues for seconds.
    const s = this.ticket.mode === 'live' ? this.liveDeps?.signer() ?? null : null;
    const viaSigner = s && s.alive && typeof s.quote === 'function'
      ? s.quote({ mint: order.mint, symbol: order.symbol, side: order.side, decimals: order.decimals, amountRaw: order.amountRaw.toString(), slippageBps: order.slippageBps })
        .then((v) => { this.liveSolUsd = v.solUsd.price; return quoteFromView(v); })
      : null;
    (viaSigner ?? withPriority('high', () => this.dl.jupiterSwap.quote(req)))
      .then((q) => { if (my !== this.seq) return; this.quote = q; this.quoteAt = this.now(); this.loading = false; this.onChange(); })
      .catch((e: unknown) => { if (my !== this.seq) return; this.quote = null; this.loading = false; this.error = rateLimitOf(e)?.message ?? msg(e); this.onChange(); });
  }

  /** True while Jupiter's shared keyless bucket is paused (429 backoff) — drives the 'rate limited' UI. */
  private jupiterPaused(): boolean {
    try { return this.dl.limiter.bucket('jupiter').stats().pausedUntil > this.now(); } catch { return false; }
  }

  /**
   * Cancel an in-flight confirm (esc during `filling`). Aborts the bounded quote wait so the booking
   * can never trap the user, and returns the ticket to editing. No-op outside `filling`.
   */
  cancel(): void {
    if (this.ticket.phase !== 'filling') return;
    this.cancelled = true;
    this.confirmAbort?.abort(abortError('confirm cancelled'));
    this.ticket.phase = 'editing';
    this.ticket.message = 'confirm cancelled';
    this.loading = false;
    this.onChange();
  }

  /**
   * Execute the armed order against a FRESH quote fetched at confirm time, then book the fill.
   * The ticket is already in `filling`; moves to `filled` (receipt), `error`, or (on esc) back to
   * `editing`. The quote is bounded by `confirmTimeoutMs` (task-1310 MAJOR fix): if the shared
   * keyless `jupiter` bucket is paused after a 429, the wait is aborted and the ticket errors
   * instead of hanging and swallowing esc/P/q.
   */
  async confirm(): Promise<void> {
    const ctx = this.ctx();
    const order = toOrder(this.ticket, ctx);
    this.clearQuoteTimer();
    this.seq++; // cancel any in-flight warm quote
    this.cancelled = false;
    this.loading = true;
    const ac = new AbortController();
    this.confirmAbort = ac;
    const timer = setTimeout(() => ac.abort(abortError('confirm quote timed out')), this.confirmTimeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
    // Visible 'rate limited, retrying' state when the fresh quote is queued behind a 429 pause.
    if (this.jupiterPaused()) this.ticket.message = 'rate limited by Jupiter — retrying…';
    this.onChange();
    try {
      if (!orderValid(this.ticket, ctx)) throw new Error('order is no longer valid');
      const req = { inputMint: order.side === 'buy' ? SOL_MINT : order.mint, outputMint: order.side === 'buy' ? order.mint : SOL_MINT, amount: order.amountRaw, slippageBps: order.slippageBps, mode: 'ExactIn' as const };
      // task-1387: the confirm-time re-quote is the user's committed action — at `high` priority it
      // jumps the shared keyless `jupiter` bucket ahead of background enrichment and drains within
      // the `confirmTimeoutMs` abort, so a PAPER fill no longer errors with "quote timed out".
      const fresh = await withPriority('high', () => this.dl.jupiterSwap.quote(req, ac.signal));
      const costBefore = this.wallet.position(this.ticket.mint)?.costLamports ?? null; // PnL % basis for a sell
      const rec = await this.exec.execute(order, fresh);
      this.receipt = rec;
      this.quote = fresh;
      this.quoteAt = this.now();
      this.ticket.phase = 'filled';
      this.ticket.message = null;
      this.settle(settledFromFill(rec, costBefore));
    } catch (e) {
      if (this.cancelled) {
        // esc already returned the ticket to editing; leave it there.
      } else {
        const aborted = isAbortError(e);
        this.ticket.phase = 'error';
        this.ticket.message = aborted
          ? (this.jupiterPaused()
            ? 'rate limited by Jupiter — quote timed out. Press any key to retry, esc to cancel.'
            : 'quote timed out. Press any key to retry, esc to cancel.')
          : msg(e);
        this.error = this.ticket.message;
        this.settle({ status: 'failed', side: this.ticket.side, symbol: this.ticket.symbol, mint: this.ticket.mint, sig: null, solDelta: null, pnlSol: null, pnlPct: null, ledger: 'paper', reason: this.ticket.message });
      }
    } finally {
      clearTimeout(timer);
      this.confirmAbort = null;
      this.loading = false;
      this.onChange();
    }
  }

  /** The single exit for a settled outcome (paper fill, live fill, refusal, failure). Never called with a quote. */
  private settle(tx: SettledTx): void {
    if (!this.onSettled) return;
    try { this.onSettled(tx); } catch { /* effects never break the ticket */ }
  }

  view(): TicketView {
    const ctx = this.ctx();
    const pos = this.wallet.position(this.ticket.mint);
    const preview = this.quote && orderValid(this.ticket, ctx) ? safePreview(this.exec, toOrder(this.ticket, ctx), this.quote) : null;
    const positionTokens = pos ? rawToTokens(pos.tokensRaw, pos.decimals) : 0;
    return {
      ticket: this.ticket,
      balanceSol: lamportsToSol(this.wallet.balance()),
      positionTokens,
      positionValueSol: null,
      quote: this.quote,
      preview,
      quoteAgeMs: this.quote ? this.now() - this.quoteAt : null,
      loading: this.loading,
      error: this.error,
      receipt: this.ticket.phase === 'filled' ? this.receipt : null,
      rateLimited: this.ticket.phase === 'filling' && this.jupiterPaused(),
      decimalsKnown: this.decimalsKnown,
      live: this.liveView(),
    };
  }
}

/** A booked PAPER fill → the settled outcome the effects read. PnL fraction uses the position's cost before the sell. */
export function settledFromFill(f: Fill, costBeforeLamports: bigint | null): SettledTx {
  const pnlSol = f.side === 'sell' ? lamportsToSol(f.realizedLamports) : 0;
  const basis = f.side === 'sell' && costBeforeLamports !== null && costBeforeLamports > 0n ? lamportsToSol(costBeforeLamports) : null;
  return { status: 'confirmed', side: f.side, symbol: f.symbol, mint: f.mint, sig: null, solDelta: lamportsToSol(f.solDelta), pnlSol, pnlPct: basis ? pnlSol / basis : null, ledger: 'paper' };
}

/** A signer ConfirmView → the settled outcome, or null when there is none to show (`send-unknown`, probes). */
export function settledFromConfirm(out: ConfirmView, symbol: string, mint: string, probe: boolean): SettledTx | null {
  if (out.kind === 'send-unknown') return null;
  if (out.kind === 'filled') {
    if (probe) return null; // the devnet wrap-and-unwrap probe is not a trade
    const f = out.fill;
    const pnlSol = f.side === 'sell' ? lamportsToSol(BigInt(f.realizedLamports)) : 0;
    return { status: 'confirmed', side: f.side, symbol: f.symbol || symbol, mint: f.mint || mint, sig: out.signature, solDelta: lamportsToSol(BigInt(f.solDelta)), pnlSol, pnlPct: null, ledger: 'live' };
  }
  const reason = out.kind === 'refused' ? `${out.reason}: ${out.message}` : out.error;
  return { status: 'failed', side: 'buy', symbol, mint, sig: out.kind === 'send-failed' ? out.signature : null, solDelta: null, pnlSol: null, pnlPct: null, ledger: 'live', reason };
}

function safePreview(exec: TradeExecutor, order: ReturnType<typeof toOrder>, q: SwapQuote): Fill | null {
  try {
    return exec.previewFill(order, q);
  } catch {
    return null;
  }
}

export const POSITIONS_REFRESH_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// task-1323 item 5: the token screen's POSITION row. The screen asks a PositionSource whether the coin
// on screen is held; the paper ledger (PositionsLive) implements it now, and a live ledger implements
// the same interface later — the token screen never sees which. Read-only: nothing here trades.

/** A held position as the token screen needs it. SOL-quoted (Solana swaps settle in SOL). */
export interface HeldPosition {
  mint: string;
  symbol: string;
  /** Spot holdings are `long`; the field exists so a future ledger can report `short`. */
  side: 'long' | 'short';
  /** Whole tokens held (raw base units ÷ 10^decimals). > 0 for a held position. */
  tokens: number;
  /** Cost basis of the tokens held, SOL. */
  costSol: number;
  /** Average entry, SOL per whole token. */
  avgEntrySol: number | null;
  /** Lifetime realized PnL on this mint, SOL (0 = none). */
  realizedSol: number;
  /** The source's own last mark, SOL per token — used only when the screen has no live tick. */
  markSol: number | null;
  /** Protective levels, USD per token; null = not set (the paper ledger has none yet). */
  stopUsd: number | null;
  targetUsd: number | null;
  /** Which ledger this came from (task-1328): set by LivePositions / CombinedPositions. */
  kind?: 'paper' | 'live';
}

/** Where the token screen looks up "do I hold this coin?". Implemented by the paper ledger; live later. */
export interface PositionSource {
  readonly kind: 'paper' | 'live';
  /** The open position for a mint, or null when flat / never held. Synchronous and cheap (per frame). */
  held(mint: string): HeldPosition | null;
  /** SOL/USD the source last saw (to price a SOL ledger in USD); null when unknown. */
  solUsd(): number | null;
}

/** A paper ledger row → HeldPosition (bigint → number happens here). Null when nothing is held. */
export function heldFromPaper(p: Position, markSol: number | null = null): HeldPosition | null {
  if (p.tokensRaw <= 0n) return null;
  const pnl = positionPnl(p, null);
  return {
    mint: p.mint,
    symbol: p.symbol,
    side: 'long',
    tokens: rawToTokens(p.tokensRaw, p.decimals),
    costSol: pnl.costSol,
    avgEntrySol: pnl.avgEntrySol,
    realizedSol: pnl.realizedSol,
    markSol,
    stopUsd: null,
    targetUsd: null,
  };
}

/** Everything the position row draws. USD fields are null when SOL/USD (or a price) is unknown. */
export interface HeldRow {
  side: 'long' | 'short';
  symbol: string;
  tokens: number;
  priceSol: number | null;
  priceUsd: number | null;
  valueSol: number | null;
  valueUsd: number | null;
  avgEntrySol: number | null;
  avgEntryUsd: number | null;
  unrealizedSol: number | null;
  unrealizedUsd: number | null;
  /** Fraction of cost (0.28 = +28 %). */
  unrealizedPct: number | null;
  realizedSol: number;
  realizedUsd: number | null;
  stopUsd: number | null;
  /** (stop − price) ÷ price, fraction; negative = stop below the price. */
  stopDistPct: number | null;
  targetUsd: number | null;
  targetDistPct: number | null;
  /** What priced the row: the screen's live tick, the source's own mark, or nothing yet. */
  basis: 'tick' | 'mark' | 'none';
  solUsd: number | null;
}

const finitePos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Price a held position at the screen's live tick. `tickUsd` is the same USD price the header shows;
 * `solUsd` converts the SOL ledger. The SOL ledger is the truth: USD figures are SOL figures × the
 * current SOL/USD, so value − cost = unrealized holds in both units.
 */
export function positionRow(h: HeldPosition, tickUsd: number | null, solUsd: number | null): HeldRow {
  const sol = finitePos(solUsd) ? solUsd : null;
  const tick = finitePos(tickUsd) ? tickUsd : null;
  const mark = finitePos(h.markSol) ? h.markSol : null;
  const priceSol = tick !== null && sol !== null ? tick / sol : mark;
  const priceUsd = tick ?? (mark !== null && sol !== null ? mark * sol : null);
  const valueSol = priceSol !== null ? h.tokens * priceSol : null;
  const dir = h.side === 'long' ? 1 : -1;
  const unrealizedSol = valueSol !== null ? dir * (valueSol - h.costSol) : null;
  const toUsd = (n: number | null) => (n !== null && sol !== null ? n * sol : null);
  const dist = (lvl: number | null) => (finitePos(lvl) && priceUsd !== null ? (lvl - priceUsd) / priceUsd : null);
  return {
    side: h.side,
    symbol: h.symbol,
    tokens: h.tokens,
    priceSol,
    priceUsd,
    valueSol,
    valueUsd: priceUsd !== null ? h.tokens * priceUsd : null,
    avgEntrySol: h.avgEntrySol,
    avgEntryUsd: toUsd(h.avgEntrySol),
    unrealizedSol,
    unrealizedUsd: toUsd(unrealizedSol),
    unrealizedPct: unrealizedSol !== null && h.costSol > 0 ? unrealizedSol / h.costSol : null,
    realizedSol: h.realizedSol,
    realizedUsd: toUsd(h.realizedSol),
    stopUsd: finitePos(h.stopUsd) ? h.stopUsd : null,
    stopDistPct: dist(h.stopUsd),
    targetUsd: finitePos(h.targetUsd) ? h.targetUsd : null,
    targetDistPct: dist(h.targetUsd),
    basis: tick !== null ? 'tick' : mark !== null ? 'mark' : 'none',
    solUsd: sol,
  };
}

/** How long a `held()` lookup is reused before re-reading the ledger (the render loop calls it per frame). */
export const HELD_MEMO_MS = 250;
/** Minimum spacing of the token screen's automatic mark pass for a held coin missing SOL/USD or a mark. */
export const HELD_AUTOMARK_MS = 30_000;

/** Live PAPER positions + PnL: marks held tokens from the keyless price feed. */
export class PositionsLive implements PositionSource {
  readonly kind = 'paper' as const;
  private readonly dl: DataLayer;
  private readonly wallet: PaperWallet;
  private readonly onChange: () => void;
  private readonly now: () => number;
  /** mint → current price in SOL per whole token. */
  private marks = new Map<string, number>();
  /** task-1407: when each mark was taken (ms), so a PnL card can print the mark's age. */
  private markTimes = new Map<string, number>();
  private solPriceUsd: number | null = null;
  private loading = false;
  private heldMemo = new Map<string, { at: number; v: HeldPosition | null }>();
  private lastAutoMark = -Infinity;
  errors: Record<string, string> = {};

  constructor(dl: DataLayer, wallet: PaperWallet, opts: { onChange?: () => void; now?: () => number } = {}) {
    this.dl = dl;
    this.wallet = wallet;
    this.onChange = opts.onChange ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  setSolPrice(p: number | undefined | null): void {
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) this.solPriceUsd = p;
  }

  /** PositionSource: SOL/USD from the last mark pass (or setSolPrice). */
  solUsd(): number | null {
    return this.solPriceUsd;
  }

  /** The last DexScreener mark for a mint (SOL per token), shared with the live positions source. */
  markOf(mint: string): number | null {
    return this.marks.get(mint) ?? null;
  }

  /** task-1407: when the mark for a mint was taken (ms), or null when there is none. */
  markAt(mint: string): number | null {
    return this.marks.has(mint) ? this.markTimes.get(mint) ?? null : null;
  }

  /**
   * PositionSource: the open paper position for a mint, or null. One indexed SQLite read, reused for
   * HELD_MEMO_MS so a 30 fps render loop does not hit the ledger every frame. A closed wallet reads as flat.
   */
  held(mint: string): HeldPosition | null {
    const now = this.now();
    const memo = this.heldMemo.get(mint);
    if (memo && now - memo.at >= 0 && now - memo.at < HELD_MEMO_MS) return memo.v;
    let v: HeldPosition | null = null;
    try {
      const p = this.wallet.position(mint);
      v = p ? heldFromPaper(p, this.marks.get(mint) ?? null) : null;
    } catch { v = null; }
    if (this.heldMemo.size > 64) this.heldMemo.clear();
    this.heldMemo.set(mint, { at: now, v });
    // A held coin with no SOL/USD (presets whose rows carry no SOL) or no mark yet: run the same
    // DexScreener mark pass the positions screen uses, at most once per HELD_AUTOMARK_MS — so the
    // token screen gets USD PnL without visiting positions. Held coins only; never on a flat mint.
    if (v && (this.solPriceUsd === null || v.markSol === null) && now - this.lastAutoMark >= HELD_AUTOMARK_MS) {
      this.lastAutoMark = now;
      void this.refresh().catch(() => {});
    }
    return v;
  }

  /**
   * Mark held tokens in SOL. Prices come from DexScreener (its own fast 300 rpm bucket), not the
   * keyless `jupiter` bucket the screener feed and quotes share — so a mark never queues behind them.
   * SOL is priced in the same call so a SOL-per-token mark is derivable without the feed's quote.
   */
  async refresh(): Promise<void> {
    const held = this.wallet.positions().filter((p) => p.tokensRaw > 0n).map((p) => p.mint);
    if (held.length === 0) { this.marks.clear(); return; }
    const mints = held.includes(SOL_MINT) ? held : [...held, SOL_MINT];
    this.loading = true;
    this.errors = {};
    try {
      const byMint = await this.dl.dexscreener.tokens(mints);
      const solUsd = byMint.get(SOL_MINT)?.pair.priceUsd ?? null;
      if (solUsd && solUsd > 0) this.solPriceUsd = solUsd;
      if (this.solPriceUsd && this.solPriceUsd > 0) {
        for (const m of held) {
          if (m === SOL_MINT) { this.marks.set(m, 1); continue; }
          const usd = byMint.get(m)?.pair.priceUsd ?? null;
          if (usd && usd > 0) { this.marks.set(m, usd / this.solPriceUsd); this.markTimes.set(m, this.now()); }
        }
      }
    } catch (e) {
      this.errors.positions = msg(e);
    } finally {
      this.loading = false;
      this.heldMemo.clear(); // a fill or a new mark: the token screen re-reads on its next frame
      this.onChange();
    }
  }

  view(): PositionsView {
    const summary = this.wallet.summary();
    const positions = this.wallet.positions();
    const rows: PositionRowView[] = [];
    let equity = lamportsToSol(summary.balanceLamports);
    let totalUnrealized = 0;
    let totalRealized = 0;
    for (const p of positions) {
      const mark = this.marks.get(p.mint) ?? null;
      const pnl = positionPnl(p, mark);
      totalRealized += pnl.realizedSol;
      if (p.tokensRaw <= 0n && p.realizedLamports === 0n) continue; // fully flat, no history interest
      if (pnl.valueSol) equity += pnl.valueSol;
      if (pnl.unrealizedSol !== null) totalUnrealized += pnl.unrealizedSol;
      rows.push({
        mint: p.mint,
        symbol: p.symbol,
        tokens: rawToTokens(p.tokensRaw, p.decimals),
        costSol: pnl.costSol,
        avgEntrySol: pnl.avgEntrySol,
        priceSol: mark,
        valueSol: mark !== null ? pnl.valueSol : null,
        unrealizedSol: pnl.unrealizedSol,
        unrealizedPct: pnl.unrealizedPct,
        realizedSol: pnl.realizedSol,
      });
    }
    rows.sort((a, b) => (b.valueSol ?? 0) - (a.valueSol ?? 0) || b.tokens - a.tokens);
    const startSol = lamportsToSol(summary.startLamports);
    return {
      balanceSol: lamportsToSol(summary.balanceLamports),
      startSol,
      equitySol: equity,
      totalUnrealizedSol: totalUnrealized,
      totalRealizedSol: totalRealized,
      totalPct: startSol > 0 ? (equity - startSol) / startSol : null,
      solPriceUsd: this.solPriceUsd,
      rows,
      history: this.wallet.trades(100),
      loading: this.loading,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// task-1328 item 5: LIVE positions. The signer process books confirmed real fills into its live ledger
// file; the UI reads that file READ-ONLY (never writes it) and serves the same PositionSource interface
// the paper ledger does, so the token screen's position row and the popup chart show real positions
// through the task-1323 selector unchanged. A CombinedPositions wraps both: live wins for a mint when
// held live, else paper; every HeldPosition says which ledger it came from.

/** Live positions from the signer's ledger file (read-only). A missing file reads as flat. */
export class LivePositions implements PositionSource {
  readonly kind = 'live' as const;
  private readonly path: string;
  private readonly now: () => number;
  private readonly mark: (mint: string) => number | null;
  private memo = new Map<string, { at: number; v: HeldPosition | null }>();
  private rowsMemo: { at: number; rows: Position[] } | null = null;
  private solUsdValue: number | null = null;

  constructor(path: string, opts: { now?: () => number; mark?: (mint: string) => number | null; solUsd?: () => number | null } = {}) {
    this.path = path;
    this.now = opts.now ?? (() => Date.now());
    this.mark = opts.mark ?? (() => null);
    if (opts.solUsd) this.solUsdFn = opts.solUsd;
  }
  private solUsdFn: () => number | null = () => this.solUsdValue;

  setSolPrice(p: number | null | undefined): void { if (typeof p === 'number' && Number.isFinite(p) && p > 0) this.solUsdValue = p; }
  solUsd(): number | null { return this.solUsdFn(); }

  /** All positions (open + closed) from the ledger file, memoised HELD_MEMO_MS. Unreadable → []. */
  positions(): Position[] {
    const now = this.now();
    if (this.rowsMemo && now - this.rowsMemo.at >= 0 && now - this.rowsMemo.at < HELD_MEMO_MS) return this.rowsMemo.rows;
    let rows: Position[] = [];
    try {
      const l = new LiveLedger({ path: this.path, readOnly: true });
      try { rows = l.positions(); } finally { l.close(); }
    } catch { rows = []; }
    this.rowsMemo = { at: now, rows };
    return rows;
  }

  /** task-1407: the raw ledger rows (newest first, swaps only) with network + signature, for the LIVE PnL card. */
  fills(mint: string, limit = 500): LiveFillRow[] {
    try {
      const l = new LiveLedger({ path: this.path, readOnly: true });
      try { return l.trades(limit * 2).filter((r) => r.kind === 'swap' && r.mint === mint).slice(0, limit); } finally { l.close(); }
    } catch { return []; }
  }

  /** Confirmed live fills (newest first) for the popup markers / history; probes excluded. */
  records(limit = 100, mint?: string): TradeRecord[] {
    try {
      const l = new LiveLedger({ path: this.path, readOnly: true });
      try { return l.records(limit, mint); } finally { l.close(); }
    } catch { return []; }
  }

  held(mint: string): HeldPosition | null {
    const now = this.now();
    const m = this.memo.get(mint);
    if (m && now - m.at >= 0 && now - m.at < HELD_MEMO_MS) return m.v;
    const p = this.positions().find((x) => x.mint === mint) ?? null;
    const v = p ? heldFromPaper(p, this.mark(mint)) : null;
    if (v) v.kind = 'live';
    if (this.memo.size > 64) this.memo.clear();
    this.memo.set(mint, { at: now, v });
    return v;
  }

  /** Forget memoised reads (after a fill). */
  invalidate(): void { this.memo.clear(); this.rowsMemo = null; }
}

/** Paper + live behind one PositionSource: live wins for a mint when held live, else paper. */
export class CombinedPositions implements PositionSource {
  readonly kind = 'paper' as const;
  readonly paper: PositionsLive;
  readonly live: LivePositions | null;
  constructor(paper: PositionsLive, live: LivePositions | null) { this.paper = paper; this.live = live; }
  held(mint: string): HeldPosition | null {
    const l = this.live?.held(mint) ?? null;
    if (l) return l;
    const p = this.paper.held(mint);
    if (p) p.kind = 'paper';
    return p;
  }
  solUsd(): number | null { return this.paper.solUsd() ?? this.live?.solUsd() ?? null; }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function abortError(reason: string): Error {
  const e = new Error(reason);
  e.name = 'AbortError';
  return e;
}

/** An AbortError from either our bounded confirm timeout/cancel or fetch's own abort. */
function isAbortError(e: unknown): boolean {
  return (e instanceof Error && e.name === 'AbortError')
    || (typeof DOMException !== 'undefined' && e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError'));
}
