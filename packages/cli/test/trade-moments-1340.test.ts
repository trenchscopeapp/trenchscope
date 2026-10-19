// task-1340 trade moments, the CLI side. The acceptance rule is structural: effects fire ONLY after a settled
// outcome. Proven here three ways: (1) the ticket binding's `onSettled` fires once per booked paper fill / failure
// and, in LIVE, once per filled / refused / send-failed signer outcome, never for a quote, a plan, an in-flight
// send or a `send-unknown`; (2) `fireMoment` has exactly one caller in the app (main.ts's live.onSettled hook) and
// the ticket screen never imports it; (3) the ticket screen is shielded: its rect renders byte-identical with the
// loudest effects + a live moment vs calm, in every phase, at 176 / 120 / 90.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeSwapQuote, SOL_MINT, LAMPORTS_PER_SOL,
  type SwapQuote, type PaperOrder, type Fill, type PaperWallet, type TradeExecutor, type DataLayer, type SignerPort, type ConfirmView, type PlanView, type StatusView, type LinkedWallet,
} from '@dexterm/data';
import { THEMES, makeVfx, fireMoment, pulse, applyFx, type SettledTx } from '@dexterm/tui';
import { TradeTicketLive, settledFromFill, settledFromConfirm } from '../src/live/trade.ts';
import type { TicketKey } from '../src/trade.ts';
import { makeFixtureState, renderFrame, type AppState } from '../src/state.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PK = 'Phan7om111111111111111111111111111111111111';
const NOW = 1_000_000;

function quote(): SwapQuote {
  return normalizeSwapQuote({
    inputMint: SOL_MINT, outputMint: MINT, inAmount: '500000000', outAmount: '2000000',
    otherAmountThreshold: '1990000', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.005',
    platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '75',
  } as never, NOW);
}
const FILL = { mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, t: NOW, tokenDelta: 2_000_000n, solDelta: -500_000_000n, grossLamports: 500_000_000n, feeLamports: 5000n, realizedLamports: 0n, priceSol: 0.00000025, priceUsd: null, priceImpactPct: 0.5, slippageBps: 50, route: ['Meteora'], paper: true } as unknown as Fill;
const SELL_FILL = { ...FILL, side: 'sell', tokenDelta: -2_000_000n, solDelta: 600_000_000n, grossLamports: 600_000_000n, realizedLamports: 100_000_000n } as unknown as Fill;

function fakeWallet(costLamports = 500_000_000n): PaperWallet {
  return { balance: () => 10n * LAMPORTS_PER_SOL, position: () => ({ mint: MINT, symbol: 'USDC', decimals: 6, tokensRaw: 2_000_000n, costLamports, realizedLamports: 0n, updatedAt: NOW }), positions: () => [] } as unknown as PaperWallet;
}
function fakeDl(): DataLayer {
  return {
    clock: { now: () => NOW },
    limiter: { bucket: () => ({ stats: () => ({ pausedUntil: 0 }) }) },
    store: { enrich: async () => ({ rows: [{ token: { decimals: 6 } }] }) },
    jupiterSwap: { quote: async () => quote() },
  } as unknown as DataLayer;
}
const ch = (c: string): TicketKey => ({ name: 'char', ch: c });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

test('paper: onSettled fires exactly once per BOOKED fill (buy → buy, sell → profit by realized PnL) and never for the warm quote', async () => {
  const settled: SettledTx[] = [];
  let exec: Fill = FILL;
  const executor = { previewFill: () => exec, execute: async () => exec } as unknown as TradeExecutor;
  const tl = new TradeTicketLive(fakeDl(), fakeWallet(), executor, { mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' }, { now: () => NOW, onSettled: (tx) => settled.push(tx) });
  tl.key(ch('0')); tl.key(ch('.')); tl.key(ch('5'));
  tl.refreshQuote(); await tick();
  assert.equal(settled.length, 0, 'quotes never settle anything');
  assert.equal(tl.key({ name: 'enter' }), 'none'); // → confirm phase
  assert.equal(settled.length, 0, 'arming never settles anything');
  assert.equal(tl.key(ch('y')), 'confirm');
  await tl.confirm();
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0], { status: 'confirmed', side: 'buy', symbol: 'USDC', mint: MINT, sig: null, solDelta: -0.5, pnlSol: 0, pnlPct: null, ledger: 'paper' });
  // a sell books realized PnL: pnl fraction = realized / cost before the sell
  exec = SELL_FILL;
  const sell = new TradeTicketLive(fakeDl(), fakeWallet(500_000_000n), executor, { mint: MINT, symbol: 'USDC', decimals: 6, side: 'sell' }, { now: () => NOW, onSettled: (tx) => settled.push(tx) });
  sell.key(ch('1')); sell.key(ch('0')); sell.key(ch('0'));
  sell.key({ name: 'enter' }); sell.key(ch('y'));
  await sell.confirm();
  assert.equal(settled.length, 2);
  assert.equal(settled[1].side, 'sell');
  assert.ok(Math.abs((settled[1].pnlSol ?? 0) - 0.1) < 1e-9);
  assert.ok(Math.abs((settled[1].pnlPct ?? 0) - 0.2) < 1e-9, '0.1 SOL on a 0.5 SOL cost = +20 %');
  assert.equal(settled[1].ledger, 'paper');
});

test('paper: a failed execution settles ONCE as failed (with the reason); an esc-cancelled confirm settles nothing', async () => {
  const settled: SettledTx[] = [];
  const executor = { previewFill: () => FILL, execute: async () => { throw new Error('paper wallet: insufficient balance'); } } as unknown as TradeExecutor;
  const tl = new TradeTicketLive(fakeDl(), fakeWallet(), executor, { mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' }, { now: () => NOW, onSettled: (tx) => settled.push(tx) });
  tl.key(ch('0')); tl.key(ch('.')); tl.key(ch('5')); tl.key({ name: 'enter' }); tl.key(ch('y'));
  await tl.confirm();
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'failed');
  assert.match(settled[0].reason ?? '', /insufficient balance/);
  // cancelled: the quote never resolves, esc returns to editing, nothing settles
  const hang = { ...fakeDl(), jupiterSwap: { quote: (_r: unknown, signal?: AbortSignal) => signal ? new Promise<SwapQuote>((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))) : Promise.resolve(quote()) } } as unknown as DataLayer;
  const t2 = new TradeTicketLive(hang, fakeWallet(), executor, { mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' }, { now: () => NOW, onSettled: (tx) => settled.push(tx) });
  t2.key(ch('0')); t2.key(ch('.')); t2.key(ch('5')); t2.key({ name: 'enter' }); t2.key(ch('y'));
  const p = t2.confirm();
  await tick();
  t2.cancel();
  await p;
  assert.equal(settled.length, 1, 'esc during filling settles nothing');
});

// ---- LIVE: the signer's outcomes
function planView(): PlanView {
  return {
    hash: 'H'.repeat(64), kind: 'swap', network: 'devnet', mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, amountInRaw: '500000000', amountOutRaw: '2000000', minOutRaw: '1990000',
    slippageBps: 50, route: ['Meteora'], priceImpactPct: 0.5, notionalUsd: null, solUsd: { price: 150, sources: ['dexscreener'] },
    sim: { ran: true, ok: true, error: null, unitsConsumed: null, solOutLamports: '500005000' }, feeLamports: '6234', prioritizationFeeLamports: 1234,
    instructions: [{ program: 'Jupiter', op: 'route' }], policy: { ok: true }, precheck: { ok: true }, userPublicKey: PK, builtAt: NOW, expiresAt: NOW + 90_000,
  } as unknown as PlanView;
}
class FakeSigner implements SignerPort {
  async fast(): Promise<never> { throw new Error('fill path not used by the ticket'); }
  async fill(): Promise<never> { throw new Error('fill path not used by the ticket'); }
  alive = true;
  confirm_: ConfirmView = { kind: 'filled', signature: 'S'.repeat(88), fill: { t: NOW, mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, solDelta: '-500005000', tokenDelta: '2000000', feeLamports: '5000', priceSol: 0.00025, realizedLamports: '0' }, roundTripMs: 12, lighthouseTail: 0, network: 'devnet' };
  async status(): Promise<StatusView> { return { version: 1, pid: 1, linked: { publicKey: PK, linkedAt: NOW }, network: 'devnet', rpcHost: 'api.devnet.solana.com', caps: { network: 'devnet', mainnetEnabled: false, perTradeUsd: 5, dailyUsd: 20, maxPriceImpactPct: 3, maxSolOut: 1, maxSlippageBps: 500 }, panic: null, ledgerLocked: null, spentTodayUsd: 0, plans: 0, solUsd: { price: 150, sources: ['dexscreener'] }, probeAvailable: true } as unknown as StatusView; }
  async plan(): Promise<PlanView> { return planView(); }
  async probe(): Promise<PlanView> { return planView(); }
  async precheck(): Promise<{ ok: boolean }> { return { ok: true }; }
  async confirm(): Promise<ConfirmView> { return this.confirm_; }
  async drop(): Promise<void> {}
  async panic(): Promise<void> {}
  close(): void { this.alive = false; }
}
const linked: LinkedWallet = { publicKey: PK, linkedAt: NOW };
async function liveRun(out: ConfirmView): Promise<SettledTx[]> {
  const settled: SettledTx[] = [];
  const signer = new FakeSigner(); signer.confirm_ = out;
  const executor = { previewFill: () => FILL, execute: async () => FILL } as unknown as TradeExecutor;
  const tl = new TradeTicketLive(fakeDl(), fakeWallet(), executor, { mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' }, { now: () => NOW, live: { signer: () => signer, linked: () => linked }, onSettled: (tx) => settled.push(tx) });
  tl.key(ch('0')); tl.key(ch('.')); tl.key(ch('5'));
  tl.key(ch('L')); await tick();
  assert.equal(settled.length, 0, 'flipping to LIVE settles nothing');
  assert.equal(tl.key({ name: 'enter' }), 'plan'); await tick();
  assert.equal(settled.length, 0, 'the PLAN settles nothing');
  assert.equal(tl.key(ch('Y')), 'confirm-live'); // the binding runs confirmLive() itself
  await tick(); await tick();
  return settled;
}

test('live: a filled outcome settles once with the signature (ledger live); refused / send-failed settle as failed; send-unknown settles NOTHING', async () => {
  const filled = await liveRun(new FakeSigner().confirm_);
  assert.equal(filled.length, 1);
  assert.equal(filled[0].status, 'confirmed'); assert.equal(filled[0].ledger, 'live'); assert.equal(filled[0].sig, 'S'.repeat(88)); assert.ok(Math.abs((filled[0].solDelta ?? 0) + 0.500005) < 1e-9);
  const refused = await liveRun({ kind: 'refused', reason: 'per-trade-cap', message: '$7.50 > $5' });
  assert.equal(refused.length, 1); assert.equal(refused[0].status, 'failed'); assert.match(refused[0].reason ?? '', /per-trade-cap/);
  const failed = await liveRun({ kind: 'send-failed', signature: null, error: 'blockhash expired' });
  assert.equal(failed.length, 1); assert.equal(failed[0].status, 'failed');
  const unknown = await liveRun({ kind: 'send-unknown', signature: 'U'.repeat(88), error: 'confirmation timed out' });
  assert.equal(unknown.length, 0, 'an unknown outcome is not a result: no effect, no sound');
  // the pure mappers agree
  assert.equal(settledFromConfirm({ kind: 'send-unknown', signature: 'x', error: 'e' }, 'USDC', MINT, false), null);
  assert.equal(settledFromConfirm(new FakeSigner().confirm_, 'USDC', MINT, true), null, 'the devnet probe is not a trade');
  assert.equal(settledFromFill(SELL_FILL, 500_000_000n).pnlPct, 0.2);
});

test('structure: fireMoment has exactly one caller in the app (the onSettled hook) and the ticket renderer never touches moments', () => {
  const read = (p: string) => readFileSync(resolve(HERE, '..', 'src', p), 'utf8');
  const main = read('main.ts');
  const calls = [...main.matchAll(/\bfireMoment\(/g)].length;
  assert.equal(calls, 1, 'one fireMoment call site in main.ts');
  const at = main.indexOf('fireMoment(');
  const hook = main.lastIndexOf('live.onSettled = (tx: SettledTx) =>', at);
  assert.ok(hook >= 0 && at - hook < 600, 'the call sits inside the live.onSettled hook');
  for (const f of ['screens/ticket.ts', 'live/trade.ts', 'trade.ts', 'live/token.ts', 'popup.ts']) assert.ok(!/fireMoment|fireInflight|playMoment/.test(read(f)), `${f} never fires an effect`);
  // the sound follows the same hook, and only it
  assert.equal([...main.matchAll(/\bplayMoment\(/g)].length, 1);
});

test('shield: the ticket (every phase) renders byte-identical under full effects + a live moment vs calm, at 176 / 120 / 90', () => {
  const T = THEMES.cyberspace;
  const phases = ['editing', 'confirm', 'filling', 'filled', 'error'] as const;
  const rect = (c: { w: number; h: number }) => { const bw = Math.min(c.w >= 100 ? 78 : c.w - 2, c.w - 2); return { x: 1, y: 2, w: bw, h: c.h - 3 }; }; // ticket box + the banner rows above it
  const snap = (c: ReturnType<typeof renderFrame>, r: { x: number; y: number; w: number; h: number }) => { const o: string[] = []; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const i = c.idx(x, y); o.push(`${c.ch[i]}|${c.fg[i]}|${c.bg[i]}|${c.at[i]}`); } return o.join('\n'); };
  let cases = 0;
  for (const [w, h] of [[176, 48], [120, 40], [90, 36]] as const) for (const phase of phases) for (const over of [{ side: 'buy' }, { side: 'sell', pnlSol: -0.2, pnlPct: -0.3 }, { status: 'failed' }] as Array<Partial<SettledTx>>) {
    const calm: AppState = makeFixtureState({ screen: 'ticket', theme: T, intensity: 'off', frame: 41 });
    const loud: AppState = makeFixtureState({ screen: 'ticket', theme: T, intensity: 'fever', frame: 41 });
    for (const st of [calm, loud]) if (st.ticket) st.ticket.ticket.phase = phase;
    pulse(loud.vfx, 'rug');
    const m = fireMoment(loud.vfx, { status: 'confirmed', side: 'buy', symbol: 'FTREE', mint: 'm', sig: null, solDelta: -0.5, pnlSol: 0, pnlPct: 0, ledger: 'paper', ...over } as SettledTx, { fps: 30, origin: { x: 1, y: 4, w: 78, h: 30 } })!;
    loud.vfx.frame = m.t0 + Math.round(m.dur * 0.4);
    const a = renderFrame(calm, w, h), b = renderFrame(loud, w, h);
    assert.ok(b.hasShield, 'the ticket screen shields its rect');
    const r = rect(a);
    assert.equal(snap(b, r), snap(a, r), `${w}x${h} ${phase} ${JSON.stringify(over)}`);
    cases++;
  }
  assert.ok(cases >= 45);
  // and the effects really ran: outside the ticket the loud frame differs from the calm one
  const calm = makeFixtureState({ screen: 'ticket', theme: T, intensity: 'off', frame: 41 });
  const loud = makeFixtureState({ screen: 'ticket', theme: T, intensity: 'fever', frame: 41 });
  fireMoment(loud.vfx, { status: 'confirmed', side: 'sell', symbol: 'FTREE', mint: 'm', sig: null, solDelta: 1, pnlSol: 0.5, pnlPct: 0.5, ledger: 'paper' }, { fps: 30 });
  loud.vfx.frame += 10;
  assert.notEqual(renderFrame(loud, 176, 48).toAnsi(), renderFrame(calm, 176, 48).toAnsi());
  // sanity: a canvas built from the fixture ticket really has a shield covering the ticket title row
  const c = renderFrame(loud, 176, 48);
  assert.equal(c.shield[c.idx(3, 4)], 1);
  void (makeVfx as unknown);
  void (applyFx as unknown);
});
