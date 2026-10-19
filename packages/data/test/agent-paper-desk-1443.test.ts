// task-1443 — the PAPER agent desk: caps come from the armed mandate (never raised), pause/take-over/stop and
// the panic file halt the agent, every call (and every refusal) is journaled, and the only trade op is the
// simulated paper ledger. A live executor is rejected at construction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/clock.ts';
import { Journal } from '../src/trade/plans/journal.ts';
import { draftMandate } from '../src/trade/plans/mandate.ts';
import type { Mandate, MandateInput } from '../src/trade/plans/mandate.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { PaperWallet, PaperExecutor, SOL_MINT, type TradeExecutor } from '../src/paper.ts';
import type { QuoteRequest, SwapQuote } from '../src/sources/jupiter-swap.ts';
import { PaperAgentDesk, PaperDeskError, type DeskControl } from '../src/trade/agent/paper-desk.ts';
import { loadMandateFromJournal, SharedJournal, readDeskControl, writePaperAgentRendezvous, readPaperAgentRendezvous, clearPaperAgentRendezvous, writeDeskControl, plansJournalPathFor } from '../src/trade/agent/rendezvous.ts';
import { PlanService } from '../src/trade/plans/service.ts';
import { writeFileSync, readFileSync } from 'node:fs';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OTHER = 'So11111111111111111111111111111111111111112xx';

/** An armed, alive mandate (unit tests arm it directly; arming via a signer gesture is tested elsewhere). */
function armedMandate(clock: FakeClock, input: MandateInput = {}): Mandate {
  const m = draftMandate(input, { clock });
  m.status = 'armed';
  m.armedAt = clock.now();
  return m;
}

/**
 * A deterministic stub quote: buy spends lamports for tokens at `lamportsPerTokenRaw`, sell does the reverse.
 * The returned SwapQuote matches the order (same input/output mint and inAmount) so the executor books it.
 */
function makeQuote(state: { lamportsPerTokenRaw: number }) {
  return async (req: QuoteRequest): Promise<SwapQuote> => {
    const buy = req.inputMint === SOL_MINT;
    const inAmount = req.amount;
    const outAmount = buy
      ? BigInt(Math.max(1, Math.floor(Number(inAmount) / state.lamportsPerTokenRaw)))
      : BigInt(Math.max(1, Math.floor(Number(inAmount) * state.lamportsPerTokenRaw)));
    return {
      inputMint: req.inputMint, outputMint: req.outputMint, inAmount, outAmount,
      otherAmountThreshold: outAmount, mode: 'ExactIn', slippageBps: req.slippageBps,
      priceImpactPct: 0.5, route: ['Meteora'], platformFeeBps: null, platformFeeAmount: null,
      usdValue: null, contextSlot: null, source: 'jupiter-swap', fetchedAt: Date.now(),
    };
  };
}

interface Harness {
  desk: PaperAgentDesk;
  wallet: PaperWallet;
  journal: Journal;
  control: { v: DeskControl };
  kill: KillSwitch;
  price: { lamportsPerTokenRaw: number };
  solUsd: { v: number | null };
  dir: string;
}

function harness(opts: { mandate?: MandateInput; killPath?: string } = {}): Harness {
  const clock = new FakeClock(1_700_000_000_000);
  const dir = mkdtempSync(join(tmpdir(), 'paper-desk-'));
  const wallet = new PaperWallet({ path: ':memory:', clock });
  const executor = new PaperExecutor(wallet, { clock });
  const journal = new Journal({ clock });
  const control = { v: { state: 'running' } as DeskControl };
  const kill = new KillSwitch(opts.killPath ?? join(dir, 'trading.panic'));
  const price = { lamportsPerTokenRaw: 1000 }; // 1000 lamports per raw token unit
  const solUsd = { v: 150 as number | null };
  const mandate = armedMandate(clock, opts.mandate);
  const desk = new PaperAgentDesk({
    mandate, wallet, executor, quote: makeQuote(price),
    solUsd: () => solUsd.v, control: () => control.v, journal, killSwitch: kill, clock, agent: 'test-agent',
  });
  return { desk, wallet, journal, control, kill, price, solUsd, dir };
}

const open = () => ({ mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' as const });

test('rejects a live executor at construction (paper only)', () => {
  const clock = new FakeClock(1);
  const wallet = new PaperWallet({ path: ':memory:', clock });
  const live = { kind: 'live', previewFill() { throw new Error('x'); }, execute() { return Promise.reject(new Error('x')); } } as unknown as TradeExecutor;
  assert.throws(() => new PaperAgentDesk({
    mandate: armedMandate(clock), wallet, executor: live, quote: makeQuote({ lamportsPerTokenRaw: 1000 }),
    solUsd: () => 150, control: () => ({ state: 'running' }), journal: new Journal({ clock }),
  }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'not-paper');
});

test('open → size → confirm books a simulated fill and journals every step', async () => {
  const h = harness();
  const t = h.desk.open(open());
  const sized = h.desk.size(t.id, { usd: 5 });
  assert.equal(sized.usd, 5);
  const { fill, position } = await h.desk.confirm(t.id);
  assert.equal(fill.paper, true);
  assert.equal(fill.side, 'buy');
  assert.ok(position && position.tokens > 0, 'a paper position now exists');
  const types = h.journal.types();
  assert.ok(types.includes('agent.paper.open'));
  assert.ok(types.includes('agent.paper.size'));
  assert.ok(types.includes('agent.paper.fill'));
  assert.ok(h.journal.verify().ok, 'the journal chain is intact');
  // the paper wallet is the source of truth
  assert.ok((h.wallet.position(MINT)?.tokensRaw ?? 0n) > 0n);
});

test('the per-trade cap is the mandate cap times the weakest tier, and over-cap is refused and journaled', () => {
  const h = harness(); // default perTradeUsd 20 → agent cap 20*0.25 = $5
  const t = h.desk.open(open());
  assert.throws(() => h.desk.size(t.id, { usd: 5.01 }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'per-trade-cap');
  assert.ok(h.journal.types().includes('agent.paper.refused'));
  // $5 is allowed
  assert.doesNotThrow(() => h.desk.size(t.id, { usd: 5 }));
});

test('per-coin and total caps are enforced from the mandate', async () => {
  const h = harness({ mandate: { perTradeUsd: 40, perCoinUsd: 12, totalUsd: 40 } });
  // agent per-trade cap = 40 * 0.25 = $10 (perTradeUsd is clamped to totalUsd, so totalUsd must be ≥ 40)
  const a = h.desk.open(open()); h.desk.size(a.id, { usd: 10 }); await h.desk.confirm(a.id); // coin $10
  const b = h.desk.open(open());
  assert.throws(() => h.desk.size(b.id, { usd: 10 }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'per-coin-cap'); // $20 > $12
});

test('pause, take-over and stop all halt the agent; refusals are journaled', () => {
  const h = harness();
  for (const state of ['paused', 'takeover', 'stopped'] as const) {
    h.control.v = { state, reason: 'user' };
    assert.throws(() => h.desk.open(open()), (e: unknown) => e instanceof PaperDeskError && e.reason === state);
  }
  h.control.v = { state: 'running' };
  assert.doesNotThrow(() => h.desk.open(open()));
  assert.ok(h.journal.types().filter((x) => x === 'agent.paper.refused').length >= 3);
});

test('the panic kill-switch halts the agent', () => {
  const h = harness();
  h.kill.engage('test panic');
  assert.throws(() => h.desk.open(open()), (e: unknown) => e instanceof PaperDeskError && e.reason === 'panic');
  h.kill.release();
  assert.doesNotThrow(() => h.desk.open(open()));
});

test('a mandate that is not armed is refused', () => {
  const clock = new FakeClock(1_700_000_000_000);
  const wallet = new PaperWallet({ path: ':memory:', clock });
  const draft = draftMandate({}, { clock }); // status 'draft'
  const desk = new PaperAgentDesk({
    mandate: draft, wallet, executor: new PaperExecutor(wallet, { clock }), quote: makeQuote({ lamportsPerTokenRaw: 1000 }),
    solUsd: () => 150, control: () => ({ state: 'running' }), journal: new Journal({ clock }), clock,
  });
  assert.throws(() => desk.open(open()), (e: unknown) => e instanceof PaperDeskError && e.reason === 'mandate-not-armed');
});

test('side and mint allow-lists come from the mandate', () => {
  const h = harness({ mandate: { actions: ['buy'], mints: [OTHER] } });
  assert.throws(() => h.desk.open({ ...open(), side: 'sell' }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'action-not-allowed');
  assert.throws(() => h.desk.open(open()), (e: unknown) => e instanceof PaperDeskError && e.reason === 'mint-not-allowed');
});

test('no fresh SOL/USD price refuses sizing and confirming (caps must stay honest)', () => {
  const h = harness();
  h.solUsd.v = null;
  const t = h.desk.open(open());
  assert.throws(() => h.desk.size(t.id, { usd: 5 }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'no-usd-price');
});

test('close sells a fraction of the held paper position and journals it', async () => {
  const h = harness();
  const t = h.desk.open(open()); h.desk.size(t.id, { usd: 5 }); await h.desk.confirm(t.id);
  const before = h.wallet.position(MINT)!.tokensRaw;
  const { fill } = await h.desk.close({ mint: MINT, fraction: 1 });
  assert.equal(fill.side, 'sell');
  assert.ok((h.wallet.position(MINT)?.tokensRaw ?? 0n) < before);
  assert.ok(h.journal.types().includes('agent.paper.close'));
});

test('a realized loss reaching the daily loss limit refuses further buys', async () => {
  const h = harness({ mandate: { perTradeUsd: 40, perCoinUsd: 1000, totalUsd: 1000, dailyLossUsd: 1 } });
  // buy at 1000 lamports/token, then close after the price halves (2000 lamports/token = cheaper token = loss)
  const a = h.desk.open(open()); h.desk.size(a.id, { usd: 10 }); await h.desk.confirm(a.id);
  h.price.lamportsPerTokenRaw = 500; // the token now sells for half the lamports it cost → realized loss
  await h.desk.close({ mint: MINT, fraction: 1 });
  const b = h.desk.open(open());
  assert.throws(() => h.desk.size(b.id, { usd: 5 }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'daily-loss-limit');
});

test('there is no method that raises or changes a cap', () => {
  const h = harness();
  const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(h.desk));
  // No method WRITES a cap/budget/limit (reading one, e.g. perTradeCapUsd, is fine).
  for (const k of keys) assert.ok(!/^(set|raise|increase|widen|update|change)(cap|budget|limit|mandate|per)/i.test(k), `desk exposes a cap-changing method: ${k}`);
});

test('pnl and positions are read-only and always labelled paper', async () => {
  const h = harness();
  const t = h.desk.open(open()); h.desk.size(t.id, { usd: 5 }); await h.desk.confirm(t.id);
  const pnl = h.desk.pnl();
  assert.equal(pnl.paper, true);
  assert.ok(pnl.positions.length >= 1);
  assert.equal(pnl.mandate?.perTradeUsd, 5); // 20 * 0.25
  rmSync(h.dir, { recursive: true, force: true });
});

test('the open-positions limit comes from the mandate', async () => {
  const h = harness({ mandate: { perTradeUsd: 40, perCoinUsd: 1000, totalUsd: 1000, maxOpenPositions: 1 } });
  const a = h.desk.open(open()); h.desk.size(a.id, { usd: 5 }); await h.desk.confirm(a.id);
  const b = h.desk.open({ ...open(), mint: OTHER });
  assert.throws(() => h.desk.size(b.id, { usd: 5 }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'open-positions-cap');
  // adding to the already-held coin is still inside the limit
  const c = h.desk.open(open());
  assert.doesNotThrow(() => h.desk.size(c.id, { usd: 5 }));
});

test('a buy quote over the mandate price-impact ceiling is refused (percent units)', async () => {
  const h = harness({ mandate: { maxPriceImpactPct: 0.3 } }); // the stub quotes 0.5 %
  const t = h.desk.open(open()); h.desk.size(t.id, { usd: 5 });
  await assert.rejects(h.desk.confirm(t.id), (e: unknown) => e instanceof PaperDeskError && e.reason === 'price-impact');
  assert.equal(h.wallet.position(MINT), undefined, 'nothing was booked');
});

test('a pause that lands while the quote is in flight still stops the fill', async () => {
  const h = harness();
  const t = h.desk.open(open()); h.desk.size(t.id, { usd: 5 });
  const pending = h.desk.confirm(t.id); // the gate passed; the quote is awaited
  h.control.v = { state: 'paused', reason: 'user' };
  await assert.rejects(pending, (e: unknown) => e instanceof PaperDeskError && e.reason === 'paused');
  assert.equal(h.wallet.position(MINT), undefined, 'nothing was booked');
});

test('the mandate is re-read on every call: a revoke halts the agent at once', () => {
  const clock = new FakeClock(1_700_000_000_000);
  const wallet = new PaperWallet({ path: ':memory:', clock });
  let m: Mandate | null = armedMandate(clock);
  const desk = new PaperAgentDesk({
    mandate: () => m, wallet, executor: new PaperExecutor(wallet, { clock }), quote: makeQuote({ lamportsPerTokenRaw: 1000 }),
    solUsd: () => 150, control: () => ({ state: 'running' }), journal: new Journal({ clock }), clock,
  });
  assert.doesNotThrow(() => desk.open(open()));
  m = { ...m!, status: 'revoked' };
  assert.throws(() => desk.open(open()), (e: unknown) => e instanceof PaperDeskError && e.reason === 'mandate-revoked');
  m = null;
  assert.throws(() => desk.open(open()), (e: unknown) => e instanceof PaperDeskError && e.reason === 'no-mandate');
});

test('the mandate is replayed from the real plans journal: armed by keypress, revoked by panic, tamper fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-plans-'));
  const journalPath = join(dir, 'plans.journal');
  const clock = new FakeClock(1_700_000_000_000);
  const svc = new PlanService({ journalPath, clock });
  const drafted = svc.draftMandate({ perTradeUsd: 20, totalUsd: 100 });
  assert.equal(loadMandateFromJournal(journalPath, drafted.id, clock).mandate?.status, 'draft');
  svc.armMandateByKeypress(drafted.id, 'keypress');
  const armed = loadMandateFromJournal(journalPath, drafted.id, clock).mandate;
  assert.equal(armed?.status, 'armed');
  assert.equal(armed?.budget.perTradeUsd, 20);
  assert.ok(Object.isFrozen(armed!.budget), 'the replayed caps are frozen');
  assert.equal(loadMandateFromJournal(journalPath, 'm_nope', clock).mandate, null);

  // An edited cap breaks the hash chain → no mandate (fail closed), never a raised cap.
  const original = readFileSync(journalPath, 'utf8');
  writeFileSync(journalPath, original.replace('"perTradeUsd":20', '"perTradeUsd":500'));
  const tampered = loadMandateFromJournal(journalPath, drafted.id, clock);
  assert.equal(tampered.mandate, null);
  assert.match((tampered as { reason: string }).reason, /chain broken/);
  writeFileSync(journalPath, original);

  svc.panic('test panic');
  assert.equal(loadMandateFromJournal(journalPath, drafted.id, clock).mandate?.status, 'revoked');
  rmSync(dir, { recursive: true, force: true });
});

test('the rendezvous names a mandate id only, the control file fails closed, and the agent journal tolerates two writers', () => {
  const home = mkdtempSync(join(tmpdir(), 'paper-rv-'));
  const env = { DEXTERM_HOME: home } as NodeJS.ProcessEnv;
  assert.equal(readPaperAgentRendezvous(env), null);
  assert.equal(readDeskControl(env).state, 'stopped', 'no control file = stopped');
  writePaperAgentRendezvous({ db: join(home, 'w.db'), mandateId: 'm_1', agent: 'bot' }, env);
  const rv = readPaperAgentRendezvous(env);
  assert.deepEqual(rv, { v: 2, db: join(home, 'w.db'), mandateId: 'm_1', agent: 'bot' });
  assert.ok(!('mandate' in (rv as object)) && !('budget' in (rv as object)), 'the rendezvous never carries caps');
  assert.equal(readDeskControl(env).state, 'running', 'enabling writes running');
  writeDeskControl({ state: 'takeover' }, env);
  assert.equal(readDeskControl(env).state, 'takeover');
  writeFileSync(join(home, 'paper-agent.control'), '{not json');
  assert.equal(readDeskControl(env).state, 'stopped', 'a broken control file = stopped');
  assert.equal(plansJournalPathFor(env), join(home, 'plans.journal'));

  const clock = new FakeClock(1);
  const a = new SharedJournal(join(home, 'paper-agent.journal'), clock);
  const b = new SharedJournal(join(home, 'paper-agent.journal'), clock);
  a.append('agent.paper.open'); b.append('agent.paper.open'); a.append('agent.paper.fill');
  assert.ok(a.verify().ok, 'interleaved writers keep one valid chain');
  assert.equal(b.types().length, 3);
  clearPaperAgentRendezvous(env);
  assert.equal(readPaperAgentRendezvous(env), null);
  rmSync(home, { recursive: true, force: true });
});
