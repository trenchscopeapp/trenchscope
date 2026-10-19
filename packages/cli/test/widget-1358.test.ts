// task-1358 Tier 5 — pack widgets in the app: the shipped example pack installs clean with its widget DISABLED; the
// page is served only after consent AND while the pack still hashes to its record; the view models are the public
// columns only (no money-shaped key anywhere); a workspace cannot consent for a widget; the controller opens a widget
// through the popup manager with the page, pushes only declared topics, and forgets it on close; saving a workspace
// records open widgets by ref; the popup topics and the custom schema's agree. Fixtures only; DEXTERM_HOME is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIDGET_TOPICS as POPUP_TOPICS, auditWidgetHtml as popupAudit, type PopupManager, type PopupManagerOptions, type WidgetTopic } from '@dexterm/popup';
import { WIDGET_TOPICS as SCHEMA_TOPICS, POPUP_KINDS, validateWorkspace, captureWorkspace, loadConfig, checkIntegrity, readManifest, auditWidgetHtml as customAudit, writeLock, saveConfig, defaultConfig, loadPacks } from '@dexterm/custom';
import { makeFixtureState } from '../src/state.ts';
import { initCustom, planPopupOpens } from '../src/custom.ts';
import { packCommand } from '../src/pack-cmd.ts';
import { installedWidgets, widgetEnabled, widgetPage, widgetPayload, widgetRowsVM, widgetAlertsVM, widgetPositionsVM, payloadIsPublic, payloadKeys, syncWidgetPopups, parseWidgetRef, WIDGET_SYNC_MS } from '../src/widgets.ts';
import { TokenPopups } from '../src/popup.ts';
import { THEMES } from '@dexterm/tui';

const EXAMPLE = realpathSync(fileURLToPath(new URL('../../../packs/example-widgets/', import.meta.url)));
const tmp = (p = 'dexterm-widget-'): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = ''; let err = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } });
  return { io: { stdout, stderr, env }, out: () => out, err: () => err, reset: () => { out = ''; err = ''; } };
}
/** A fake popup manager: records opens and per-topic sends; never opens a window. */
function fakeManager() {
  const opens: Array<{ kind: string; title?: string; widget?: { key: string; topics: string[]; html: string } }> = [];
  const sends: Array<{ id: string; topic: string; payload: unknown }> = [];
  const closed: string[] = [];
  let n = 0;
  const create = (_opts: PopupManagerOptions): PopupManager => ({
    async open(req) {
      opens.push({ kind: req.kind, title: req.title, widget: req.widget });
      const id = `p_${++n}`;
      return { id, kind: req.kind, native: false, setData: () => {}, sendData: (topic, payload) => sends.push({ id, topic, payload }), close: () => closed.push(id), show: () => {}, hide: () => {}, focus: () => {}, alwaysOnTop: () => {} };
    },
    setData: () => {}, close: (id) => closed.push(id), native: false, reason: 'fake', hotkeyRegistered: false, port: 1, async shutdown() {},
  });
  return { create, opens, sends, closed };
}

test('the example pack: verifies clean, the topics agree across packages, the workspace schema accepts a widget popup and refuses a malformed ref', () => {
  assert.deepEqual([...POPUP_TOPICS], [...SCHEMA_TOPICS], '@dexterm/popup WIDGET_TOPICS and the custom schema enum must match');
  assert.ok((POPUP_KINDS as readonly string[]).includes('widget'));
  assert.equal(checkIntegrity(EXAMPLE).ok, true, 'packs/example-widgets ships a pack.lock that matches its files');
  const m = readManifest(EXAMPLE);
  assert.deepEqual(m.contents.widgets, ['widgets/movers']);
  const page = readFileSync(join(EXAMPLE, 'widgets', 'movers', 'movers.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  // r2: plain tags — there is no nonce on a widget page (the placeholder is now a refusal), and the example passes the audit
  assert.ok(!/\snonce=/.test(page) && !page.includes('__NONCE__'), 'no nonce attribute or placeholder in the example');
  assert.deepEqual(popupAudit(readFileSync(join(EXAMPLE, 'widgets', 'movers', 'movers.html'), 'utf8')), [], 'the shipped example passes the page audit');
  assert.ok(!/innerHTML|fetch\(|import\(|eval\(|\son(load|click|error|mouse[a-z]+|key[a-z]+)=/.test(page), 'the example uses none of what the CSP forbids');
  // the mirrored audit in @dexterm/custom is the same function: identical verdicts on the vectors, identical source below the imports
  const vectors = ['<p>hi</p>', '<script nonce="__NONCE__" src="https://evil.example/x.js"></script>', '<link rel=stylesheet href=x>', '<style>@import "x";</style>', '<iframe src=x></iframe>', '<meta http-equiv=refresh content=0>', '<svg><script href=x></script></svg>', '<!-- @import <link> __NONCE__ --><script>ok()</script>', '<script data-x="a>b" src=x></script>', Array.from({ length: 65 }, (_, i) => `<script>${i}</script>`).join('')];
  for (const v of vectors) assert.deepEqual(customAudit(v), popupAudit(v), v);
  const body = (p: string): string => { const t = readFileSync(p, 'utf8'); return t.slice(t.indexOf("import { createHash } from 'node:crypto';")); };
  assert.equal(body(fileURLToPath(new URL('../../custom/src/widget-html.ts', import.meta.url))), body(fileURLToPath(new URL('../../popup/src/widget-html.ts', import.meta.url))), 'custom/src/widget-html.ts mirrors popup/src/widget-html.ts from the import line down — edit the popup copy, then copy it over');
  assert.deepEqual(validateWorkspace({ name: 'w', popups: [{ kind: 'widget', widget: 'example-widgets/movers' }] }), []);
  assert.match(validateWorkspace({ name: 'w', popups: [{ kind: 'widget' }] })[0].msg, /needs "widget"/);
  assert.match(validateWorkspace({ name: 'w', popups: [{ kind: 'widget', widget: '../x' }] })[0].msg, /does not match/);
  assert.match(validateWorkspace({ name: 'w', popups: [{ kind: 'narrative', widget: 'a/b' }] })[0].msg, /only kind "widget"/);
  const ws = captureWorkspace('saved', { screen: 'screener', theme: 'cyberspace', intensity: 'fever', popups: ['narrative', 'widget'], widgets: ['example-widgets/movers/movers'] });
  assert.deepEqual(ws.popups, [{ kind: 'narrative' }, { kind: 'widget', widget: 'example-widgets/movers/movers' }]);
  assert.deepEqual(parseWidgetRef('example-widgets/movers/movers'), { key: 'example-widgets/movers', pack: 'example-widgets', name: 'movers', id: 'movers' });
  assert.equal(parseWidgetRef('../x'), null);
  assert.equal(parseWidgetRef('Example/Movers'), null);
});

test('install → DISABLED (no page served) → enable → the page is served from the re-hashed pack → tamper refuses → disable refuses; a workspace cannot consent', async () => {
  const home = tmp('dexterm-home-');
  const f = fakeIo({ DEXTERM_HOME: home });
  assert.equal(await packCommand(['add', EXAMPLE, '--accept-unsigned'], f.io), 0, f.err());
  assert.match(f.out(), /widget example-widgets\/movers is DISABLED/);
  let state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.deepEqual(state.custom.configErrors, []);
  assert.deepEqual(installedWidgets(state.custom).map((w) => [w.key, w.enabled]), [['example-widgets/movers', false]]);
  assert.equal(widgetEnabled(state.custom, 'example-widgets/movers'), false);
  let r = widgetPage(state.custom, 'example-widgets/movers');
  assert.ok(!r.ok && /not enabled \(trenchscope pack widget example-widgets movers --enable\)/.test(r.reason), JSON.stringify(r));
  // the pack's own workspace lists the widget: planning skips it with the consent hint (a workspace cannot enable anything)
  const ws = state.custom.workspaces.find((w) => w.name === 'example-widgets/movers');
  assert.ok(ws && !ws.error);
  const st = { chartOpen: false, bubblesOpen: false, narrativeOpen: false, plansOpen: false, hasToken: false, widgetEnabled: (ref: string) => widgetEnabled(state.custom, ref), widgetOpen: () => false };
  let plan = planPopupOpens(ws!.workspace.popups!, st);
  assert.deepEqual(plan.widgets, []);
  assert.deepEqual(plan.skipped, [{ kind: 'widget', why: 'example-widgets/movers is not enabled (trenchscope pack widget example-widgets movers --enable)' }]);
  assert.deepEqual(planPopupOpens([{ kind: 'widget', widget: 'example-widgets/movers' }], { ...st, widgetEnabled: undefined }).skipped[0].why, 'example-widgets/movers: widgets need live or replay mode');
  // consent
  f.reset();
  assert.equal(await packCommand(['widget', 'example-widgets', 'movers', '--enable'], f.io), 0, f.err());
  state = makeFixtureState(); state.custom = initCustom({ DEXTERM_HOME: home });
  assert.equal(widgetEnabled(state.custom, 'example-widgets/movers'), true);
  r = widgetPage(state.custom, 'example-widgets/movers');
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.page.key, 'example-widgets/movers/movers');
  assert.equal(r.page.title, 'MOVERS');
  assert.deepEqual(r.page.topics, ['rows', 'alerts', 'theme']);
  assert.ok(r.page.html.includes("dexterm.on('rows'"));
  assert.ok(widgetPage(state.custom, 'example-widgets/movers/movers').ok);
  assert.match((widgetPage(state.custom, 'example-widgets/movers/nope') as { reason: string }).reason, /has no widget "nope"/);
  plan = planPopupOpens(ws!.workspace.popups!, { ...st, widgetEnabled: (ref) => widgetEnabled(state.custom, ref) });
  assert.deepEqual(plan.widgets, ['example-widgets/movers']);
  assert.deepEqual(plan.skipped, []);
  plan = planPopupOpens(ws!.workspace.popups!, { ...st, widgetEnabled: () => true, widgetOpen: () => true });
  assert.deepEqual(plan.widgets, [], 'an open widget is left alone');
  // tamper with the installed page after consent: refused at open time (the pack no longer hashes to its record)
  const installed = join(home, 'packs', 'example-widgets@1.0.0', 'widgets', 'movers', 'movers.html');
  const original = readFileSync(installed, 'utf8');
  writeFileSync(installed, original.replace('MOVERS · 5m', 'PWNED'));
  const s2 = makeFixtureState(); s2.custom = initCustom({ DEXTERM_HOME: home });
  assert.ok(s2.custom.configErrors.some((e) => /files changed since install/.test(e)));
  assert.match((widgetPage(s2.custom, 'example-widgets/movers') as { reason: string }).reason, /no installed widget|changed since install/);
  // the page swapped underneath a running app (custom loaded before the tamper): still refused
  writeFileSync(installed, original);
  const s3 = makeFixtureState(); s3.custom = initCustom({ DEXTERM_HOME: home });
  assert.ok(widgetPage(s3.custom, 'example-widgets/movers').ok);
  writeFileSync(installed, original + '<!-- x -->');
  assert.match((widgetPage(s3.custom, 'example-widgets/movers') as { reason: string }).reason, /changed since install \((hash differs|files differ from pack\.lock)\); re-install it/);
  writeFileSync(installed, original);
  // disable → refused again
  f.reset();
  assert.equal(await packCommand(['widget', 'example-widgets', 'movers', '--disable'], f.io), 0, f.err());
  const s4 = makeFixtureState(); s4.custom = initCustom({ DEXTERM_HOME: home });
  assert.match((widgetPage(s4.custom, 'example-widgets/movers') as { reason: string }).reason, /not enabled/);
  assert.deepEqual(loadConfig(home).config.plugins!['example-widgets/movers'], { enabled: false, capabilities: [], settings: {} });
});

test('r2 REGRESSION at OPEN time: an installed, hash-valid pack whose page carries a loader is neutralised on load (no widget, the reason in configErrors) and refused by widgetPage even when handed the widget directly; the CLI refuses the same pack at add', async () => {
  const FIXTURE = realpathSync(fileURLToPath(new URL('../../custom/test/fixtures/packs/trenches/', import.meta.url)));
  const home = tmp('dexterm-home-');
  // simulate a pack installed BEFORE r2: its directory and record are consistent (lock + hash match), the page has a loader
  const dir = join(home, 'packs', 'trenches@1.0.0');
  mkdirSync(join(home, 'packs'), { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
  const pagePath = join(dir, 'widgets', 'tips', 'tips.html');
  const good = readFileSync(pagePath, 'utf8');
  writeFileSync(pagePath, good.replace('<script>', '<script nonce="__NONCE__" src="https://evil.example/x.js"></script><script nonce="__NONCE__">'));
  writeLock(dir);
  const integ = checkIntegrity(dir);
  assert.ok(integ.ok);
  const cfg = defaultConfig();
  cfg.packs = [{ name: 'trenches', version: '1.0.0', source: FIXTURE, hash: integ.hash, trust: 'unsigned', publisher: 'dexterm-examples', installedAt: 1 }];
  cfg.plugins = { 'trenches/tips': { enabled: true, capabilities: [], settings: {} } }; // consent was given to the old page
  saveConfig(home, cfg);
  // load: the pack hashes to its record, but its widget is refused by name and never registered
  const loaded = loadPacks(home, cfg);
  assert.deepEqual(loaded.widgets, [], 'no widget from a pack whose page carries a loader');
  assert.ok(loaded.errors.some((e) => /^pack trenches: widget tips: page tips\.html: .*__NONCE__.*<script src=…>|^pack trenches: widget tips: page tips\.html: .*<script src=…>/.test(e)), loaded.errors.join('; '));
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.ok(state.custom.configErrors.some((e) => /widget tips: page tips\.html/.test(e)), state.custom.configErrors.join('; '));
  assert.deepEqual(installedWidgets(state.custom), []);
  assert.equal(widgetEnabled(state.custom, 'trenches/tips'), false, 'the stale consent flag buys nothing');
  let r = widgetPage(state.custom, 'trenches/tips');
  assert.ok(!r.ok && /no installed widget trenches\/tips/.test(r.reason), JSON.stringify(r));
  // the belt: hand widgetPage the widget as if the loader had registered it (enabled, hash-valid) — the page audit refuses it
  const manifest = JSON.parse(readFileSync(join(dir, 'widgets', 'tips', 'widget.json'), 'utf8')) as InstalledWidgetManifest;
  const ui = { ...state.custom, packs: { ...state.custom.packs, widgets: [{ pack: 'trenches', name: 'tips', dir: join(dir, 'widgets', 'tips'), manifest, enabled: true }] } };
  r = widgetPage(ui as typeof state.custom, 'trenches/tips');
  assert.ok(!r.ok && /^trenches\/tips: page tips\.html refused: .*__NONCE__/.test(r.reason) && /<script src=…>/.test(r.reason), JSON.stringify(r));
  // the same page through the CLI: `pack add` refuses it (install-time), nothing new lands, and `verify` shows why
  const src = tmp('dexterm-evil-');
  cpSync(dir, src, { recursive: true });
  const f = fakeIo({ DEXTERM_HOME: tmp('dexterm-home2-') });
  assert.equal(await packCommand(['verify', src], f.io), 1);
  assert.match(f.out(), /widget {5}✗ tips: page tips\.html: .*__NONCE__/);
  assert.match(f.out(), /1 item\(s\) refused; this pack would not install/);
  f.reset();
  assert.equal(await packCommand(['add', src, '--accept-unsigned'], f.io), 1);
  assert.match(f.err(), /install: pack content refused: widget tips refused: page tips\.html: .*__NONCE__/);
  assert.ok(!existsSync(join(f.io.env.DEXTERM_HOME!, 'packs')));
  // and the clean fixture page still installs and serves
  writeFileSync(join(src, 'widgets', 'tips', 'tips.html'), good);
  writeLock(src);
  f.reset();
  assert.equal(await packCommand(['add', src, '--accept-unsigned'], f.io), 0, f.err());
  assert.equal(await packCommand(['widget', 'trenches', 'tips', '--enable'], f.io), 0, f.err());
  assert.match(f.out(), /hash-only CSP: only the inline script\/style you just read runs/);
  const s2 = makeFixtureState(); s2.custom = initCustom(f.io.env);
  const ok = widgetPage(s2.custom, 'trenches/tips');
  assert.ok(ok.ok && ok.page.html === good, JSON.stringify(ok));
});
type InstalledWidgetManifest = ReturnType<typeof installedWidgets>[number]['manifest'];

test('view models are the public columns only: no key, signer, cap, mandate or gate anywhere; token/narrative are null until there is one; theme = the popup tokens', () => {
  const state = makeFixtureState();
  const rows = widgetRowsVM(state);
  assert.ok(rows.rows.length > 5);
  assert.equal(rows.feed, state.screener.preset);
  for (const r of rows.rows) {
    assert.deepEqual(Object.keys(r).sort(), ['ageMin', 'chg', 'flags', 'holders', 'launchpad', 'liq', 'mcap', 'mint', 'name', 'org', 'price', 'symbol', 'top10', 'verified', 'vol1h', 'vol24', 'vol5m']);
    assert.ok(!('pair' in r) && !('sources' in r) && !('fixture' in r) && !('spark' in r), 'no provenance internals');
  }
  const alerts = widgetAlertsVM(state);
  assert.ok(alerts.items.length > 0, 'fixture alerts');
  for (const a of alerts.items) assert.deepEqual(Object.keys(a).sort(), ['at', 'kind', 'level', 'symbol', 'text']);
  const pos = widgetPositionsVM(state);
  assert.deepEqual(pos.rows, [], 'no book on a fixture run');
  assert.equal(widgetPayload(state, 'token'), null);
  assert.equal(widgetPayload(state, 'narrative'), null);
  assert.equal((widgetPayload(state, 'token', { token: () => ({ symbol: 'WIF' } as never) }) as { symbol: string }).symbol, 'WIF');
  const theme = widgetPayload(state, 'theme') as { bg: string; up: string };
  assert.equal(theme.bg, THEMES.mono.bg); assert.equal(theme.up, THEMES.mono.up);
  for (const t of POPUP_TOPICS as readonly WidgetTopic[]) { const p = widgetPayload(state, t); if (p) assert.ok(payloadIsPublic(p), t); }
  assert.equal(payloadIsPublic({ rows: [{ symbol: 'x', signer: 'y' }] }), false);
  assert.equal(payloadIsPublic({ a: { mandates: [] } }), false);
  assert.ok(payloadKeys({ a: { b: 1 } }).includes('b'));
});

test('the controller opens a widget through the manager with the page, pushes only declared topics (throttled), forgets it on close; save records open widgets', async () => {
  const fm = fakeManager();
  const popups = new TokenPopups({ theme: THEMES.cyberspace, createManager: fm.create, env: {} });
  const page = { key: 'example-widgets/movers/movers', title: 'MOVERS', topics: ['rows', 'theme'] as WidgetTopic[], html: '<p>x</p>' };
  const res = await popups.openWidget(page);
  assert.equal(res.native, false);
  assert.equal(fm.opens.length, 1);
  assert.equal(fm.opens[0].kind, 'widget');
  assert.equal(fm.opens[0].widget?.key, page.key);
  assert.ok(popups.widgetOpen(page.key));
  assert.deepEqual(popups.openWidgets(), [{ key: page.key, topics: ['rows', 'theme'] }]);
  await popups.openWidget(page);
  assert.equal(fm.opens.length, 1, 'already open → no second window');
  // sync: declared topics only; a topic the widget did not declare is never sent even when asked
  const state = makeFixtureState();
  state.popups = popups;
  popups.syncWidget(page.key, 'alerts', { items: [], updatedAt: 1 });
  assert.equal(fm.sends.length, 0, 'alerts was not declared by this widget');
  let n = syncWidgetPopups(state);
  assert.equal(n, 2);
  assert.deepEqual(fm.sends.map((s) => s.topic), ['rows', 'theme']);
  assert.ok((fm.sends[0].payload as { rows: unknown[] }).rows.length > 0);
  n = syncWidgetPopups(state);
  assert.equal(n, 0, 'throttled within WIDGET_SYNC_MS');
  state.now = new Date(state.now.getTime() + WIDGET_SYNC_MS);
  assert.equal(syncWidgetPopups(state), 2);
  assert.equal(syncWidgetPopups(state, {}, { force: true, only: 'other/widget' }), 0, 'only= filters by key');
  assert.equal(syncWidgetPopups(state, {}, { force: true, topics: ['theme'] }), 1);
  // the save path lists open widgets by key; a workspace capture turns them into widget popups
  const ws = captureWorkspace('mine', { screen: 'screener', theme: 'cyberspace', intensity: 'fever', popups: [], widgets: popups.openWidgets().map((w) => w.key) });
  assert.deepEqual(ws.popups, [{ kind: 'widget', widget: 'example-widgets/movers/movers' }]);
  // close → forgotten; shutdown clears
  popups.closeWidget(page.key);
  assert.ok(!popups.widgetOpen(page.key));
  assert.deepEqual(fm.closed, ['p_1']);
  assert.equal(syncWidgetPopups(state, {}, { force: true }), 0);
  popups.closeWidget(page.key); // idempotent
  await popups.openWidget(page);
  popups.shutdown();
  assert.deepEqual(popups.openWidgets(), []);
});
