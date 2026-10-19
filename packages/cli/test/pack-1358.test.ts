// task-1358 Tier 4 — packs in the app: `trenchscope pack` end to end (verify → add needs the risk card → list → the
// installed pack's workspace / theme / rules reach initCustom and the rules engine → toggling a pack rule makes the
// user's copy → keymap shown, merged only on --merge, reserved keys refused → widget consent → export → sign →
// trust → signed install loads rules enabled → remove), and a malicious pack through the CLI leaves nothing behind.
// Fixtures only; no network; DEXTERM_HOME is a temp dir throughout; the signing key is ephemeral (never a real one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseKeys, type ScreenKey } from '@dexterm/tui';
import { loadConfig, readJournal, writeLock, saveConfig, defaultConfig } from '@dexterm/custom';
import { applyKey, switchWorkspace } from '../src/main.ts';
import { makeFixtureState } from '../src/state.ts';
import { initCustom, workspaceSlots, themeByName } from '../src/custom.ts';
import { rulesUiOf, toggleSelectedRule } from '../src/rules.ts';
import { packCommand } from '../src/pack-cmd.ts';

const FIXTURE = realpathSync(fileURLToPath(new URL('../../custom/test/fixtures/packs/trenches/', import.meta.url)));
const tmp = (p = 'dexterm-pack-'): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
function copyPack(): string { const d = tmp(); cpSync(FIXTURE, d, { recursive: true }); writeLock(d); return d; }
function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = ''; let err = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } });
  return { io: { stdout, stderr, env }, out: () => out, err: () => err, reset: () => { out = ''; err = ''; } };
}
const CTRL_R = '\x12';

test('trenchscope pack: verify → add (risk card) → list → the app sees the pack workspace, theme and DISABLED rules → toggling copies a rule → keymap/widget consent → remove', async () => {
  const home = tmp('dexterm-home-');
  const pack = copyPack();
  const f = fakeIo({ DEXTERM_HOME: home });
  // verify: the card names integrity, trust, every contribution and what stays off
  assert.equal(await packCommand(['verify', pack], f.io), 0, f.err());
  assert.match(f.out(), /trenches@1\.0\.0 · publisher publisher@example/);
  assert.match(f.out(), /integrity {2}ok sha256:/);
  assert.match(f.out(), /trust {6}UNSIGNED/);
  assert.match(f.out(), /rule {7}trenches-surge-clean: when .* \(loads DISABLED\)/);
  assert.match(f.out(), /keymap {5}keymap\.json \(NOT merged/);
  assert.match(f.out(), /widget {5}trenches\/tips: tips "JITO TIPS" topics rows,theme {2}\(installed DISABLED, no capabilities\)/);
  assert.match(f.out(), /needs --accept-unsigned/);
  // add without accepting the risk card: refused, nothing written
  f.reset();
  assert.equal(await packCommand(['add', pack], f.io), 1);
  assert.match(f.err(), /not reviewed or signed — do you trust its source\? re-run with --accept-unsigned/);
  assert.ok(!existsSync(join(home, 'config.json')), 'no config written');
  assert.ok(!existsSync(join(home, 'packs')), 'nothing copied');
  // accept → installed, journaled (actor user), widget disabled with no capabilities, keymap not merged
  f.reset();
  assert.equal(await packCommand(['add', pack, '--accept-unsigned'], f.io), 0, f.err());
  assert.match(f.out(), /installed trenches@1\.0\.0 → .*packs[\\/]trenches@1\.0\.0 \(unsigned\)/);
  assert.match(f.out(), /widget trenches\/tips is DISABLED: read widgets\/tips\/tips\.html then "trenchscope pack widget trenches tips --enable"/);
  const cfg1 = loadConfig(home);
  assert.equal(cfg1.ok, true, cfg1.errors.join('; '));
  assert.deepEqual(cfg1.config.packs!.map((p) => [p.name, p.version, p.trust]), [['trenches', '1.0.0', 'unsigned']]);
  assert.deepEqual(cfg1.config.plugins, { 'trenches/tips': { enabled: false, capabilities: [], settings: {} } });
  assert.deepEqual(cfg1.config.keymap, defaultConfig().keymap);
  assert.deepEqual(cfg1.config.rules ?? [], [], 'pack rules are not copied into config.rules on install');
  const j1 = readJournal(home);
  assert.equal(j1.length, 1); assert.equal(j1[0].actor, 'user'); assert.match(j1[0].why, /pack add trenches@1\.0\.0 \(unsigned\)/);
  // list
  f.reset();
  assert.equal(await packCommand(['list'], f.io), 0);
  assert.match(f.out(), /1 pack\(s\) installed/);
  assert.match(f.out(), /trenches@1\.0\.0 {2}unsigned/);
  assert.match(f.out(), /workspaces trenches\/trenches/);
  assert.match(f.out(), /themes {5}trenches-gold/);
  assert.match(f.out(), /rules {6}trenches-surge-clean \(off\), trenches-holder-velocity \(off\), trenches-exit-warning \(off\)/);
  assert.match(f.out(), /widget {5}trenches\/tips {2}disabled/);
  assert.match(f.out(), /keymap {5}not merged/);
  // the app: initCustom carries the pack's workspace + theme; the rules engine has its rules, all disabled
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.deepEqual(state.custom.configErrors, [], state.custom.configErrors.join('; '));
  assert.deepEqual(workspaceSlots(state.custom), ['default', 'morning-hud', 'trenches/trenches']);
  assert.equal(state.custom.workspaces.find((w) => w.name === 'trenches/trenches')?.pack, 'trenches');
  const gold = themeByName(state.custom, 'trenches-gold');
  assert.ok(gold, state.custom.themeErrors.join('; '));
  assert.equal(gold!.accent, '#ffb02e');
  const ui = rulesUiOf(state);
  assert.deepEqual(ui.engine.rules.map((r) => [r.id, r.source, r.enabled]), [['trenches-surge-clean', 'pack:trenches', false], ['trenches-holder-velocity', 'pack:trenches', false], ['trenches-exit-warning', 'pack:trenches', false]]);
  assert.deepEqual(ui.errors, []);
  // switching to the pack workspace works like any other (theme + preset + popups queued); nothing arms
  const stack: ScreenKey[] = [];
  const sw = switchWorkspace(state, 'trenches/trenches', stack);
  assert.equal(sw.ok, true, sw.ok ? '' : sw.reason);
  assert.equal(state.theme.name, 'trenches-gold');
  assert.equal(state.custom.active, 'trenches/trenches');
  assert.equal(state.custom.pendingPopups?.length, 3);
  assert.ok(!state.plansSvc);
  // toggling a pack rule on the Rules screen makes the USER's copy in config.rules (the pack file is untouched)
  for (const k of parseKeys(CTRL_R)) applyKey(state, k, stack);
  ui.selected = 0;
  const notice = toggleSelectedRule(state);
  assert.match(notice, /rule trenches-surge-clean enabled \(your copy of the pack rule/);
  const cfg2 = loadConfig(home);
  assert.deepEqual(cfg2.config.rules!.map((r) => [r.id, r.enabled, r.source]), [['trenches-surge-clean', true, 'pack:trenches']]);
  assert.equal(readFileSync(join(home, 'packs', 'trenches@1.0.0', 'rules', 'trenches.rules'), 'utf8'), readFileSync(join(FIXTURE, 'rules', 'trenches.rules'), 'utf8'));
  // a fresh init: the user's copy shadows the pack's (enabled), the other two stay off
  const s2 = makeFixtureState();
  s2.custom = initCustom({ DEXTERM_HOME: home });
  assert.deepEqual(rulesUiOf(s2).engine.rules.map((r) => [r.id, r.enabled]), [['trenches-surge-clean', true], ['trenches-holder-velocity', false], ['trenches-exit-warning', false]]);
  // keymap: shown, not merged; --merge validates the merged result and journals it
  f.reset();
  assert.equal(await packCommand(['keymap', 'trenches'], f.io), 0, f.err());
  assert.match(f.out(), /NOT merged/);
  assert.match(f.out(), /global +screen\.watchlist +3 \/ W/);
  assert.match(f.out(), /screener +preset\.next +\] \/ l/);
  assert.match(f.out(), /would merge cleanly/);
  assert.deepEqual(loadConfig(home).config.keymap, defaultConfig().keymap);
  f.reset();
  assert.equal(await packCommand(['keymap', 'trenches', '--merge'], f.io), 0, f.err());
  assert.match(f.out(), /merged 3 binding\(s\)/);
  const km = loadConfig(home).config.keymap!;
  assert.deepEqual(km.global!['screen.watchlist'], ['3', 'W']);
  assert.deepEqual(km.screens!.screener['preset.next'], [']', 'l']);
  const s3 = makeFixtureState(); s3.custom = initCustom({ DEXTERM_HOME: home });
  assert.deepEqual(s3.custom.configErrors, []);
  assert.equal(s3.custom.keymap.resolveId('W', 'screener'), 'screen.watchlist');
  // widget consent: --enable names the page + topics, flips only the enabled flag, never adds a capability
  f.reset();
  assert.equal(await packCommand(['widget', 'trenches', 'tips', '--enable'], f.io), 0, f.err());
  assert.match(f.out(), /enabling trenches\/tips: the popup host will serve .*widgets[\\/]tips[\\/]tips\.html .*hash-only CSP: only the inline script\/style you just read runs — no remote script, style, frame or import, no fetch, no eval; topics rows, theme/);
  assert.deepEqual(loadConfig(home).config.plugins!['trenches/tips'], { enabled: true, capabilities: [], settings: {} });
  f.reset();
  assert.equal(await packCommand(['widget', 'trenches', 'tips', '--disable'], f.io), 0);
  assert.equal(loadConfig(home).config.plugins!['trenches/tips'].enabled, false);
  assert.equal(await packCommand(['widget', 'trenches', 'nope', '--enable'], f.io), 1);
  // tamper with the installed copy: the pack is skipped on load (reported), and a widget cannot be enabled
  const installedRules = join(home, 'packs', 'trenches@1.0.0', 'rules', 'trenches.rules');
  const original = readFileSync(installedRules, 'utf8');
  writeFileSync(installedRules, 'when liq > 0 then alert(up, "x")\n');
  const s4 = makeFixtureState(); s4.custom = initCustom({ DEXTERM_HOME: home });
  assert.ok(s4.custom.configErrors.some((e) => /pack trenches: files changed since install/.test(e)), s4.custom.configErrors.join('; '));
  assert.deepEqual(workspaceSlots(s4.custom), ['default', 'morning-hud']);
  f.reset();
  assert.equal(await packCommand(['widget', 'trenches', 'tips', '--enable'], f.io), 1);
  assert.match(f.err(), /changed since install/);
  writeFileSync(installedRules, original);
  // remove: directory + record + widget registration gone; the user's rule copy and merged keys stay (they are the user's now)
  f.reset();
  assert.equal(await packCommand(['remove', 'trenches'], f.io), 0, f.err());
  assert.ok(!existsSync(join(home, 'packs', 'trenches@1.0.0')));
  const cfg3 = loadConfig(home);
  assert.deepEqual(cfg3.config.packs, []); assert.deepEqual(cfg3.config.plugins, {});
  assert.equal(cfg3.config.rules!.length, 1);
  assert.equal(await packCommand(['remove', 'trenches'], f.io), 1);
  // unknown subcommand / usage
  assert.equal(await packCommand(['bogus'], f.io), 2);
});

test('trenchscope pack: export your own files → verify → sign with an ephemeral key → trust → a SIGNED install loads its rules enabled', async () => {
  const home = tmp('dexterm-home-');
  const f = fakeIo({ DEXTERM_HOME: home, USER: 'anon-test' });
  // the user's own things: a theme file, a workspace file, two rules, a keymap override
  saveConfig(home, { ...defaultConfig(), rules: [{ id: 'surge', name: 'surge', when: 'vol5m.velocity > 3 and liq > 25K', then: [{ action: 'alert', args: { level: 'up', text: 'surge' } }], cooldown: '15m', maxPerHour: 6, source: 'user' }, { id: 'jarvis-one', when: 'liq > 1', then: [{ action: 'watch' }], source: 'jarvis' }], keymap: { global: { 'screen.watchlist': ['3', 'W'] }, screens: {} } });
  const { writeWorkspace } = await import('@dexterm/custom');
  writeWorkspace(home, { name: 'hud', start: 'narrative', popups: [{ kind: 'narrative' }] });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(home, 'themes'), { recursive: true });
  writeFileSync(join(home, 'themes', 'amber.json'), JSON.stringify({ extends: 'cyberspace', tokens: { accent: '#ffb02e' } }));
  const out = join(tmp('dexterm-export-'), 'mypack');
  assert.equal(await packCommand(['export', out, '--name', 'mypack', '--description', 'my trench setup', '--workspace', 'hud', '--theme', 'amber', '--rules', '--keymap'], f.io), 0, f.err());
  assert.match(f.out(), /wrote .*mypack · 5 file\(s\) · sha256:/, 'manifest + keymap + rules + theme + workspace (the lock is not counted)');
  assert.deepEqual(readdirSync(out).sort(), ['keymap.json', 'pack.json', 'pack.lock', 'rules', 'themes', 'workspaces']);
  const rulesText = readFileSync(join(out, 'rules', 'rules.rules'), 'utf8');
  assert.match(rulesText, /name "surge"/);
  assert.ok(!rulesText.includes('jarvis-one'), 'only the user\'s own rules are exported');
  assert.equal(JSON.parse(readFileSync(join(out, 'pack.json'), 'utf8')).publisher, 'anon-test');
  f.reset();
  assert.equal(await packCommand(['verify', out], f.io), 0, f.err());
  assert.match(f.out(), /trust {6}UNSIGNED/);
  // missing args
  assert.equal(await packCommand(['export', join(tmp('dexterm-export-'), 'x')], f.io), 2);
  assert.equal(await packCommand(['export', join(tmp('dexterm-export-'), 'x'), '--name', 'x', '--workspace', 'nope'], f.io), 1);
  // sign with an ephemeral ed25519 key; trust pins the public key; the signed pack installs as SIGNED
  const kd = tmp('dexterm-key-');
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', join(kd, 'id')], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  f.reset();
  assert.equal(await packCommand(['sign', out, '--key', join(kd, 'id')], f.io), 0, f.err());
  assert.ok(existsSync(join(out, 'pack.lock.sig')));
  assert.equal(await packCommand(['sign', out, '--key', join(kd, 'missing')], f.io), 1);
  f.reset();
  assert.equal(await packCommand(['signers'], f.io), 0);
  assert.match(f.out(), /no pinned publisher keys/);
  assert.equal(await packCommand(['trust', 'anon-test', readFileSync(join(kd, 'id.pub'), 'utf8')], f.io), 0, f.err());
  f.reset();
  assert.equal(await packCommand(['signers'], f.io), 0);
  assert.match(f.out(), /anon-test {20,}ssh-ed25519 /);
  assert.equal(await packCommand(['trust', 'bad identity!', 'x'], f.io), 1);
  // a second home installs the signed pack without the risk card; its rules load ENABLED
  const home2 = tmp('dexterm-home-');
  const g = fakeIo({ DEXTERM_HOME: home2 });
  assert.equal(await packCommand(['trust', 'anon-test', readFileSync(join(kd, 'id.pub'), 'utf8')], g.io), 0);
  assert.equal(await packCommand(['add', out], g.io), 0, g.err());
  assert.match(g.out(), /signature {2}ok \(identity anon-test\)/);
  assert.match(g.out(), /installed mypack@1\.0\.0 .*\(signed\)/);
  const s = makeFixtureState(); s.custom = initCustom({ DEXTERM_HOME: home2 });
  assert.deepEqual(rulesUiOf(s).engine.rules.map((x) => [x.id, x.enabled, x.source]), [['mypack-surge', true, 'pack:mypack']]);
  assert.deepEqual(workspaceSlots(s.custom), ['default', 'morning-hud', 'mypack/hud']);
  assert.ok(themeByName(s.custom, 'mypack-amber'));
  // a tampered signed pack: integrity fails first, the signature is never consulted, nothing installs
  const home3 = tmp('dexterm-home-');
  const h = fakeIo({ DEXTERM_HOME: home3 });
  assert.equal(await packCommand(['trust', 'anon-test', readFileSync(join(kd, 'id.pub'), 'utf8')], h.io), 0);
  writeFileSync(join(out, 'rules', 'rules.rules'), 'when liq > 0 then alert(up, "x") name "surge"\n');
  assert.equal(await packCommand(['add', out], h.io), 1);
  assert.match(h.err(), /integrity: files differ from pack\.lock \(rules\/rules\.rules\)/);
  assert.ok(!existsSync(join(home3, 'packs')));
});

test('MALICIOUS PACK through the CLI: a rule that arms, a widget that asks for capabilities, a symlink out of the pack — refused; nothing lands in config or on disk', async () => {
  const home = tmp('dexterm-home-');
  const f = fakeIo({ DEXTERM_HOME: home });
  const evil = copyPack();
  writeFileSync(join(evil, 'rules', 'trenches.rules'), 'when liq > 0 then ticket(buy, 1, sol, arm=true) name "evil"\n');
  writeLock(evil);
  assert.equal(await packCommand(['verify', evil], f.io), 1);
  assert.match(f.out(), /rule {7}✗ rules\/trenches\.rules:1 ticket cannot carry "arm"/);
  assert.match(f.out(), /1 item\(s\) refused; this pack would not install/);
  f.reset();
  assert.equal(await packCommand(['add', evil, '--accept-unsigned'], f.io), 1);
  assert.match(f.err(), /install: pack content refused: rules\/trenches\.rules:1 refused: ticket cannot carry "arm"/);
  assert.ok(!existsSync(join(home, 'config.json')) && !existsSync(join(home, 'packs')));
  const caps = copyPack();
  const w = JSON.parse(readFileSync(join(caps, 'widgets', 'tips', 'widget.json'), 'utf8')) as Record<string, unknown>;
  w.capabilities = ['signer.sign']; w.enabled = true;
  writeFileSync(join(caps, 'widgets', 'tips', 'widget.json'), JSON.stringify(w));
  writeLock(caps);
  f.reset();
  assert.equal(await packCommand(['add', caps, '--accept-unsigned'], f.io), 1);
  assert.match(f.err(), /widget tips refused: .*unknown key/);
  const link = copyPack();
  const { symlinkSync } = await import('node:fs');
  symlinkSync(home, join(link, 'themes', 'hosts.json'), process.platform === 'win32' ? 'junction' : 'dir');
  f.reset();
  assert.equal(await packCommand(['verify', link], f.io), 1);
  assert.match(f.out(), /integrity {2}✗ .*hosts\.json is a symlink/);
  assert.equal(await packCommand(['add', link, '--accept-unsigned'], f.io), 1);
  assert.ok(!existsSync(join(home, 'config.json')) && !existsSync(join(home, 'packs')));
  assert.equal(readJournal(home).length, 0);
});
