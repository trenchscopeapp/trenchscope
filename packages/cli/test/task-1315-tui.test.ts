// trenchscope — task-1315 (LARP detector) TUI: the token-screen open-in-browser keys (W/X/T/L) and the
// safety gate on openInBrowser. No browser is launched here: the positive flow only queues the URL on
// state.pendingOpen (the loop opens it), and openInBrowser is exercised only on its rejection paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, openInBrowser } from '../src/main.ts';
import { makeFixtureState, renderFrame, type AppState } from '../src/state.ts';
import { larpBadge, screenerColumns } from '../src/screens/screener.ts';
import { THEMES, Canvas } from '@dexterm/tui';
import type { ScreenKey } from '@dexterm/tui';

/** A token screen in live mode with a stub live binding carrying the advertised links. */
function liveTokenState(links: { web: string | null; x: string | null; tg: string | null }): AppState {
  const s = makeFixtureState({ screen: 'token', selected: 0 });
  s.screener.source = 'replay'; // not 'fixtures' → applyAction takes the live path
  s.live = { token: { view: { socialLinks: links } }, notice: '', watch: { notice: '' } } as unknown as AppState['live'];
  return s;
}

test('open.web queues the website URL and shows it before opening (task-1315)', () => {
  const s = liveTokenState({ web: 'https://mycoin.io', x: 'https://x.com/mycoin', tg: null });
  applyAction(s, 'open.web', [] as ScreenKey[]);
  assert.equal(s.pendingOpen, 'https://mycoin.io/', 'the website is queued for the browser (normalised)');
  assert.match(s.live!.notice ?? '', /open https:\/\/mycoin\.io/, 'the URL is surfaced first');
});

test('explicit product-vet action launches the structured skill for the selected mint', () => {
  const s = liveTokenState({ web: 'https://mycoin.io', x: null, tg: null });
  Object.assign(s.live!.token!.view, { mint: 'fixture-mint', symbol: 'FIX' });
  applyAction(s, 'analyst.larp', []);
  assert.deepEqual(s.pendingAnalyst, { skill: 'larp-check', mint: 'fixture-mint', symbol: 'FIX', target: 'token' });
  assert.equal(s.aiOpen, true);
});

test('open.x queues the X link; a missing link reports instead of opening (task-1315)', () => {
  const s = liveTokenState({ web: null, x: null, tg: 'https://t.me/mycoin' });
  applyAction(s, 'open.x', [] as ScreenKey[]);
  assert.equal(s.pendingOpen ?? null, null, 'nothing is queued when there is no X link');
  assert.match(s.live!.notice ?? '', /no X link/, 'it says the link is absent');
  applyAction(s, 'open.tg', [] as ScreenKey[]);
  assert.equal(s.pendingOpen, 'https://t.me/mycoin', 'the telegram link is queued');
});

test('open.links lists every advertised link (task-1315)', () => {
  const s = liveTokenState({ web: 'https://mycoin.io', x: 'https://x.com/mycoin', tg: 'https://t.me/mycoin' });
  applyAction(s, 'open.links', [] as ScreenKey[]);
  assert.equal(s.pendingOpen ?? null, null, 'listing never opens anything on its own');
  const n = s.live!.notice ?? '';
  assert.match(n, /mycoin\.io/);
  assert.match(n, /x\.com\/mycoin/);
  assert.match(n, /t\.me\/mycoin/);
});

test('open keys need live mode on fixtures (no real hrefs) (task-1315)', () => {
  const s = makeFixtureState({ screen: 'token', selected: 0 }); // source: fixtures → live path is null
  applyAction(s, 'open.web', [] as ScreenKey[]);
  assert.equal(s.pendingOpen ?? null, null, 'fixtures carry only presence badges, not URLs');
  assert.match(s.screener.notice ?? '', /needs live mode/);
});

test('openInBrowser refuses every non-http(s) scheme — no shell ever sees it (task-1315)', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'vscode://x', 'ftp://host/x', 'not a url']) {
    assert.equal(openInBrowser(bad), false, `${bad} is refused`);
  }
});

test('larpBadge maps each verdict to a label, and nothing for an unknown verdict (task-1315)', () => {
  const t = THEMES.cyberspace;
  assert.equal(larpBadge('LARP', t)?.text, 'LARP');
  assert.equal(larpBadge('REAL_PRODUCT', t)?.text, 'REAL');
  assert.equal(larpBadge('EARLY_BUT_REAL', t)?.text, 'REAL?');
  assert.equal(larpBadge('UNVERIFIABLE', t)?.text, 'UNKNOWN');
  assert.equal(larpBadge('AMBIGUOUS', t)?.text, 'UNKNOWN');
  assert.deepEqual(larpBadge('NO_PRODUCT_CLAIMED', t), { text: 'MEME', fg: t.muted }, 'a no-product meme gets a neutral badge');
  assert.equal(larpBadge(undefined, t), null);
  assert.equal(larpBadge('WATCH', t), null);
});

test('the screener FLAGS column shows a LARP badge only for a vetted mint (task-1315)', () => {
  const t = THEMES.cyberspace;
  const s = makeFixtureState({ screen: 'screener', selected: 0 });
  const row = s.screener.rows[0]!;
  const flagsCell = (larp: Map<string, { verdict: string }> | null): string => {
    const cv = new Canvas(14, 1, t);
    const col = screenerColumns(cv, 'wide', null, larp).find((c) => c.key === 'flags')!;
    col.render(cv, 0, 0, 14, row, t.bg, { index: 0 } as never);
    return cv.toPlain();
  };
  assert.doesNotMatch(flagsCell(null), /LARP/, 'no badge before a verdict is computed');
  assert.match(flagsCell(new Map([[row.mint, { verdict: 'LARP' }]])), /LARP/, 'the badge shows once the verdict is cached');
  assert.match(flagsCell(new Map([[row.mint, { verdict: 'REAL_PRODUCT' }]])), /REAL/, 'a real-product verdict shows REAL');
});
