// task-1324 AI SCAN MODE — UI wiring over the RECORDED replay sample (live code paths, no network, no
// model): flags/keys/commands, the header indicator, the SCANNING ticker, the WHY strip, resume/stop,
// the credit-meter text, and that observing + ticking the scan makes ZERO data-layer requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, applyKey, scanCommand, scanScreenState, buildScreenState, scanMeterOf } from '../src/main.ts';
import { makeFeedState, renderFrame, headerModel, type AppState } from '../src/state.ts';
import { createReplayFeed } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';
import { screenerView } from '../src/screener/view.ts';
import { parseScanCommand } from '../src/scan/command.ts';
import { buildObservations, observeSig } from '../src/scan/observe.ts';
import { DEFAULT_SCAN_CONFIG } from '../src/scan/engine.ts';
import { analystContextBlock, buildArgv, deniedActionTools } from '../src/analyst/backend.ts';
import { parseKeys, type ScreenKey } from '@dexterm/tui';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');

async function liveState(screen: ScreenKey = 'screener'): Promise<AppState> {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen, intensity: 'off' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  return state;
}
const close = (s: AppState): void => { try { s.live?.close(); } catch { /* */ } try { s.feed?.close(); } catch { /* */ } };
const key = (s: AppState, raw: string, stack: ScreenKey[] = []) => { for (const k of parseKeys(raw)) applyKey(s, k, stack); };
const rowText = (s: AppState, y: number, w = 200, h = 50): string => renderFrame(s, w, h).toPlain().split('\n')[y] ?? '';

/** Count every data-layer request attempt (HTTP getJson/postJson and cache-miss loaders). */
function countRequests(s: AppState): { n: () => number } {
  const dl = s.live!.dl as unknown as { http: Record<string, (...a: unknown[]) => unknown>; cache: Record<string, (...a: unknown[]) => unknown> };
  let n = 0;
  for (const [obj, m] of [[dl.http, 'getJson'], [dl.http, 'postJson'], [dl.cache, 'fetch']] as const) {
    const orig = obj[m].bind(obj);
    obj[m] = (...a: unknown[]) => { n++; return orig(...a); };
  }
  return { n: () => n };
}

test('flags: --scan + --scan-* parse into the config; bad values and fixtures/one-shot are rejected', () => {
  const a = parseArgs(['--scan', '--scan-min-score', '30', '--scan-max-ai-per-hour', '4', '--scan-vol-x', '2.5', '--scan-refresh-s', '120']);
  assert.equal(a.scan, true);
  assert.deepEqual(a.scanConfig, { minScore: 30, maxAiPerHour: 4, volX: 2.5, refreshS: 120 });
  assert.throws(() => parseArgs(['--scan-max-ai-per-hour', '2.5']), /whole number/);
  assert.throws(() => parseArgs(['--scan-flow-share', '62']), /share 0\.\.1/);
  assert.throws(() => parseArgs(['--scan-min-score', '-1']), /non-negative/);
  assert.throws(() => parseArgs(['--scan', '--fixtures']), /needs live data/);
  assert.throws(() => parseArgs(['--scan', '--screen', 'screener']), /interactive/);
  assert.equal(parseArgs([]).scan, false, 'OFF by default');
});

test('/scan grammar: on/start · off/stop · resume/next · status · bare = toggle; real filters are not commands', () => {
  assert.equal(parseScanCommand('/scan on'), 'on');
  assert.equal(parseScanCommand('scan start'), 'on');
  assert.equal(parseScanCommand('/scan stop'), 'off');
  assert.equal(parseScanCommand('/SCAN off'), 'off');
  assert.equal(parseScanCommand('/scan resume'), 'resume');
  assert.equal(parseScanCommand('/scan'), 'toggle');
  assert.equal(parseScanCommand('/scan status'), 'status');
  assert.match((parseScanCommand('/scan launch') as { error: string }).error, /unknown \/scan command/);
  assert.equal(parseScanCommand('vol24 > 250K liq > 50K'), null);
  assert.equal(parseScanCommand('scanner > 1'), null);
});

test('fixtures: Z says the scan needs live data and changes nothing', async () => {
  const { makeFixtureState } = await import('../src/state.ts');
  const s = makeFixtureState({ intensity: 'off' });
  key(s, 'Z');
  assert.match(s.pendingToast ?? '', /needs live data/);
  assert.ok(!s.scan?.engine.on);
});

test('Z toggles the scan; the header shows the running indicator + the analyst meter; row 1 shows the ticker', async () => {
  const s = await liveState();
  assert.doesNotMatch(String(headerModel(s).status ?? ''), /AI SCAN/, 'off by default: no indicator');
  key(s, 'Z');
  assert.equal(s.scan?.engine.mode, 'scanning');
  assert.match(s.pendingToast ?? '', /AI scan ON · observe-only · warming up 30s/);
  assert.match(String(headerModel(s).status), /◉ AI SCAN SCANNING · ai 0\/8 per h/);
  assert.match(rowText(s, 0), /AI SCAN SCANNING/, 'header row');
  assert.match(rowText(s, 1), /◉ AI SCAN SCANNING · \d+ coins/, 'ticker on row 1');
  key(s, 'Z');
  assert.equal(s.scan?.engine.mode, 'off');
  assert.equal(s.live!.scanMeter, null);
  assert.doesNotMatch(rowText(s, 1), /AI SCAN/);
  close(s);
});

test('/scan on|off typed on the screener / line runs the command and leaves the filter untouched', async () => {
  const s = await liveState();
  key(s, '/');
  key(s, 'liq > 1K\r');
  assert.equal(s.screener.query, 'liq > 1K');
  key(s, '/');
  for (const ch of '\x15scan on') key(s, ch); // ctrl-u clears the prefilled filter text
  key(s, '\r');
  assert.equal(s.scan?.engine.mode, 'scanning');
  assert.equal(s.screener.query, 'liq > 1K', 'the filter stays applied');
  assert.equal(s.screener.mode, 'table');
  key(s, '/');
  for (const ch of '\x15scan stop') key(s, ch);
  key(s, '\r');
  assert.equal(s.scan?.engine.mode, 'off');
  close(s);
});

test('recorded data: observing + 50 scan ticks over the replay sample make ZERO data-layer requests', async () => {
  const s = await liveState();
  const live = s.live!;
  const c = countRequests(s);
  scanCommand(s, 'on', [], 0);
  const e = s.scan!.engine;
  const src = { rows: s.screener.rows, token: null, larp: s.larpByMint };
  const obs = buildObservations({ ...src, cacheGet: (ns, k) => live.dl.cache.get(ns, k), livePrice: (m) => live.livePrice(m), now: 1, minLiqUsd: e.cfg.minLiqUsd });
  assert.ok(obs.length > 10, `observations from the recorded pool (${obs.length})`);
  assert.ok(obs.filter((o) => o.m5 && o.h1).length > 5, 'm5/h1 txns come from the cached DexScreener pair');
  for (let i = 0; i < 50; i++) { e.observe(obs, 1 + i * 2000); e.tick(1 + i * 2000); }
  assert.equal(c.n(), 0, 'no HTTP request and no cache loader ran');
  assert.equal(observeSig(src), observeSig(src), 'the signature is stable when nothing changed');
  close(s);
});

test('scanScreenState: the LOCKED coin is the selected coin and the action types are empty (observe-only)', async () => {
  const s = await liveState();
  const r = screenerView(s.screener).find((x) => x.mint)!;
  s.selected = 3; // the cursor is elsewhere
  const ss = scanScreenState(s, r.mint, r.symbol);
  assert.deepEqual(ss.selected, { mint: r.mint, symbol: r.symbol });
  assert.deepEqual((ss.actions as { types: string[] }).types, []);
  assert.ok((ss.actions as { mints: string[] }).mints.includes(r.mint));
  assert.match(analystContextBlock(ss), /UI actions: NONE in this session — AI scan mode is observe-only/);
  assert.doesNotMatch(analystContextBlock(buildScreenState(s)), /NONE in this session/, 'normal sessions keep the 1313 line');
  const argv = buildArgv({ prompt: 'x', screenState: ss, actionTypes: [] }, '/tmp/mcp.json');
  const i = argv.indexOf('--disallowedTools');
  assert.ok(i > 0, 'the CLI is told to deny the action tools');
  assert.deepEqual(argv[i + 1].split(','), deniedActionTools([]));
  assert.ok(argv[i + 1].includes('mcp__dexterm__open_ticket'));
  assert.equal(buildArgv({ prompt: 'x', screenState: {} }, '/tmp/mcp.json').indexOf('--disallowedTools'), -1, 'unrestricted turns unchanged');
  close(s);
});

test('LOCKED: the token screen shows WHY IT TRIGGERED on row 1; R resumes and returns to the screener', async () => {
  const s = await liveState();
  const stack: ScreenKey[] = [];
  s.scanConfig = { warmupS: 0, minScore: 1, minTriggers: 1, volX: 0.01, volMinUsd: 0, vetoAuthorities: false };
  scanCommand(s, 'on', stack, 1000);
  const live = s.live!;
  const e = s.scan!.engine;
  e.observe(buildObservations({ rows: s.screener.rows, cacheGet: (ns, k) => live.dl.cache.get(ns, k), now: 1000, minLiqUsd: e.cfg.minLiqUsd }), 1000);
  const d = e.tick(1000);
  assert.equal(d?.kind, 'lock', 'forced thresholds lock a recorded coin');
  // what the loop does on a lock (minus spawning claude)
  live.scanMeter = scanMeterOf(e, 1000);
  stack.push(s.screen);
  live.openToken({ mint: d!.mint, symbol: d!.symbol, name: '', launchpad: 'unknown' });
  s.screen = 'token';
  const row1 = rowText(s, 1, 220);
  assert.match(row1, /AI SCAN LOCKED · WHY IT TRIGGERED \d\d:\d\d:\d\d · score \d+ ·/);
  assert.match(row1, /vol 5m \$[\d.]+K? = [\d.]+× its (6h|1h|24h) pace/, 'the reasons with their numbers');
  assert.match(row1, /esc cancel · R resume · Z stop/);
  assert.match(String(headerModel(s).status), /◉ AI SCAN LOCKED \$\S+ · ai 1\/8 per h · coin 1\/4/);
  key(s, 'R', stack);
  assert.equal(s.scan!.engine.mode, 'scanning');
  assert.equal(s.screen, 'screener', 'resume returns to where the lock pulled the user from');
  assert.match(s.pendingToast ?? '', /scan resumed · \$\S+ cooling down 15m/);
  close(s);
});

test('WHY strip at 176 cols with four live-style reasons: full reasons while they fit, the rest by id, keys always visible', async () => {
  const { Canvas, THEMES } = await import('@dexterm/tui');
  const { makeScanUi, renderScanWhy } = await import('../src/scan/ui.ts');
  const scan = makeScanUi();
  const hit = (id: 'vol' | 'fresh' | 'holders' | 'liq', reason: string) => ({ id, strength: 1, points: 10, reason });
  scan.engine.mode = 'locked';
  scan.engine.lock = { mint: 'M', symbol: 'BNKR', at: 0, score: 67, liveScore: 70, lastReadAt: 0, lastRead: null, lastHits: [], reads: 1, moved: [],
    hits: [hit('vol', 'vol 5m $21.6K = 15.9× its 6h pace'), hit('fresh', 'fresh launch 24m old: 5m 180 txns, 66% buys, $21.6K'), hit('holders', 'holders +40 (+9.1%) in 1m'), hit('liq', 'liquidity +25% in 1m ($20.0K→$25.0K)')] };
  const c = new Canvas(176, 4, THEMES.cyberspace);
  renderScanWhy(c, scan, '', 8_000, 'UTC');
  const row = c.toPlain().split('\n')[1];
  assert.match(row, /score 67 \(now 70\) · vol 5m \$21\.6K = 15\.9× its 6h pace \+ fresh, holders, liq /, 'the top reason in full, every other trigger still named');
  assert.match(row, /read 1 \(8s ago\) · esc cancel · R resume · Z stop$/);
});

test('defaults are sane and documented: off, 45/2 to lock, 8 analyst turns per hour, 90 s refresh', () => {
  assert.equal(DEFAULT_SCAN_CONFIG.minScore, 45);
  assert.equal(DEFAULT_SCAN_CONFIG.minTriggers, 2);
  assert.equal(DEFAULT_SCAN_CONFIG.maxAiPerHour, 8);
  assert.equal(DEFAULT_SCAN_CONFIG.maxAiPerCoin, 4);
  assert.equal(DEFAULT_SCAN_CONFIG.refreshS, 90);
});
