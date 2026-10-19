// task-1310 MAJOR fix regression: the confirm-time quote must be BOUNDED. After a Jupiter 429 the
// shared keyless `jupiter` bucket pauses for 30 s–10 min; before the fix `confirm()` awaited that
// quote with no timeout, so the ticket hung in `filling` and swallowed esc/P/q (only Ctrl-C escaped).
// These tests prove: the quote carries an AbortSignal, a bounded wait errors instead of hanging, a
// paused bucket shows the 'rate limited' state, and esc cancels an in-flight confirm.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  normalizeSwapQuote, SOL_MINT, LAMPORTS_PER_SOL, currentPriority,
  type SwapQuote, type PaperOrder, type Fill, type PaperWallet, type TradeExecutor, type DataLayer,
} from '@dexterm/data';
import { fmtPct } from '@dexterm/tui';
import { TradeTicketLive } from '../src/live/trade.ts';
import type { TicketKey } from '../src/trade.ts';

// The confirm-quote timer is unref'd (it must never block quit). Node 22's test runner cancels an await that only
// an unref'd timer can settle, so keep the event loop alive while this file runs.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function sampleQuote(): SwapQuote {
  return normalizeSwapQuote({
    inputMint: SOL_MINT, outputMint: MINT, inAmount: '500000000', outAmount: '2000000',
    otherAmountThreshold: '1990000', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.005',
    platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '75',
  } as never, 1_000_000);
}

const FILL = {
  mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, t: 1_000_000,
  tokenDelta: 2_000_000n, solDelta: -500_000_000n, feeLamports: 5000n, realizedLamports: 0n,
  priceSol: 0.00000025, priceUsd: null, priceImpactPct: 0.5,
} as unknown as Fill;

/** A fake wallet: TradeTicketLive only reads balance() and position(). */
function fakeWallet(balanceSol = 10): PaperWallet {
  return {
    balance: () => BigInt(Math.round(balanceSol * Number(LAMPORTS_PER_SOL))),
    position: () => undefined,
    positions: () => [],
  } as unknown as PaperWallet;
}

const fakeExec: TradeExecutor = {
  previewFill: (_o: PaperOrder, _q: SwapQuote) => FILL,
  execute: async (_o: PaperOrder, _q: SwapQuote) => FILL,
} as unknown as TradeExecutor;

interface QuoteHook { (signal?: AbortSignal): Promise<SwapQuote>; }

/** A fake data layer: a warm quote (no signal) always resolves; the confirm quote (signal) is scripted. */
function fakeDl(confirmQuote: QuoteHook, pausedUntil = 0): { dl: DataLayer; lastSignal: { v?: AbortSignal } } {
  const lastSignal: { v?: AbortSignal } = {};
  const dl = {
    clock: { now: () => 1_000_000 },
    limiter: { bucket: () => ({ stats: () => ({ pausedUntil }) }) },
    store: { enrich: async () => ({ rows: [{ token: { decimals: 6 } }] }) },
    jupiterSwap: {
      quote: (_req: unknown, signal?: AbortSignal) => {
        if (!signal) return Promise.resolve(sampleQuote()); // warm quote
        lastSignal.v = signal;
        return confirmQuote(signal);
      },
    },
  } as unknown as DataLayer;
  return { dl, lastSignal };
}

const ch = (c: string): TicketKey => ({ name: 'char', ch: c });

/** Build a ticket, size it, arm it and arrive at `filling` (as the key loop would). */
function armedTicket(dl: DataLayer, opts: { confirmQuoteTimeoutMs?: number; now?: () => number } = {}): TradeTicketLive {
  const tl = new TradeTicketLive(dl, fakeWallet(), fakeExec, { mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' }, {
    now: opts.now ?? (() => 1_000_000),
    confirmQuoteTimeoutMs: opts.confirmQuoteTimeoutMs,
  });
  tl.key(ch('0')); tl.key(ch('.')); tl.key(ch('5')); // 0.5 SOL (below the typed-back threshold)
  const eff = tl.key({ name: 'enter' }); // → confirm
  assert.equal(tl.ticket.phase, 'confirm');
  const armed = tl.key(ch('y')); // → filling, loop calls confirm()
  assert.equal(armed, 'confirm');
  assert.equal(tl.ticket.phase, 'filling');
  return tl;
}

test('confirm quote is BOUNDED: a hung (429-paused) quote errors within the timeout, never hangs', async () => {
  // A quote that only ever settles when aborted — the real 429-paused limiter behaviour.
  const hung: QuoteHook = (signal) => new Promise((_res, rej) => {
    signal!.addEventListener('abort', () => rej(signal!.reason ?? new Error('aborted')), { once: true });
  });
  const { dl, lastSignal } = fakeDl(hung, /* pausedUntil */ 2_000_000);
  const tl = armedTicket(dl, { confirmQuoteTimeoutMs: 40 });

  const started = Date.now();
  await tl.confirm();
  assert.ok(Date.now() - started < 2_000, 'confirm resolved promptly, did not hang on the paused bucket');
  assert.ok(lastSignal.v instanceof AbortSignal, 'the confirm-time quote was passed an AbortSignal');
  assert.equal(tl.ticket.phase, 'error', 'a timed-out quote lands in error, not a permanent filling');
  assert.match(tl.ticket.message ?? '', /rate limited|timed out/i);
  assert.match(tl.ticket.message ?? '', /esc to cancel|retry/i, 'the error tells the user esc/retry work');
});

test('rate-limited state is visible while filling against a paused Jupiter bucket', async () => {
  const hung: QuoteHook = (signal) => new Promise((_res, rej) => {
    signal!.addEventListener('abort', () => rej(signal!.reason ?? new Error('aborted')), { once: true });
  });
  const { dl } = fakeDl(hung, 2_000_000); // bucket paused into the future
  const tl = armedTicket(dl, { confirmQuoteTimeoutMs: 40 });
  const p = tl.confirm();
  assert.equal(tl.view().rateLimited, true, 'the view flags rate-limited while filling on a paused bucket');
  await p;
});

test('esc cancels an in-flight confirm: the ticket returns to editing, never trapped', async () => {
  let aborted = false;
  const hung: QuoteHook = (signal) => new Promise((_res, rej) => {
    signal!.addEventListener('abort', () => { aborted = true; rej(signal!.reason ?? new Error('aborted')); }, { once: true });
  });
  const { dl } = fakeDl(hung);
  const tl = armedTicket(dl, { confirmQuoteTimeoutMs: 10_000 }); // long timeout: esc, not the timer, must free it
  const p = tl.confirm();
  tl.cancel(); // the key loop's esc handler
  await p;
  assert.equal(aborted, true, 'cancel aborted the in-flight quote');
  assert.equal(tl.ticket.phase, 'editing', 'esc returned the ticket to editing');
  assert.match(tl.ticket.message ?? '', /cancel/i);
});

test('DEFECT 1: a 94.67% price impact normalizes to a percent and DISPLAYS as ~94.67%, not 0.9%', () => {
  // Jupiter reports priceImpactPct as a 0..1 fraction; a severe 0.9467 impact must become 94.67 (a
  // percent), both for the cap comparison and for what the user sees. The pre-fix bug stored 0.9467
  // raw, so it both passed the 3% cap AND rendered as "0.9%".
  const q = normalizeSwapQuote({
    inputMint: SOL_MINT, outputMint: MINT, inAmount: '500000000', outAmount: '2000000',
    otherAmountThreshold: '1990000', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.9467',
    platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '75',
  } as never, 1_000_000);
  assert.ok(q.priceImpactPct !== null && Math.abs(q.priceImpactPct - 94.67) < 1e-9, 'stored as a percent (94.67), not the 0.9467 fraction');
  const shown = fmtPct(q.priceImpactPct, { sign: false });
  assert.equal(shown, '94.7%', 'the user sees a ~94.67% impact (rounded for display), never a benign-looking 0.9%');
  assert.notEqual(shown, '0.9%');
});

test('happy path still books: a quote that resolves fills the ticket', async () => {
  const ok: QuoteHook = async () => sampleQuote();
  const { dl, lastSignal } = fakeDl(ok);
  const tl = armedTicket(dl);
  await tl.confirm();
  assert.ok(lastSignal.v instanceof AbortSignal, 'even the happy path carries an abort signal');
  assert.equal(tl.ticket.phase, 'filled');
  assert.equal(tl.view().rateLimited, false);
});

test('task-1387: the warm AND confirm-time quotes run at HIGH priority so they are not starved by background enrichment', async () => {
  // The keyless `jupiter` bucket is ~0.5 rps and shared with the screener/token enrichment. Before
  // this fix the ticket quoted at the default `normal` priority, so on a live token the warm quote
  // took seconds and the confirm-time re-quote hit its 8 s abort → a PAPER fill failed with
  // "quote timed out". A user-initiated trade quote must preempt background work (`high`).
  const seen: { warm?: string; confirm?: string } = {};
  const dl = {
    clock: { now: () => 1_000_000 },
    limiter: { bucket: () => ({ stats: () => ({ pausedUntil: 0 }) }) },
    store: { enrich: async () => ({ rows: [{ token: { decimals: 6 } }] }) },
    jupiterSwap: {
      quote: (_req: unknown, signal?: AbortSignal) => {
        const level = currentPriority()?.level;
        if (signal) seen.confirm = level; else seen.warm = level;
        return Promise.resolve(sampleQuote());
      },
    },
  } as unknown as DataLayer;
  const tl = new TradeTicketLive(dl, fakeWallet(), fakeExec, { mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' }, { now: () => 1_000_000 });
  tl.key(ch('0')); tl.key(ch('.')); tl.key(ch('5')); // 0.5 SOL
  tl.refreshQuote(); // the warm quote, issued synchronously now
  assert.equal(seen.warm, 'high', 'the warm quote preempts background enrichment');
  tl.key({ name: 'enter' }); // → confirm
  tl.key(ch('y')); // → filling
  await tl.confirm(); // the confirm-time re-quote
  assert.equal(seen.confirm, 'high', 'the confirm-time re-quote preempts background enrichment');
  assert.equal(tl.ticket.phase, 'filled', 'and the fill books instead of timing out');
});
