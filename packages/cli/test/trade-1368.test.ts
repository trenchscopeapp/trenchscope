// task-1368 — the ticket side of "live trade cannot go out": (b) the size in USD against the signer's caps BEFORE ⏎,
// red when over, `f` fits it; (c) the devnet-cannot-fill-mainnet-tokens line; (e) small token amounts (0.0144 AVGOx,
// never "0"; "decimals unknown" instead of a guess); (f) the full simulation error + the devnet-vs-mainnet hint; and
// (a) a rate-limited plan that is never dropped: countdown, auto-retry, `r`, esc. Offline: fake signer port, fake
// data layer, no network, nothing signed. The keypress gate (ticketKey's confirm branches) is not touched here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeSwapQuote, SOL_MINT, LAMPORTS_PER_SOL, computeFill, lamportsToSol,
  type SwapQuote, type PaperOrder, type PaperWallet, type TradeExecutor, type DataLayer, type SignerPort, type PlanView, type ConfirmView, type StatusView, type LinkedWallet, type FastView, type QuoteView,
} from '@dexterm/data';
import { fmtAmount } from '@dexterm/tui';
import { openTicket, ticketKey, capPreflight, devnetMintWarning, simFailureHint, CAP_FIT_OVERHEAD_SOL, type TicketContext, type TicketKey } from '../src/trade.ts';
import { TradeTicketLive, rateLimitOf, quoteFromView, RETRY_MIN_MS, RETRY_MAX_MS, RETRY_DEFAULT_MS } from '../src/live/trade.ts';
import { makeFixtureState, renderFrame, type AppState } from '../src/state.ts';

// The second bug-report screenshot: $AVGOx (an xStock, 8 decimals, ~$300 a token), 0.04 SOL = $4.33, DEVNET signer.
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYMBOL = 'AVGOx';
const DECIMALS = 8;
const PK = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const NOW = 1_000_000;
const SOL_USD = 108;
const ctx = (over: Partial<TicketContext> = {}): TicketContext => ({ balanceLamports: 10n * LAMPORTS_PER_SOL, positionTokensRaw: 0n, notionalSol: 0.05, typebackThresholdSol: 1, ...over });
const ch = (c: string): TicketKey => ({ name: 'char', ch: c });
const K = { enter: { name: 'enter' } as TicketKey, esc: { name: 'esc' } as TicketKey };
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------ fakes

/** 0.04 SOL → 0.0144 AVGOx (raw 1_440_000 at 8 decimals), as Jupiter quoted it. */
const RAW = { inputMint: SOL_MINT, outputMint: MINT, inAmount: '40000000', outAmount: '1440000', otherAmountThreshold: '1432800', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', platformFee: null, routePlan: [{ swapInfo: { label: 'Kipseli' } }, { swapInfo: { label: 'Meteora DLMM' } }], contextSlot: 1, swapUsdValue: '4.33' };
const sampleQuote = (): SwapQuote => normalizeSwapQuote(RAW as never, NOW);
const quoteView = (over: Partial<QuoteView> = {}): QuoteView => ({
  inputMint: SOL_MINT, outputMint: MINT, inAmountRaw: RAW.inAmount, outAmountRaw: RAW.outAmount, minOutRaw: RAW.otherAmountThreshold, slippageBps: 50, priceImpactPct: 0,
  route: ['Kipseli', 'Meteora DLMM'], usdValue: 4.33, solUsd: { price: SOL_USD, sources: ['dexscreener', 'coingecko'] }, host: 'https://api.jup.ag', ageMs: 0, fetchedAt: NOW, ...over,
});
const fakeWallet = (): PaperWallet => ({ balance: () => 10n * LAMPORTS_PER_SOL, position: () => undefined, positions: () => [] } as unknown as PaperWallet);
const fakeExec: TradeExecutor = { previewFill: (o: PaperOrder, q: SwapQuote) => computeFill(o, q, NOW), execute: async () => { throw new Error('paper execute is not a live path'); } } as unknown as TradeExecutor;
function fakeDl(opts: { decimals?: number | null; quotes?: number[] } = {}): DataLayer {
  const quotes = opts.quotes ?? [];
  return {
    clock: { now: () => NOW }, limiter: { bucket: () => ({ stats: () => ({ pausedUntil: 0 }) }) },
    store: { enrich: async () => ({ rows: [{ token: { decimals: opts.decimals === undefined ? DECIMALS : opts.decimals } }] }) },
    jupiterSwap: { quote: async () => { quotes.push(1); return sampleQuote(); } },
  } as unknown as DataLayer;
}

function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    hash: 'a'.repeat(64), kind: 'swap', lane: 'main', ref: null, network: 'devnet', mint: MINT, symbol: SYMBOL, side: 'buy', decimals: DECIMALS, amountInRaw: RAW.inAmount, amountOutRaw: RAW.outAmount, minOutRaw: RAW.otherAmountThreshold,
    slippageBps: 50, route: ['Kipseli', 'Meteora DLMM'], priceImpactPct: 0, notionalUsd: null, solUsd: { price: SOL_USD, sources: ['dexscreener', 'coingecko'] },
    sim: { ran: true, ok: true, error: null, unitsConsumed: null, solOutLamports: '40005000' }, mintOnNetwork: false, feeLamports: '105000', prioritizationFeeLamports: 100000,
    instructions: [{ program: 'ComputeBudget', op: 'SetComputeUnitLimit' }, { program: 'Jupiter', op: 'shared_accounts_route' }], policy: { ok: true }, precheck: { ok: true },
    userPublicKey: PK, builtAt: NOW, expiresAt: NOW + 90_000, ...over,
  };
}
function statusView(over: Partial<StatusView> = {}): StatusView {
  return {
    version: 1, pid: 4242, linked: { publicKey: PK, linkedAt: NOW }, fastWallet: null, network: 'devnet', rpcHost: 'api.devnet.solana.com',
    caps: { network: 'devnet', mainnetEnabled: false, perTradeUsd: 5, dailyUsd: 20, maxPriceImpactPct: 3, maxSolOut: 1, maxSlippageBps: 500 },
    panic: null, ledgerLocked: null, spentTodayUsd: 0, plans: 0, solUsd: { price: SOL_USD, sources: ['dexscreener', 'coingecko'] }, probeAvailable: true, ...over,
  };
}
/** The signer's rate-limit refusal as the client surfaces it (reason + retryAfterMs + its own message). */
const rateLimited = (ms: number, host = 'api.jup.ag'): Error => Object.assign(new Error(`rate-limited: Jupiter is rate limiting this IP (429 from ${host}); retry in ${Math.ceil(ms / 1000)}s`), { reason: 'rate-limited', retryAfterMs: ms });

class FakeSigner implements SignerPort {
  alive = true;
  calls: string[] = [];
  status_ = statusView();
  plan_ = planView();
  /** Errors to throw from plan(), in order, before plan_ is returned. */
  planErrors: Error[] = [];
  quote_: QuoteView | null = quoteView();
  quoteError: Error | null = null;
  async status(): Promise<StatusView> { this.calls.push('status'); return this.status_; }
  async plan(p: Parameters<SignerPort['plan']>[0]): Promise<PlanView> { this.calls.push(`plan:${p.side}:${p.amountRaw}`); const e = this.planErrors.shift(); if (e) throw e; return this.plan_; }
  async probe(): Promise<PlanView> { this.calls.push('probe'); return planView({ kind: 'probe', mint: SOL_MINT, symbol: 'SOL' }); }
  async precheck(): Promise<{ ok: boolean }> { this.calls.push('precheck'); return { ok: true }; }
  async confirm(): Promise<ConfirmView> { this.calls.push('confirm'); return { kind: 'refused', reason: 'test', message: 'not here' }; }
  async drop(hash: string): Promise<void> { this.calls.push(`drop:${hash.slice(0, 4)}`); }
  async panic(): Promise<void> { this.calls.push('panic'); }
  async fast(): Promise<FastView> { this.calls.push('fast'); return { loaded: false, publicKey: null, network: 'devnet', balanceLamports: null, maxSolPerFill: 0.05, createdAt: null, reason: 'none' }; }
  async fill(): Promise<PlanView> { this.calls.push('fill'); throw new Error('fill is not a ticket path'); }
  async quote(p: Parameters<SignerPort['plan']>[0]): Promise<QuoteView> { this.calls.push(`quote:${p.side}:${p.amountRaw}`); if (this.quoteError) throw this.quoteError; return this.quote_!; }
  close(): void { this.alive = false; }
}
/** A signer without `quote` (an older fake): the ticket must fall back to the terminal's adapter. */
class NoQuoteSigner extends FakeSigner { override quote = undefined as unknown as FakeSigner['quote']; }

function liveTicket(signer: FakeSigner, opts: { dl?: DataLayer; decimals?: number; linked?: LinkedWallet | null } = {}): TradeTicketLive {
  const seed = { mint: MINT, symbol: SYMBOL, side: 'buy' as const, ...(opts.decimals === undefined ? { decimals: DECIMALS } : opts.decimals > 0 ? { decimals: opts.decimals } : {}) };
  return new TradeTicketLive(opts.dl ?? fakeDl(), fakeWallet(), fakeExec, seed, { now: () => NOW, live: { signer: () => signer, linked: () => (opts.linked === undefined ? { publicKey: PK, linkedAt: NOW } : opts.linked) } });
}
async function liveEditing(signer: FakeSigner, size = '0.05', opts: Parameters<typeof liveTicket>[1] = {}): Promise<TradeTicketLive> {
  const t = liveTicket(signer, opts);
  await tick();
  t.key(ch('L')); await tick(20);
  for (const d of size) t.key(ch(d));
  await tick(350); // the debounced warm quote
  return t;
}
function stateWith(t: TradeTicketLive): AppState {
  const s = makeFixtureState({ screen: 'ticket', intensity: 'off' });
  s.now = new Date(NOW);
  s.live = { ticket: t, linkedWallet: { publicKey: PK, linkedAt: NOW }, creditsStatus: () => undefined, meterStatus: () => undefined, scanMeterLabel: () => null } as unknown as AppState['live'];
  return s;
}
const plain = (s: AppState): string => renderFrame(s, 160, 48).toPlain();

// ------------------------------------------------------------------------------------ (b) cap preflight: pure math

test('capPreflight: 0.05 SOL at SOL $108 is $5.40, OVER the $5 per-trade cap; the fit leaves room for fees + rent (0.043 SOL)', () => {
  const pf = capPreflight({ side: 'buy', sizeSol: 0.05, solUsd: SOL_USD, perTradeUsd: 5, dailyUsd: 20, spentTodayUsd: 0 });
  assert.equal(pf.sizeUsd!.toFixed(2), '5.40');
  assert.equal(pf.over, true);
  assert.equal(pf.binding, 'per-trade');
  assert.equal(pf.capUsd, 5);
  assert.equal(pf.dailyRemainingUsd, 20);
  assert.equal(pf.fitSizeSol, 0.043, `floor((5/108 − ${CAP_FIT_OVERHEAD_SOL}) × 1000) / 1000`);
  assert.match(pf.line, /^0\.05 SOL = \$5\.40 > \$5 cap: use ≤ 0\.043 SOL \(f fits it; fees \+ token-account rent counted\)$/);
  // The fit really prices under the cap even with the overhead the signer's simulation adds on top.
  assert.ok((pf.fitSizeSol! + CAP_FIT_OVERHEAD_SOL) * SOL_USD <= 5, 'fit + overhead ≤ cap');
  // Without the overhead allowance the plain floor would be 0.046 — which the signer would refuse once ATA rent lands.
  assert.equal(Math.floor((5 / SOL_USD) * 1000) / 1000, 0.046);
});

test('capPreflight: a SOL price move flips the verdict; the daily remainder binds before the per-trade cap; no price = unknown, never "ok"', () => {
  const cheaper = capPreflight({ side: 'buy', sizeSol: 0.05, solUsd: 90, perTradeUsd: 5, dailyUsd: 20, spentTodayUsd: 0 });
  assert.equal(cheaper.over, false);
  assert.match(cheaper.line, /^0\.05 SOL ≈ \$4\.50 at SOL \$90 · cap \$5\/trade · \$20 left of \$20 today$/);
  assert.equal(cheaper.fitSizeSol, 0.053);

  const nearlySpent = capPreflight({ side: 'buy', sizeSol: 0.05, solUsd: SOL_USD, perTradeUsd: 5, dailyUsd: 20, spentTodayUsd: 17 });
  assert.equal(nearlySpent.over, true);
  assert.equal(nearlySpent.binding, 'daily');
  assert.equal(nearlySpent.capUsd, 3);
  assert.equal(nearlySpent.fitSizeSol, 0.025);
  assert.match(nearlySpent.line, /> \$3 left today: use ≤ 0\.025 SOL/);

  const spent = capPreflight({ side: 'buy', sizeSol: 0.01, solUsd: SOL_USD, perTradeUsd: 5, dailyUsd: 20, spentTodayUsd: 20 });
  assert.equal(spent.over, true);
  assert.equal(spent.fitSizeSol, null);
  assert.match(spent.line, /nothing fits — the cap is spent for today/);

  const unpriced = capPreflight({ side: 'buy', sizeSol: 0.05, solUsd: null, perTradeUsd: 5, dailyUsd: 20, spentTodayUsd: 0 });
  assert.equal(unpriced.sizeUsd, null);
  assert.equal(unpriced.over, false);
  assert.equal(unpriced.fitSizeSol, null);
  assert.match(unpriced.line, /\$\? \(the signer has no SOL\/USD yet/);

  const empty = capPreflight({ side: 'buy', sizeSol: 0, solUsd: SOL_USD, perTradeUsd: 5, dailyUsd: 20, spentTodayUsd: 0 });
  assert.match(empty.line, /enter a size$/);
  // A sell is priced from its SOL leg the same way.
  const sell = capPreflight({ side: 'sell', sizeSol: 0.06, solUsd: SOL_USD, perTradeUsd: 5, dailyUsd: 20, spentTodayUsd: 0 });
  assert.equal(sell.over, true);
});

// ------------------------------------------------------------------------------------ (c) devnet line, (f) sim hint: pure

test('devnetMintWarning: devnet signer + a token = the two ways out, with the caps; not for the probe, wrapped SOL or mainnet', () => {
  assert.equal(devnetMintWarning({ network: 'devnet', probe: false, mint: MINT, perTradeUsd: 5, dailyUsd: 20 }), 'DEVNET cannot fill mainnet tokens: paper trade (L) or restart with --mainnet (real funds, caps $5/$20)');
  assert.equal(devnetMintWarning({ network: 'devnet', probe: true, mint: MINT }), null);
  assert.equal(devnetMintWarning({ network: 'devnet', probe: false, mint: SOL_MINT }), null);
  assert.equal(devnetMintWarning({ network: 'mainnet', probe: false, mint: MINT }), null);
  assert.equal(devnetMintWarning({ network: null, probe: false, mint: MINT }), null);
});

test('simFailureHint: the devnet-vs-mainnet pattern (the reported "invalid transaction: Tr…") gets the plain-English wall; other failures keep only the full error', () => {
  const devnetSim = planView({ sim: { ran: true, ok: false, error: 'rpc simulateTransaction: invalid transaction: Transaction loads an address table account that doesn\'t exist', unitsConsumed: null, solOutLamports: null }, mintOnNetwork: false });
  const hint = simFailureHint(devnetSim, { perTradeUsd: 5, dailyUsd: 20 })!;
  assert.match(hint, /devnet-vs-mainnet wall \(the mint does not exist on devnet\)/);
  assert.match(hint, /Paper trade \(L\) or restart with --mainnet \(real funds, caps \$5\/\$20\)/);
  assert.equal(simFailureHint(planView()), null, 'sim ok');
  assert.equal(simFailureHint(planView({ sim: { ran: false, ok: false, error: null, unitsConsumed: null, solOutLamports: null } })), null, 'not run');
  assert.match(simFailureHint(planView({ network: 'mainnet', sim: { ran: true, ok: false, error: 'Blockhash not found', unitsConsumed: null, solOutLamports: null }, mintOnNetwork: true }))!, /stale plan or the wrong RPC network/);
  assert.equal(simFailureHint(planView({ sim: { ran: true, ok: false, error: 'insufficient lamports 1, need 40005000', unitsConsumed: null, solOutLamports: null }, mintOnNetwork: true })), null, 'a real failure on the right network has no hint');
  // mintOnNetwork false alone (devnet) is enough for the wall even when the error text is opaque.
  assert.match(simFailureHint(planView({ sim: { ran: true, ok: false, error: 'custom program error: 0x1', unitsConsumed: null, solOutLamports: null }, mintOnNetwork: false }))!, /devnet-vs-mainnet wall/);
});

// ------------------------------------------------------------------------------------ (e) amounts

test('fmtAmount in the ticket: the quote\'s outAmount 1 440 000 at 8 decimals renders 0.0144, matching Jupiter', () => {
  const q = sampleQuote();
  assert.equal(fmtAmount(Number(q.outAmount) / 10 ** DECIMALS), '0.0144');
  assert.equal(fmtAmount(Number(q.otherAmountThreshold) / 10 ** DECIMALS), '0.0143');
});

// ------------------------------------------------------------------------------------ the reducer: f

test('ticketKey: f on a LIVE buy asks the binding to fit the cap; inert on PAPER, on a sell, and outside editing', () => {
  const live = openTicket({ mint: MINT, symbol: SYMBOL, decimals: DECIMALS, side: 'buy', mode: 'live' });
  assert.equal(ticketKey(live, ch('f'), ctx()), 'fit-cap');
  assert.equal(ticketKey(live, ch('F'), ctx()), 'fit-cap');
  const paper = openTicket({ mint: MINT, symbol: SYMBOL, decimals: DECIMALS, side: 'buy' });
  assert.equal(ticketKey(paper, ch('f'), ctx()), 'none');
  const sell = openTicket({ mint: MINT, symbol: SYMBOL, decimals: DECIMALS, side: 'sell', mode: 'live' });
  assert.equal(ticketKey(sell, ch('f'), ctx({ positionTokensRaw: 100n })), 'none');
  // The keypress gate is untouched: on the PLAN screen f is a stray key = cancel, never confirm.
  const onPlan = openTicket({ mint: MINT, symbol: SYMBOL, decimals: DECIMALS, side: 'buy', mode: 'live' });
  onPlan.phase = 'plan';
  assert.equal(ticketKey(onPlan, ch('f'), ctx()), 'drop-plan');
  assert.equal(onPlan.phase, 'editing');
});

// ------------------------------------------------------------------------------------ the binding

test('LIVE preview quote comes from the SIGNER (one limiter): the terminal\'s adapter is not called; the signer\'s SOL/USD prices the preflight; an older signer without quote falls back', async () => {
  const dlCalls: number[] = [];
  const signer = new FakeSigner();
  const t = await liveEditing(signer, '0.05', { dl: fakeDl({ quotes: dlCalls }) });
  const v = t.view();
  assert.equal(v.ticket.mode, 'live');
  assert.ok(signer.calls.some((c) => c.startsWith('quote:buy:50000000')), signer.calls.join(','));
  assert.equal(dlCalls.length, 0, 'no size at open → no PAPER quote; every LIVE quote went to the signer, none to the terminal adapter');
  assert.equal(v.quote?.outAmount, 1_440_000n);
  assert.deepEqual(v.quote?.route, ['Kipseli', 'Meteora DLMM']);
  assert.equal(v.live?.preflight?.sizeUsd?.toFixed(2), '5.40');

  const older = new NoQuoteSigner();
  const dl2: number[] = [];
  await liveEditing(older, '0.05', { dl: fakeDl({ quotes: dl2 }) });
  assert.ok(dl2.length >= 1, 'fallback to the terminal adapter');
  assert.ok(!older.calls.some((c) => c.startsWith('quote')));
});

test('f fits the size to the cap (SOL unit, 0.043 at $108) and re-quotes; a % size is converted; the message says what happened', async () => {
  const signer = new FakeSigner();
  const t = await liveEditing(signer, '0.05');
  assert.equal(t.view().live?.preflight?.over, true);
  assert.equal(t.key(ch('f')), 'fit-cap');
  assert.equal(t.ticket.sizeInput, '0.043');
  assert.equal(t.ticket.sizeUnit, 'sol');
  assert.match(t.ticket.message ?? '', /^fit to cap: 0\.043 SOL/);
  await tick(20);
  assert.equal(t.view().live?.preflight?.over, false);
  assert.ok(signer.calls.some((c) => c === 'quote:buy:43000000'), 're-quoted at the fitted size');

  // 50 % of the 10 SOL paper balance = 5 SOL = $540 → f brings it to 0.043 SOL.
  const t2 = await liveEditing(new FakeSigner(), '50');
  t2.key(ch('u')); await tick(350);
  assert.equal(t2.ticket.sizeUnit, 'pct');
  assert.equal(t2.view().live?.preflight?.sizeUsd?.toFixed(0), '540');
  t2.key(ch('f'));
  assert.equal(t2.ticket.sizeUnit, 'sol');
  assert.equal(t2.ticket.sizeInput, '0.043');

  // No SOL/USD from the signer → f explains instead of guessing.
  const blind = new FakeSigner();
  blind.status_ = statusView({ solUsd: { price: null, reason: 'no fresh samples' } });
  blind.quote_ = quoteView({ solUsd: { price: null, reason: 'no fresh samples' } });
  const t3 = await liveEditing(blind, '0.05');
  t3.key(ch('f'));
  assert.match(t3.ticket.message ?? '', /needs the signer's SOL\/USD price/);
  assert.equal(t3.ticket.sizeInput, '0.05');
});

test('rateLimitOf: the client\'s reason + retryAfterMs, the message fallback, the clamps; anything else is null', () => {
  assert.deepEqual(rateLimitOf(rateLimited(3_000)), { ms: 3_000, message: 'Jupiter is rate limiting this IP (429 from api.jup.ag); retry in 3s' });
  assert.equal(rateLimitOf(new Error('rate-limited: Jupiter is rate limiting this IP (429 from lite-api.jup.ag); retry in 8s'))!.ms, 8_000, 'message-only fallback');
  assert.equal(rateLimitOf(Object.assign(new Error('rate-limited: x'), { reason: 'rate-limited' }))!.ms, RETRY_DEFAULT_MS);
  assert.equal(rateLimitOf(rateLimited(200))!.ms, RETRY_MIN_MS);
  assert.equal(rateLimitOf(rateLimited(999_999))!.ms, RETRY_MAX_MS);
  assert.equal(rateLimitOf(new Error('build-failed: HTTP 500 for https://api.jup.ag/swap/v1/swap')), null);
  assert.equal(rateLimitOf(Object.assign(new Error('x'), { reason: 'build-failed' })), null);
  assert.equal(rateLimitOf('rate-limited: not an Error'), null);
});

test('a rate-limited plan is NEVER dropped: the ticket stays in planning with the signer\'s line + countdown, auto-retries when the wait ends, and the plan lands', async () => {
  const signer = new FakeSigner();
  signer.planErrors = [rateLimited(1_000)];
  const t = await liveEditing(signer, '0.04');
  assert.equal(t.key(K.enter), 'plan');
  await tick(20);
  assert.equal(t.ticket.phase, 'planning', 'not error');
  const v = t.view();
  assert.equal(v.live?.retryAt, NOW + 1_000);
  assert.equal(v.live?.retryMessage, 'Jupiter is rate limiting this IP (429 from api.jup.ag); retry in 1s');
  assert.match(t.ticket.message ?? '', /retry in 1s · r retries now · esc cancels$/);
  assert.equal(t.retryInMs(), 1_000);
  assert.equal(signer.calls.filter((c) => c.startsWith('plan')).length, 1);
  assert.ok(!signer.calls.some((c) => c.startsWith('drop')), 'nothing to drop: no plan was built');
  await tick(1_150); // the auto-retry fires on the real timer after ~1 s
  assert.equal(signer.calls.filter((c) => c.startsWith('plan')).length, 2, 'retried by itself');
  assert.equal(t.ticket.phase, 'plan');
  assert.equal(t.view().live?.retryAt, null);
  assert.equal(t.view().live?.plan?.hash, 'a'.repeat(64));
});

test('r retries now; esc during the wait cancels back to editing and the timer never fires', async () => {
  const signer = new FakeSigner();
  signer.planErrors = [rateLimited(30_000), rateLimited(30_000)];
  const t = await liveEditing(signer, '0.04');
  t.key(K.enter); await tick(20);
  assert.equal(t.ticket.phase, 'planning');
  t.retryPlan(); await tick(20);
  assert.equal(signer.calls.filter((c) => c.startsWith('plan')).length, 2, 'r = plan again at once');
  assert.equal(t.ticket.phase, 'planning', 'still rate limited → still waiting');
  t.cancelPlan();
  assert.equal(t.ticket.phase, 'editing');
  assert.equal(t.view().live?.retryAt, null);
  assert.equal(t.retryInMs(), null);
  t.retryPlan(); await tick(20);
  assert.equal(signer.calls.filter((c) => c.startsWith('plan')).length, 2, 'r outside the wait is a no-op');
  // A rate-limited PREVIEW quote shows the signer's line in the quote slot, without a prefix.
  const s2 = new FakeSigner();
  s2.quoteError = rateLimited(6_000);
  const t2 = await liveEditing(s2, '0.04');
  assert.equal(t2.view().error, 'Jupiter is rate limiting this IP (429 from api.jup.ag); retry in 6s');
  // Any other plan failure is still the error phase (unchanged behaviour).
  const s3 = new FakeSigner();
  s3.planErrors = [Object.assign(new Error('build-failed: swap build returned no transaction'), { reason: 'build-failed' })];
  const t3 = await liveEditing(s3, '0.04');
  t3.key(K.enter); await tick(20);
  assert.equal(t3.ticket.phase, 'error');
  assert.match(t3.ticket.message ?? '', /^plan failed: build-failed/);
});

// ------------------------------------------------------------------------------------ the screen

test('screen: BEFORE ⏎ a LIVE buy shows the size in USD vs the caps in red with the fitting size, the DEVNET line, and 0.0144 AVGOx (never 0)', async () => {
  const t = await liveEditing(new FakeSigner(), '0.05');
  const text = plain(stateWith(t));
  assert.match(text, /✗ 0\.05 SOL = \$5\.40 > \$5 cap: use ≤ 0\.043 SOL/);
  // The line wraps inside the 78-column ticket; both halves are on screen.
  assert.match(text, /⚠ DEVNET cannot fill mainnet tokens: paper trade \(L\) or restart with/);
  assert.match(text, /--mainnet \(real funds, caps \$5\/\$20\)/);
  assert.match(text, /You receive\s+0\.0144 AVGOx/, 'the fake signer quotes the same route whatever the size');
  assert.match(text, /f\s+fit cap/);
  assert.doesNotMatch(text, /You receive\s+0 AVGOx/);
});

test('screen: a 0.04 SOL buy renders exactly the quote (0.0144 AVGOx, min 0.0143) and a within-cap line; decimals unknown says so instead of a number', async () => {
  const t = await liveEditing(new FakeSigner(), '0.04');
  const text = plain(stateWith(t));
  assert.match(text, /You receive\s+0\.0144 AVGOx/);
  assert.match(text, /Min received\s+0\.0143 AVGOx/);
  assert.match(text, /0\.04 SOL ≈ \$4\.32 at SOL \$108 · cap \$5\/trade · \$20 left of \$20 today/);
  assert.doesNotMatch(text, /✗ 0\.04 SOL/);

  const unknown = await liveEditing(new FakeSigner(), '0.04', { dl: fakeDl({ decimals: null }), decimals: 0 });
  const u = plain(stateWith(unknown));
  assert.equal(unknown.view().decimalsKnown, false);
  assert.match(u, /You receive\s+AVGOx: decimals unknown yet \(raw 1440000\)/);
  assert.match(u, /per-token price needs the decimals/);
});

test('screen: the PLAN with a failed simulation shows the FULL RPC error over several lines plus the devnet-vs-mainnet hint; a rate-limited wait shows the countdown and r', async () => {
  const signer = new FakeSigner();
  const long = 'rpc simulateTransaction: invalid transaction: Transaction loads an address table account that doesn\'t exist (lookup table 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU is not on this cluster)';
  signer.plan_ = planView({ sim: { ran: true, ok: false, error: long, unitsConsumed: null, solOutLamports: null }, precheck: { ok: false, reason: 'simulation-failed', message: `simulation failed: ${long}` }, mintOnNetwork: false });
  const t = await liveEditing(signer, '0.04');
  t.key(K.enter); await tick(20);
  assert.equal(t.ticket.phase, 'plan');
  const text = plain(stateWith(t));
  assert.match(text, /Simulation\s+FAILED/);
  assert.match(text, /rpc simulateTransaction: invalid transaction: Transaction loads an/);
  assert.match(text, /address table account that doesn't exist \(lookup table/);
  assert.match(text, /is not on this cluster\)/, 'the tail of the error is on screen, not cut to "Tr…"');
  assert.match(text, /↳ devnet-vs-mainnet wall \(the mint does not exist on/);
  assert.match(text, /Paper trade \(L\) or/, 'the way out is on screen too…');
  assert.match(text, /restart with --mainnet \(real funds, caps \$5\/\$20\)\./, '…in full, on the next wrapped line');
  assert.match(text, /the signer WILL REFUSE this plan: simulation-failed/);
  assert.match(text, /You receive\s+0\.0144 AVGOx/);

  const rl = new FakeSigner();
  rl.planErrors = [rateLimited(8_000)];
  const t2 = await liveEditing(rl, '0.04');
  t2.key(K.enter); await tick(20);
  const text2 = plain(stateWith(t2));
  assert.match(text2, /⚠ Jupiter is rate limiting this IP \(429 from api\.jup\.ag\), retrying in 8s/);
  assert.match(text2, /r = retry now · esc = cancel · the plan is kept/);
  assert.match(text2, /r\s+retry now/);
  t2.cancelPlan();
});
