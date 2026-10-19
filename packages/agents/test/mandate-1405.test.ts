// task-1405: per-agent MANDATES (tool allow-lists) and the WIDENED read-only tool surface. A mandate can
// only narrow a tier, never widen it, and never reaches a tool outside the table (the never-list runs
// first). The newly-exposed analysis packs (analyze_token, narrative_board, rug_backtest) are observe-tier,
// read-only, and — like every agent tool — cannot arm, sign or raise a cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentBus } from '../src/bus.ts';
import { AgentRegistry } from '../src/identity.ts';
import { MemoryAuditLog } from '../src/audit.ts';
import { FixtureExecutor, FixtureFeed } from '../src/executor.ts';
import { MemoryProposalStore } from '../src/proposals.ts';
import { DextermAgent } from '../src/sdk.ts';
import { TOOL_TIERS, NEVER_PATTERNS, neverAllowed } from '../src/tiers.ts';
import { AGENT_TOOLS } from '../src/tools.ts';

const MINT = 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function harness() {
  const registry = new AgentRegistry({ path: ':memory:' });
  const audit = new MemoryAuditLog();
  const bus = new AgentBus({ registry, audit, executor: new FixtureExecutor(), proposals: new MemoryProposalStore(), feed: new FixtureFeed(), discoveryPath: null });
  const port = await bus.start();
  return { registry, audit, bus, url: `ws://127.0.0.1:${port}` };
}

function codeOf(e: unknown): string { const err = e as Error & { data?: { code?: string } }; return err?.data?.code ?? 'unknown'; }

test('the widened agent surface exposes the analysis packs as observe, read-only', async () => {
  // every newly-exposed tool is a known table tool at observe tier, advertised, and read-only (no proposal).
  for (const t of ['analyze_token', 'narrative_board', 'rug_backtest']) {
    assert.equal(TOOL_TIERS[t], 'observe', `${t} must be observe tier`);
    assert.ok(AGENT_TOOLS.some((x) => x.name === t), `${t} must be advertised in AGENT_TOOLS`);
    assert.ok(!neverAllowed(t), `${t} must pass the never-list (it is a vetted table tool)`);
  }
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'obs', token: h.registry.add('obs', 'observe').token, url: h.url });
    const names = (await a.listTools()).map((t) => t.name);
    for (const t of ['analyze_token', 'narrative_board', 'rug_backtest']) assert.ok(names.includes(t), `observe tier sees ${t}`);
    const verdict = await a.call('analyze_token', { mint: MINT });
    assert.equal(verdict.model_output, false, 'analyze_token is the deterministic (no-model) stage');
    assert.ok(typeof verdict.deterministic_verdict === 'string');
    const board = await a.call('narrative_board', {});
    assert.ok('note' in board || Array.isArray(board.narratives), 'narrative_board returns a board or an honest note');
    a.close();
  } finally { await h.bus.close(); }
});

test('a per-agent mandate narrows the tier: only the listed tools, plus agent_whoami', async () => {
  const h = await harness();
  try {
    // a propose-tier agent, mandated down to two read tools.
    h.registry.add('scanbot', 'propose');
    h.registry.setScope('scanbot', ['screener_query', 'analyze_token']);
    const token = h.registry.rotate('scanbot');
    const a = await DextermAgent.connect({ name: 'scanbot', token, url: h.url });

    // hello + tools/list show ONLY the mandate (plus agent_whoami).
    const offered = new Set((a.hello?.tools ?? []));
    assert.deepEqual([...offered].sort(), ['agent_whoami', 'analyze_token', 'screener_query'].sort(), 'mandate narrows the advertised tools');
    assert.deepEqual((a.hello as unknown as { mandate: string[] }).mandate.sort(), ['analyze_token', 'screener_query']);

    // the mandated tools work…
    assert.ok(Array.isArray((await a.call('screener_query', { preset: 'new' })).rows));
    assert.equal((await a.call('analyze_token', { mint: MINT })).model_output, false);
    assert.ok((await a.whoami()).agent === 'scanbot');

    // …everything else is refused with 'mandate', even tools its propose tier would otherwise allow.
    for (const tool of ['get_token', 'rugcheck', 'open_token', 'add_to_watchlist', 'narrative_board']) {
      await assert.rejects(a.call(tool, tool === 'add_to_watchlist' ? { mint: MINT, idempotency_key: 'k-12345678' } : { mint: MINT }),
        (e: unknown) => codeOf(e) === 'mandate', `${tool} must be refused by the mandate`);
    }
    // the never-list still runs first: a financial shape is 'never', not 'mandate'.
    await assert.rejects(a.call('arm_plan', { mint: MINT }), (e: unknown) => codeOf(e) === 'never');
    a.close();
  } finally { await h.bus.close(); }
});

test('a mandate can only narrow, never widen a tier', async () => {
  const h = await harness();
  try {
    // observe agent mandated to a propose tool: tier still refuses it (mandate cannot grant a higher tier).
    h.registry.add('low', 'observe');
    h.registry.setScope('low', ['add_to_watchlist', 'get_token']);
    const token = h.registry.rotate('low');
    const a = await DextermAgent.connect({ name: 'low', token, url: h.url });
    await assert.rejects(a.call('add_to_watchlist', { mint: MINT, idempotency_key: 'k-87654321' }),
      (e: unknown) => codeOf(e) === 'tier', 'the tier gate still refuses a propose tool for an observe agent');
    assert.ok(await a.call('get_token', { mint: MINT }), 'a mandated read tool within tier works');
    a.close();
  } finally { await h.bus.close(); }
});

test('setScope rejects unknown tools and never-list names; clearing restores the full surface', () => {
  const registry = new AgentRegistry({ path: ':memory:' });
  registry.add('a1', 'observe');
  assert.throws(() => registry.setScope('a1', ['not_a_real_tool']), /unknown tool/);
  // a mandate can never name a never-list tool (it is not in the table), so it cannot be used to grant one.
  assert.throws(() => registry.setScope('a1', ['arm_plan']), /unknown tool/);
  assert.ok(NEVER_PATTERNS.some((re) => re.test('arm_plan')));
  registry.setScope('a1', ['get_token']);
  assert.deepEqual(registry.get('a1')!.scope, ['get_token']);
  registry.setScope('a1', null);
  assert.equal(registry.get('a1')!.scope, undefined);
});
