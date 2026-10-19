// task-1359 token-detail + feeds popups on the popup host: the keys (I on the token screen, M on the trending
// screen), the actions (intent only; the loop owns the window), the feeds view model (newest first, firewalled
// text, injection withheld, mints kept terminal-side) and the TokenPopups windows with a fake manager.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEMES, parseKeys, DEFAULT_KEYMAP, type ScreenKey } from '@dexterm/tui';
import type { PopupManager, PopupManagerOptions, ServerEvent, TokenDetailVM, FeedVM } from '@dexterm/popup';
import { makeFixtureState } from '../src/state.ts';
import { applyAction } from '../src/main.ts';
import { TokenPopups, tokenDetailVMFromView } from '../src/popup.ts';
import { feedsPopupModel, socialOf, FEEDS_POPUP_MAX } from '../src/social/view.ts';
import type { TokenView } from '../src/live/token.ts';

const T = THEMES.cyberspace;
const k = (s: string) => parseKeys(s)[0];

test('keymap: I on the token screen = token popup, M on the trending screen = feeds popup; neither is global, the other popup keys are untouched', () => {
  assert.equal(DEFAULT_KEYMAP.resolve(k('I'), 'token'), 'popup.token');
  assert.equal(DEFAULT_KEYMAP.resolve(k('M'), 'trending'), 'popup.feeds');
  assert.equal(DEFAULT_KEYMAP.resolve(k('I'), 'screener'), undefined, 'I is not global');
  assert.equal(DEFAULT_KEYMAP.resolve(k('i'), 'token'), 'input.focus', 'lowercase i stays "ask"');
  assert.equal(DEFAULT_KEYMAP.resolve(k('C'), 'token'), 'popup.chart');
  assert.equal(DEFAULT_KEYMAP.resolve(k('M'), 'token'), 'intel.bubbles');
  assert.equal(DEFAULT_KEYMAP.resolve(k('M'), 'narrative'), 'narrative.popup');
});

test('actions: popup.feeds on the trending screen records the intent (demo feed too); popup.token needs a live token and says so', () => {
  const stack: ScreenKey[] = [];
  const s = makeFixtureState({ screen: 'trending', theme: T, intensity: 'off' });
  applyAction(s, 'popup.feeds', stack);
  assert.equal(s.pendingPopup, 'feeds');
  s.pendingPopup = null;
  s.screen = 'screener';
  applyAction(s, 'popup.feeds', stack);
  assert.equal(s.pendingPopup ?? null, null, 'only on the trending screen');
  s.screen = 'token';
  applyAction(s, 'popup.token', stack);
  assert.equal(s.pendingPopup ?? null, null);
  assert.match(s.pendingToast ?? '', /live mode first, then I/);
});

test('feeds popup model: newest first, firewalled text with the $SYMBOL, injection posts withheld, spam hidden as on the panel, headlines included, mints aligned and never in the VM', () => {
  const s = makeFixtureState({ screen: 'trending', theme: T, intensity: 'off' });
  const feed = socialOf(s)!;
  assert.ok(feed, 'fixtures build the demo feed');
  const m = feedsPopupModel(s);
  assert.equal(m.vm.title, 'FEEDS');
  assert.ok(m.vm.items.length > 5, `items: ${m.vm.items.length}`);
  assert.ok(m.vm.items.length <= FEEDS_POPUP_MAX);
  assert.equal(m.mints.length, m.vm.items.length);
  for (let i = 1; i < m.vm.items.length; i++) assert.ok(m.vm.items[i - 1].t >= m.vm.items[i].t, 'newest first');
  const json = JSON.stringify(m.vm);
  for (const mint of m.mints) if (mint) assert.ok(!json.includes(mint), 'the window never carries a mint');
  assert.doesNotMatch(json, /https?:\/\//, 'no URL reaches the page');
  assert.doesNotMatch(json, /firewall: instruction-like/, 'injection posts are withheld like the panel hides them');
  assert.ok(m.vm.items.some((it) => /^\$\S+ · /.test(it.text)), 'post rows carry their coin symbol');
  assert.ok(!m.vm.items.some((it) => it.source.includes('@@')), 'handles print one @');
  assert.ok(!m.vm.items.some((it) => /near-identical posts/.test(it.text)), 'spam bursts stay hidden as on the panel (x shows them there)');
  assert.ok(m.vm.items.some((it) => it.source.startsWith('news · ')), 'official headlines are in the feed');
  assert.ok(m.vm.items.some((it) => it.source === 'chain' || it.source.startsWith('chain')), 'rule-written on-chain rows are in the feed');
  const postRows = m.vm.items.map((it, i) => ({ it, mint: m.mints[i] })).filter((x) => /^\$/.test(x.it.text));
  assert.ok(postRows.every((x) => typeof x.mint === 'string' && x.mint.length > 20), 'every post row resolves to a coin');
  // the board's filter carries over (x = X posts only: no headlines, title says so)
  s.socialFilter = 'x';
  const mx = feedsPopupModel(s);
  assert.equal(mx.vm.title, 'FEEDS · x');
  assert.ok(!mx.vm.items.some((it) => it.source.startsWith('news')));
  // caps
  assert.ok(feedsPopupModel(s, 3).vm.items.length <= 3);
});

function fakeManager(opens: Array<{ kind: string; data: unknown }>, pushes: unknown[], closed: { n: number }, hook: (onEvent: (e: ServerEvent) => void) => void) {
  return (o: PopupManagerOptions): PopupManager => {
    hook(o.onEvent!);
    return { native: true, reason: 'wry', hotkeyRegistered: false, port: 1, async open(req) { opens.push({ kind: req.kind, data: req.data }); return { id: `p${opens.length}`, kind: req.kind, native: true, setData: (d) => pushes.push(d), close() { closed.n++; }, show() {}, hide() {}, focus() {}, alwaysOnTop() {} }; }, setData() {}, close() {}, async shutdown() {} };
  };
}

const VIEW = {
  symbol: 'VOID', name: 'void protocol', mint: '7VoiDfix7ureMint000000000000000000000pump', launchpad: 'pump.fun', price: 0.0012, chg: { m5: 1, h1: 2, h6: 3, h24: 4 },
  mcap: 1.2e6, fdv: 1.2e6, liq: 9e4, vol24: 4e5, holders: 1842, top10: 31, dev: 2, lpLocked: 100, mintAuth: false, freezeAuth: false,
  rug: { score: 12, risks: [{ name: 'low liquidity', level: 'warn' }] }, flags: [], holdersSample: 'top 20 of 1,842', updatedAt: 1,
} as unknown as TokenView;

test('TokenPopups: openToken opens a `token` window with the scan cells, syncToken pushes, close-request closes; independent of the chart', async () => {
  const opens: Array<{ kind: string; data: unknown }> = []; const pushes: unknown[] = []; const closed = { n: 0 };
  let onEvent!: (e: ServerEvent) => void;
  const tp = new TokenPopups({ theme: T, env: { DEXTERM_HOME: '/nonexistent-1359' }, createManager: fakeManager(opens, pushes, closed, (h) => { onEvent = h; }) });
  const vm = tokenDetailVMFromView(VIEW, { snipers: '7 · 18.9% at launch', bundle: 'needs Helius key', snipersLevel: 'warn', bundleLevel: 'na' });
  assert.equal(tp.tokenOpen(), false);
  await tp.openToken(vm);
  assert.equal(opens.length, 1); assert.equal(opens[0].kind, 'token');
  const sent = opens[0].data as TokenDetailVM;
  assert.equal(sent.symbol, 'VOID'); assert.equal(sent.intel?.snipers, '7 · 18.9% at launch'); assert.equal(sent.intel?.bundleLevel, 'na');
  assert.equal(tp.chartOpen(), false);
  await tp.openToken({ ...vm, price: 0.002 });
  assert.equal(opens.length, 1, 'a second open re-syncs'); assert.equal((pushes[0] as TokenDetailVM).price, 0.002);
  onEvent({ ev: 'popup.event', popupId: 'p1', name: 'popup.close-request', payload: {} });
  assert.equal(tp.tokenOpen(), false); assert.equal(closed.n, 1);
  tp.closeToken();
  assert.equal(closed.n, 1, 'idempotent');
  assert.equal(tokenDetailVMFromView(VIEW).intel, null, 'no scan → no cells (the page shows nothing rather than a guess)');
});

test('TokenPopups: openFeeds opens a `feeds` window; feed.selected {i} resolves the mint terminal-side; items without a coin and bad indices only note', async () => {
  const opens: Array<{ kind: string; data: unknown }> = []; const pushes: unknown[] = []; const closed = { n: 0 };
  let onEvent!: (e: ServerEvent) => void;
  const picked: string[] = []; const notes: string[] = [];
  const tp = new TokenPopups({ theme: T, env: { DEXTERM_HOME: '/nonexistent-1359' }, createManager: fakeManager(opens, pushes, closed, (h) => { onEvent = h; }), onFeedSelected: (m) => picked.push(m), onNote: (n) => notes.push(n) });
  const vm: FeedVM = { title: 'FEEDS', items: [{ t: 3, source: 'chain', text: '$A · dev wallet …' }, { t: 2, source: 'news · coindesk.com', text: 'headline [macro]', kind: 'news' }] };
  await tp.openFeeds(vm, ['MintA111111111111111111111111111111111111', null]);
  assert.equal(opens[0].kind, 'feeds'); assert.equal(tp.feedsOpen(), true);
  assert.ok(!JSON.stringify(opens[0].data).includes('MintA'), 'mints never leave the terminal');
  onEvent({ ev: 'popup.event', popupId: 'p1', name: 'feed.selected', payload: { i: 0 } });
  onEvent({ ev: 'popup.event', popupId: 'p1', name: 'feed.selected', payload: { i: 1 } });
  onEvent({ ev: 'popup.event', popupId: 'p1', name: 'feed.selected', payload: { i: 9 } });
  onEvent({ ev: 'popup.event', popupId: 'p1', name: 'feed.selected', payload: { i: -1 } });
  assert.deepEqual(picked, ['MintA111111111111111111111111111111111111']);
  assert.equal(notes.filter((n) => /names no coin/.test(n)).length, 3);
  // a sync replaces the index → mint table
  tp.syncFeeds({ title: 'FEEDS', items: [{ t: 9, source: 'chain', text: '$B · x' }] }, ['MintB111111111111111111111111111111111111']);
  onEvent({ ev: 'popup.event', popupId: 'p1', name: 'feed.selected', payload: { i: 0 } });
  assert.equal(picked[1], 'MintB111111111111111111111111111111111111');
  onEvent({ ev: 'popup.closed', popupId: 'p1' } as ServerEvent);
  assert.equal(tp.feedsOpen(), false);
  onEvent({ ev: 'popup.event', popupId: 'p1', name: 'feed.selected', payload: { i: 0 } });
  assert.equal(picked.length, 2, 'a closed window cannot open coins');
});
