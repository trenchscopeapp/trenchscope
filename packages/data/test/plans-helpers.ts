// task-1355 — test helpers: the scripted FixtureExecutor + fixture tokens/price paths. All synthetic;
// no key, no wallet, no network. Ported from research/task-1292/sim/{executor,fixtures}.mjs, typed.
// This file is TEST-ONLY (lives under test/, never imported by src).

import type { Clock } from '../src/clock.ts';
import type { PlanEngine, PriceTick } from '../src/trade/plans/engine.ts';

/**
 * A synchronous fake clock for the plan engine, which only reads now() (it never sleeps). The data-layer
 * FakeClock.advance() is async (it fires timers); the engine's tick loop is synchronous, so the ported
 * tests use this sim-style clock whose advance() moves time in place — matching research/task-1292/sim.
 */
export class SimClock implements Clock {
  private t: number;
  constructor(start = 1_700_000_000_000) { this.t = start; }
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
  sleep(): Promise<void> { return Promise.resolve(); }
}
import { RpcOutage } from '../src/trade/plans/executor.ts';
import type { ChainLookup, Executor, Fill, Quote, QuoteRequest, SubmitOutcome, SubmitRequest } from '../src/trade/plans/executor.ts';
import type { OrderPlan } from '../src/trade/plans/types.ts';

export interface ScriptedOutcome {
  kind: 'filled' | 'send-failed' | 'send-unknown' | 'outage-after-send' | 'crash' | 'rug' | 'sim-failed';
  impactPct?: number;
  priceSkew?: number;
  priorityFeeLamports?: number;
  tipLamports?: number;
  error?: string;
  landed?: boolean;
  roundTripMs?: number;
}

interface ChainEntry { status: 'confirmed' | 'failed'; fill?: Fill }
interface Call { op: 'quote' | 'submit' | 'lookup'; planId?: string; legKey?: string; signature?: string; side?: string; kind?: string; at?: number }

export class FixtureExecutor implements Executor {
  private clock: Clock;
  solUsd: number;
  private fees: { baseFeeLamports: number; priorityFeeLamports: number; tipLamports: number };
  scripts = new Map<string, ScriptedOutcome[]>();
  calls: Call[] = [];
  chain = new Map<string, ChainEntry>();
  outage = false;
  private sigN = 0;

  constructor({ clock, solUsd = 150, baseFeeLamports = 5_000, priorityFeeLamports = 500_000, tipLamports = 100_000 }: { clock: Clock; solUsd?: number; baseFeeLamports?: number; priorityFeeLamports?: number; tipLamports?: number }) {
    this.clock = clock; this.solUsd = solUsd;
    this.fees = { baseFeeLamports, priorityFeeLamports, tipLamports };
  }

  /** Script the next outcomes for a leg key (`${planId}:${legKey}`) or for a mint (`mint:${mint}`). */
  script(key: string, outcomes: ScriptedOutcome[]): void { this.scripts.set(key, [...(this.scripts.get(key) ?? []), ...outcomes]); }
  private nextOutcome(keys: string[]): ScriptedOutcome { for (const k of keys) { const q = this.scripts.get(k); if (q && q.length) return q.shift()!; } return { kind: 'filled' }; }
  private peek(plan: OrderPlan, legKey: string): ScriptedOutcome | null { for (const k of [`${plan.id}:${legKey}`, `mint:${plan.mint}`]) { const q = this.scripts.get(k); if (q && q.length) return q[0]; } return null; }

  quote({ plan, legKey, side, usd, tokenRaw, priceUsd }: QuoteRequest): Quote {
    if (this.outage) throw new RpcOutage();
    const o = this.peek(plan, legKey);
    const impactPct = o?.kind === 'rug' ? 45 : (o?.impactPct ?? 0.4);
    const implied = o?.kind === 'rug' ? priceUsd * 0.2 : priceUsd * (1 + (o?.priceSkew ?? 0));
    const q: Quote = {
      side, priceUsd: implied, impactPct, route: ['Raydium'],
      feeLamports: this.fees.baseFeeLamports + (o?.priorityFeeLamports ?? this.fees.priorityFeeLamports), tipLamports: o?.tipLamports ?? this.fees.tipLamports,
      simOk: o?.kind !== 'sim-failed', simError: o?.kind === 'sim-failed' ? 'custom program error: 0x1' : null, usd: usd ?? null, tokenRaw: tokenRaw ?? null, at: this.clock.now(),
    };
    this.calls.push({ op: 'quote', planId: plan.id, legKey, side, at: q.at });
    return q;
  }

  nextSignature(): string { return `SIG${String(++this.sigN).padStart(4, '0')}`; }

  private computeFill(plan: OrderPlan, quote: Quote, usd: number | null, tokenRaw: bigint | null): Fill {
    const tokens = tokenRaw ?? BigInt(Math.round((usd! / quote.priceUsd) * 10 ** plan.decimals));
    const usdValue = usd ?? Number(tokens) / 10 ** plan.decimals * quote.priceUsd;
    const lamports = BigInt(Math.round(usdValue / this.solUsd * 1e9));
    return { tokenDelta: quote.side === 'buy' ? tokens : -tokens, solDelta: quote.side === 'buy' ? -lamports : lamports, usd: usdValue, priceUsd: quote.priceUsd };
  }

  /** "Sign with the fast wallet and send". The caller journals `signature` BEFORE calling this. */
  submit({ plan, legKey, quote, signature, usd, tokenRaw }: SubmitRequest): SubmitOutcome {
    if (this.outage) throw new RpcOutage();
    const o = this.nextOutcome([`${plan.id}:${legKey}`, `mint:${plan.mint}`]);
    this.calls.push({ op: 'submit', planId: plan.id, legKey, signature, kind: o.kind, at: this.clock.now() });
    const feeLamports = quote.feeLamports + quote.tipLamports;
    const land = (): Fill => { const fill = this.computeFill(plan, quote, usd, tokenRaw); this.chain.set(signature, { status: 'confirmed', fill }); return fill; };
    switch (o.kind) {
      case 'filled': return { kind: 'filled', signature, feeLamports, fill: land(), roundTripMs: o.roundTripMs ?? 900 };
      case 'send-failed': this.chain.set(signature, { status: 'failed' }); return { kind: 'send-failed', signature, error: o.error ?? 'Transaction simulation failed: slippage tolerance exceeded', feeLamports: 0 };
      case 'send-unknown': if (o.landed !== false) land(); else this.chain.set(signature, { status: 'failed' }); return { kind: 'send-unknown', signature, error: 'socket hang up', feeLamports };
      case 'outage-after-send': if (o.landed !== false) land(); else this.chain.set(signature, { status: 'failed' }); throw new RpcOutage();
      case 'crash': if (o.landed !== false) land(); else this.chain.set(signature, { status: 'failed' }); throw new Error('process crashed after send'); // the test simulates the crash
      default: throw new Error(`unknown scripted outcome ${o.kind}`);
    }
  }

  /** What the chain says about a signature (recovery path): {status, fill?} or 'not-found'. */
  lookup(signature: string): ChainLookup { if (this.outage) throw new RpcOutage(); this.calls.push({ op: 'lookup', signature }); return this.chain.get(signature) ?? 'not-found'; }
  chainFill(signature: string): Fill | null { return this.chain.get(signature)?.fill ?? null; }
  submits(): Call[] { return this.calls.filter((c) => c.op === 'submit'); }
}

// ───────────────────────── fixtures ─────────────────────────
export const SUPPLY = 1_000_000_000;
export const TOKEN = { mint: 'Fx9sDipT3StRench3sHoTAbcdefGhiJkLmNoPqRsTuV', symbol: 'TRENCH', decimals: 6 };
export const TOKEN2 = { mint: 'Gy7mRugPu11Ab3cdefGhiJkLmNoPqRsTuVwXyZ12345', symbol: 'RUGME', decimals: 6 };

/** Market cap → price at the fixture supply. */
export const priceAtMc = (mcUsd: number, supply = SUPPLY): number => mcUsd / supply;

/**
 * The north-star path: coin sits at 450k, dips through 300k (entry), recovers, runs through 600k (half
 * exit), keeps going (moon bag held). Each step is a market cap; the engine needs two consecutive fresh
 * ticks to fire, so the path repeats the trigger levels.
 */
export const NORTH_STAR_MC = [450_000, 400_000, 350_000, 320_000, 299_000, 295_000, 290_000, 330_000, 420_000, 500_000, 590_000, 605_000, 612_000, 700_000, 850_000, 1_200_000];

/** Feed a market-cap path into an engine, advancing the clock between ticks. Returns the ticks fed. */
export function feed(engine: PlanEngine, clock: SimClock, mcs: number[], { stepMs = 1000, mint = TOKEN.mint, supply = SUPPLY, source = 'dexscreener', mutate = null as ((t: PriceTick) => void) | null } = {}): PriceTick[] {
  const fed: PriceTick[] = [];
  for (const mc of mcs) {
    clock.advance(stepMs);
    const tick: PriceTick = { mint, priceUsd: priceAtMc(mc, supply), supply, source, ts: clock.now() };
    if (mutate) mutate(tick);
    engine.tick(tick);
    fed.push(tick);
  }
  return fed;
}

export const NORTH_STAR_PLAN = Object.freeze({
  mint: TOKEN.mint, symbol: TOKEN.symbol, decimals: TOKEN.decimals, side: 'buy' as const, sizeUsd: 20,
  entry: { kind: 'mc-below' as const, value: 300_000 },
  exits: [{ at: { kind: 'mc-above' as const, value: 600_000 }, fraction: 0.5 }],
  stop: { kind: 'mc-below' as const, value: 150_000 },
  slippageBps: 300, maxPriceImpactPct: 3, ttlMs: 4 * 3600_000,
});

export const DEFAULT_MANDATE = Object.freeze({
  totalUsd: 1000, perTradeUsd: 25, perCoinUsd: 40, dailyLossUsd: 200,
  maxArmedPlans: 60, maxInFlight: 10, maxOpenPositions: 60, maxSlippageBps: 500, maxPriceImpactPct: 3, maxSendsPerSec: 10,
  tipBudgetLamports: 100_000_000, maxTipLamportsPerTx: 1_000_000, maxPriorityFeeLamportsPerTx: 2_000_000,
  actions: ['buy', 'sell'], maxTier: 'hands-free', ttlMs: 8 * 3600_000,
});

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function manyMints(n: number): string[] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: 44 }, (_, j) => B58[(i * 7 + j * 3) % 58]).join(''));
}
