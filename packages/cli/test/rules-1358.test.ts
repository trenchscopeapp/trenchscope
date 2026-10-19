// task-1358 Tier 3 — the rules engine in the app: ctrl+r opens the RULES screen, typing a rule shows a live
// dry-run and ⏎ persists it through the config journal, a money-shaped rule is refused, ticks turn fires into a
// toast + log + PROPOSAL cards (never an order plan, never anything armed), acting on a proposal only queues the
// PAPER ticket editor / an analyst question, a compromised config.rules entry never loads, and the `trenchscope rules`
// subcommands. Fixtures only; DEXTERM_HOME is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKeys, DEFAULT_KEYMAP } from '@dexterm/tui';
import { saveConfig, defaultConfig, loadConfig, readJournal } from '@dexterm/custom';
import { applyKey } from '../src/main.ts';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import { initCustom } from '../src/custom.ts';
import { rulesUiOf, rulesTick, RULES_TICK_MS } from '../src/rules.ts';
import { rulesCommand } from '../src/rules-cmd.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-rules-'));
function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = ''; let err = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } });
  return { io: { stdout, stderr, env }, out: () => out, err: () => err };
}
const type = (state: ReturnType<typeof makeFixtureState>, text: string): void => { for (const k of parseKeys(text)) applyKey(state, k, []); };
const CTRL_R = '\x12';
const ESC = '\x1b';
const ENTER = '\r';

function appState(home: string) {
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  state.rulesUi = rulesUiOf(state);
  return state;
}

test('ctrl+r opens the RULES screen (empty state explains the grammar), esc goes back, the help card names it', () => {
  const state = appState(tmp());
  const stack: never[] = [];
  for (const k of parseKeys(CTRL_R)) applyKey(state, k, stack);
  assert.equal(state.screen, 'rules');
  const frame = renderFrame(state, 176, 45).toPlain();
  assert.ok(frame.includes('RULES · 0 (0 on)'), frame.split('\n')[2]);
  assert.ok(frame.includes('no rules yet.'));
  assert.ok(frame.includes('every rule has a cooldown (10m) and a max/h (12, cap 120) · ticket/ask make PROPOSAL cards: you still size + confirm in the paper ticket'));
  assert.ok(frame.includes('alerts + proposals only · nothing arms'), 'the header says what the screen cannot do');
  state.overlay = 'help';
  assert.ok(renderFrame(state, 176, 45).toPlain().includes('Rules (alerts + proposals only)'));
  state.overlay = null;
  for (const k of parseKeys(ESC)) applyKey(state, k, stack);
  assert.equal(state.screen, 'screener');
  // the bindings exist and ctrl+r is global
  assert.equal(DEFAULT_KEYMAP.resolveId('ctrl+r', 'screener'), 'screen.rules');
  assert.equal(DEFAULT_KEYMAP.resolveId('i', 'rules'), 'rules.new');
  assert.equal(DEFAULT_KEYMAP.resolveId('tab', 'rules'), 'rules.tab');
});

test('typing a rule shows a live dry-run; ⏎ persists it through the config journal; a money-shaped rule is refused and nothing is written', () => {
  const home = tmp();
  const state = appState(home);
  const stack: never[] = [];
  for (const k of parseKeys(CTRL_R)) applyKey(state, k, stack);
  type(state, 'i');
  assert.equal(state.rulesUi!.input, '');
  type(state, 'liq > 100K then alert(up, "deep book") popup(chart) name "deep"');
  const d = state.rulesUi!.dry!;
  assert.equal(d.error, null);
  assert.ok(d.matches.length > 0 && d.matches.length <= d.considered);
  const frame = renderFrame(state, 176, 45).toPlain();
  assert.match(frame, /would match \d+ of \d+ rows right now/);
  assert.ok(frame.includes('rule: liq > 100K then alert(up, "deep book") popup(chart) name "deep"█'), 'the input line shows the text');
  type(state, ENTER);
  assert.equal(state.rulesUi!.input, null);
  assert.match(state.rulesUi!.notice ?? '', /^saved rule deep: alert up · popup chart/);
  const cfg = loadConfig(home);
  assert.equal(cfg.ok, true);
  assert.equal(cfg.config.rules!.length, 1);
  assert.equal(cfg.config.rules![0].id, 'deep');
  assert.deepEqual(cfg.config.rules![0].then, [{ action: 'alert', args: { level: 'up', text: 'deep book' } }, { action: 'popup', args: { kind: 'chart' } }]);
  const j = readJournal(home);
  assert.equal(j.length, 1); assert.equal(j[0].actor, 'user'); assert.match(j[0].why, /add rule deep/);
  assert.equal(state.rulesUi!.engine.rules.length, 1);
  // a second rule with the same name gets a fresh id instead of overwriting
  type(state, 'i'); type(state, 'liq > 1 then watch name "deep"'); type(state, ENTER);
  assert.deepEqual(loadConfig(home).config.rules!.map((r) => r.id), ['deep', 'deep-2']);
  // money-shaped: refused, config unchanged, journal unchanged
  const before = readFileSync(join(home, 'config.json'), 'utf8');
  type(state, 'i'); type(state, 'liq > 1 then ticket(buy, 1, sol, arm=true)');
  assert.match(state.rulesUi!.dry!.error ?? '', /cannot carry "arm"/);
  type(state, ENTER);
  assert.match(state.rulesUi!.notice ?? '', /not saved: ticket cannot carry "arm"/);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
  assert.equal(readJournal(home).length, 2);
  assert.equal(state.rulesUi!.engine.rules.length, 2);
  // edit the first rule (⏎ on the rules pane prefills its text), toggle it off, delete the second
  state.rulesUi!.selected = 0;
  type(state, ENTER);
  assert.equal(state.rulesUi!.editingId, 'deep');
  assert.equal(state.rulesUi!.input, 'when liq > 100K then alert(up, "deep book") popup(chart) name "deep"');
  type(state, ESC);
  type(state, ' ');
  assert.match(state.rulesUi!.notice ?? '', /disabled/);
  assert.equal(loadConfig(home).config.rules![0].enabled, false);
  state.rulesUi!.selected = 1;
  type(state, 'd');
  assert.deepEqual(loadConfig(home).config.rules!.map((r) => r.id), ['deep']);
  assert.equal(state.rulesUi!.engine.rules.length, 1);
  assert.equal(readJournal(home).length, 4);
});

test('ticks: a fire becomes a toast + log line + PROPOSAL cards; no order plan, nothing armed; acting only queues the PAPER ticket editor / an analyst question', () => {
  const home = tmp();
  saveConfig(home, { ...defaultConfig(), rules: [{ id: 'hot', name: 'hot', when: 'liq > 0', then: [{ action: 'alert', args: { level: 'up', text: 'liquid' } }, { action: 'ticket', args: { side: 'buy', size: 0.5, unit: 'sol' } }, { action: 'ask', args: { skill: 'token-dossier' } }, { action: 'popup', args: { kind: 'narrative' } }, { action: 'sound', args: { name: 'ping' } }], cooldown: '0s', maxPerHour: 2, source: 'user' }] });
  const state = appState(home);
  const ui = state.rulesUi!;
  assert.equal(ui.engine.rules.length, 1);
  const t0 = state.now.getTime();
  const s1 = rulesTick(state, t0)!;
  assert.ok(s1, 'first tick runs');
  assert.equal(s1.fired, 2, 'max 2/h caps a liq > 0 rule over the whole fixture universe');
  assert.equal(rulesTick(state, t0 + 100), null, 'throttled');
  assert.ok(state.pendingToast && state.pendingToast.startsWith('⚑ '), state.pendingToast ?? '');
  assert.ok(ui.log.some((l) => l.kind === 'alert' && /liquid: liq > 0 \(/.test(l.text)));
  assert.equal(ui.proposals.length, 4, 'two fires × (ticket + ask)');
  for (const p of ui.proposals) { assert.equal(p.status, 'proposal'); assert.equal(p.requiresKeypress, true); assert.equal(p.armedBy, null); }
  assert.equal(ui.pending.popups.length, 2); assert.equal(ui.pending.bells, 2);
  assert.ok(!state.plansSvc, 'a rule never touches the order-plan engine');
  assert.equal(JSON.stringify(ui).includes('"armed"'), false);
  // the screen shows the proposals pane; ⏎ acts on the selected card (a ticket): the loop gets a PAPER-ticket request, nothing else
  const stack: never[] = [];
  for (const k of parseKeys(CTRL_R)) applyKey(state, k, stack);
  type(state, '\t');
  assert.equal(ui.pane, 'proposals');
  const frame = renderFrame(state, 176, 45).toPlain();
  assert.ok(frame.includes('PROPOSALS · 4 pending · inert until you act'), frame);
  assert.ok(frame.includes('ticket BUY 0.5 sol on'));
  // newest first: the ask card (last action of the latest fire) is on top → a question for the analyst, as text
  assert.equal(ui.proposals[0].type, 'ask');
  type(state, ENTER);
  assert.equal(ui.proposals.length, 3);
  assert.match(ui.pending.ask ?? '', /^token dossier for [A-Z]+ \([1-9A-HJ-NP-Za-km-z]+\) — rule "hot" fired: liq > 0/);
  assert.equal(ui.pending.ticket, null);
  // then the ticket card → the loop gets a PAPER-ticket request, nothing else
  const first = ui.proposals[0];
  assert.equal(first.type, 'ticket');
  type(state, ENTER);
  assert.equal(ui.proposals.length, 2);
  assert.deepEqual(ui.pending.ticket, { mint: first.mint, symbol: first.symbol, name: ui.pending.ticket!.name, side: 'buy', size: 0.5, unit: 'sol' });
  assert.match(ui.notice ?? '', /PAPER ticket editor .* nothing is confirmed until you do/);
  // x dismisses without side effects
  type(state, 'x');
  assert.equal(ui.proposals.length, 1);
  assert.ok(ui.log[0].kind === 'dismissed');
  // the config file was never touched by ticks or proposals
  assert.equal(loadConfig(home).config.rules!.length, 1);
  assert.equal(readJournal(home).length, 0);
  // cooldown + max/h: the next tick after the throttle fires nothing more this hour
  const s2 = rulesTick(state, t0 + RULES_TICK_MS + 1)!;
  assert.equal(s2.fired, 0); assert.ok(s2.suppressed > 0);
});

test('COMPROMISED CONFIG: a rules[] entry with an unknown action fails the schema (defaults in use, reported); one with arm-shaped args never loads', () => {
  const home = tmp();
  const bad = { ...defaultConfig(), rules: [{ id: 'evil', when: 'liq > 0', then: [{ action: 'execute', args: { side: 'buy' } }] }] };
  writeFileSync(join(home, 'config.json'), JSON.stringify(bad));
  const state = appState(home);
  assert.ok(state.custom!.configErrors.some((e) => /\/rules\/0\/then\/0\/action/.test(e)), state.custom!.configErrors.join('; '));
  assert.equal(state.rulesUi!.engine.rules.length, 0);
  const home2 = tmp();
  saveConfig(home2, { ...defaultConfig(), rules: [{ id: 'sly', when: 'liq > 0', then: [{ action: 'ticket', args: { side: 'buy', size: 1, unit: 'sol', autoArm: true } }] }, { id: 'ok', when: 'liq > 0', then: [{ action: 'watch' }] }] });
  const s2 = appState(home2);
  assert.deepEqual(s2.rulesUi!.engine.rules.map((r) => r.id), ['ok']);
  assert.ok(s2.rulesUi!.errors.some((e) => /rule sly: ticket cannot carry "autoArm"/.test(e)), s2.rulesUi!.errors.join('; '));
  assert.ok(s2.custom!.configErrors.some((e) => /rule sly/.test(e)));
  assert.ok(renderFrame(Object.assign(s2, { screen: 'rules' as const }), 176, 45).toPlain().includes('⚠ rule sly: ticket cannot carry "autoArm"'));
});

test('trenchscope rules: add/list/check/dry-run/enable/disable/remove/fields; refusals exit 1; nothing but config.json + the journal is written', async () => {
  const home = tmp();
  const env = { DEXTERM_HOME: home };
  let r = fakeIo(env);
  assert.equal(await rulesCommand(['add', 'vol5m.velocity > 3 and cluster < 20 and liq > 25K for 2 ticks then alert(up, "surge") popup(chart) name "surge"'], r.io), 0);
  assert.match(r.out(), /^added rule surge: when vol5m\.velocity > 3 and cluster < 20 and liq > 25K for 2 ticks then alert\(up, "surge"\) popup\(chart\) name "surge"/);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['add', 'liq > 1 then ticket(buy, 500)'], r.io), 1);
  assert.match(r.err(), /refused: ticket size must be a number 0 < n ≤ 50/);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['check', 'liq > 1 then sign()'], r.io), 1);
  assert.match(r.out(), /✗ unknown action "sign"/);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['check', 'mc > $1M then watch'], r.io), 0);
  assert.match(r.out(), /"when": "mcap > 1M"/);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['list'], r.io), 0);
  assert.match(r.out(), /1 rule\(s\)\n  on  surge\s+when vol5m\.velocity > 3 and cluster < 20 and liq > 25K for 2 ticks → alert up · popup chart · user · cooldown 10m · max 12\/h · scope screener/);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['disable', 'surge'], r.io), 0);
  assert.equal(loadConfig(home).config.rules![0].enabled, false);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['enable', 'surge'], r.io), 0);
  assert.equal(loadConfig(home).config.rules![0].enabled, true);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['dry-run', 'liq > 100K then alert(info, "x")'], r.io), 0);
  assert.match(r.out(), /would match \d+ of \d+ demo rows right now \(fixture data, flat history\) → alert info/);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['dry-run', 'liq > 1 then ticket(buy, 1, sol, confirm=1)'], r.io), 1);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['fields'], r.io), 0);
  assert.match(r.out(), /fields:  price mcap fdv liq vol5m/);
  assert.match(r.out(), /actions: alert ticket ask popup tag sound watch/);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['remove', 'surge'], r.io), 0);
  assert.equal(loadConfig(home).config.rules!.length, 0);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['remove', 'surge'], r.io), 1);
  r = fakeIo(env);
  assert.equal(await rulesCommand(['bogus'], r.io), 2);
  assert.equal(readJournal(home).length, 4);
  assert.ok(existsSync(join(home, 'config.json')));
  assert.ok(!existsSync(join(home, 'helius.key')), 'no key file is ever written by the rules CLI');
});
