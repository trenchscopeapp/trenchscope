// Paper trading (task-1310 T0): the keyless swap-quote adapter, fill/PnL maths, the SQLite wallet
// and the paper executor. Importing ./helpers blocks the network for the whole file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/clock.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient, HttpError } from '../src/http.ts';
import type { HttpRequest, HttpResponse, Transport } from '../src/http.ts';
import { DEFAULT_BUCKETS, RateLimiter } from '../src/limiter.ts';
import { JupiterSwap, normalizeSwapQuote, type SwapQuote } from '../src/sources/jupiter-swap.ts';
import {
  PaperWallet, PaperExecutor, InsufficientFundsError, buildQuoteRequest, computeFill, applyBuy, applySell,
  positionPnl, emptyPosition, solToLamports, SOL_MINT, LAMPORTS_PER_SOL, DEFAULT_START_LAMPORTS,
  type PaperOrder, type Fill,
} from '../src/paper.ts';
import { json, drive } from './helpers.ts';

const TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function clientWith(transport: Transport, clock = new FakeClock(1_000_000)) {
  const limiter = new RateLimiter(DEFAULT_BUCKETS, clock);
  const health = new HealthRegistry({ clock });
  const charged: string[] = [];
  const http = new HttpClient({ transport, limiter, health, clock, onRequest: (_r, m) => charged.push(m.source) });
  return { http, limiter, health, clock, charged };
}

/** A synthetic Jupiter quote body (the shape /swap/v1/quote returns). */
function quoteBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputMint: SOL_MINT, outputMint: TOKEN, inAmount: '1000000000', outAmount: '2000000',
    otherAmountThreshold: '1990000', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.005',
    platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }, { swapInfo: { label: 'Whirlpool' } }],
    contextSlot: 123, swapUsdValue: '150', ...over,
  };
}

/** A SwapQuote object directly (for the pure maths, no transport). */
function quote(over: Partial<SwapQuote> = {}): SwapQuote {
  return { ...normalizeSwapQuote(quoteBody() as never, 2_000_000), ...over };
}

// ----------------------------------------------------------------- adapter

test('swap quote: builds the keyless URL, parses amounts to bigint, keeps the route order', async () => {
  let seen = '';
  const t: Transport = async (req: HttpRequest) => { seen = req.url; return json(200, quoteBody()); };
  const { http, charged } = clientWith(t);
  const swap = new JupiterSwap(http);
  const q = await swap.quote({ inputMint: SOL_MINT, outputMint: TOKEN, amount: LAMPORTS_PER_SOL, slippageBps: 50 });
  assert.match(seen, /\/swap\/v1\/quote\?/);
  assert.match(seen, /inputMint=So1111/);
  assert.match(seen, /amount=1000000000/);
  assert.match(seen, /slippageBps=50/);
  assert.match(seen, /swapMode=ExactIn/);
  assert.equal(q.inAmount, 1_000_000_000n);
  assert.equal(q.outAmount, 2_000_000n);
  assert.equal(q.otherAmountThreshold, 1_990_000n);
  assert.deepEqual(q.route, ['Meteora', 'Whirlpool']);
  // Jupiter sends a 0..1 fraction ('0.005'); the quote carries a percent (0.5 == 0.5%).
  assert.equal(q.priceImpactPct, 0.5);
  assert.equal(q.usdValue, 150);
  assert.equal(q.source, 'jupiter-swap');
  assert.deepEqual(charged, ['jupiter-swap'], 'the request is metered under the jupiter-swap source');
});

test('swap quote: a positive amount is required and two distinct mints', async () => {
  const { http } = clientWith(async () => json(200, quoteBody()));
  const swap = new JupiterSwap(http);
  await assert.rejects(() => swap.quote({ inputMint: SOL_MINT, outputMint: TOKEN, amount: 0n, slippageBps: 50 }), /positive/);
  await assert.rejects(() => swap.quote({ inputMint: SOL_MINT, outputMint: SOL_MINT, amount: 1n, slippageBps: 50 }), /different mints/);
});

test('swap quote: 403 on api.jup.ag fails over to lite-api for the session', async () => {
  const hits: string[] = [];
  const t: Transport = async (req: HttpRequest) => {
    hits.push(req.url);
    if (req.url.startsWith('https://api.jup.ag')) return { status: 403, headers: {}, body: 'no', latencyMs: 1 } as HttpResponse;
    return json(200, quoteBody());
  };
  const { http, clock } = clientWith(t);
  const swap = new JupiterSwap(http);
  const q = await drive(clock, swap.quote({ inputMint: SOL_MINT, outputMint: TOKEN, amount: LAMPORTS_PER_SOL, slippageBps: 50 }));
  assert.equal(q.outAmount, 2_000_000n);
  assert.equal(swap.host, 'https://lite-api.jup.ag');
  assert.ok(hits.some((u) => u.startsWith('https://api.jup.ag')) && hits.some((u) => u.startsWith('https://lite-api.jup.ag')));
});

test('swap quote: a 200 body carrying {error} is treated as a failure', async () => {
  const { http } = clientWith(async () => json(200, { error: 'no routes found' }));
  const swap = new JupiterSwap(http);
  await assert.rejects(() => swap.quote({ inputMint: SOL_MINT, outputMint: TOKEN, amount: LAMPORTS_PER_SOL, slippageBps: 50 }), HttpError);
});

// ----------------------------------------------------------------- fill maths

const DECIMALS = 6;
function buyOrder(sol: number, slippageBps = 50): PaperOrder {
  return { mint: TOKEN, symbol: 'USDC', side: 'buy', decimals: DECIMALS, amountRaw: solToLamports(sol), slippageBps };
}

test('computeFill (buy): SOL leaves the wallet incl. fee, tokens arrive, price is SOL/token', () => {
  const q = quote(); // 1 SOL -> 2.0 tokens
  const fill = computeFill(buyOrder(1), q, 5_000_000);
  assert.equal(fill.grossLamports, 1_000_000_000n);
  assert.equal(fill.feeLamports, 5_000n);
  assert.equal(fill.solDelta, -1_000_005_000n, 'SOL out = gross + sim fee');
  assert.equal(fill.tokenDelta, 2_000_000n);
  assert.equal(fill.priceSol, 0.5, '1 SOL for 2.0 tokens = 0.5 SOL/token');
  assert.equal(fill.priceUsd, 75, '150 usd / 2.0 tokens');
  assert.equal(fill.paper, true);
});

test('computeFill (sell): tokens leave, net SOL (minus fee) arrives', () => {
  const sellQ = quote({ inputMint: TOKEN, outputMint: SOL_MINT, inAmount: 2_000_000n, outAmount: 1_100_000_000n });
  const order: PaperOrder = { mint: TOKEN, symbol: 'USDC', side: 'sell', decimals: DECIMALS, amountRaw: 2_000_000n, slippageBps: 50 };
  const fill = computeFill(order, sellQ, 5_000_000);
  assert.equal(fill.grossLamports, 1_100_000_000n);
  assert.equal(fill.solDelta, 1_099_995_000n, 'SOL in = gross - sim fee');
  assert.equal(fill.tokenDelta, -2_000_000n);
  assert.equal(fill.priceSol, 0.55);
});

test('position maths: buy builds cost basis, sell books realized PnL and reduces cost pro-rata', () => {
  const now = 5_000_000;
  let pos = emptyPosition(TOKEN, 'USDC', DECIMALS, now);
  pos = applyBuy(pos, computeFill(buyOrder(1), quote(), now)); // +2.0 tokens, cost 1.000005 SOL
  assert.equal(pos.tokensRaw, 2_000_000n);
  assert.equal(pos.costLamports, 1_000_005_000n);

  // sell half (1.0 token) for 0.6 SOL gross
  const sellHalf = computeFill({ mint: TOKEN, symbol: 'USDC', side: 'sell', decimals: DECIMALS, amountRaw: 1_000_000n, slippageBps: 50 },
    quote({ inputMint: TOKEN, outputMint: SOL_MINT, inAmount: 1_000_000n, outAmount: 600_000_000n }), now);
  const r = applySell(pos, sellHalf);
  assert.equal(r.pos.tokensRaw, 1_000_000n);
  assert.equal(r.pos.costLamports, 500_002_500n, 'half the cost basis removed');
  // realized = net proceeds (0.6 SOL - fee) - cost removed (0.5000025 SOL)
  assert.equal(r.realizedLamports, 599_995_000n - 500_002_500n);
  assert.equal(r.pos.realizedLamports, r.realizedLamports);

  // unrealized on the remaining 1.0 token at 0.7 SOL/token
  const pnl = positionPnl(r.pos, 0.7);
  assert.ok(Math.abs(pnl.valueSol - 0.7) < 1e-9);
  assert.ok(Math.abs((pnl.unrealizedSol ?? 0) - (0.7 - 0.5000025)) < 1e-9);
  assert.equal(positionPnl(r.pos, null).unrealizedSol, null, 'no price → no unrealized');
});

test('buildQuoteRequest: buy is SOL→mint, sell is mint→SOL, both ExactIn', () => {
  assert.deepEqual(buildQuoteRequest(buyOrder(2)), { inputMint: SOL_MINT, outputMint: TOKEN, amount: solToLamports(2), slippageBps: 50, mode: 'ExactIn' });
  const sell: PaperOrder = { mint: TOKEN, symbol: 'USDC', side: 'sell', decimals: DECIMALS, amountRaw: 3n, slippageBps: 100 };
  assert.deepEqual(buildQuoteRequest(sell), { inputMint: TOKEN, outputMint: SOL_MINT, amount: 3n, slippageBps: 100, mode: 'ExactIn' });
});

// ----------------------------------------------------------------- wallet + executor + persistence

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-paper-'));
  return { path: join(dir, 'wallet.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('wallet: default start balance is 10 SOL and is configurable', () => {
  const a = new PaperWallet();
  assert.equal(a.balance(), DEFAULT_START_LAMPORTS);
  assert.equal(a.balance(), 10n * LAMPORTS_PER_SOL);
  a.close();
  const b = new PaperWallet({ startLamports: 25n * LAMPORTS_PER_SOL });
  assert.equal(b.balance(), 25n * LAMPORTS_PER_SOL);
  b.close();
});

test('executor: a buy then a sell books balance, position, realized PnL and history', async () => {
  const clock = new FakeClock(5_000_000);
  const wallet = new PaperWallet({ clock });
  const exec = new PaperExecutor(wallet, { clock });

  const buyRec = await exec.execute(buyOrder(1), quote());
  assert.equal(buyRec.side, 'buy');
  assert.equal(wallet.balance(), 10n * LAMPORTS_PER_SOL - 1_000_005_000n);
  const pos = wallet.position(TOKEN)!;
  assert.equal(pos.tokensRaw, 2_000_000n);

  const sellOrder: PaperOrder = { mint: TOKEN, symbol: 'USDC', side: 'sell', decimals: DECIMALS, amountRaw: 2_000_000n, slippageBps: 50 };
  const sellQ = quote({ inputMint: TOKEN, outputMint: SOL_MINT, inAmount: 2_000_000n, outAmount: 1_100_000_000n });
  const sellRec = await exec.execute(sellOrder, sellQ);
  assert.equal(sellRec.realizedLamports, 1_099_995_000n - 1_000_005_000n, 'profit on the round trip');
  assert.equal(wallet.position(TOKEN)!.tokensRaw, 0n);
  assert.equal(wallet.balance(), 10n * LAMPORTS_PER_SOL - 1_000_005_000n + 1_099_995_000n);

  const history = wallet.trades();
  assert.equal(history.length, 2);
  assert.equal(history[0].side, 'sell'); // newest first
  assert.equal(history[1].side, 'buy');
  assert.deepEqual(history[1].route, ['Meteora', 'Whirlpool']);
  wallet.close();
});

test('executor: a buy beyond the balance is refused and nothing is booked', async () => {
  const wallet = new PaperWallet({ startLamports: LAMPORTS_PER_SOL / 2n }); // 0.5 SOL
  const exec = new PaperExecutor(wallet);
  await assert.rejects(() => exec.execute(buyOrder(1), quote()), InsufficientFundsError);
  assert.equal(wallet.balance(), LAMPORTS_PER_SOL / 2n, 'balance unchanged');
  assert.equal(wallet.trades().length, 0, 'no trade recorded');
  assert.equal(wallet.position(TOKEN), undefined);
  wallet.close();
});

test('executor: selling more than held is refused', async () => {
  const wallet = new PaperWallet();
  const exec = new PaperExecutor(wallet);
  const sellOrder: PaperOrder = { mint: TOKEN, symbol: 'USDC', side: 'sell', decimals: DECIMALS, amountRaw: 5n, slippageBps: 50 };
  const sellQ = quote({ inputMint: TOKEN, outputMint: SOL_MINT, inAmount: 5n, outAmount: 10n });
  await assert.rejects(() => exec.execute(sellOrder, sellQ), InsufficientFundsError);
  wallet.close();
});

test('executor: a quote that does not match the order is rejected (re-quote guard)', async () => {
  const wallet = new PaperWallet();
  const exec = new PaperExecutor(wallet);
  const mismatched = quote({ inAmount: 999n }); // order wants 1 SOL, quote is for a different amount
  await assert.rejects(() => exec.execute(buyOrder(1), mismatched), /does not match/);
  wallet.close();
});

test('wallet persistence: positions, balance and history survive a reopen of the same DB file', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const clock = new FakeClock(5_000_000);
    const w1 = new PaperWallet({ path, clock });
    const exec = new PaperExecutor(w1, { clock });
    await exec.execute(buyOrder(2), quote({ inAmount: 2_000_000_000n, outAmount: 4_000_000n }));
    const bal = w1.balance();
    const tokens = w1.position(TOKEN)!.tokensRaw;
    w1.close();

    const w2 = new PaperWallet({ path, clock }); // reopen: must NOT reset the balance
    assert.equal(w2.balance(), bal);
    assert.equal(w2.position(TOKEN)!.tokensRaw, tokens);
    assert.equal(w2.trades().length, 1);
    assert.equal(w2.summary().startLamports, DEFAULT_START_LAMPORTS, 'start balance is remembered, not re-seeded');
    w2.close();
  } finally {
    cleanup();
  }
});

test('wallet: reset restores the start balance and clears positions + history', async () => {
  const wallet = new PaperWallet();
  const exec = new PaperExecutor(wallet);
  await exec.execute(buyOrder(1), quote());
  assert.ok(wallet.trades().length === 1);
  wallet.reset();
  assert.equal(wallet.balance(), DEFAULT_START_LAMPORTS);
  assert.equal(wallet.positions().length, 0);
  assert.equal(wallet.trades().length, 0);
  wallet.close();
});
