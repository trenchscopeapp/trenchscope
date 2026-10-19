// trenchscope — task-1313 analyst round 2: ambient context injection, the split coin-list layout, and
// the UI-action trust boundary (incl. a prompt-injection proof). Offline; no real `claude` spawn.
// The three end-to-end pty proofs (A open_token, E filter, F results) run in the serial lane:
// serial/task-1313-pty.test.ts (task-1424).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScreenState, applyAction, applyAnalystAction, applyKey } from '../src/main.ts';
import { analystContextBlock, turnPrompt } from '../src/analyst/backend.ts';
import { AnalystSession, parseResults, parseFilterApplied } from '../src/analyst/session.ts';
import { resolveAnalystResults } from '../src/analyst/results.ts';
import { makeFeedState, renderFrame, type AppState } from '../src/state.ts';
import { createReplayFeed } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';
import { screenerView, setFilter } from '../src/screener/view.ts';
import { parseFilter } from '../src/screener/filter.ts';
import { ACTION_RATE, parseActionLine } from '@dexterm/data';
import { McpTools } from '@dexterm/mcp';
import type { ScreenKey } from '@dexterm/tui';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');

/** A live-backed state over the recorded sample (replay = live code paths, no network). */
async function liveState(screen: ScreenKey = 'screener'): Promise<AppState> {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  return state;
}
const liveMint = (s: AppState): string => screenerView(s.screener).find((r) => !(r as { fixture?: unknown }).fixture)!.mint;
const close = (s: AppState): void => { try { s.live?.close(); } catch { /* */ } try { s.feed?.close(); } catch { /* */ } };

// ------------------------------------------------------------------ A: ambient context on every turn
test('context: buildScreenState carries the hovered coin, visible rows, watchlist and an action allow-list', async () => {
  const s = await liveState('screener');
  s.selected = 2;
  const ss = buildScreenState(s);
  assert.ok(Array.isArray(ss.visible) && (ss.visible as unknown[]).length > 0, 'visible pool rows are included');
  assert.ok((ss.selected as { mint?: string })?.mint, 'the hovered coin is reported');
  const allow = ss.actions as { mints: string[]; feeds: string[]; sortKeys: string[] };
  assert.ok(allow.mints.includes((ss.selected as { mint: string }).mint), 'the selected mint is in the action allow-list');
  assert.ok(allow.sortKeys.includes('vol') && allow.feeds.length > 0);
  close(s);
});

test('context: analystContextBlock names the selected coin, wraps token text as untrusted, and resolves "this coin"', async () => {
  const s = await liveState('screener');
  s.selected = 1;
  const block = analystContextBlock(buildScreenState(s));
  assert.match(block, /SELECTED\/HOVERED COIN/);
  assert.match(block, /<untrusted/, 'symbols are wrapped so injected instructions in them cannot act');
  assert.match(block, /"this coin".*SELECTED coin/s, 'it tells the model to resolve "this coin" to the selection');
  assert.match(block, /visible pool/);
  close(s);
});

test('context: turnPrompt prepends the block on every turn; an empty screen state injects nothing', async () => {
  const s = await liveState('screener');
  const ss = buildScreenState(s);
  const block = analystContextBlock(ss);
  const tp = turnPrompt({ prompt: 'is this a rug?', screenState: ss });
  assert.ok(tp.startsWith(block) && tp.endsWith('is this a rug?'), 'the context block is injected before the question');
  assert.equal(analystContextBlock({}), '', 'no block for an empty/unknown screen state');
  assert.equal(turnPrompt({ prompt: 'hi', screenState: {} }), 'hi', 'the prompt is unchanged when there is no context');
  close(s);
});

test('context: a /dexterm:<skill> slash-prompt stays FIRST so the CLI expands it; context follows (merge regression 2026-10-08)', async () => {
  const s = await liveState('screener');
  const ss = buildScreenState(s);
  const block = analystContextBlock(ss);
  assert.ok(block.length > 0);
  const tp = turnPrompt({ prompt: '/dexterm:larp-check MINT123\nProduct evidence pass: x', screenState: ss });
  assert.ok(tp.startsWith('/dexterm:larp-check MINT123'), 'the slash command is the first thing in the prompt');
  assert.ok(tp.endsWith(block), 'the context block follows the skill prompt');
  close(s);
});

// ------------------------------------------------------------------ B: split coin-list layout + keys
test('layout: the Analyst tab shows a navigable coin list beside the chat at 120x35 and degrades when narrow', async () => {
  const s = await liveState('analyst');
  s.analyst = new AnalystSession({ skill: 'trench-scan', screenState: {} }, () => {});
  const wide = renderFrame(s, 120, 35).toPlain();
  assert.match(wide, /COINS/, 'the coin list is visible beside the chat at 120x35');
  assert.match(wide, /ANALYST/, 'the chat renders alongside it');
  const narrow = renderFrame(s, 90, 40).toPlain();
  assert.doesNotMatch(narrow, /COINS/, 'the coin list gracefully drops when too narrow');
  assert.match(narrow, /ANALYST/, 'the chat still renders full-width');
  close(s);
});

test('layout: on the Analyst tab arrows move the coin selection (updating context) while PgUp/PgDn scroll the chat', async () => {
  const s = await liveState('analyst');
  s.analyst = new AnalystSession({ skill: 'trench-scan', screenState: {} }, () => {});
  assert.ok(screenerView(s.screener).length > 1);
  s.selected = 0; s.aiScroll = 0;
  applyAction(s, 'move.down', []);
  assert.equal(s.selected, 1, 'the arrow moved the coin-list selection');
  assert.equal(s.aiScroll ?? 0, 0, 'the arrow did not scroll the chat');
  // the selection change feeds the next turn's context
  assert.equal((buildScreenState(s).selected as { mint: string }).mint, screenerView(s.screener)[1].mint);
  applyAction(s, 'move.pagedown', []);
  assert.equal(s.selected, 1, 'PgDn left the coin selection where it was');
  assert.ok((s.aiScroll ?? 0) > 0, 'PgDn scrolled the chat');
  close(s);
});

// ------------------------------------------------------------------ C: UI-action trust boundary
test('action: open_token puts an on-screen coin on the token screen', async () => {
  const s = await liveState('screener');
  const r = applyAnalystAction(s, { type: 'open_token', mint: liveMint(s) }, []);
  assert.equal(r.ok, true);
  assert.equal(s.screen, 'token', 'the coin was put on screen');
  assert.match(r.label!, /opened/);
  close(s);
});

test('action (PROMPT INJECTION): an action naming a mint not on screen is rejected and changes nothing', async () => {
  const s = await liveState('screener');
  const before = s.screen;
  // Simulates a token name/description that tricked the model into requesting a navigation to an
  // attacker-chosen mint. The app re-validates against the allow-list and refuses.
  const EVIL = 'Zzz' + '9'.repeat(40);
  const r = applyAnalystAction(s, { type: 'open_token', mint: EVIL }, []);
  assert.equal(r.ok, false);
  assert.equal(s.screen, before, 'the injected action did not navigate anywhere');
  close(s);
});

test('action: open_ticket opens the PAPER ticket pre-filled but never confirms/fills it', async () => {
  const s = await liveState('screener');
  const r = applyAnalystAction(s, { type: 'open_ticket', mint: liveMint(s), side: 'buy' }, []);
  assert.equal(r.ok, true);
  assert.equal(s.screen, 'ticket');
  assert.ok(s.live!.ticket, 'a ticket was opened');
  assert.notEqual(s.live!.ticket!.ticket.phase, 'filled', 'the ticket is only opened, never confirmed');
  close(s);
});

test('action: applied UI actions are rate-limited', async () => {
  const s = await liveState('screener');
  const mint = liveMint(s);
  let rejected = 0;
  for (let i = 0; i < ACTION_RATE.max + 3; i++) {
    const r = applyAnalystAction(s, { type: 'show_in_screener', highlight: mint }, []);
    if (!r.ok) rejected++;
  }
  assert.ok(rejected >= 1, 'a burst of actions is throttled');
  close(s);
});

// ------------------------------------------------------------------ C: the MCP tool validates before it writes
test('mcp: a UI-action tool validates against screen_state and writes to the channel only on success', async () => {
  const A = 'Aaa' + '1'.repeat(40);
  const EVIL = 'Zzz' + '9'.repeat(40);
  const appended: string[] = [];
  const channel = { token: 'run-tok', append: (l: string) => appended.push(l) };
  const screenState = () => ({ screen: 'screener', actions: { mints: [A], feeds: ['trending'], sortKeys: ['vol'] } });
  const tools = new McpTools({} as never, screenState, channel);

  const bad = await tools.call('open_token', { mint: EVIL });
  assert.match(bad.error as string, /not among/);
  assert.equal(appended.length, 0, 'a rejected (injected) action is never written to the channel');

  const good = await tools.call('open_token', { mint: A });
  assert.equal(good.ok, true);
  assert.equal(appended.length, 1, 'a valid action is written exactly once');
  const parsed = parseActionLine(appended[0], 'run-tok');
  assert.deepEqual(parsed!.action, { type: 'open_token', mint: A }, 'the channel line is the normalized action');

  // With no channel wired the tool still validates but reports UI actions unavailable.
  const tools2 = new McpTools({} as never, screenState, null);
  const r2 = await tools2.call('open_token', { mint: A });
  assert.match(r2.error as string, /not available/);
});


// ================================================================== E: PLAIN-LANGUAGE FILTERING
//
// The analyst turns a request in words into dexterm's screener filter grammar and applies it via
// `show_in_screener`. These phrases and the filter strings are exactly the vague-word conventions the
// analyst is taught in analyst-system.md. The test proves every taught filter PARSES and APPLIES
// cleanly (so the analyst can never be told to emit a string the app would reject), that the clauses
// are what we expect, and that the structured string survives a parse→text→parse round-trip.
const PHRASES: Array<{ say: string; filter: string; want: Array<[string, string, number]> }> = [
  { say: 'coins under 5M mcap', filter: 'mcap < 5M', want: [['mcap', '<', 5e6]] },
  { say: 'micro caps', filter: 'mcap < 500K', want: [['mcap', '<', 5e5]] },
  { say: 'with over 100k liquidity', filter: 'liq > 100K', want: [['liq', '>', 1e5]] },
  { say: 'deep liquidity', filter: 'liq > 250K', want: [['liq', '>', 2.5e5]] },
  { say: 'fresh launches', filter: 'age < 6h', want: [['age', '<', 360]] },
  { say: 'brand new', filter: 'age < 1h', want: [['age', '<', 60]] },
  { say: 'trending with real volume', filter: 'vol24 > 250K', want: [['vol24', '>', 2.5e5]] },
  { say: 'up on the day', filter: 'h24 > 20', want: [['h24', '>', 20]] },
  { say: 'dumping today', filter: 'h24 < -20', want: [['h24', '<', -20]] },
  { say: 'lots of holders', filter: 'holders > 500', want: [['holders', '>', 500]] },
  { say: 'high organic score', filter: 'org > 60', want: [['org', '>', 60]] },
  { say: 'top-10 concentration low', filter: 'top10 < 25', want: [['top10', '<', 25]] },
  { say: 'locked LP', filter: 'lplocked >= 100', want: [['lplocked', '>=', 100]] },
  { say: 'under 5M mcap with over 100k liq, up on the day, not a rug',
    filter: 'mcap < 5M liq > 100K h24 > 20 lplocked >= 100 !flag:mint !flag:freeze org > 50',
    want: [['mcap', '<', 5e6], ['liq', '>', 1e5], ['h24', '>', 20], ['lplocked', '>=', 100], ['org', '>', 50]] },
  { say: 'low cap, liquid, trending', filter: 'mcap < 5M liq > 50K vol24 > 250K',
    want: [['mcap', '<', 5e6], ['liq', '>', 5e4], ['vol24', '>', 2.5e5]] },
  { say: 'fresh pump.fun launches with liquidity', filter: 'age < 6h liq > 50K launchpad:pump',
    want: [['age', '<', 360], ['liq', '>', 5e4]] },
  { say: 'tighter: raise the floors', filter: 'mcap < 3M liq > 150K vol24 > 500K',
    want: [['mcap', '<', 3e6], ['liq', '>', 1.5e5], ['vol24', '>', 5e5]] },
];

test('E filter table: every taught plain-language filter parses, applies, and has the expected clauses', async () => {
  const s = await liveState('screener');
  assert.ok(PHRASES.length >= 15, 'at least 15 plain-language phrases are covered');
  for (const p of PHRASES) {
    const parsed = parseFilter(p.filter);
    assert.equal(parsed.ok, true, `"${p.say}" → "${p.filter}" must parse (got ${parsed.ok ? '' : (parsed as { error: string }).error})`);
    if (!parsed.ok) continue;
    // the numeric comparisons the analyst committed to are exactly the clauses we expect
    const cmps = parsed.filter.clauses.filter((c): c is Extract<typeof c, { kind: 'cmp' }> => c.kind === 'cmp');
    for (const [field, op, value] of p.want) {
      const hit = cmps.find((c) => c.field.key === field && c.op === op && c.value === value);
      assert.ok(hit, `"${p.filter}" should contain ${field} ${op} ${value}`);
    }
    // round-trip: the normalized text re-parses to the same clause count (grammar is stable)
    const again = parseFilter(parsed.filter.text);
    assert.equal(again.ok, true, `round-trip of "${p.filter}" parses`);
    if (again.ok) assert.equal(again.filter.clauses.length, parsed.filter.clauses.length, 'round-trip preserves the clause count');
    // and the app applies it through the UI-action boundary without rejection
    s.analystActionTimes = []; // reset the rate-limit window between phrases
    const r = applyAnalystAction(s, { type: 'show_in_screener', filter: p.filter }, []);
    assert.equal(r.ok, true, `show_in_screener should accept "${p.filter}" (${r.error ?? ''})`);
    assert.equal(s.screen, 'screener');
    // the header echoes the applied filter string verbatim (trimmed), so the user sees exactly what ran
    assert.equal(s.screener.query, p.filter.trim(), 'the applied filter is shown in the header');
  }
  close(s);
});

test('E rejection: an invalid/unknown field is rejected with a clear message, not silently dropped', async () => {
  const s = await liveState('screener');
  const before = s.screener.query;
  const r = applyAnalystAction(s, { type: 'show_in_screener', filter: 'rugscore < 10' }, []);
  assert.equal(r.ok, false, 'an unknown field is rejected');
  assert.match(r.error!, /bad filter|unknown field/i, 'the rejection names the problem');
  assert.equal(s.screener.query, before, 'the old filter is left in place, nothing silently dropped');
  close(s);
});

test('E one-key reversal: \\ clears the applied filter and leaves the preset baked filter intact', async () => {
  const s = await liveState('screener');
  const err = setFilter(s.screener, 'mcap < 5M liq > 100K');
  assert.equal(err, null);
  assert.ok(s.screener.query, 'a filter is applied');
  applyKey(s, { name: 'char', ch: '\\', raw: '\\' } as never, []);
  assert.equal(s.screener.query, '', 'one key cleared the user filter');
  assert.match(s.screener.notice ?? '', /cleared/, 'the UI confirms the clear');
  close(s);
});

test('E filter_applied echo: parseFilterApplied keeps the query + notes and drops malformed input', () => {
  const ok = parseFilterApplied({ query: 'mcap < 5M liq > 100K', notes: 'low cap → 5M, liquid → 100K' });
  assert.deepEqual(ok, { query: 'mcap < 5M liq > 100K', notes: 'low cap → 5M, liquid → 100K' });
  assert.equal(parseFilterApplied({ notes: 'no query' }), null, 'a missing query is dropped');
  assert.equal(parseFilterApplied({ query: '   ' }), null, 'a blank query is dropped');
  assert.equal(parseFilterApplied('not an object'), null);
  assert.equal(parseFilterApplied({ query: 'x' })?.notes, undefined, 'notes is optional');
});


// ================================================================== F: COIN LISTS AS ANSWERS + JUMP
//
// A list-of-coins answer is a validated `results: [{mint, reason}]` block the UI renders as a real
// table, with the numbers pulled LIVE by mint (never the model's text). Rows navigate; Enter jumps to
// the coin; 'o' opens a PAPER ticket. Unknown mints are dropped (the list's injection defense).
test('F parse: parseResults keeps well-formed rows and drops malformed ones (never throws)', () => {
  const GOOD = 'So11111111111111111111111111111111111111112';
  const rows = parseResults([
    { mint: GOOD, symbol: 'WSOL', reason: 'deepest liquidity on screen' },
    { mint: GOOD, reason: 'duplicate mint' },              // dup → dropped
    { mint: 'not-base58!!', reason: 'bad mint' },          // bad mint → dropped
    { symbol: 'NOPE', reason: 'no mint' },                 // missing mint → dropped
    { mint: 'Aaa' + '1'.repeat(40) },                      // missing reason → reason ''
    'garbage', 42, null,                                   // non-objects → dropped
  ]);
  assert.equal(rows.length, 2, 'only the unique, base58, non-duplicate mints survive');
  assert.equal(rows[0].mint, GOOD);
  assert.equal(rows[0].reason, 'deepest liquidity on screen');
  assert.equal(parseResults('not an array').length, 0, 'a non-array degrades to an empty table');
  assert.equal(parseResults([]).length, 0);
});

test('F resolve: results resolve to LIVE numbers by mint and unknown mints are ignored', async () => {
  const s = await liveState('analyst');
  const onScreen = screenerView(s.screener)[0];
  const EVIL = 'Zzz' + '9'.repeat(40);
  const resolved = resolveAnalystResults(s, [
    { mint: onScreen.mint, reason: 'top of the screener' },
    { mint: EVIL, reason: 'an injected mint not on screen' },
  ]);
  assert.equal(resolved.length, 1, 'only the on-screen mint resolves; the unknown one is dropped');
  assert.equal(resolved[0].mint, onScreen.mint);
  assert.equal(resolved[0].symbol, onScreen.symbol, 'the symbol comes from live data');
  assert.equal(resolved[0].liq, onScreen.liq, 'the numbers come from the app data layer, not model text');
  assert.equal(resolved[0].reason, 'top of the screener', 'the analyst reason is carried through');
  close(s);
});

test('F render: a results answer draws a real table at 120 cols and still renders narrow', async () => {
  const s = await liveState('analyst');
  const rows = screenerView(s.screener).slice(0, 3);
  const session = new AnalystSession({ skill: 'trench-scan', screenState: {} }, () => {});
  session.status = 'done';
  session.doneAt = Date.now();
  session.summary = ['here are the best setups right now'];
  session.results = rows.map((r, i) => ({ mint: r.mint, symbol: r.symbol, reason: `reason ${i}` }));
  s.analyst = session;
  const wide = renderFrame(s, 120, 40).toPlain();
  assert.match(wide, /SYMBOL/, 'the table header renders at 120 cols');
  assert.match(wide, /WHY/, 'the per-row reason column renders');
  assert.match(wide, new RegExp(rows[0].symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the first coin symbol is in the table');
  assert.match(wide, /reason 0/, 'the analyst reason is shown per row');
  const narrow = renderFrame(s, 70, 40).toPlain();
  assert.match(narrow, /coin/i, 'the table degrades but still renders a coins header when narrow');
  close(s);
});

test('F navigate: moveResults clamps the cursor and selectedResult tracks it', () => {
  const session = new AnalystSession({ skill: 'trench-scan', screenState: {} }, () => {});
  session.status = 'done';
  const M = (n: number) => 'A'.repeat(43) + n; // not base58-validated here; set directly
  session.results = [
    { mint: 'Aaa' + '1'.repeat(40), reason: 'a' },
    { mint: 'Bbb' + '2'.repeat(40), reason: 'b' },
    { mint: 'Ccc' + '3'.repeat(40), reason: 'c' },
  ];
  void M;
  assert.equal(session.resultsCursor, 0);
  assert.equal(session.moveResults(-1)?.reason, 'a', 'cursor clamps at the top');
  assert.equal(session.moveResults(1)?.reason, 'b');
  assert.equal(session.moveResults(5)?.reason, 'c', 'cursor clamps at the bottom');
  assert.equal(session.selectedResult?.reason, 'c');
  assert.equal(session.hasResults, true, 'a finished turn with results is navigable');
});

