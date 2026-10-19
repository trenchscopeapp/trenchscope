// task-1443 — the MCP paper agent-trading tools: they are registered, they refuse when agent paper trading is
// disabled, they book the SIMULATED ledger through the desk when enabled, cap refusals surface with a reason,
// results are JSON-safe, and the resolver wires a desk from the running app's rendezvous. Every paper tool call
// flows through the same spectator path as any other tool (so it is visible).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpTools, TOOLS, PAPER_WRITE_TOOLS, PAPER_READ_TOOLS, resolvePaperAgentDesk } from '../src/index.ts';
import { paperWiring } from '../src/server.ts';
import { recordForToolCall } from '../src/spectator-sink.ts';
import {
  PaperAgentDesk, PaperWallet, PaperExecutor, SOL_MINT, FakeClock,
  writePaperAgentRendezvous, writeDeskControl, clearPaperAgentRendezvous, systemClock, currentPriority,
  type DataLayer, type QuoteRequest, type SwapQuote,
} from '@dexterm/data';
import { draftMandate, Journal, PlanService } from '@dexterm/data/plans';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function stubQuote(req: QuoteRequest): Promise<SwapQuote> {
  const buy = req.inputMint === SOL_MINT;
  const out = buy ? BigInt(Math.max(1, Math.floor(Number(req.amount) / 1000))) : BigInt(Number(req.amount) * 1000);
  return Promise.resolve({
    inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount: out,
    otherAmountThreshold: out, mode: 'ExactIn', slippageBps: req.slippageBps, priceImpactPct: 0.4, route: ['Meteora'],
    platformFeeBps: null, platformFeeAmount: null, usdValue: null, contextSlot: null, source: 'jupiter-swap', fetchedAt: Date.now(),
  });
}

function desk(clock = new FakeClock(1_700_000_000_000)): PaperAgentDesk {
  const wallet = new PaperWallet({ path: ':memory:', clock });
  const m = draftMandate({}, { clock }); m.status = 'armed'; m.armedAt = clock.now();
  return new PaperAgentDesk({
    mandate: m, wallet, executor: new PaperExecutor(wallet, { clock }), quote: stubQuote,
    solUsd: () => 150, control: () => ({ state: 'running' }), journal: new Journal({ clock }), clock,
  });
}

const names = TOOLS.map((t) => String(t.name));
/** The paper wiring McpTools takes: a desk resolver + whether a spectator surface is watching. */
const wired = (d: PaperAgentDesk | null, watched = true) => ({ desk: async () => d, watched: () => watched });

test('all six paper tools are registered and partitioned into write/read sets', () => {
  for (const n of ['paper_open_ticket', 'paper_size_ticket', 'paper_confirm', 'paper_close', 'paper_positions', 'paper_pnl']) {
    assert.ok(names.includes(n), `${n} is registered`);
  }
  assert.deepEqual([...PAPER_WRITE_TOOLS].sort(), ['paper_close', 'paper_confirm', 'paper_open_ticket', 'paper_size_ticket']);
  assert.deepEqual([...PAPER_READ_TOOLS].sort(), ['paper_pnl', 'paper_positions']);
});

test('every paper tool description says PAPER / simulated (no profit wording)', () => {
  for (const t of TOOLS.filter((x) => String(x.name).startsWith('paper_'))) {
    const d = String(t.description).toLowerCase();
    assert.ok(/paper|simulat/.test(d), `${t.name} description must say paper/simulated`);
    assert.ok(!/\bprofit|\bwinner|\breturns?\b|\bguarantee/.test(d), `${t.name} description must not claim profit/returns`);
  }
});

test('paper tools refuse when agent paper trading is disabled (no desk)', async () => {
  const tools = new McpTools({} as never, () => ({}));
  const r = await tools.call('paper_pnl', {});
  assert.match(String(r.error), /not enabled/);
  const o = await tools.call('paper_open_ticket', { mint: MINT, symbol: 'X', decimals: 6, side: 'buy' });
  assert.match(String(o.error), /not enabled/);
});

test('open → size → confirm books a simulated fill; the result is JSON-safe', async () => {
  const d = desk();
  const tools = new McpTools({} as never, () => ({}), null, null, wired(d));
  const open = await tools.call('paper_open_ticket', { mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
  assert.equal(open.paper, true);
  const ticketId = (open.ticket as { id: string }).id;
  const sized = await tools.call('paper_size_ticket', { ticketId, usd: 4 });
  assert.equal((sized.ticket as { usd: number }).usd, 4);
  const conf = await tools.call('paper_confirm', { ticketId });
  assert.equal(conf.paper, true);
  assert.ok((conf.fill as { paper: boolean }).paper);
  // no bigint leaks to the wire
  assert.doesNotThrow(() => JSON.stringify(conf));
  const pnl = await tools.call('paper_pnl', {});
  assert.equal(pnl.paper, true);
  assert.ok(Array.isArray(pnl.positions) && (pnl.positions as unknown[]).length >= 1);
});

test('an over-cap size is refused with a cap reason', async () => {
  const d = desk();
  const tools = new McpTools({} as never, () => ({}), null, null, wired(d));
  const open = await tools.call('paper_open_ticket', { mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
  const ticketId = (open.ticket as { id: string }).id;
  const r = await tools.call('paper_size_ticket', { ticketId, usd: 9999 });
  assert.equal(r.reason, 'per-trade-cap');
  assert.match(String(r.error), /per-trade cap/);
});

test('a paper tool call produces a spectator record (visible like any other call)', () => {
  const rec = recordForToolCall({ seq: 1, agent: 'mcp-agent', tool: 'paper_confirm', args: { ticketId: 'pt_1' }, result: { paper: true, fill: { priceSol: 1 } }, ms: 9 });
  assert.equal(rec.tool, 'paper_confirm');
  assert.equal(rec.transport, 'mcp');
  assert.equal(rec.ok, true);
  const refused = recordForToolCall({ seq: 2, agent: 'mcp-agent', tool: 'paper_size_ticket', args: {}, result: { error: 'per-trade cap', reason: 'per-trade-cap' }, ms: 1 });
  assert.equal(refused.phase, 'refused');
});

test('paper WRITE tools refuse while no spectator surface is watching; reads still answer', async () => {
  const d = desk();
  const tools = new McpTools({} as never, () => ({}), null, null, wired(d, false));
  const o = await tools.call('paper_open_ticket', { mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
  assert.equal(o.reason, 'not-watched');
  const c = await tools.call('paper_close', { mint: MINT });
  assert.equal(c.reason, 'not-watched');
  const p = await tools.call('paper_positions', {});
  assert.equal(p.paper, true);
});

test('the spectator record for a paper call is PAPER-labelled and readable', () => {
  const rec = recordForToolCall({ seq: 3, agent: 'mcp-agent', tool: 'paper_confirm', args: { ticketId: 'pt_1' }, result: { paper: true, fill: { side: 'buy', symbol: 'SAMPLE', solDelta: -0.03 } }, ms: 4 });
  assert.match(rec.summary, /^PAPER buy SAMPLE -0\.0300 SOL$/);
  const sized = recordForToolCall({ seq: 4, agent: 'mcp-agent', tool: 'paper_size_ticket', args: {}, result: { paper: true, ticket: { symbol: 'SAMPLE', usd: 4 } }, ms: 1 });
  assert.equal(sized.summary, 'PAPER size SAMPLE $4.00');
  assert.equal(sized.nav, null, 'a paper call never moves the owner\'s screen');
});

test('resolvePaperAgentDesk: off without a rendezvous; with one, caps come from the plans journal and pause/stop halt it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'paper-rv-'));
  const env = { DEXTERM_HOME: home } as NodeJS.ProcessEnv;
  const quotePriorities: (string | undefined)[] = [];
  const data = {
    jupiterSwap: { quote: (req: QuoteRequest) => { quotePriorities.push(currentPriority()?.level); return stubQuote(req); } },
    jupiter: { price: async (mints: string[]) => new Map(mints.map((m) => [m, { usdPrice: 150 }])) },
  } as unknown as DataLayer;
  assert.equal(await resolvePaperAgentDesk(data, env), null, 'off by default');

  // The user drafts + arms a mandate by keypress in the app (real PlanService, real hash-chained journal).
  const svc = new PlanService({ journalPath: join(home, 'plans.journal'), clock: systemClock });
  const m = svc.draftMandate({ perTradeUsd: 20, totalUsd: 100 });
  svc.armMandateByKeypress(m.id, 'keypress');
  writePaperAgentRendezvous({ db: join(home, 'wallet.db'), mandateId: m.id, agent: 'test' }, env);
  assert.ok(await resolvePaperAgentDesk(data, env), 'enabled once the rendezvous exists');

  const tools = new McpTools(data, () => ({}), null, null, { desk: () => resolvePaperAgentDesk(data, env), watched: () => true });
  const open = await tools.call('paper_open_ticket', { mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
  const ticketId = (open.ticket as { id: string }).id;
  // agent cap = $20 × 0.25 = $5, from the JOURNAL mandate
  assert.equal((await tools.call('paper_size_ticket', { ticketId, usd: 6 })).reason, 'per-trade-cap');
  await tools.call('paper_size_ticket', { ticketId, usd: 4 });
  const conf = await tools.call('paper_confirm', { ticketId });
  assert.equal((conf.fill as { paper: boolean }).paper, true);
  assert.ok(quotePriorities.length > 0 && quotePriorities.every((p) => p === 'high'), 'agent paper quotes jump the shared jupiter bucket like the human ticket');
  assert.equal(((await tools.call('paper_pnl', {})).mandate as { perTradeUsd: number }).perTradeUsd, 5);

  // the app's controls: pause / take-over / stop all halt the agent's paper calls
  for (const state of ['paused', 'takeover', 'stopped'] as const) {
    writeDeskControl({ state }, env);
    const r = await tools.call('paper_open_ticket', { mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
    assert.equal(r.reason, state);
  }
  writeDeskControl({ state: 'running' }, env);
  // a panic in the app revokes the mandate in the journal → the very next call is refused
  svc.panic('test');
  const after = await tools.call('paper_open_ticket', { mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
  assert.equal(after.reason, 'mandate-revoked');

  // every call (and refusal) is in the agent's own hash-chained journal, and the plans journal stays valid
  const aj = new Journal({ path: join(home, 'paper-agent.journal'), clock: systemClock });
  assert.ok(aj.verify().ok);
  assert.ok(aj.types().includes('agent.paper.fill') && aj.types().includes('agent.paper.refused'));
  assert.ok(svc.verifyJournal().ok, 'the agent never writes the app\'s plans journal');
  // a server the APP spawned (the in-app analyst / scan) never gets a desk, even while agent paper trading is on
  writeDeskControl({ state: 'running' }, env);
  assert.ok(await paperWiring(env, data, { active: () => true }).desk(), 'an external `trenchscope mcp` gets the desk');
  assert.equal(await paperWiring({ ...env, DEXTERM_ACTION_FILE: join(home, 'a'), DEXTERM_SPECTATOR_FILE: join(home, 's') }, data, { active: () => true }).desk(), null);
  assert.equal(await paperWiring({ ...env, DEXTERM_SPECTATOR_FILE: join(home, 's') }, data, { active: () => true }).desk(), null);
  clearPaperAgentRendezvous(env);
  assert.equal(await resolvePaperAgentDesk(data, env), null, 'off again once the app clears it');
  rmSync(home, { recursive: true, force: true });
});
