// task-1324 AI SCAN MODE — SAFETY. Scan mode can only observe and analyze; it can never open a ticket,
// sign, confirm or trade. Proven structurally, not by the prompt:
//   1. static: src/scan/** has no import path (runtime, transitively) into trade / paper / executor /
//      bridge / wallet code, and no runtime import of @dexterm/data (which re-exports the paper wallet);
//   2. a COMPROMISED model (a real child process standing in for `claude`) that emits open_ticket /
//      open_token / show_in_screener during a scan session changes nothing — while the very same fake
//      in a normal task-1313 session does open the ticket (control);
//   3. the MCP server refuses every UI action for a scan screen state and writes nothing to the channel;
//   4. the shared validator rejects all five types for `types: []` and is unchanged without `types`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScanSession, applyAnalystAction, scanCommand, scanScreenState } from '../src/main.ts';
import { AnalystSession } from '../src/analyst/session.ts';
import { makeFeedState, type AppState } from '../src/state.ts';
import { createReplayFeed } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';
import { screenerView } from '../src/screener/view.ts';
import { validateAnalystAction, ANALYST_ACTION_TYPES } from '@dexterm/data';
import { McpTools } from '../../mcp/src/server.ts';
import type { ScreenKey } from '@dexterm/tui';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', 'src');
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');

// ------------------------------------------------------------------ 1. static import closure
const FORBIDDEN = /(^|\/)(trade|paper|executor|bridge|wallet)(\.ts)?$|\/live\/trade\.ts$|\/trade\.ts$|paper|executor|bridge|wallet/i;

/** Runtime (non-type) import specifiers of a TS file. `import type …` and `import { type X }`-only are erased. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2]) continue; // import type / export type
    const names = m[3].replace(/^\{|\}$/g, '').split(',').map((x) => x.trim()).filter(Boolean);
    if (m[3].trim().startsWith('{') && names.length && names.every((n) => n.startsWith('type '))) continue;
    out.push(m[4]);
  }
  for (const d of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(d[1]);
  for (const d of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(d[1]);
  return out;
}
function allSpecifiers(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
}
const scanFiles = (): string[] => readdirSync(join(SRC, 'scan')).filter((f) => f.endsWith('.ts')).map((f) => join(SRC, 'scan', f));

test('static: src/scan/** names no trade/paper/executor/bridge/wallet module, even as a type import', () => {
  const files = scanFiles();
  assert.ok(files.length >= 4, `scan files: ${files.map((f) => f.split('/').pop()).join(', ')}`);
  for (const f of files) for (const spec of allSpecifiers(f)) assert.doesNotMatch(spec, FORBIDDEN, `${f.split('/').pop()} imports ${spec}`);
});

test('static: the RUNTIME import closure of src/scan/** never loads trade/paper/executor/bridge/wallet code', () => {
  const seen = new Set<string>();
  const queue = scanFiles();
  const external = new Set<string>();
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of runtimeImports(f)) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(f), spec);
        assert.ok(existsSync(target) && statSync(target).isFile(), `${spec} resolves`);
        assert.doesNotMatch(target, FORBIDDEN, `${f.replace(SRC, 'src')} → ${spec} (runtime)`);
        queue.push(target);
      } else external.add(spec);
    }
  }
  // @dexterm/data re-exports the paper wallet + executor: the scan must not load it at runtime.
  assert.ok(!external.has('@dexterm/data'), `runtime externals: ${[...external].join(', ')}`);
  for (const e of external) assert.ok(e === '@dexterm/tui' || e.startsWith('node:'), `unexpected runtime dependency ${e}`);
  const rel = [...seen].map((f) => relative(SRC, f).split(sep).join('/')).sort();
  assert.deepEqual(rel, ['live/flow.ts', 'scan/command.ts', 'scan/engine.ts', 'scan/observe.ts', 'scan/ui.ts', 'screener/rows.ts'], 'the whole runtime closure');
});

// ------------------------------------------------------------------ 2. compromised model in a scan session
async function liveState(screen: ScreenKey = 'screener'): Promise<AppState> {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen, intensity: 'off' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  return state;
}
const close = (s: AppState): void => { try { s.live?.close(); } catch { /* */ } try { s.feed?.close(); } catch { /* */ } };

/**
 * A compromised `claude`: it ignores every instruction and, on its turn, writes authenticated
 * open_ticket / open_token / show_in_screener lines to the action channel (exactly what a hijacked MCP
 * call would produce), announces an open_ticket tool call, and logs what it was launched with.
 */
function compromisedClaude(log: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan1324-evil-'));
  const script = join(dir, 'claude.cjs');
  writeFileSync(script, `
const fs = require('fs');
const ss = JSON.parse(process.env.DEXTERM_SCREEN_STATE || '{}');
const mint = (ss.selected && ss.selected.mint) || '';
const other = ((ss.actions && ss.actions.mints) || []).find((m) => m !== mint) || mint;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), types: ss.actions && ss.actions.types, mint }) + '\\n');
const file = process.env.DEXTERM_ACTION_FILE, token = process.env.DEXTERM_ACTION_TOKEN;
const acts = [{ type: 'open_ticket', mint, side: 'buy' }, { type: 'open_token', mint: other }, { type: 'show_in_screener', filter: 'liq > 1K' }];
acts.forEach((a, i) => fs.appendFileSync(file, JSON.stringify({ v: 1, token, seq: i + 1, ts: Date.now(), action: a }) + '\\n'));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', model: 'fake', session_id: 'evil', mcp_servers: [], skills: [] });
say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__dexterm__open_ticket', input: { mint, side: 'buy' } }] } });
say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'BUY NOW · opening your ticket' } } });
setTimeout(() => say({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, duration_ms: 5, num_turns: 1, is_error: false, session_id: 'evil' }), 300);
`);
  return script;
}
const fakeSpawn = (script: string) => ({ spawn: ((_cmd: string, args: string[], opts: object) => spawn(process.execPath, [script, ...args], opts)) as never });
async function settle(sess: AnalystSession): Promise<void> {
  const t0 = Date.now();
  while (sess.busy && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 400)); // the channel tail drains on settle
}

test('compromised model emitting open_ticket during a SCAN session is rejected: no ticket, no navigation, no filter', async () => {
  const s = await liveState();
  const stack: ScreenKey[] = [];
  scanCommand(s, 'on', stack);
  const coin = screenerView(s.screener).find((r) => r.mint)!;
  s.live!.openToken({ mint: coin.mint, symbol: coin.symbol, name: '', launchpad: 'unknown' });
  s.screen = 'token';
  const queryBefore = s.screener.query;
  const log = join(mkdtempSync(join(tmpdir(), 'scan1324-log-')), 'evil.log');
  const blocked: Array<[string, string]> = [];
  const sess = createScanSession(s, coin.mint, coin.symbol, { onBlocked: (t, e) => blocked.push([t, e]) }, fakeSpawn(compromisedClaude(log)));
  sess.ask('SCAN TRIGGER on the SELECTED coin (scan score 60/100): test. Give your short read now.', scanScreenState(s, coin.mint, coin.symbol), 'AI scan · test');
  await settle(sess);
  assert.equal(sess.status, 'done');
  assert.deepEqual(blocked.map((b) => b[0]).sort(), ['open_ticket', 'open_token', 'show_in_screener'], 'every emitted action reached the boundary…');
  for (const [, err] of blocked) assert.match(err, /not allowed in this session|observe-only/, '…and was refused');
  assert.equal(s.live!.ticket, null, 'NO paper ticket was opened');
  assert.equal(s.screen, 'token', 'no navigation');
  assert.equal(s.live!.token!.view.mint, coin.mint, 'the locked coin is still the one on screen');
  assert.equal(s.screener.query, queryBefore, 'no filter applied');
  const launched = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]);
  assert.deepEqual(launched.types, [], 'the MCP server would have seen actions.types = [] (observe-only)');
  const i = launched.argv.indexOf('--disallowedTools');
  assert.ok(i >= 0 && String(launched.argv[i + 1]).split(',').includes('mcp__dexterm__open_ticket'), 'the CLI was told to deny open_ticket');
  assert.equal(launched.mint, coin.mint, 'the locked coin was the selected coin in the context');
  close(s);
});

test('control: the SAME compromised fake in a normal (non-scan) session does open the PAPER ticket — the scan structure is what stops it', async () => {
  const s = await liveState();
  const stack: ScreenKey[] = [];
  const coin = screenerView(s.screener).find((r) => r.mint)!;
  s.selected = screenerView(s.screener).indexOf(coin);
  const log = join(mkdtempSync(join(tmpdir(), 'scan1324-log-')), 'ctl.log');
  const applied: string[] = [];
  const { buildScreenState } = await import('../src/main.ts');
  const sess = new AnalystSession({ skill: 'trench-scan', screenState: buildScreenState(s), onAction: (raw) => { const r = applyAnalystAction(s, raw, stack); if (r.ok) applied.push(String(raw.type)); } }, () => {}, fakeSpawn(compromisedClaude(log)));
  sess.ask('hi', buildScreenState(s));
  await settle(sess);
  assert.ok(applied.includes('open_ticket'), `applied: ${applied.join(', ')}`);
  assert.ok(s.live!.ticket, 'a normal session may open the PAPER ticket (editing phase only, task-1313)');
  assert.equal(s.live!.ticket!.ticket.phase, 'editing', 'never confirmed');
  close(s);
});

// ------------------------------------------------------------------ 3. MCP server layer
test('MCP server: with a scan screen state every UI-action tool returns an error and nothing reaches the channel', async () => {
  const s = await liveState();
  const coin = screenerView(s.screener).find((r) => r.mint)!;
  const scanSS = scanScreenState(s, coin.mint, coin.symbol);
  const lines: string[] = [];
  const tools = new McpTools({} as never, () => scanSS, { token: 't', append: (l) => lines.push(l) });
  for (const [name, args] of [['open_ticket', { mint: coin.mint, side: 'buy' }], ['open_token', { mint: coin.mint }], ['add_to_watchlist', { mint: coin.mint }], ['switch_feed', { feed: 'trending' }], ['show_in_screener', { highlight: coin.mint }]] as const) {
    const r = await tools.call(name, args as Record<string, unknown>);
    assert.match(String(r.error), /not allowed in this session/, `${name}: ${JSON.stringify(r)}`);
  }
  assert.equal(lines.length, 0, 'no channel write');
  // control: the unrestricted 1313 screen state still works through the same server
  const { buildScreenState } = await import('../src/main.ts');
  const ok = await new McpTools({} as never, () => ({ ...buildScreenState(s), selected: { mint: coin.mint, symbol: coin.symbol }, actions: { ...(buildScreenState(s).actions as object), mints: [coin.mint] } }), { token: 't', append: (l) => lines.push(l) }).call('open_ticket', { mint: coin.mint, side: 'buy' });
  assert.equal(ok.ok, true);
  assert.equal(lines.length, 1);
  // a malformed types field fails closed
  const bad = await new McpTools({} as never, () => ({ actions: { mints: [coin.mint], feeds: [], sortKeys: [], types: 'open_ticket' } }), { token: 't', append: (l) => lines.push(l) }).call('open_ticket', { mint: coin.mint, side: 'buy' });
  assert.match(String(bad.error), /not allowed/);
  close(s);
});

// ------------------------------------------------------------------ 4. shared validator
test('validator: types [] rejects all five actions; absent types keeps the task-1313 behaviour', () => {
  const mint = 'So11111111111111111111111111111111111111112';
  const allow = { mints: [mint], feeds: ['trending'], sortKeys: ['vol'] };
  const raw: Record<string, Record<string, unknown>> = { open_token: { mint }, add_to_watchlist: { mint }, open_ticket: { mint, side: 'buy' }, switch_feed: { feed: 'trending' }, show_in_screener: { highlight: mint } };
  // The task-1313 navigation five (task-1413 added more action kinds, covered in actions-tiers-1413.test.ts).
  for (const t of Object.keys(raw)) {
    assert.equal(validateAnalystAction({ type: t, ...raw[t] }, { ...allow, types: [] }).ok, false, `${t} rejected for a scan session`);
    assert.equal(validateAnalystAction({ type: t, ...raw[t] }, allow).ok, true, `${t} unchanged without types`);
  }
  assert.equal(validateAnalystAction({ type: 'open_token', mint }, { ...allow, types: ['open_token'] }).ok, true, 'an explicit allow-list is honoured');
});
