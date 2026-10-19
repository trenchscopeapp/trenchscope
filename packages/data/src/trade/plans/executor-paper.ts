// task-1355 — PAPER fire path for the plan engine (the default; no key, no wallet, no network, no mainnet).
//
// Implements the engine's Executor by booking fills deterministically at the fire-time tick price, exactly
// as paper trading does elsewhere (packages/data/src/paper.ts computeFill). The engine's signer-side policy
// (caps, allow-list, impact ceiling, panic, trigger re-confirm) still runs on every fire — this executor
// only stands in for "sign with the fast wallet + land", so a paper mandate exercises the full money-safe
// path with zero funds at risk. The real devnet/mainnet fire path (async Jupiter warm-quote +
// LiveExecutor.confirmAndSubmit) is a separate adapter and is intentionally not this one.

import type { Clock } from '../../clock.ts';
import type { ChainLookup, Executor, Fill, Quote, QuoteRequest, SubmitRequest } from './executor.ts';

export interface PaperPlanExecutorOptions {
  clock: Clock;
  solUsd?: number;
  baseFeeLamports?: number;
  priorityFeeLamports?: number;
  tipLamports?: number;
  /** modelled price impact for paper quotes (%). Real routes compute this; paper assumes a small constant. */
  impactPct?: number;
}

export class PaperPlanExecutor implements Executor {
  readonly kind = 'paper' as const;
  private clock: Clock;
  private solUsd: number;
  private fees: { baseFeeLamports: number; priorityFeeLamports: number; tipLamports: number };
  private impactPct: number;
  private chain = new Map<string, { status: 'confirmed'; fill: Fill }>();
  private sigN = 0;

  constructor({ clock, solUsd = 150, baseFeeLamports = 5_000, priorityFeeLamports = 500_000, tipLamports = 100_000, impactPct = 0.4 }: PaperPlanExecutorOptions) {
    this.clock = clock; this.solUsd = solUsd;
    this.fees = { baseFeeLamports, priorityFeeLamports, tipLamports };
    this.impactPct = impactPct;
  }

  quote({ plan, side, usd, tokenRaw, priceUsd }: QuoteRequest): Quote {
    return {
      side, priceUsd, impactPct: this.impactPct, route: ['Paper'],
      feeLamports: this.fees.baseFeeLamports + this.fees.priorityFeeLamports, tipLamports: this.fees.tipLamports,
      simOk: true, simError: null, usd: usd ?? null, tokenRaw: tokenRaw ?? null, at: this.clock.now(),
    };
  }

  nextSignature(): string { return `PAPER${String(++this.sigN).padStart(6, '0')}`; }

  private computeFill(decimals: number, quote: Quote, usd: number | null, tokenRaw: bigint | null): Fill {
    const tokens = tokenRaw ?? BigInt(Math.round((usd! / quote.priceUsd) * 10 ** decimals));
    const usdValue = usd ?? Number(tokens) / 10 ** decimals * quote.priceUsd;
    const lamports = BigInt(Math.round(usdValue / this.solUsd * 1e9));
    return { tokenDelta: quote.side === 'buy' ? tokens : -tokens, solDelta: quote.side === 'buy' ? -lamports : lamports, usd: usdValue, priceUsd: quote.priceUsd };
  }

  submit({ plan, quote, signature, usd, tokenRaw }: SubmitRequest) {
    const fill = this.computeFill(plan.decimals, quote, usd, tokenRaw);
    this.chain.set(signature, { status: 'confirmed', fill });
    return { kind: 'filled' as const, signature, feeLamports: quote.feeLamports + quote.tipLamports, fill, roundTripMs: 0 };
  }

  lookup(signature: string): ChainLookup { return this.chain.get(signature) ?? 'not-found'; }
  chainFill(signature: string): Fill | null { return this.chain.get(signature)?.fill ?? null; }
}
