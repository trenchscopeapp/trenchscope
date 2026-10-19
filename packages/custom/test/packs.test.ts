// task-1358 Tier 4 — PACKS (ported from the task-1288 prototype) + the MALICIOUS-PACK suite: a pack can never run
// code without explicit consent (widgets land disabled with zero capabilities), never escape its directory
// (`..`, absolute paths, symlinks, hidden files, node_modules), never pollute prototypes (`__proto__`), never
// rebind reserved keys by itself (keymaps are shown, merged only on an explicit command), never carry a
// money-shaped rule (refused at install), and never trust itself (unsigned → rules disabled, hash pinned).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, realpathSync, existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  listPackFiles, computeLock, writeLock, checkIntegrity, readManifest, signPack, verifySignature, trustOf, pinSigner, inspectPack, installPack, removePack, loadPacks, setWidgetEnabled, exportPack, scanForSecrets, PackError, PACK_LIMITS, allowedSignersPath,
} from '../src/packs.ts';
import { defaultConfig, validateConfig, saveConfig, loadConfig, applyKeymapConfig, type DextermConfig } from '../src/index.ts';

const SRC = fileURLToPath(new URL('./fixtures/packs/trenches/', import.meta.url));
const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
function copyPack(): string { const d = tmp('dexterm-pack-'); cpSync(SRC, d, { recursive: true }); return d; }
/** Ephemeral signing key for the test only (never a real one). */
function keypair(identity = 'publisher@example') {
  const d = tmp('dexterm-key-');
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test-publisher', '-f', join(d, 'id')], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  const pub = readFileSync(join(d, 'id.pub'), 'utf8').trim();
  return { key: join(d, 'id'), pub, identity };
}
const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
const writeJson = (p: string, v: unknown): void => writeFileSync(p, JSON.stringify(v, null, 2));

test('manifest validates and every referenced file exists; traversal, absolute paths and api > 1 are refused', () => {
  const m = readManifest(SRC);
  assert.equal(m.name, 'trenches');
  assert.deepEqual(m.contents.widgets, ['widgets/tips']);
  const d = copyPack();
  const base = readJson(join(d, 'pack.json'));
  for (const bad of ['../../../etc/passwd.json', 'workspaces/../../x.json', '/etc/passwd.json', 'workspaces/missing.json']) {
    writeJson(join(d, 'pack.json'), { ...base, contents: { ...(base.contents as object), workspaces: [bad] } });
    assert.throws(() => readManifest(d), /pack\.json (invalid|references)/, bad);
  }
  writeJson(join(d, 'pack.json'), { ...base, requires: { api: 2 } });
  assert.throws(() => readManifest(d), /api 2/);
  writeJson(join(d, 'pack.json'), { ...base, name: '$(rm -rf ~)' });
  assert.throws(() => readManifest(d), /\/name/);
  writeJson(join(d, 'pack.json'), { ...base, keys: { helius: 'x' } });
  assert.throws(() => readManifest(d), /unknown key/);
  writeFileSync(join(d, 'pack.json'), '{"name":"trenches","version":"1.0.0","publisher":"x","__proto__":{"polluted":true},"contents":{}}');
  assert.throws(() => readManifest(d), /forbidden key/);
});

test('lock: deterministic hash, tamper detection (changed + missing + added); symlinks, hidden files, node_modules and size caps are REFUSED (not skipped)', () => {
  const d = copyPack();
  const lock = writeLock(d);
  assert.equal(lock.hash, computeLock(d).hash);
  assert.ok(lock.files.some((f) => f.path === 'widgets/tips/tips.html'));
  assert.ok(!lock.files.some((f) => f.path === 'pack.lock'));
  assert.equal(checkIntegrity(d).ok, true);
  writeFileSync(join(d, 'rules', 'trenches.rules'), 'when liq > 0 then ticket(buy, 50)\n');
  const t = checkIntegrity(d);
  assert.equal(t.ok, false); assert.deepEqual(!t.ok && t.changed, ['rules/trenches.rules']);
  rmSync(join(d, 'keymap.json'));
  writeFileSync(join(d, 'extra.json'), '{}');
  const t2 = checkIntegrity(d);
  assert.ok(!t2.ok && t2.missing?.includes('keymap.json') && t2.added?.includes('extra.json'));
  // a symlink anywhere in the pack is a refusal (it would be followed after install)
  const s = copyPack();
  // A directory junction is an actual symlink on Windows without requiring Developer Mode.
  symlinkSync(d, join(s, 'themes', 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => listPackFiles(s), /symlink/);
  assert.equal(checkIntegrity(s).ok, false);
  const h = copyPack();
  writeFileSync(join(h, '.env'), 'HELIUS=x');
  assert.throws(() => listPackFiles(h), /hidden entry/);
  const n = copyPack();
  mkdirSync(join(n, 'node_modules', 'evil'), { recursive: true }); writeFileSync(join(n, 'node_modules', 'evil', 'index.js'), 'x');
  assert.throws(() => listPackFiles(n), /no dependencies/);
  const big = copyPack();
  writeFileSync(join(big, 'big.json'), 'x'.repeat(PACK_LIMITS.maxFileBytes + 1));
  assert.throws(() => listPackFiles(big), /max 512000/);
  const many = copyPack();
  mkdirSync(join(many, 'many'));
  for (let i = 0; i < PACK_LIMITS.maxFiles; i++) writeFileSync(join(many, 'many', `f${i}.json`), '{}');
  assert.throws(() => listPackFiles(many), /more than 200 files/);
  const weird = copyPack();
  writeFileSync(join(weird, 'themes', 'Évil.json'), '{}');
  assert.throws(() => listPackFiles(weird), /file name/);
});

test('sign + verify with ssh-keygen -Y: pinned publisher verifies; wrong identity / other key fail; tamper after signing fails; re-lock breaks the signature', () => {
  const d = copyPack();
  const home = tmp('dexterm-home-');
  const k = keypair();
  pinSigner(home, k.identity, k.pub);
  assert.ok(readFileSync(allowedSignersPath(home), 'utf8').includes(`${k.identity} namespaces="dexterm-pack" ssh-ed25519 `));
  assert.throws(() => pinSigner(home, 'bad identity!', k.pub), /identity/);
  assert.throws(() => pinSigner(home, 'x@example', 'not a key'), /pubkey/);
  signPack(d, { keyFile: k.key });
  assert.ok(existsSync(join(d, 'pack.lock.sig')));
  assert.equal(verifySignature(d, { allowedSigners: allowedSignersPath(home), identity: k.identity }).ok, true);
  assert.equal(verifySignature(d, { allowedSigners: allowedSignersPath(home), identity: 'someone-else@example' }).ok, false);
  const other = keypair('other@example');
  const home2 = tmp('dexterm-home-'); pinSigner(home2, other.identity, other.pub);
  assert.equal(verifySignature(d, { allowedSigners: allowedSignersPath(home2), identity: other.identity }).ok, false, 'another publisher key does not verify');
  writeFileSync(join(d, 'keymap.json'), JSON.stringify({ global: { 'alert.confirm': ['enter'] } }));
  assert.equal(checkIntegrity(d).ok, false, 'integrity catches the tamper before the signature is consulted');
  writeLock(d);
  assert.equal(checkIntegrity(d).ok, true);
  assert.equal(verifySignature(d, { allowedSigners: allowedSignersPath(home), identity: k.identity }).ok, false, 'signature no longer matches the re-locked pack');
  assert.equal(verifySignature(copyPack(), { allowedSigners: allowedSignersPath(home), identity: k.identity }).ok, false, 'unsigned');
});

test('trust tiers + install + load: unsigned needs acceptance and loads its rules DISABLED; signed loads them enabled; widgets register disabled with no capabilities; keymap is never merged; rogue dirs ignored; tamper after install skips the pack; remove cleans up', () => {
  const d = copyPack();
  const home = tmp('dexterm-home-');
  const k = keypair();
  pinSigner(home, k.identity, k.pub);
  writeLock(d);
  let cfg: DextermConfig = defaultConfig();
  // unsigned, not accepted → refused; accepted → trust unsigned
  assert.throws(() => installPack(home, d, cfg), (e: Error) => e instanceof PackError && e.code === 'trust');
  const u = installPack(home, d, cfg, { acceptUnsigned: true, now: 1 });
  assert.equal(u.trust, 'unsigned');
  assert.deepEqual(validateConfig(u.config), []);
  assert.deepEqual(u.config.plugins, { 'trenches/tips': { enabled: false, capabilities: [], settings: {} } }, 'widget registered disabled with no capabilities');
  assert.deepEqual(u.config.keymap, defaultConfig().keymap, 'the pack keymap is NOT merged on install');
  assert.ok(existsSync(join(home, 'packs', 'trenches@1.0.0', 'pack.json')));
  assert.ok(!existsSync(join(home, 'packs', 'trenches@1.0.0', 'pack.lock.sig')));
  const lu = loadPacks(home, u.config);
  assert.deepEqual(lu.errors, []);
  assert.deepEqual(lu.rules.map((r) => [r.id, r.source, r.enabled]), [['trenches-surge-clean', 'pack:trenches', false], ['trenches-holder-velocity', 'pack:trenches', false], ['trenches-exit-warning', 'pack:trenches', false]]);
  assert.deepEqual(lu.workspaces.map((w) => w.name), ['trenches/trenches']);
  assert.equal(lu.workspaces[0].workspace.name, 'trenches/trenches');
  assert.deepEqual(lu.themes.map((t) => t.name), ['trenches-gold']);
  assert.equal(lu.keymaps.length, 1);
  assert.deepEqual(lu.widgets.map((w) => [w.name, w.enabled]), [['tips', false]]);
  // already installed → refused; remove → directory + record + widget registration gone
  assert.throws(() => installPack(home, d, u.config, { acceptUnsigned: true }), /already installed/);
  const rm = removePack(home, u.config, 'trenches');
  assert.ok(rm.removed && !existsSync(rm.removed));
  assert.deepEqual(rm.config.packs, []); assert.deepEqual(rm.config.plugins, {});
  // signed by a pinned publisher → rules enabled on load
  signPack(d, { keyFile: k.key });
  const s = installPack(home, d, rm.config, { now: 2 });
  assert.equal(s.trust, 'signed');
  assert.equal(s.config.packs![0].hash, s.hash);
  assert.ok(existsSync(join(home, 'packs', 'trenches@1.0.0', 'pack.lock.sig')));
  cfg = s.config;
  saveConfig(home, cfg);
  const re = loadConfig(home);
  assert.equal(re.ok, true, re.errors.join('; '));
  const ls = loadPacks(home, re.config);
  assert.ok(ls.rules.every((r) => r.enabled === true));
  // reviewed beats signed; the same hash in the user's reviewed list
  assert.equal(trustOf({ hash: s.hash, signatureOk: true, reviewedHashes: [s.hash] }), 'reviewed');
  assert.equal(trustOf({ hash: s.hash, signatureOk: false, reviewedHashes: [] }), 'unsigned');
  writeFileSync(join(home, 'reviewed-packs.json'), JSON.stringify([s.hash]));
  assert.equal(inspectPack(d, { home }).trust, 'reviewed');
  // widget consent is a separate explicit flip; nothing else changes
  const on = setWidgetEnabled(cfg, 'trenches', 'tips', true);
  assert.equal(on.plugins!['trenches/tips'].enabled, true);
  assert.deepEqual(on.plugins!['trenches/tips'].capabilities, []);
  assert.equal(loadPacks(home, on).widgets[0].enabled, true);
  assert.throws(() => setWidgetEnabled(cfg, 'trenches', 'nope', true), /no widget/);
  // a directory dropped into packs/ without a record is not an install
  mkdirSync(join(home, 'packs', 'rogue@0.0.1'));
  writeJson(join(home, 'packs', 'rogue@0.0.1', 'pack.json'), { name: 'rogue', version: '0.0.1', publisher: 'x', contents: { rules: ['r.rules'] } });
  writeFileSync(join(home, 'packs', 'rogue@0.0.1', 'r.rules'), 'when liq > 0 then ticket(buy, 50)\n');
  const lr = loadPacks(home, cfg);
  assert.ok(!lr.rules.some((x) => x.source === 'pack:rogue'));
  assert.ok(lr.notes.some((n) => /rogue@0\.0\.1: not installed/.test(n)), lr.notes.join('; '));
  // tamper after install: the recorded hash no longer matches → the whole pack is skipped and reported
  writeFileSync(join(home, 'packs', 'trenches@1.0.0', 'rules', 'trenches.rules'), 'when liq > 0 then alert(up, "x")\n');
  const lt = loadPacks(home, cfg);
  assert.equal(lt.rules.length, 0); assert.equal(lt.workspaces.length, 0);
  assert.ok(lt.errors.some((e) => /trenches: files changed since install/.test(e)), lt.errors.join('; '));
});

test('MALICIOUS PACK: money-shaped or unknown rule actions, prototype keys in content, bad widget pages, reserved-key keymaps — refused at install or never merged; a pack never grants itself anything', () => {
  const home = tmp('dexterm-home-');
  const cfg = defaultConfig();
  const attempt = (mutate: (d: string) => void): { error: PackError | null; insp: ReturnType<typeof inspectPack> | null } => {
    const d = copyPack();
    mutate(d);
    try { writeLock(d); } catch (e) { return { error: e as PackError, insp: null }; }
    let insp: ReturnType<typeof inspectPack> | null = null;
    try { insp = inspectPack(d, { home }); } catch (e) { return { error: e as PackError, insp: null }; }
    try { installPack(home, d, cfg, { acceptUnsigned: true }); return { error: null, insp }; }
    catch (e) { return { error: e as PackError, insp }; }
  };
  // rules that try to arm / sign / oversize: the whole pack is refused (all-or-nothing), the reason names the line
  let r = attempt((d) => writeFileSync(join(d, 'rules', 'trenches.rules'), 'when liq > 0 then ticket(buy, 1, sol, arm=true) name "evil"\n'));
  assert.match(r.error?.message ?? '', /trenches\.rules:1 refused: ticket cannot carry "arm"/);
  r = attempt((d) => writeFileSync(join(d, 'rules', 'trenches.rules'), 'when liq > 0 then sign() name "evil"\n'));
  assert.match(r.error?.message ?? '', /unknown action "sign"/);
  r = attempt((d) => writeFileSync(join(d, 'rules', 'trenches.rules'), 'when liq > 0 then ticket(buy, 5000) name "evil"\n'));
  assert.match(r.error?.message ?? '', /≤ 50/);
  r = attempt((d) => writeFileSync(join(d, 'rules', 'trenches.rules'), 'when liq > 0 then alert("x") max 9999/h name "flood"\n'));
  assert.match(r.error?.message ?? '', /1\.\.120/);
  // JSON rules: a smuggled `autoArm` arg dies the same way
  r = attempt((d) => { writeJson(join(d, 'rules', 'evil.json'), [{ id: 'evil', when: 'liq > 0', then: [{ action: 'ticket', args: { side: 'buy', size: 1, unit: 'sol', autoArm: true } }] }]); const m = readJson(join(d, 'pack.json')); (m.contents as { rules: string[] }).rules = ['rules/evil.json']; writeJson(join(d, 'pack.json'), m); });
  assert.ok(r.error, 'install refused');
  // __proto__ inside a workspace / theme / rules json / widget manifest → refused by name
  for (const rel of ['workspaces/trenches.json', 'themes/gold.json', 'widgets/tips/widget.json']) {
    r = attempt((d) => writeFileSync(join(d, rel), readFileSync(join(d, rel), 'utf8').replace(/^\{/, '{"__proto__":{"x":1},')));
    assert.match(r.error?.message ?? '', /forbidden key/, rel);
  }
  // a widget whose page escapes the pack or is missing; a widget asking for api 2; a widget with a non-topic
  r = attempt((d) => { const w = readJson(join(d, 'widgets', 'tips', 'widget.json')); (w.widgets as Array<{ page: string }>)[0].page = '../../pack.json'; writeJson(join(d, 'widgets', 'tips', 'widget.json'), w); });
  assert.match(r.error?.message ?? '', /widget tips refused/);
  r = attempt((d) => { const w = readJson(join(d, 'widgets', 'tips', 'widget.json')); (w.widgets as Array<{ page: string }>)[0].page = 'gone.html'; writeJson(join(d, 'widgets', 'tips', 'widget.json'), w); });
  assert.match(r.error?.message ?? '', /page gone\.html is missing/);
  r = attempt((d) => { const w = readJson(join(d, 'widgets', 'tips', 'widget.json')); w.api = 2; writeJson(join(d, 'widgets', 'tips', 'widget.json'), w); });
  assert.match(r.error?.message ?? '', /\/api/);
  r = attempt((d) => { const w = readJson(join(d, 'widgets', 'tips', 'widget.json')); (w.widgets as Array<{ topics: string[] }>)[0].topics = ['signer']; writeJson(join(d, 'widgets', 'tips', 'widget.json'), w); });
  assert.match(r.error?.message ?? '', /topics/);
  // a widget manifest cannot ask for capabilities at all (no such field) and a pack cannot pre-enable itself
  r = attempt((d) => { const w = readJson(join(d, 'widgets', 'tips', 'widget.json')); w.capabilities = ['signer.sign']; w.enabled = true; writeJson(join(d, 'widgets', 'tips', 'widget.json'), w); });
  assert.match(r.error?.message ?? '', /unknown key/);
  // r2 REGRESSION — a widget PAGE that would load code or a document from elsewhere is refused at install, by name, before
  // anything lands: the __NONCE__ token (the host no longer substitutes it; a remote <script src> wearing it was the defect),
  // a remote script, a stylesheet link, @import, a frame, <meta http-equiv>. Nothing is written under packs/.
  const page = readFileSync(join(SRC, 'widgets', 'tips', 'tips.html'), 'utf8');
  const hostilePages: Array<[string, RegExp]> = [
    [page.replace('<script>', '<script nonce="__NONCE__" src="https://evil.example/x.js"></script><script>'), /__NONCE__.*<script src=…>|<script src=…>.*__NONCE__/s],
    [page.replace('<style>', '<style nonce="__NONCE__">'), /__NONCE__/],
    [page.replace('<script>', '<script src="https://evil.example/x.js"></script><script>'), /<script src=…> \(a script from elsewhere\) is refused/],
    [page.replace('</head>', '<link rel="stylesheet" href="https://evil.example/x.css"></head>'), /<link> is refused/],
    [page.replace('<style>', '<style>@import url(https://evil.example/x.css);'), /@import in a <style> block \(a stylesheet from elsewhere\) is refused/],
    [page.replace('<body>', '<body><iframe src="https://evil.example/"></iframe>'), /<iframe> is refused/],
    [page.replace('</head>', '<meta http-equiv="refresh" content="0;url=https://evil.example/"></head>'), /<meta http-equiv> is refused/],
    [page.replace('<body>', '<body><svg><script xlink:href="https://evil.example/x.js"/></svg>'), /<script xlink:href=…>/],
  ];
  for (const [html, re] of hostilePages) {
    r = attempt((d) => writeFileSync(join(d, 'widgets', 'tips', 'tips.html'), html));
    assert.ok(r.error instanceof PackError && r.error.code === 'install', `refused as an install problem: ${r.error?.message}`);
    assert.match(r.error.message, /pack content refused: widget tips refused: page tips\.html: /);
    assert.match(r.error.message, re);
    assert.ok(r.insp && r.insp.widgets[0].manifest === null && /page tips\.html/.test(r.insp.widgets[0].error ?? ''), 'inspect shows the refusal on the widget');
    assert.ok(!existsSync(join(home, 'packs', 'trenches@1.0.0')), 'nothing landed');
  }
  // the fixture page itself (plain <script>/<style>, no nonce) is fine, and a comment that merely mentions these is not read
  r = attempt((d) => writeFileSync(join(d, 'widgets', 'tips', 'tips.html'), `<!-- do not write nonce="__NONCE__", <script src=…>, <link> or @import -->${page}`));
  assert.equal(r.error, null, r.error?.message);
  rmSync(join(home, 'packs', 'trenches@1.0.0'), { recursive: true, force: true }); // that attempt installed; the keymap case below installs again
  // a keymap that rebinds confirm / quit / panic: the pack still inspects (it is only shown), install never merges it, and the explicit merge path refuses it
  const kd = copyPack();
  writeJson(join(kd, 'keymap.json'), { global: { 'alert.confirm': ['enter'], quit: ['x'], 'plans.panic': ['p'] } });
  writeLock(kd);
  const ki = installPack(home, kd, cfg, { acceptUnsigned: true });
  assert.deepEqual(ki.config.keymap, cfg.keymap);
  const packKeymap = loadPacks(home, ki.config).keymaps[0].keymap;
  const merged = applyKeymapConfig([{ keys: ['y'], action: 'alert.confirm' }, { keys: ['q'], action: 'quit' }, { keys: ['!'], action: 'plans.panic', screen: 'plans' }], packKeymap);
  assert.ok(merged.errors.length >= 3, 'every reserved rebinding is refused');
  assert.deepEqual(merged.bindings.map((b) => b.keys), [['y'], ['q'], ['!']], 'defaults untouched');
  removePack(home, ki.config, 'trenches');
  // the good pack installs; nothing in the resulting config is enabled, granted, armed or keyed
  const good = copyPack(); writeLock(good);
  const g = installPack(home, good, cfg, { acceptUnsigned: true });
  for (const [k, p] of Object.entries(g.config.plugins ?? {})) { assert.equal(p.enabled, false, k); assert.deepEqual(p.capabilities, [], k); }
  assert.equal(g.config.packs![0].trust, 'unsigned');
  const keys = (v: unknown, acc: string[] = []): string[] => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as object)) { acc.push(k); keys(x, acc); } return acc; };
  assert.ok(!keys(g.config).some((k) => /^(arm|armed|sign|keys|signer|mandates?|caps|gate)$/.test(k)), 'no money-shaped section or key anywhere in the config');
  assert.deepEqual(validateConfig(g.config), []);
});

test('r2 upgrade: installing a NEW version removes the previous version\'s directory (under packs/ only), drops its widget registrations and restarts consent; the same version is still "already installed"', () => {
  const home = tmp('dexterm-home-');
  const v1 = copyPack(); writeLock(v1);
  const i1 = installPack(home, v1, defaultConfig(), { acceptUnsigned: true, now: 1 });
  assert.equal(i1.replaced, null, 'a first install replaces nothing');
  const on = setWidgetEnabled(i1.config, 'trenches', 'tips', true);
  assert.equal(loadPacks(home, on).widgets[0].enabled, true);
  const old = join(home, 'packs', 'trenches@1.0.0');
  assert.ok(existsSync(old));
  // same version again → refused, nothing changes
  assert.throws(() => installPack(home, v1, on, { acceptUnsigned: true }), /already installed/);
  // a new version: the manifest bumps, the lock is rewritten (a different hash), the widget renamed to show stale keys go
  const v2 = copyPack();
  const m = readJson(join(v2, 'pack.json'));
  writeJson(join(v2, 'pack.json'), { ...m, version: '1.1.0' });
  writeLock(v2);
  const i2 = installPack(home, v2, on, { acceptUnsigned: true, now: 2 });
  assert.equal(i2.replaced, old, 'the previous directory is reported…');
  assert.ok(!existsSync(old), '…and gone');
  assert.ok(existsSync(join(home, 'packs', 'trenches@1.1.0', 'widgets', 'tips', 'tips.html')));
  assert.deepEqual(i2.config.packs!.map((p) => [p.name, p.version]), [['trenches', '1.1.0']], 'one record, the new version');
  assert.notEqual(i2.config.packs![0].hash, i1.config.packs![0].hash);
  assert.deepEqual(i2.config.plugins, { 'trenches/tips': { enabled: false, capabilities: [], settings: {} } }, 'consent starts over on an upgrade (the page may have changed)');
  const l2 = loadPacks(home, i2.config);
  assert.deepEqual(l2.errors, []);
  assert.deepEqual(l2.notes.filter((n) => /trenches@1\.0\.0/.test(n)), [], 'no rogue note about the old directory: it is gone');
  assert.deepEqual(l2.widgets.map((w) => [w.name, w.enabled]), [['tips', false]]);
  assert.deepEqual(validateConfig(i2.config), []);
  // a record whose directory was already removed by hand: the upgrade still installs, reports no replacement
  rmSync(join(home, 'packs', 'trenches@1.1.0'), { recursive: true, force: true });
  const v3 = copyPack(); writeJson(join(v3, 'pack.json'), { ...m, version: '1.2.0' }); writeLock(v3);
  const i3 = installPack(home, v3, i2.config, { acceptUnsigned: true, now: 3 });
  assert.equal(i3.replaced, null);
  assert.deepEqual(i3.config.packs!.map((p) => p.version), ['1.2.0']);
});

test('export: the user\'s own workspace/theme/rules/keymap → a pack with a lock that round-trips through inspect; secrets are refused', () => {
  const out = join(tmp('dexterm-export-'), 'mypack');
  const lock = exportPack(out, {
    name: 'mypack', publisher: 'me@example', description: 'my trench setup',
    workspaces: [{ name: 'hud', start: 'narrative', popups: [{ kind: 'narrative' }] }],
    themes: [{ name: 'amber', extends: 'cyberspace', tokens: { accent: '#ffb02e' } }],
    rules: [{ id: 'surge', name: 'surge', when: 'vol5m.velocity > 3 and liq > 25K', for: '2 ticks', then: [{ action: 'alert', args: { level: 'up', text: 'surge' } }, { action: 'popup', args: { kind: 'chart' } }], cooldown: '15m', maxPerHour: 6, scope: 'screener', window: '10m', source: 'user' }],
    keymap: { global: { 'screen.watchlist': ['3', 'W'] } },
  });
  assert.ok(lock.files.map((f) => f.path).includes('rules/rules.rules'));
  assert.equal(checkIntegrity(out).ok, true);
  const insp = inspectPack(out);
  assert.equal(insp.manifest.name, 'mypack');
  assert.equal(insp.rules[0].rules.length, 1);
  assert.equal(insp.rules[0].rules[0].id, 'mypack-surge');
  assert.equal(insp.rules[0].rules[0].when, 'vol5m.velocity > 3 and liq > 25K');
  assert.deepEqual(insp.rules[0].errors, []);
  assert.equal(insp.workspaces[0].workspace?.name, 'hud');
  assert.equal(insp.themes[0].doc?.tokens?.accent, '#ffb02e');
  assert.equal(insp.keymap?.keymap?.global?.['screen.watchlist']?.[1], 'W');
  assert.equal(insp.trust, 'unsigned');
  // secrets never leave: a key-looking string in any exported text refuses the whole export (nothing written)
  const out2 = join(tmp('dexterm-export-'), 'leak');
  const b58 = '5Hwz' + 'K'.repeat(80);
  assert.throws(() => exportPack(out2, { name: 'leak', publisher: 'me', rules: [{ id: 'k', when: 'liq > 0', then: [{ action: 'alert', args: { text: b58.slice(0, 118) } }] }] }), /refused to export .* base58/);
  assert.ok(!existsSync(join(out2, 'pack.json')));
  assert.match(scanForSecrets('token hlx-abcdefghij12') ?? '', /Helius/);
  assert.match(scanForSecrets('key: ' + '0123456789abcdef'.repeat(4) + ' end') ?? '', /hex/);
  assert.equal(scanForSecrets('sha256:' + '0123456789abcdef'.repeat(4)), null, 'a pack hash is not a secret');
  assert.equal(scanForSecrets('when liq > 25K then alert(up, "surge")'), null);
  assert.throws(() => exportPack(join(tmp('dexterm-export-'), 'x'), { name: 'Bad Name', publisher: 'me' }), /pack name/);
});
