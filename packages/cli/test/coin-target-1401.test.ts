// task-1401 "paste a CA or a coin link anywhere": the shared parser, dexscreener pool → coin resolution, the analyst
// chat (CA alone opens the coin; CA + question opens it and asks about it), the screener `/` line, the GO-TO prompt
// with a dexscreener link, `--mint <link>` and the MCP server's refs. Offline: the recorded replay sample + stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKeys } from '@dexterm/tui';
import { DexScreener } from '../../data/src/sources/dexscreener.ts';
import { parseCoinTarget, parseMintTarget, resolveCoinTarget, isBareOpen } from '../src/coin-target.ts';
import { applyAction, applyKey, chatOpenCoin, parseArgs } from '../src/main.ts';
import { makeFixtureState, makeFeedState, type AppState } from '../src/state.ts';
import { createReplayFeed } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';
import { McpTools } from '../../mcp/src/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const DEXTERM = '2huJ1cxDXpGrh2bPYxptaoLj89to8CnzdVC5aYTEpump';
const POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const SIG = '5'.repeat(88);
const keys = (state: AppState, s: string, stack: string[] = []): void => { for (const k of parseKeys(s)) applyKey(state, k, stack as never); };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('parseCoinTarget: bare CAs, coin links by site, the rest of the text, and no false hits', () => {
  assert.deepEqual(parseCoinTarget(BONK), { address: BONK, via: 'address', rest: '' });
  assert.deepEqual(parseCoinTarget(`is ${BONK}? a rug`), { address: BONK, via: 'address', rest: 'is a rug' });
  assert.deepEqual(parseCoinTarget(`(${BONK}),`), { address: BONK, via: 'address', rest: '' });
  assert.equal(parseCoinTarget('https://dexscreener.com/solana/trending'), null, 'a coin site without an address in the path');
  assert.deepEqual(parseCoinTarget(`check https://dexscreener.com/solana/${POOL} pls`), { address: POOL, via: 'dexscreener', rest: 'check pls' });
  assert.equal(parseCoinTarget(`pump.fun/coin/${DEXTERM}`)!.via, 'pumpfun');
  assert.equal(parseCoinTarget(`https://www.solscan.io/token/${BONK}?cluster=mainnet`)!.via, 'solscan');
  assert.equal(parseCoinTarget(`https://birdeye.so/token/${BONK}?chain=solana`)!.via, 'birdeye');
  assert.equal(parseCoinTarget(`https://gmgn.ai/sol/token/${BONK}`)!.via, 'link');
  for (const no of ['', 'is this a rug?', 'what is hot right now', `tx ${SIG}`, 'https://x.com/someone/status/1234567890123456789', 'O0Il'.repeat(10)]) assert.equal(parseCoinTarget(no), null, JSON.stringify(no));
  assert.equal(parseMintTarget(`https://pump.fun/coin/${DEXTERM}`), DEXTERM, 'the task-1388 parser is unchanged');
  for (const bare of ['', 'open', 'open this', 'check it ?', 'go to', '—']) assert.ok(isBareOpen(bare), bare);
  for (const q of ['is it a rug?', 'what is the dev holding', 'compare to the screener']) assert.ok(!isBareOpen(q), q);
});

test('resolveCoinTarget + DexScreener.pairCoin: a dexscreener pool resolves to its coin (the non-SOL side); failures fall back to the address', async () => {
  const calls: string[] = [];
  const http = { getJson: async (url: string) => { calls.push(url); return { data: { pairs: [{ chainId: 'solana', pairAddress: POOL, baseToken: { address: 'So11111111111111111111111111111111111111112' }, quoteToken: { address: BONK } }] }, fetchedAt: 0, latencyMs: 0 }; } };
  const ds = new DexScreener(http as never);
  assert.equal(await ds.pairCoin(POOL), BONK, 'WSOL base → the quote side is the coin');
  assert.match(calls[0], /\/latest\/dex\/pairs\/solana\/5zpy/);
  assert.equal(await ds.pairCoin(BONK), null, 'not a pair at that address');
  const t = parseCoinTarget(`https://dexscreener.com/solana/${POOL}`)!;
  assert.deepEqual(await resolveCoinTarget(t, { dexscreener: ds }), { mint: BONK, fromPair: true });
  assert.deepEqual(await resolveCoinTarget(t, { dexscreener: { pairCoin: async () => { throw new Error('offline'); } } as never }), { mint: POOL, fromPair: false });
  let asked = 0;
  assert.deepEqual(await resolveCoinTarget(parseCoinTarget(`pump.fun/coin/${DEXTERM}`)!, { dexscreener: { pairCoin: async () => { asked++; return null; } } as never }), { mint: DEXTERM, fromPair: false });
  assert.equal(asked, 0, 'only dexscreener links cost a lookup');
});

async function liveState(screen: 'screener' | 'analyst' | 'token' = 'analyst') {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  return { state, close: () => { state.live!.close(); feed.close(); }, dl: feed.dl };
}

test('analyst chat: a bare CA opens its token view; CA + question opens it and asks THAT coin; a plain question is untouched', async () => {
  const { state, close } = await liveState('analyst');
  try {
    const asked: string[] = []; const said: string[] = [];
    const hooks = { ask: (q: string) => asked.push(`${state.live!.token?.view.mint}:${q}`), say: (m: string) => said.push(m) };
    const stack: string[] = [];
    assert.equal(chatOpenCoin(state, stack as never, 'is the market hot today?', hooks), false);
    assert.equal(state.screen, 'analyst');
    state.aiInput = BONK;
    assert.equal(chatOpenCoin(state, stack as never, BONK, hooks), true);
    assert.equal(state.screen, 'token'); assert.equal(state.live!.token?.view.mint, BONK);
    assert.deepEqual(stack, ['analyst']); assert.equal(state.aiInput, ''); assert.deepEqual(asked, []);
    assert.match(said[0], /opened DezX…B263 from the chat/);
    assert.equal(chatOpenCoin(state, stack as never, `https://pump.fun/coin/${DEXTERM} is the dev still holding?`, hooks), true);
    assert.equal(state.live!.token?.view.mint, DEXTERM);
    assert.deepEqual(asked, [`${DEXTERM}:is the dev still holding?`], 'the question is asked about the pasted coin');
  } finally { close(); }
});

test('analyst chat on fixtures: a CA is recognised but says it needs live mode (nothing opens)', () => {
  const state = makeFixtureState({ screen: 'analyst' });
  const said: string[] = [];
  assert.equal(chatOpenCoin(state, [], BONK, { ask: () => assert.fail('no ask'), say: (m) => said.push(m) }), true);
  assert.equal(state.screen, 'analyst');
  assert.match(said[0], /needs live mode/);
});

test('GO-TO with a dexscreener link resolves the pool to its coin before opening', async () => {
  const { state, close, dl } = await liveState('screener');
  try {
    (dl.dexscreener as unknown as { pairCoin: (a: string) => Promise<string | null> }).pairCoin = async (a) => (a === POOL ? BONK : null);
    const stack: string[] = [];
    applyAction(state, 'goto.open', stack as never);
    keys(state, `https://dexscreener.com/solana/${POOL}\r`, stack);
    assert.equal(state.goto, null, 'the prompt closes while the link resolves');
    assert.match(state.live!.notice ?? '', /resolving the dexscreener link/);
    await tick();
    assert.equal(state.screen, 'token');
    assert.equal(state.live!.token?.view.mint, BONK, 'opened the coin, not the pool');
  } finally { close(); }
});

test('screener `/` line: a pasted CA opens the coin and leaves the filter alone', async () => {
  const { state, close } = await liveState('screener');
  try {
    const before = state.screener.query;
    const stack: string[] = [];
    applyAction(state, 'filter.edit', stack as never);
    assert.equal(state.screener.mode, 'filter');
    state.screener.edit.text = `solscan.io/token/${BONK}`;
    keys(state, '\r', stack);
    assert.equal(state.screen, 'token'); assert.equal(state.live!.token?.view.mint, BONK);
    assert.equal(state.screener.mode, 'table'); assert.equal(state.screener.query, before);
  } finally { close(); }
});

test('--mint accepts a CA or a coin link; junk is still refused', () => {
  assert.equal(parseArgs(['--mint', BONK]).mint, BONK);
  const a = parseArgs(['--mint', `https://dexscreener.com/solana/${POOL}`]);
  assert.equal(a.mint, POOL); assert.equal(a.mintVia, 'dexscreener');
  assert.equal(parseArgs(['--mint', `https://pump.fun/coin/${DEXTERM}`]).mint, DEXTERM);
  assert.throws(() => parseArgs(['--mint', 'not-a-mint']), /base58 Solana address or a coin link/);
});

test('MCP: a coin link passed as the mint resolves (dexscreener pool → coin); symbols still search', async () => {
  const enriched: string[] = [];
  const data = {
    store: { enrich: async (m: string[]) => { enriched.push(m[0]); return { rows: [{ mint: m[0], token: { symbol: 'X', name: 'X', socials: { x: null, tg: null, web: null } }, pair: {}, sources: [] }], errors: {} }; } },
    dexscreener: { pairCoin: async (a: string) => (a === POOL ? BONK : null), tokensRaw: async () => ({ pairs: [], fetchedAt: 0, latencyMs: 0 }) },
    jupiter: { search: async () => [] },
  };
  const tools = new McpTools(data as never, () => ({}));
  await tools.call('get_links', { mint: `https://dexscreener.com/solana/${POOL}` });
  await tools.call('get_links', { mint: `pump.fun/coin/${DEXTERM}` });
  assert.deepEqual(enriched, [BONK, DEXTERM]);
});
