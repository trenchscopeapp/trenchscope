// task-1366 — the price display mode in the app: helpers (supply ratio, cells, fallback), the `$` key (persisted
// through the journal), --price-mode, workspaces, `trenchscope display`. Fixtures only; DEXTERM_HOME is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKeys, DEFAULT_KEYMAP, Canvas, THEMES, candleChart, fmtMcapBare, type ScreenKey } from '@dexterm/tui';
import { configPath, readJournal, writeWorkspace } from '@dexterm/custom';
import { applyKey, parseArgs, switchWorkspace, stateFromArgs } from '../src/main.ts';
import { makeFixtureState, renderFrame, newPlansUi } from '../src/state.ts';
import { PlanService } from '@dexterm/data/plans';
import type { HeldRow } from '../src/live/trade.ts';
import { initCustom } from '../src/custom.ts';
import { chartVMFromView, positionCells } from '../src/popup.ts';
import { emptyView, type TokenView } from '../src/live/token.ts';
import { helpRows } from '../src/screens/overlay.ts';
import { supplyRatio, mcapAt, priceCell, mcapWithPrice, priceModeOf, configPriceMode, displayCommand, planLevels, triggerLevel, positionPriceCells, MCAP_FALLBACK_NOTE } from '../src/display.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-1366-'));
const keys = (state: ReturnType<typeof makeFixtureState>, raw: string, stack: ScreenKey[] = []): void => { for (const k of parseKeys(raw)) applyKey(state, k, stack); };
function bufIo(env: NodeJS.ProcessEnv) { let out = ''; let err = ''; return { io: { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, env }, out: () => out, err: () => err }; }

test('supply ratio = mcap / price at the latest tick; unknown supply is null, never a guess', () => {
  assert.equal(supplyRatio(0.001, 1_000_000), 1e9);
  assert.equal(mcapAt(0.002, 1e9), 2_000_000);
  for (const [p, m] of [[null, 1e6], [0.001, null], [0, 1e6], [0.001, 0], [-1, 1e6], [Number.NaN, 1e6], [0.001, Number.POSITIVE_INFINITY]] as const) assert.equal(supplyRatio(p, m), null, `${p} ${m}`);
  assert.equal(mcapAt(0.001, null), null);
});

test('price cells: mcap mode shows market cap, falls back to a flagged price without a supply, price mode unchanged', () => {
  assert.deepEqual(priceCell('mcap', 0.0012, 1_234_567), { text: '$1.23M', kind: 'mcap', fallback: false });
  assert.deepEqual(priceCell('mcap', 0.0012, null), { text: '$0.0012', kind: 'price', fallback: true });
  assert.deepEqual(priceCell('mcap', null, null), { text: '—', kind: 'price', fallback: false });
  assert.deepEqual(priceCell('price', 0.0012, 1_234_567), { text: '$0.0012', kind: 'price', fallback: false });
  assert.equal(mcapWithPrice(0.0012, 300_000), 'mcap $300K ($0.0012)');
  assert.equal(mcapWithPrice(0.0012, null), `$0.0012 · ${MCAP_FALLBACK_NOTE}`);
});

test('$ is bound globally, unbound before, listed in ? help on every main screen', () => {
  assert.equal(DEFAULT_KEYMAP.bindings.filter((b) => b.keys.includes('$')).length, 1);
  for (const screen of ['screener', 'token', 'newpairs', 'watchlist', 'positions', 'plans'] as ScreenKey[]) {
    assert.ok(helpRows(screen, false).some((r) => r.keys === '$' && /price ⇄ mcap/.test(r.label)), screen);
  }
});

test('$ toggles price ⇄ mcap, persists display.priceMode through the journal, and a new run starts in the saved mode', () => {
  const home = tmp();
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  state.priceMode = configPriceMode(state.custom.config);
  assert.equal(priceModeOf(state), 'price');
  keys(state, '$');
  assert.equal(state.priceMode, 'mcap');
  assert.match(state.pendingToast ?? '', /MARKET CAP .*mcap \(current supply\).*saved/);
  assert.equal(JSON.parse(readFileSync(configPath(home), 'utf8')).display.priceMode, 'mcap');
  assert.equal(readJournal(home).at(-1)?.actor, 'user');
  assert.equal(configPriceMode(initCustom({ DEXTERM_HOME: home }).config), 'mcap');
  keys(state, '$');
  assert.equal(state.priceMode, 'price');
  assert.equal(JSON.parse(readFileSync(configPath(home), 'utf8')).display.priceMode, 'price');
});

test('$ on a run without a config still flips the mode for the run and says it was not saved', () => {
  const state = makeFixtureState();
  keys(state, '$');
  assert.equal(state.priceMode, 'mcap');
  assert.match(state.pendingToast ?? '', /not saved/);
});

test('--price-mode sets the run mode and rejects anything else', () => {
  assert.equal(parseArgs(['--price-mode', 'mcap']).priceMode, 'mcap');
  assert.equal(parseArgs([]).priceMode, null);
  assert.throws(() => parseArgs(['--price-mode', 'fdv']), /--price-mode expects price\|mcap/);
  assert.equal(stateFromArgs(parseArgs(['--screen', 'screener', '--price-mode', 'mcap']), {}).priceMode, 'mcap');
  assert.equal(priceModeOf(stateFromArgs(parseArgs(['--screen', 'screener']), {})), 'price');
});

test('a workspace with priceMode switches the mode; one without keeps the current mode', () => {
  const home = tmp();
  writeWorkspace(home, { name: 'mc', priceMode: 'mcap' });
  writeWorkspace(home, { name: 'plain' });
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.equal(switchWorkspace(state, 'mc', []).ok, true);
  assert.equal(state.priceMode, 'mcap');
  assert.equal(switchWorkspace(state, 'plain', []).ok, true);
  assert.equal(state.priceMode, 'mcap');
});

test('trenchscope display shows and sets the saved mode; a bad mode exits 2', () => {
  const home = tmp();
  const a = bufIo({ DEXTERM_HOME: home });
  assert.equal(displayCommand([], a.io), 0);
  assert.match(a.out(), /display\.priceMode = price/);
  const b = bufIo({ DEXTERM_HOME: home });
  assert.equal(displayCommand(['mcap'], b.io), 0);
  assert.equal(JSON.parse(readFileSync(configPath(home), 'utf8')).display.priceMode, 'mcap');
  const c = bufIo({ DEXTERM_HOME: home });
  assert.equal(displayCommand(['usd'], c.io), 2);
  assert.match(c.err(), /unknown mode/);
  writeFileSync(configPath(home), '{ broken');
  const d = bufIo({ DEXTERM_HOME: home });
  assert.equal(displayCommand([], d.io), 1);
});

// ------------------------------------------------------------------ Tier 2: tables on fixtures, both modes
const frame = (screen: ScreenKey, mode: 'price' | 'mcap', mutate?: (s: ReturnType<typeof makeFixtureState>) => void): string[] => {
  const s = makeFixtureState({ screen, calm: true });
  s.priceMode = mode;
  mutate?.(s);
  return renderFrame(s, 176, 48).toPlain().split('\n');
};
const headerLine = (lines: string[], re: RegExp): string => lines.find((l) => re.test(l)) ?? '';

test('screener price mode: PRICE comes before MCAP (unchanged layout)', () => {
  const head = headerLine(frame('screener', 'price'), /# TOKEN/);
  assert.ok(head.indexOf('PRICE') > 0 && head.indexOf('PRICE') < head.indexOf('MCAP'), head);
});

test('screener mcap mode: MCAP takes the PRICE slot, PRICE moves to MCAP\'s; the spotlight leads with mcap (price beside it)', () => {
  const lines = frame('screener', 'mcap');
  const head = headerLine(lines, /# TOKEN/);
  assert.ok(head.indexOf('MCAP') > 0 && head.indexOf('MCAP') < head.indexOf('5M') && head.indexOf('PRICE') > head.indexOf('LIQ'), head);
  const row = lines.find((l) => /1 SIGMA/.test(l)) ?? '';
  assert.match(row, /3\.2h\s+\$162\.4M\s+▼2\.1%.*\$23\.5M\s+\$0\.1624/);
  assert.ok(lines.some((l) => /\$162M \(\$0\.1624\) ▲45\.3% 24h/.test(l)), 'spotlight headline');
});

test('screener mcap mode: the mcap sort key still sorts by market cap and its header carries the arrow', () => {
  const lines = frame('screener', 'mcap', (s) => { s.screener.sort = { key: 'mcap', dir: 'desc' }; });
  const head = headerLine(lines, /# TOKEN/);
  assert.match(head, /▼ MCAP/);
  const caps = lines.filter((l) => /│[▎ ]\s+\d+ /.test(l)).slice(0, 6).map((l) => l.match(/\$([\d.]+)([KMB])/)).filter(Boolean).map((m) => Number(m![1]) * { K: 1e3, M: 1e6, B: 1e9 }[m![2] as 'K' | 'M' | 'B']);
  assert.ok(caps.length >= 4, `rows parsed: ${caps.length}`);
  for (let i = 1; i < caps.length; i++) assert.ok(caps[i - 1] >= caps[i], `sorted desc: ${caps.join(', ')}`);
});

test('screener mcap mode: a token without a supply shows its price marked ᵖ, the caption counts it, the spotlight says so', () => {
  const lines = frame('screener', 'mcap', (s) => { s.screener.rows[0].mcap = null; });
  const row = lines.find((l) => /1 SIGMA/.test(l)) ?? '';
  assert.match(row, /\$0\.1624ᵖ/);
  assert.ok(lines.some((l) => /ᵖ 1 price \(supply unknown\)/.test(l)), 'caption');
  assert.ok(lines.some((l) => /supply unknown · showing price/.test(l)), 'spotlight note');
  // price mode is untouched by a missing mcap: the PRICE column still shows the price, MCAP a dash
  const p = frame('screener', 'price', (s) => { s.screener.rows[0].mcap = null; });
  assert.ok(!p.some((l) => /ᵖ|supply unknown/.test(l)));
});

test('watchlist mcap mode: MCAP leads, ENTRY becomes ENTRY MC (entry × current supply), VS ENTRY unchanged', () => {
  const pl = frame('watchlist', 'price');
  const ml = frame('watchlist', 'mcap');
  assert.match(headerLine(pl, /TOKEN.*LP/), /PRICE\s+ENTRY\s+VS ENTRY.*MCAP/);
  assert.match(headerLine(ml, /TOKEN.*LP/), /MCAP\s+ENTRY MC\s+VS ENTRY.*PRICE/);
  const goat = ml.find((l) => /GOAT Goatseus/.test(l)) ?? '';
  // entry $0.1575 × (133.9M / 0.1339) supply ≈ $157.5M; the % vs entry is the same in both modes
  assert.match(goat, /\$133\.9M\s+\$157\.5M\s+▼15\.0%/);
  assert.match(pl.find((l) => /GOAT Goatseus/.test(l)) ?? '', /▼15\.0%/);
});

test('new pairs mcap mode: the table (already MCAP-first) is unchanged; the spotlight leads with mcap, price beside it', () => {
  const pl = frame('newpairs', 'price');
  const ml = frame('newpairs', 'mcap');
  assert.equal(headerLine(pl, /AGE TOKEN/).split('│ │')[0], headerLine(ml, /AGE TOKEN/).split('│ │')[0]);
  assert.ok(pl.some((l) => /│ \$0\.0₄8079 ▲60\.5%/.test(l)));
  assert.ok(ml.some((l) => /│ \$80\.8K \(\$0\.0₄8079\) ▲60\.5%/.test(l)));
});

// ------------------------------------------------------------------ Tier 3: token screen, TUI chart, popup chart VM
const chartRows = (lines: string[]): string[] => lines.filter((l) => /^│ /.test(l)).slice(0, 12).map((l) => l.slice(0, 100)); // plot area, axis column excluded

test('token screen mcap mode: header leads with mcap (price beside it), the chart title says current supply, axis is K/M/B', () => {
  const pl = frame('token', 'price');
  const ml = frame('token', 'mcap');
  assert.ok(pl.some((l) => /^ \$0\.1624  5m/.test(l)));
  assert.ok(pl.some((l) => /SIGMA\/SOL · 1h/.test(l)) && pl.some((l) => /0\.20056 │/.test(l)));
  assert.ok(ml.some((l) => /^ \$162M \(\$0\.1624\)  5m/.test(l)), 'header');
  assert.ok(ml.some((l) => /SIGMA mcap \(current supply\) · 1h/.test(l)), 'chart title');
  assert.ok(ml.some((l) => /\s201M │/.test(l)) && ml.some((l) => /\s162M │/.test(l)), 'axis + last-value tag in K/M/B');
  assert.ok(!ml.some((l) => /0\.20056/.test(l)), 'no price labels on the mcap axis');
  // same data underneath: the candles are drawn identically, only the axis labels change
  assert.deepEqual(chartRows(ml.slice(4)), chartRows(pl.slice(4)));
});

test('token screen mcap mode without a supply: the price stays, the title says supply unknown, the axis stays prices', () => {
  const ml = frame('token', 'mcap', (s) => { (s.token as { mcap: number | null }).mcap = null; });
  assert.ok(ml.some((l) => /^ \$0\.1624  5m/.test(l)), 'header falls back to the price');
  assert.ok(ml.some((l) => /SIGMA\/SOL · supply unknown · showing price · 1h/.test(l)), 'title says why');
  assert.ok(ml.some((l) => /0\.20056 │/.test(l)), 'price axis');
});

test('candleChart: scale relabels the axis as price × scale with axisFmt; the bars are glyph-identical', () => {
  const C1 = Array.from({ length: 30 }, (_, i) => ({ t: i * 60_000, o: 0.001 + i * 1e-5, h: 0.0011 + i * 1e-5, l: 0.0009 + i * 1e-5, c: 0.00105 + i * 1e-5, v: 10 }));
  const draw = (opts: Parameters<typeof candleChart>[6]): string => { const cv = new Canvas(80, 20, THEMES.cyberspace); candleChart(cv, 0, 0, 80, 20, C1, opts); return cv.toPlain(); };
  const scaled = draw({ scale: 1e9, axisFmt: fmtMcapBare });
  assert.match(scaled, /\b1\.3\dM\b/);
  assert.match(scaled, /\b1\.0\dM\b/);
  // identical glyphs left of the axis
  const strip = (s: string) => s.split('\n').map((l) => l.slice(0, 68)).join('\n');
  assert.equal(strip(scaled), strip(draw({})));
});

const tokenView = (mcap: number | null): TokenView => {
  const v = emptyView({ mint: 'MINT1', symbol: 'WIF', name: 'dogwifhat', launchpad: 'pump.fun' }, '1h');
  v.price = 0.002; v.mcap = mcap;
  v.candles = [{ t: 0, o: 0.001, h: 0.0022, l: 0.0009, c: 0.002, v: 5 }];
  v.panels.candles = { state: 'ok', via: 'geckoterminal', reason: null, fetchedAt: 1, stale: false };
  return v;
};

test('popup chart VM: priceMode + supply (= mcap / price at the latest tick) travel with the VM; bars stay USD prices', () => {
  const vm = chartVMFromView(tokenView(2_000_000), { interval: '1h', series: null, priceMode: 'mcap', now: 1 });
  assert.equal(vm.priceMode, 'mcap');
  assert.equal(vm.supply, 1e9);
  assert.equal(vm.candles[0].c, 0.002, 'the bars are prices; only the page formatter changes');
  const none = chartVMFromView(tokenView(null), { interval: '1h', series: null, priceMode: 'mcap', now: 1 });
  assert.equal(none.priceMode, 'mcap');
  assert.equal(none.supply, null, 'unknown supply is sent as null (the page shows price + a note), never guessed');
  const px = chartVMFromView(tokenView(2_000_000), { interval: '1h', series: null, now: 1 });
  assert.equal(px.priceMode, 'price');
  assert.equal(px.supply, null);
  assert.equal(chartVMFromView(tokenView(2_000_000)).priceMode, undefined, 'the v1 (no extras) VM shape is untouched');
});

// ------------------------------------------------------------------ Tier 4: plan preview, positions
const PLAN = { entry: { kind: 'mc-below' as const, value: 300_000 }, exits: [{ at: { kind: 'mc-above' as const, value: 600_000 }, fraction: 0.5 }], stop: { kind: 'mc-below' as const, value: 150_000 }, supplyAtProposal: 1e9 };

test('plan levels show BOTH market cap and price (price = mc / the plan\'s own supply snapshot), mc first in mcap mode', () => {
  assert.equal(planLevels(PLAN, 'mcap'), 'entry mc ≤ $300K ($0.0₃3) · TP 50% mc ≥ $600K ($0.0₃6) · stop mc ≤ $150K ($0.0₃15)');
  assert.equal(planLevels(PLAN, 'price'), 'entry ≤ $0.0₃3 (mc $300K) · TP 50% ≥ $0.0₃6 (mc $600K) · stop ≤ $0.0₃15 (mc $150K)');
  assert.equal(triggerLevel({ kind: 'immediate' }, 1e9, 'mcap'), 'now');
  assert.equal(triggerLevel({ kind: 'price-above', value: 0.002 }, 1e9, 'mcap'), 'mc ≥ $2M ($0.002)');
  assert.equal(triggerLevel({ kind: 'price-above', value: 0.002 }, 0, 'mcap'), 'mc ≥ — ($0.002)', 'no supply: no invented mcap');
});

test('plans screen: the selected plan\'s preview carries mc + price; proposing/arming is untouched (still PROPOSED)', () => {
  for (const mode of ['price', 'mcap'] as const) {
    const s = makeFixtureState({ screen: 'plans', calm: true });
    s.plansUi = newPlansUi();
    s.plansSvc = new PlanService(); // in-memory, no journal file
    s.priceMode = mode;
    const p = s.plansSvc.propose({ mint: 'So11111111111111111111111111111111111111112', symbol: 'WIF', decimals: 6, side: 'buy', sizeUsd: 20, ...PLAN }, { supply: 1e9, by: 'user' });
    const lines = renderFrame(s, 176, 40).toPlain();
    assert.match(lines, mode === 'mcap' ? /entry mc ≤ \$300K \(\$0\.0₃3\) · TP 50% mc ≥ \$600K/ : /entry ≤ \$0\.0₃3 \(mc \$300K\) · TP 50% ≥ \$0\.0₃6/);
    assert.equal(s.plansSvc.listPlans().find((r) => r.id === p.id)?.status, 'proposed');
  }
});

test('position cells: mcap mode (supply known) reads AVG MC / MCAP; PnL cells unchanged; no supply → price + ᵖ', () => {
  const mc = positionPriceCells('mcap', 1e9, 0.001, 0.002, '$0.0010', '$0.0020');
  assert.deepEqual(mc, { avg: { label: 'AVG MC', value: '$1M' }, price: { label: 'MCAP', value: '$2M' } });
  assert.deepEqual(positionPriceCells('mcap', null, 0.001, 0.002, '$0.0010', '$0.0020'), { avg: { label: 'AVG ENTRY', value: '$0.0010ᵖ' }, price: { label: 'PRICE', value: '$0.0020ᵖ' } });
  assert.deepEqual(positionPriceCells('price', 1e9, 0.001, 0.002, '$0.0010', '$0.0020'), { avg: { label: 'AVG ENTRY', value: '$0.0010' }, price: { label: 'PRICE', value: '$0.0020' } });
  const row: HeldRow = { side: 'long', tokens: 1000, symbol: 'WIF', basis: 'usd', solUsd: 150, valueUsd: 2, valueSol: 2 / 150, avgEntryUsd: 0.001, avgEntrySol: 0.001 / 150, priceUsd: 0.002, priceSol: 0.002 / 150, unrealizedUsd: 1, unrealizedSol: 1 / 150, unrealizedPct: 1, realizedUsd: 0, realizedSol: 0, stopUsd: null, stopDistPct: null, targetUsd: null, targetDistPct: null } as unknown as HeldRow;
  const px = positionCells(row);
  const mcCells = positionCells(row, 'mcap', 1e9);
  assert.deepEqual(mcCells.map((c) => c.label), px.map((c) => c.label === 'AVG ENTRY' ? 'AVG MC' : c.label === 'PRICE' ? 'MCAP' : c.label));
  assert.equal(mcCells.find((c) => c.label === 'MCAP')?.value, '$2M');
  assert.deepEqual(mcCells.filter((c) => c.label === 'UNREALIZED' || c.label === 'VALUE'), px.filter((c) => c.label === 'UNREALIZED' || c.label === 'VALUE'), 'PnL / value stay USD');
});

test('paper positions screen: mcap mode labels AVG MC / MCAP and prices them at the current supply; price mode unchanged', () => {
  const mintRow = (s: ReturnType<typeof makeFixtureState>) => s.screener.rows[0];
  const view = (s: ReturnType<typeof makeFixtureState>) => ({
    startSol: 10, equitySol: 10.5, totalPct: 0.05, solPriceUsd: 150, loading: false, totalRealizedSol: 0, totalUnrealizedSol: 0.5,
    rows: [{ mint: mintRow(s).mint, symbol: mintRow(s).symbol, tokens: 1000, costSol: 1, avgEntrySol: mintRow(s).price! / 150, priceSol: mintRow(s).price! / 150, valueSol: 1.5, unrealizedSol: 0.5, unrealizedPct: 0.5, realizedSol: 0 }],
    history: [], notice: null,
  });
  for (const mode of ['price', 'mcap'] as const) {
    const plain = frame('positions', mode, (s) => { s.positions = view(s) as never; }).join('\n');
    if (mode === 'mcap') { assert.match(plain, /AVG MC\s+MCAP/); assert.match(plain, /\$162M\s+\$162M/); }
    else { assert.match(plain, /AVG\s+PRICE/); assert.ok(!/MCAP|AVG MC/.test(plain)); }
  }
});
