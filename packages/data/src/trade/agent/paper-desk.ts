// task-1443 — the PAPER AGENT DESK: the one surface an untrusted agent (Claude Code, a custom bot) uses to
// open, size, confirm and close a PAPER position, and to read paper positions and paper PnL — strictly inside
// a user-armed mandate's caps (SPEC §6.13, ROADMAP Pillar 4: "agents are untrusted and can never arm, sign or
// raise caps").
//
// Hard boundaries this module keeps, which the public claim "no MCP tool can sign or send" rests on:
//   (a) PAPER LEDGER ONLY. The only trade op is `executor.execute`, a `TradeExecutor` whose `kind` MUST be
//       'paper' (asserted at construction). This file imports NOTHING from the signer, the live executor, the
//       swap BUILD adapter, the rpc sender or the bridge — only the paper ledger (./paper.ts), the mandate
//       SCHEMA (../plans/mandate.ts), the audit journal, the panic kill-switch and the keyless quote TYPE. It
//       is therefore structurally unable to reach any live / wallet / signer / send path (enforced by the
//       no-sign registry test, task-1443).
//   (b) CAPS COME FROM THE USER-SET MANDATE. Every limit is read from the armed `Mandate`, RE-READ on every
//       call (in production: replayed from the hash-chained plans journal the app arms it in, so a revoke or a
//       panic in the app halts the agent at once); there is NO method that changes a cap. An agent runs at the most-restricted confirmation tier (`AGENT_TIER`), so
//       its per-trade cap is the mandate's per-trade cap times that tier's multiplier — it can never meet or
//       exceed a human keypress tier.
//   (c) EVERY CALL IS VALIDATED, JOURNALED AND HALTABLE. Before any state change the desk re-reads the control
//       surface (pause / take-over / stop) and the panic file and re-checks the mandate is alive; a refusal is
//       journaled too, so the spectator view and the audit log see it. The user always wins.

import type { Clock } from '../../clock.ts';
import { systemClock } from '../../clock.ts';
import type { Mandate } from '../plans/mandate.ts';
import { mandateAlive, TIERS } from '../plans/mandate.ts';
import type { TierName } from '../plans/mandate.ts';
import { KillSwitch } from '../kill-switch.ts';
import type { Journal } from '../plans/journal.ts';
import { capsHash } from '../plans/mandate.ts';
import {
  SOL_MINT, buildQuoteRequest, lamportsToSol, solToLamports, rawToTokens,
  type PaperOrder, type Position, type TradeExecutor, type TradeRecord,
} from '../../paper.ts';
import type { PaperWallet } from '../../paper.ts';
import type { QuoteRequest, SwapQuote } from '../../sources/jupiter-swap.ts';
import type { Side } from '../plans/types.ts';

/** The confirmation tier an agent is pinned to: the weakest, so an agent can never match a human keypress. */
export const AGENT_TIER: TierName = 'hands-free';

/** The desk is halted whenever the control surface is not `running`. */
export type DeskControlState = 'running' | 'paused' | 'stopped' | 'takeover';
export interface DeskControl {
  state: DeskControlState;
  reason?: string;
}

/** A refusal from the desk. `reason` is a stable code; `message` is human text (both are journaled). */
export class PaperDeskError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PaperDeskError';
    this.reason = reason;
  }
}

/** A quote fetcher: the keyless Jupiter swap-QUOTE (never the build/sign/send path). */
export type QuoteFn = (req: QuoteRequest, signal?: AbortSignal) => Promise<SwapQuote>;

export interface PaperAgentDeskDeps {
  /**
   * The armed mandate whose caps bound every agent paper trade. A function is re-read on EVERY call (null ⇒
   * refuse), so a revoke / expiry / panic in the app is seen at once; a plain object is for tests.
   */
  mandate: Mandate | (() => Mandate | null);
  /** The simulated paper wallet (node:sqlite), the single source of truth for positions and PnL. */
  wallet: PaperWallet;
  /** The paper executor. MUST be `kind: 'paper'` — a live executor is rejected at construction. */
  executor: TradeExecutor;
  /** Keyless swap-quote fetcher (quote only). */
  quote: QuoteFn;
  /** Current SOL/USD (USD per SOL) used to price the mandate's USD caps; null/≤0 ⇒ refuse (caps unpriceable). */
  solUsd: () => number | null;
  /** The control surface, re-read on every call: pause / take-over / stop halts the agent. */
  control: () => DeskControl;
  /** The hash-chained audit journal (every call and every refusal is appended). Only `append` is used. */
  journal: Pick<Journal, 'append'>;
  /** The global panic kill-switch (a `wallet panic` from any terminal halts the desk). */
  killSwitch?: KillSwitch;
  clock?: Clock;
  /** Label for the journal/spectator (never a real name). */
  agent?: string;
}

/** An in-flight ticket (ephemeral, in memory). A ticket is inert until `confirm`. */
export interface PaperTicket {
  id: string;
  mint: string;
  symbol: string;
  decimals: number;
  side: Side;
  /** For a buy: the intended size in USD. For a sell: the fraction of the held position in (0, 1]. */
  usd: number | null;
  fraction: number | null;
  openedAt: number;
}

/** A position row the read tools return (cost basis + realized; a live mark is layered on by the caller). */
export interface PaperPositionView {
  mint: string;
  symbol: string;
  decimals: number;
  tokens: number;
  costSol: number;
  realizedSol: number;
  avgEntrySol: number | null;
}

/** The paper PnL snapshot. All figures are SIMULATED; a caller must label them PAPER and never as a result. */
export interface PaperPnlView {
  paper: true;
  balanceSol: number;
  startSol: number;
  /** Lifetime realized PnL across all paper positions, SOL. */
  realizedSol: number;
  /** Cost basis currently deployed across open positions, SOL. */
  openCostSol: number;
  positions: PaperPositionView[];
  mandate: { id: string; capsHash: string; perTradeUsd: number; perCoinUsd: number; totalUsd: number; dailyLossUsd: number; maxOpenPositions: number; maxPriceImpactPct: number; expiresAt: number } | null;
}

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * The paper agent desk. One instance per armed mandate + paper wallet. All four verbs (open / size / confirm /
 * close) and both reads (positions / pnl) run here; nothing else is exposed, and there is no cap setter.
 */
export class PaperAgentDesk {
  private readonly mandateSrc: () => Mandate | null;
  /** The mandate the current call runs under (set by `gate`, which every mutating call runs first). */
  private mandate!: Mandate;
  private readonly wallet: PaperWallet;
  private readonly executor: TradeExecutor;
  private readonly quote: QuoteFn;
  private readonly solUsd: () => number | null;
  private readonly control: () => DeskControl;
  private readonly journal: Pick<Journal, 'append'>;
  private readonly kill: KillSwitch;
  private readonly clock: Clock;
  private readonly agent: string;
  private readonly tickets = new Map<string, PaperTicket>();
  private ticketSeq = 0;

  constructor(deps: PaperAgentDeskDeps) {
    if (deps.executor.kind !== 'paper') {
      // The one invariant that makes the "no MCP tool can sign or send" claim true: the desk refuses to hold a
      // live executor. There is no code path from here to a signer, so a live executor is a programming error.
      throw new PaperDeskError('not-paper', `the paper agent desk only accepts a paper executor, got "${deps.executor.kind}"`);
    }
    const m = deps.mandate;
    this.mandateSrc = typeof m === 'function' ? m : () => m;
    this.wallet = deps.wallet;
    this.executor = deps.executor;
    this.quote = deps.quote;
    this.solUsd = deps.solUsd;
    this.control = deps.control;
    this.journal = deps.journal;
    this.kill = deps.killSwitch ?? new KillSwitch();
    this.clock = deps.clock ?? systemClock;
    this.agent = deps.agent ?? 'mcp-agent';
  }

  /** The agent's effective per-trade cap: the mandate cap times the weakest-tier multiplier. */
  private perTradeCapUsd(): number {
    return this.mandate.budget.perTradeUsd * TIERS[AGENT_TIER].perTradeMultiplier;
  }

  /** Journal one audit event (kept out of the hot path's failure mode: never throws). */
  private note(type: string, data: Record<string, unknown>): void {
    try { this.journal.append(type, { mandateId: this.mandate?.id ?? null, data: { agent: this.agent, ...data } }); } catch { /* audit is best-effort */ }
  }

  /** Refuse (journaling the refusal) — the one place a PaperDeskError is raised for a gate failure. */
  private refuse(stage: string, reason: string, message: string, extra: Record<string, unknown> = {}): never {
    this.note('agent.paper.refused', { stage, reason, message, ...extra });
    throw new PaperDeskError(reason, message);
  }

  /**
   * The gate every mutating call runs first: panic file → control surface → mandate alive. A failure here is
   * journaled and throws, so a paused / taken-over / stopped session (or a dead mandate) halts the agent.
   */
  private gate(stage: string, extra: Record<string, unknown> = {}): void {
    const panic = this.kill.engaged();
    if (panic) this.refuse(stage, 'panic', `trading is halted (panic): ${panic.reason}`, extra);
    const c = this.control();
    if (c.state !== 'running') {
      const msg = c.state === 'takeover' ? 'the user has taken over — agent paper trading is paused'
        : c.state === 'paused' ? `agent paper trading is paused${c.reason ? `: ${c.reason}` : ''}`
        : `agent paper trading is stopped${c.reason ? `: ${c.reason}` : ''}`;
      this.refuse(stage, c.state, msg, extra);
    }
    const m = this.mandateSrc();
    if (!m) this.refuse(stage, 'no-mandate', 'no armed mandate is available for agent paper trading', extra);
    this.mandate = m!;
    const alive = mandateAlive(this.mandate, this.clock.now());
    if (!alive.ok) this.refuse(stage, alive.reason, `the mandate is not usable (${alive.reason})`, extra);
  }

  private requireAction(stage: string, side: Side, extra: Record<string, unknown> = {}): void {
    if (!this.mandate.allowed.actions.includes(side)) {
      this.refuse(stage, 'action-not-allowed', `${side} is not permitted by the mandate`, extra);
    }
  }

  private requireMintAllowed(stage: string, mint: string, extra: Record<string, unknown> = {}): void {
    if (this.mandate.allowed.mints && !this.mandate.allowed.mints.includes(mint)) {
      this.refuse(stage, 'mint-not-allowed', 'this mint is not on the mandate allow-list', extra);
    }
  }

  private price(stage: string, extra: Record<string, unknown> = {}): number {
    const p = this.solUsd();
    if (!isFiniteNum(p) || p <= 0) this.refuse(stage, 'no-usd-price', 'no fresh SOL/USD price — cannot price the mandate caps', extra);
    return p as number;
  }

  // ── USD exposure derived from the paper wallet (source of truth), so caps survive a restart ──
  private costUsd(pos: Position | undefined, solUsd: number): number {
    return pos ? lamportsToSol(pos.costLamports) * solUsd : 0;
  }
  private openCostUsd(solUsd: number): number {
    return this.wallet.positions().reduce((s, p) => s + lamportsToSol(p.costLamports) * solUsd, 0);
  }
  /** Realized LOSS (USD, positive) booked since the mandate was armed. Over the whole paper wallet. */
  private realizedLossUsd(solUsd: number): number {
    const since = this.mandate.armedAt ?? this.mandate.createdAt;
    let lamports = 0n;
    for (const t of this.wallet.trades(1000)) {
      if (t.t < since) continue;
      if (t.realizedLamports < 0n) lamports += -t.realizedLamports;
    }
    return lamportsToSol(lamports) * solUsd;
  }

  /** Check the buy caps for `usd`, throwing a cap-named refusal on any breach. */
  private admitBuy(stage: string, mint: string, usd: number, solUsd: number, extra: Record<string, unknown>): void {
    const perTrade = this.perTradeCapUsd();
    if (usd > perTrade + 1e-9) this.refuse(stage, 'per-trade-cap', `$${usd.toFixed(2)} exceeds the agent per-trade cap $${perTrade.toFixed(2)}`, extra);
    const coin = this.costUsd(this.wallet.position(mint), solUsd);
    if (coin + usd > this.mandate.budget.perCoinUsd + 1e-9) {
      this.refuse(stage, 'per-coin-cap', `$${(coin + usd).toFixed(2)} on this coin exceeds the per-coin cap $${this.mandate.budget.perCoinUsd.toFixed(2)}`, extra);
    }
    const total = this.openCostUsd(solUsd);
    if (total + usd > this.mandate.budget.totalUsd + 1e-9) {
      this.refuse(stage, 'total-cap', `$${(total + usd).toFixed(2)} deployed exceeds the total budget $${this.mandate.budget.totalUsd.toFixed(2)}`, extra);
    }
    const held = this.wallet.positions().filter((p) => p.tokensRaw > 0n);
    if (!held.some((p) => p.mint === mint) && held.length >= this.mandate.limits.maxOpenPositions) {
      this.refuse(stage, 'open-positions-cap', `${held.length} open paper positions reached the mandate limit ${this.mandate.limits.maxOpenPositions}`, extra);
    }
    const loss = this.realizedLossUsd(solUsd);
    if (loss >= this.mandate.budget.dailyLossUsd - 1e-9) {
      this.refuse(stage, 'daily-loss-limit', `realized loss $${loss.toFixed(2)} has reached the daily loss limit $${this.mandate.budget.dailyLossUsd.toFixed(2)}; no new buys`, extra);
    }
  }

  // ───────────────────────────── the four verbs ─────────────────────────────

  /** Open an inert PAPER ticket for a mint + side. Validates the gate, the action and the allow-list only. */
  open(input: { mint: string; symbol: string; decimals: number; side: Side }): PaperTicket {
    const side = input.side;
    this.gate('open', { mint: input.mint, side });
    if (typeof input.mint !== 'string' || input.mint.length < 32) this.refuse('open', 'bad-request', 'a base58 mint is required');
    if (!isFiniteNum(input.decimals) || input.decimals < 0 || input.decimals > 18) this.refuse('open', 'bad-request', 'token decimals (0..18) are required');
    this.requireAction('open', side, { mint: input.mint });
    this.requireMintAllowed('open', input.mint, { side });
    const t: PaperTicket = {
      id: `pt_${++this.ticketSeq}_${this.clock.now().toString(36)}`,
      mint: input.mint, symbol: input.symbol, decimals: input.decimals, side, usd: null, fraction: null, openedAt: this.clock.now(),
    };
    this.tickets.set(t.id, t);
    this.note('agent.paper.open', { ticketId: t.id, mint: t.mint, symbol: t.symbol, side });
    return { ...t };
  }

  /** Size a ticket. Buy: `usd` (checked against the caps, never raised). Sell: `fraction` in (0, 1]. */
  size(ticketId: string, input: { usd?: number; fraction?: number }): PaperTicket {
    const t = this.tickets.get(ticketId);
    if (!t) this.refuse('size', 'unknown-ticket', 'no such open ticket');
    this.gate('size', { ticketId });
    if (t!.side === 'buy') {
      const usd = input.usd;
      if (!isFiniteNum(usd) || usd <= 0) this.refuse('size', 'bad-request', 'a positive USD size is required for a buy', { ticketId });
      const solUsd = this.price('size', { ticketId });
      this.admitBuy('size', t!.mint, usd as number, solUsd, { ticketId });
      t!.usd = usd as number;
      t!.fraction = null;
    } else {
      const frac = input.fraction;
      if (!isFiniteNum(frac) || !(frac > 0 && frac <= 1)) this.refuse('size', 'bad-request', 'a sell fraction in (0, 1] is required', { ticketId });
      t!.fraction = frac as number;
      t!.usd = null;
    }
    this.note('agent.paper.size', { ticketId, side: t!.side, usd: t!.usd, fraction: t!.fraction });
    return { ...t! };
  }

  /** Confirm a sized ticket: re-check the gate and the caps, fetch a FRESH quote, book the PAPER fill. */
  async confirm(ticketId: string): Promise<{ fill: TradeRecord; position: PaperPositionView | null }> {
    const t = this.tickets.get(ticketId);
    if (!t) this.refuse('confirm', 'unknown-ticket', 'no such open ticket');
    this.gate('confirm', { ticketId });
    this.requireAction('confirm', t!.side, { ticketId });
    this.requireMintAllowed('confirm', t!.mint, { ticketId });
    const order = await this.buildOrder('confirm', t!);
    const rec = await this.book('confirm', order, { ticketId });
    this.tickets.delete(ticketId);
    return { fill: rec, position: this.positionView(this.wallet.position(t!.mint)) };
  }

  /** Close a fraction of a held PAPER position in one call (open sell → size fraction → confirm). */
  async close(input: { mint: string; fraction?: number }): Promise<{ fill: TradeRecord; position: PaperPositionView | null }> {
    this.gate('close', { mint: input.mint });
    this.requireAction('close', 'sell', { mint: input.mint });
    this.requireMintAllowed('close', input.mint, {});
    const pos = this.wallet.position(input.mint);
    if (!pos || pos.tokensRaw <= 0n) this.refuse('close', 'no-position', 'no open paper position in this mint to close', { mint: input.mint });
    const fraction = input.fraction ?? 1;
    if (!isFiniteNum(fraction) || !(fraction > 0 && fraction <= 1)) this.refuse('close', 'bad-request', 'fraction must be in (0, 1]', { mint: input.mint });
    const t: PaperTicket = { id: `pt_close_${++this.ticketSeq}`, mint: input.mint, symbol: pos!.symbol, decimals: pos!.decimals, side: 'sell', usd: null, fraction, openedAt: this.clock.now() };
    this.note('agent.paper.close', { mint: input.mint, fraction });
    const order = await this.buildOrder('close', t);
    const rec = await this.book('close', order, { mint: input.mint });
    return { fill: rec, position: this.positionView(this.wallet.position(input.mint)) };
  }

  /** Build the paper order from a ticket, re-checking the buy caps against the live wallet at execute time. */
  private async buildOrder(stage: string, t: PaperTicket): Promise<PaperOrder> {
    if (t.side === 'buy') {
      if (!isFiniteNum(t.usd) || t.usd <= 0) this.refuse(stage, 'not-sized', 'the ticket has no size — call size first', { ticketId: t.id });
      const solUsd = this.price(stage, { ticketId: t.id });
      this.admitBuy(stage, t.mint, t.usd as number, solUsd, { ticketId: t.id });
      const amountRaw = solToLamports((t.usd as number) / solUsd);
      if (amountRaw <= 0n) this.refuse(stage, 'bad-request', 'the sized amount rounds to zero lamports', { ticketId: t.id });
      return { mint: t.mint, symbol: t.symbol, side: 'buy', decimals: t.decimals, amountRaw, slippageBps: this.mandate.limits.maxSlippageBps };
    }
    const pos = this.wallet.position(t.mint);
    if (!pos || pos.tokensRaw <= 0n) this.refuse(stage, 'no-position', 'no paper tokens to sell', { ticketId: t.id });
    const frac = t.fraction ?? 1;
    let amountRaw = BigInt(Math.round(Number(pos!.tokensRaw) * frac));
    if (amountRaw > pos!.tokensRaw) amountRaw = pos!.tokensRaw;
    if (amountRaw <= 0n) this.refuse(stage, 'bad-request', 'the sell fraction rounds to zero tokens', { ticketId: t.id });
    return { mint: t.mint, symbol: pos!.symbol, side: 'sell', decimals: pos!.decimals, amountRaw, slippageBps: this.mandate.limits.maxSlippageBps };
  }

  /** Fetch a fresh quote and book the fill through the PAPER executor; journal the booked fill. */
  private async book(stage: string, order: PaperOrder, extra: Record<string, unknown>): Promise<TradeRecord> {
    let quote: SwapQuote;
    try { quote = await this.quote(buildQuoteRequest(order)); }
    catch (e) { this.refuse(stage, 'quote-failed', `could not price the trade: ${e instanceof Error ? e.message : String(e)}`, extra); }
    // Buys honour the mandate's price-impact ceiling (SwapQuote.priceImpactPct is already a PERCENT — the source
    // converts Jupiter's 0..1 fraction once). Exits are never trapped by it, like the plan engine's stop leg.
    if (order.side === 'buy' && isFiniteNum(quote!.priceImpactPct) && quote!.priceImpactPct > this.mandate.limits.maxPriceImpactPct + 1e-9) {
      this.refuse(stage, 'price-impact', `price impact ${quote!.priceImpactPct.toFixed(2)}% exceeds the mandate max ${this.mandate.limits.maxPriceImpactPct}%`, extra);
    }
    // The control surface may have flipped while the quote was in flight: re-check right before booking.
    this.gate(stage, extra);
    let rec: TradeRecord;
    try { rec = await this.executor.execute(order, quote!); }
    catch (e) { this.refuse(stage, 'fill-failed', e instanceof Error ? e.message : String(e), extra); }
    this.note('agent.paper.fill', {
      ...extra, mint: rec!.mint, symbol: rec!.symbol, side: rec!.side, paper: true,
      solDelta: rec!.solDelta.toString(), tokenDelta: rec!.tokenDelta.toString(),
      priceSol: rec!.priceSol, priceUsd: rec!.priceUsd, realizedLamports: rec!.realizedLamports.toString(), fillId: rec!.id,
    });
    return rec!;
  }

  // ───────────────────────────── the two reads ─────────────────────────────

  private positionView(pos: Position | undefined): PaperPositionView | null {
    if (!pos) return null;
    const tokens = rawToTokens(pos.tokensRaw, pos.decimals);
    const costSol = lamportsToSol(pos.costLamports);
    return {
      mint: pos.mint, symbol: pos.symbol, decimals: pos.decimals, tokens,
      costSol, realizedSol: lamportsToSol(pos.realizedLamports),
      avgEntrySol: tokens > 0 ? costSol / tokens : null,
    };
  }

  /** Read paper positions (cost basis + realized; the caller may layer a live mark). Read-only. */
  positions(): PaperPositionView[] {
    return this.wallet.positions().map((p) => this.positionView(p)!).filter(Boolean);
  }

  /** Read the paper PnL snapshot (balance, realized, open cost, per-position). Read-only, always PAPER. */
  pnl(): PaperPnlView {
    const s = this.wallet.summary();
    const m = this.mandateSrc();
    const positions = this.positions();
    const realizedSol = positions.reduce((a, p) => a + p.realizedSol, 0);
    const openCostSol = positions.reduce((a, p) => a + p.costSol, 0);
    return {
      paper: true,
      balanceSol: lamportsToSol(s.balanceLamports),
      startSol: lamportsToSol(s.startLamports),
      realizedSol,
      openCostSol,
      positions,
      mandate: m ? {
        id: m.id, capsHash: capsHash(m), perTradeUsd: m.budget.perTradeUsd * TIERS[AGENT_TIER].perTradeMultiplier, perCoinUsd: m.budget.perCoinUsd,
        totalUsd: m.budget.totalUsd, dailyLossUsd: m.budget.dailyLossUsd, maxOpenPositions: m.limits.maxOpenPositions,
        maxPriceImpactPct: m.limits.maxPriceImpactPct, expiresAt: m.expiresAt,
      } : null,
    };
  }
}

export { SOL_MINT };
