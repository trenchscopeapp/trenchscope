// task-1358 Tier 1 — workspaces in the app: switch (theme / intensity / screener / start screen / popups),
// the ctrl+w chord + save-as input, slot picks, layout persistence through a real file, the morning HUD,
// renderer numbers from a saved layout, the --workspace flag, the `trenchscope workspace` subcommand and the
// voice "show me everything" decision. Fixtures only; no network; DEXTERM_HOME is a temp dir throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKeys, THEMES, type ScreenKey } from '@dexterm/tui';
import { route, isSafe } from '@dexterm/voice';
import { listWorkspaces, builtinScreens } from '@dexterm/custom';
import { applyKey, parseArgs, main, switchWorkspace } from '../src/main.ts';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import { initCustom, planPopupOpens, layoutFor, workspaceBadge, workspaceSlots } from '../src/custom.ts';
import { workspaceCommand } from '../src/workspace-cmd.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-ws-'));
const keys = (state: ReturnType<typeof makeFixtureState>, raw: string, stack: ScreenKey[] = []): void => { for (const k of parseKeys(raw)) applyKey(state, k, stack); };
const CTRL_W = '\x17';

function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = ''; let err = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: false, columns: 176, rows: 45 });
  Object.assign(stderr, { isTTY: false });
  const stdin = { isTTY: false } as unknown as NodeJS.ReadStream & { fd: 0 };
  return { io: { stdout, stderr, stdin, env }, out: () => out, err: () => err };
}

test('switching to the morning HUD lands on the narrative board, queues its popups and reports the switch', () => {
  const home = tmp();
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.equal(state.custom.active, 'default');
  assert.deepEqual(workspaceSlots(state.custom), ['default', 'morning-hud']);
  const stack: ScreenKey[] = [];
  const r = switchWorkspace(state, 'morning-hud', stack);
  assert.equal(r.ok, true);
  assert.equal(state.screen, 'narrative');
  assert.equal(state.custom.active, 'morning-hud');
  assert.deepEqual(state.custom.pendingPopups?.map((p) => p.kind), ['narrative', 'feeds', 'plans', 'chart']);
  assert.equal(state.screener.preset, 'trench');
  assert.match(state.pendingToast ?? '', /workspace morning-hud · 4 popups/);
  // and back: default lands on the screener, no popups
  const d = switchWorkspace(state, 'default', stack);
  assert.equal(d.ok, true);
  assert.equal(state.screen, 'screener');
  assert.equal(state.custom.pendingPopups, null);
  // an unknown name is a precise refusal that lists what exists
  const bad = switchWorkspace(state, 'nope', stack);
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /no workspace "nope" \(default · morning-hud\)/);
});

test('the ctrl+w chord: m = morning HUD, d = default, digits pick slots, a stale prefix fires nothing, unknown second key is refused', () => {
  const home = tmp();
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  keys(state, CTRL_W);
  assert.equal(state.custom.chord, 'ctrl+w');
  assert.ok(workspaceBadge(state.custom, state.now.getTime())?.kind === 'chord', 'the badge shows the pending chord');
  keys(state, 'm');
  assert.equal(state.custom.chord, null);
  assert.equal(state.custom.active, 'morning-hud');
  assert.equal(state.screen, 'narrative');
  keys(state, CTRL_W + 'd');
  assert.equal(state.custom.active, 'default');
  assert.equal(state.screen, 'screener');
  keys(state, CTRL_W + '2');
  assert.equal(state.custom.active, 'morning-hud');
  keys(state, CTRL_W + '1');
  assert.equal(state.custom.active, 'default');
  keys(state, CTRL_W + '9');
  assert.match(state.pendingToast ?? '', /no workspace in slot 9/);
  // a stale prefix (older than the TTL) is dropped and the key is handled normally: `m` is unbound on the screener
  keys(state, CTRL_W);
  state.custom.chordAt = state.now.getTime() - 10_000;
  keys(state, 'm');
  assert.equal(state.custom.active, 'default');
  assert.equal(state.custom.chord, null);
  // an unknown second key never falls through to a verb: ctrl+w then q must NOT quit
  state.pendingToast = null;
  const stack: ScreenKey[] = [];
  let effect: unknown;
  for (const k of parseKeys(CTRL_W + 'q')) effect = applyKey(state, k, stack);
  assert.notEqual(effect, 'quit');
  assert.match(state.pendingToast ?? '', /no such chord/);
});

test('ctrl+w s saves the current layout under a typed name; the file round-trips and restores theme + screen + filter', () => {
  const home = tmp();
  const state = makeFixtureState({ screen: 'watchlist', theme: THEMES.ember });
  state.custom = initCustom({ DEXTERM_HOME: home });
  state.screener.query = 'liq > 10K';
  keys(state, CTRL_W + 's');
  assert.equal(state.custom.nameInput, '');
  keys(state, 'Even!ing-1'); // uppercase and punctuation are dropped: names are [a-z0-9-]
  assert.equal(state.custom.nameInput, 'vening-1');
  keys(state, '\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7fevening');
  assert.equal(state.custom.nameInput, 'evening');
  keys(state, '\r');
  assert.equal(state.custom.nameInput, null);
  const path = join(home, 'workspaces', 'evening.json');
  assert.ok(existsSync(path), 'the workspace file was written');
  assert.match(state.pendingToast ?? '', /saved workspace evening/);
  assert.equal(state.custom.active, 'evening');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(doc.name, 'evening');
  assert.equal(doc.start, 'watchlist');
  assert.equal(doc.theme, 'ember');
  assert.equal(doc.screener.filter, 'liq > 10K');
  // a fresh process reads it back and the switch restores the look
  const s2 = makeFixtureState();
  s2.custom = initCustom({ DEXTERM_HOME: home });
  assert.deepEqual(workspaceSlots(s2.custom), ['default', 'morning-hud', 'evening']);
  const r = switchWorkspace(s2, 'evening', []);
  assert.equal(r.ok, true);
  assert.equal(s2.screen, 'watchlist');
  assert.equal(s2.theme.name, 'ember');
  assert.equal(s2.screener.query, 'liq > 10K');
  // esc cancels the input without writing; a built-in name is refused
  keys(s2, CTRL_W + 's' + 'zzz' + '\x1b');
  assert.equal(s2.custom.nameInput, null);
  keys(s2, CTRL_W + 's' + 'default' + '\r');
  assert.match(s2.pendingToast ?? '', /built-in/);
});

test('a saved layout with pane trees changes the screener spotlight and the token chart share; default renders byte-identical to no config', () => {
  const home = tmp();
  mkdirSync(join(home, 'workspaces'), { recursive: true });
  const screens = builtinScreens();
  (screens.screener as { children: Array<{ fixed?: number }> }).children[1].fixed = 60;
  writeFileSync(join(home, 'workspaces', 'wide-spot.json'), JSON.stringify({ name: 'wide-spot', screens }));
  const state = makeFixtureState();
  const plain = renderFrame(state, 176, 45).toPlain();
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.equal(renderFrame(state, 176, 45).toPlain(), plain, 'the default workspace draws exactly the shipped layout (no badge, same numbers)');
  assert.equal(layoutFor(state.custom, 176, 45).spotlightW, 44);
  assert.equal(switchWorkspace(state, 'wide-spot', []).ok, true);
  assert.equal(layoutFor(state.custom, 176, 45).spotlightW, 60);
  assert.equal(layoutFor(state.custom, 120, 40).spotlightW, 0, 'the spotlight still collapses below wide');
  const frame = renderFrame(state, 176, 45).toPlain();
  assert.notEqual(frame, plain);
  assert.ok(frame.includes('⌗ wide-spot'), 'the badge names the active workspace');
  // the table box is now 176 - 60 - 1 = 115 wide: its right border sits at column 114 on the SCREENER title row
  const title = frame.split('\n').find((l) => l.includes('SCREENER'))!;
  assert.equal(title.indexOf('SCREENER') < 20, true);
  assert.ok(/[┐╮]/.test(title[114]), `expected the table's right border at column 114, got ${JSON.stringify(title.slice(110, 120))}`);
});

test('planPopupOpens: already-open windows are left alone, chart/bubbles need a token, unbound kinds are reported', () => {
  const specs = [{ kind: 'narrative' as const }, { kind: 'plans' as const }, { kind: 'chart' as const, mint: 'selected' }, { kind: 'feeds' as const }, { kind: 'roster' as const }, { kind: 'narrative' as const }];
  const a = planPopupOpens(specs, { chartOpen: false, bubblesOpen: false, narrativeOpen: true, plansOpen: false, feedsOpen: true, hasToken: false });
  assert.deepEqual(a.open, ['plans']);
  assert.deepEqual(a.skipped, [{ kind: 'chart', why: 'no token open' }, { kind: 'roster', why: 'not wired to workspaces yet' }]);
  const b = planPopupOpens(specs, { chartOpen: false, bubblesOpen: false, narrativeOpen: false, plansOpen: false, hasToken: true });
  assert.deepEqual(b.open, ['narrative', 'plans', 'chart', 'feeds']);
});

test('--workspace: a one-shot frame applies the workspace; an unknown name is a clean exit 2, never a silent default', async () => {
  const home = tmp();
  assert.equal(parseArgs(['--workspace', 'morning-hud']).workspace, 'morning-hud');
  assert.throws(() => parseArgs(['--workspace', '../x']), /--workspace expects a name/);
  const bad = fakeIo({ DEXTERM_HOME: home, DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--plain', '--workspace', 'nope'], bad.io), 2);
  assert.match(bad.err(), /no workspace "nope"/);
  const ok = fakeIo({ DEXTERM_HOME: home, DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--plain', '--width', '176', '--height', '45', '--workspace', 'morning-hud'], ok.io), 0);
  assert.ok(ok.out().includes('⌗ morning-hud'), 'the frame carries the workspace badge');
  assert.ok(/NARRATIVE/.test(ok.out()), 'the morning HUD starts on the narrative board');
  // no config file was created by reading
  assert.ok(!existsSync(join(home, 'config.json')));
});

test('trenchscope workspace list | init | show | remove', async () => {
  const home = tmp();
  const env = { DEXTERM_HOME: home };
  let io = fakeIo(env);
  assert.equal(await workspaceCommand(['list'], io.io), 0);
  assert.match(io.out(), /default\s+built-in/);
  assert.match(io.out(), /morning-hud\s+built-in.*4 popup\(s\): narrative, feeds, plans, chart/);
  io = fakeIo(env);
  assert.equal(await workspaceCommand(['init'], io.io), 0);
  assert.match(io.out(), /wrote .*workspaces[\\/]default\.json/);
  assert.equal(listWorkspaces(home).find((w) => w.name === 'default')?.builtin, false);
  io = fakeIo(env);
  assert.equal(await workspaceCommand(['show', 'default'], io.io), 0);
  assert.ok(JSON.parse(io.out()).screens.screener, 'init wrote the editable trees');
  io = fakeIo(env);
  assert.equal(await workspaceCommand(['remove', 'morning-hud'], io.io), 1);
  assert.match(io.err(), /built in/);
  io = fakeIo(env);
  assert.equal(await workspaceCommand(['remove', 'default'], io.io), 0);
  assert.equal(listWorkspaces(home).find((w) => w.name === 'default')?.builtin, true, 'removing the file brings the built-in back');
  io = fakeIo(env);
  assert.equal(await workspaceCommand(['bogus'], io.io), 2);
  assert.match(io.err(), /unknown subcommand/);
});

test('voice: "show me everything" is the morning HUD; a trade in the same breath is never a workspace switch', () => {
  const prov = { pttActive: true, speakerCount: 1, echoFlagged: false, sttConfidence: 0.9, lowConfTokens: [] as string[] };
  const d = route('yo jarvis the trenches are hot, show me everything', prov, { screen: 'screener', visibleSymbols: ['WIF'] });
  assert.equal(d.kind, 'workspace');
  assert.equal((d as { name: string }).name, 'morning-hud');
  assert.ok(isSafe(d));
  const w = route('switch to the evening workspace', prov, {});
  assert.deepEqual(w, { kind: 'workspace', name: 'evening', say: 'evening workspace' });
  const def = route('back to the default workspace', prov, {});
  assert.equal((def as { name: string }).name, 'default');
  const t = route('show me everything and buy wif', prov, { visibleSymbols: ['WIF'] });
  assert.notEqual(t.kind, 'workspace');
  assert.notEqual(t.kind, 'open-ticket');
});
