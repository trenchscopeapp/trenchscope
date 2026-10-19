import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1407 PNL CARDS: a coin's recorded fills → a 16:9 + 1:1 PNG and a text card, stamped PAPER / LIVE / TRACKED,
// wallet hidden and size as a band by default; share = save + clipboard image + X compose intent (tested with fakes,
// no network). Offline: fixture fills only, temp DEXTERM_HOME, fetch blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Canvas, DEFAULT_KEYMAP, parseKeys, THEMES } from '@dexterm/tui';
import { decodePng } from '@dexterm/data';
import {
  computeCard, renderCard, cardPixels, cardPng, cardText, previewCanvas, shareText, xIntentUrl, shareCard, saveCard, sizeBand, fmtPnlPct, fmtHold,
  fitScale, imageClipboardCommand, trackedCardInput, CardError, CARD_GEOMETRY, DEXTERM_URL, type CardInput, type ShareDeps,
} from '../src/pnl-card.ts';
import { openPnl, loadPnl, pnlKey, renderPnlOverlay, markFor } from '../src/pnl-app.ts';
import { canvasText } from '../src/export.ts';
import { applyAction } from '../src/main.ts';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import {
  NOW, MIN, HOUR, DAY, MINT_NEON, MINT_GLYPH, MINT_DRIFT, WALLET, SIG1, SIG2, profitInput, lossInput, longHoldInput, longHoldTrades, paperRecord,
} from './fixtures/pnl-1407.ts';
import { identityRegex } from './identity-terms.ts';

const t = THEMES.cyberspace;
const tmp = () => mkdtempSync(join(tmpdir(), 'dexterm-pnl-'));
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const BASE58_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/;

test('numbers come from the fills: profit (paper, closed), loss (live, closed), long hold (tracked, open + marked)', () => {
  const p = computeCard(profitInput(), NOW);
  assert.equal(p.kind, 'realized'); assert.equal(p.open, false); assert.equal(p.buys, 2); assert.equal(p.sells, 2);
  near(p.costInSol, 0.80001); near(p.proceedsSol, 1.32999); near(p.pnlSol, 0.52998); near(p.pnlPct, 0.52998 / 0.80001);
  assert.equal(fmtPnlPct(p.pnlPct), '+66.2%'); assert.equal(fmtHold(p.holdMs), '5h 0m');
  near(p.entryAvg!, 0.80001 / 3_000_000, 1e-15); near(p.exitAvg!, 1.32999 / 3_000_000, 1e-15);
  assert.equal(sizeBand(p.costInSol), '0.5-1 SOL');

  const l = computeCard(lossInput(), NOW);
  assert.equal(l.kind, 'realized'); near(l.pnlSol, 1.539985 - 2.500015); assert.equal(fmtPnlPct(l.pnlPct), '-38.4%'); assert.equal(fmtHold(l.holdMs), '40m');
  assert.equal(l.feesSol !== null, true); near(l.feesSol!, 0.00003);

  const h = computeCard(longHoldInput(), NOW);
  assert.equal(h.kind, 'realized + unrealized'); assert.equal(h.open, true);
  near(h.realizedSol, 2.9 - 4.3 * 0.3); near(h.unrealizedSol!, 35_000_000 * 0.000_000_31 - 4.3 * 0.7);
  assert.equal(fmtPnlPct(h.pnlPct), '+219.8%'); assert.equal(fmtHold(h.holdMs), '11d 4h');
  assert.match(h.input.excluded.join(), /1 token-to-token swap \(no SOL leg\)/);
});

test('no manual numbers: extra PnL-looking fields are ignored; no fills / no buy / open without a mark refuse', () => {
  const doctored = { ...profitInput(), pnlPct: 99, pnlSol: 1e6, sizeSol: 0.01 } as unknown as CardInput;
  assert.equal(fmtPnlPct(computeCard(doctored, NOW).pnlPct), '+66.2%');
  assert.throws(() => computeCard({ ...profitInput(), fills: [] }, NOW), CardError);
  assert.throws(() => computeCard({ ...profitInput(), fills: profitInput().fills.filter((f) => f.side === 'sell') }, NOW), /no recorded buy/);
  const open = { ...profitInput(), fills: profitInput().fills.filter((f) => f.side === 'buy') };
  assert.throws(() => computeCard(open, NOW), /no price mark/);
  const marked = computeCard({ ...open, mark: { priceSol: 0.0000004, at: NOW - 5000, via: 'dexscreener' } }, NOW);
  assert.equal(marked.kind, 'unrealized'); near(marked.pnlSol, 3_000_000 * 0.0000004 - 0.80001);
  // a sell beyond the recorded buys counts only its matched part, and says so
  const over = computeCard({ ...profitInput(), fills: [profitInput().fills.find((f) => f.side === 'buy')!, { t: NOW - HOUR, side: 'sell', solDelta: 2, tokenDelta: -4_000_000_000_000n, feeSol: 0, sig: null }] }, NOW);
  assert.match(over.input.excluded.join(), /beyond the recorded buys/);
});

test('every card carries its stamp in the stamp block, the strip and the text; there is no way to drop it', () => {
  const cases: [CardInput, string, string][] = [[profitInput(), 'PAPER', t.warn], [lossInput(), 'LIVE', t.up], [longHoldInput(), 'TRACKED', t.accent]];
  for (const [input, word, color] of cases) {
    const s = computeCard(input, NOW);
    for (const aspect of ['wide', 'square'] as const) {
      // options that try to hide the stamp are not part of the API and change nothing
      const r = renderCard(s, { aspect, stamp: false, hideStamp: true } as never);
      assert.equal(r.stamp.big, word);
      assert.ok(r.big.some((b) => b.text === word), `${word} big text`);
      const text = canvasText(r.canvas).join('\n');
      assert.ok(text.includes(r.stamp.line), `${aspect}: stamp line`);
      assert.ok(text.split('\n').some((l) => (l.match(new RegExp(r.stamp.strip.split(' ')[0], 'g')) ?? []).length >= 2), `${aspect}: stamp strip repeats`);
      assert.match(text, /not financial advice/); assert.ok(text.includes(DEXTERM_URL));
      // the PNG: exact size, and the stamp block really is painted in the stamp colour with dark lettering on it
      const px = cardPixels(r);
      const g = CARD_GEOMETRY[aspect];
      assert.equal(px.w, g.w); assert.equal(px.h, g.h); assert.ok(px.scales.every((k) => k >= 4), `big text scales ${px.scales}`);
      assert.deepEqual(r.clipped, [], `${word} ${aspect}: nothing clipped`);
      const [cr, cg, cb] = [1, 3, 5].map((k) => parseInt(color.slice(k, k + 2), 16));
      let colored = 0, ink = 0;
      const sr = r.stampRect;
      for (let y = sr.y * g.cellH; y < (sr.y + sr.h) * g.cellH; y += 2) for (let x = sr.x * g.cellW; x < (sr.x + sr.w) * g.cellW; x += 2) {
        const i = (y * px.w + x) * 4;
        if (px.rgba[i] === cr && px.rgba[i + 1] === cg && px.rgba[i + 2] === cb) colored++;
        else if (px.rgba[i] < 40 && px.rgba[i + 1] < 40 && px.rgba[i + 2] < 40) ink++;
      }
      assert.ok(colored > 2000 && ink > 500, `${word} ${aspect}: stamp painted (colour ${colored}, ink ${ink})`);
    }
    assert.ok(cardText(s).startsWith(`trenchscope PnL card · ${word}`));
  }
  assert.throws(() => computeCard({ ...profitInput(), source: 'demo' as never }, NOW), /source stamp/);
  // a devnet live fill says so on the stamp
  assert.match(renderCard(computeCard(lossInput('devnet'), NOW)).stamp.line, /DEVNET TEST FUNDS/);
});

test('privacy: wallet, tx signatures and exact size hidden by default; shown only on opt-in; never a key, path or balance', () => {
  for (const input of [profitInput(), lossInput(), longHoldInput()]) {
    const s = computeCard(input, NOW);
    for (const aspect of ['wide', 'square'] as const) {
      const text = canvasText(renderCard(s, { aspect }).canvas).join('\n') + cardText(s);
      assert.doesNotMatch(text, BASE58_ADDR, 'no full address or signature by default');
      assert.ok(!text.includes(WALLET) && !text.includes(SIG1.slice(0, 12)) && !text.includes(SIG2.slice(0, 12)));
      assert.doesNotMatch(text, /\d\.\d{4} SOL (in|on)/, 'no exact size by default');
      assert.match(text, /\(band\)|size [\d.]+-[\d.]+ SOL|SOL \(band\)/);
      assert.doesNotMatch(text, /helius|api[-_]?key|secret|\/Users\/|\/home\/|balance \d|equity/i);
    }
  }
  const s = computeCard(lossInput(), NOW);
  const shown = cardText(s, { showWallet: true, exactSize: true });
  assert.ok(shown.includes(WALLET) && shown.includes(SIG1) && shown.includes(SIG2), 'opt-in text shows the wallet and full signatures');
  assert.match(shown, /-0\.9600 SOL on 2\.5000 SOL in/);
  const png = canvasText(renderCard(s, { showWallet: true }).canvas).join('\n');
  assert.ok(png.includes(WALLET) && png.includes(`${SIG1.slice(0, 8)}…${SIG1.slice(-6)}`), 'opt-in card shows the wallet and short signatures');
});

test('PNGs decode at 1200×675 and 1080×1080; a long ticker auto-fits instead of clipping', () => {
  const s = computeCard(profitInput(), NOW);
  const wide = decodePng(cardPng(s, { aspect: 'wide' })), square = decodePng(cardPng(s, { aspect: 'square' }));
  assert.deepEqual([wide.w, wide.h, square.w, square.h], [1200, 675, 1080, 1080]);
  const long = computeCard({ ...profitInput(), symbol: 'ABCDEFGHIJKLMNOPQRS', name: 'A very long sample coin name that goes on and on and on' }, NOW);
  for (const aspect of ['wide', 'square'] as const) {
    const r = renderCard(long, { aspect, showWallet: true, exactSize: true });
    const px = cardPixels(r);
    assert.ok(px.scales.every((k) => k >= 1));
    assert.deepEqual(r.clipped, []);
  }
  assert.equal(fitScale('+1,284%', 672, 150), 15); assert.equal(fitScale('x'.repeat(200), 100, 100), 0);
  // the preview canvas carries the big texts at cell size for the terminal
  assert.match(canvasText(previewCanvas(renderCard(s))).join('\n'), /\+66\.2%[\s\S]*PAPER|PAPER[\s\S]*\+66\.2%/);
});

// copied from dexterm/marketing/launch-day/scan.mjs (HYGIENE + CLAIMS, keep in sync): the default share text is drafted
// by dexterm, so the marketing guardrails apply to it. task-1415: the owner/host names come from the identity term
// list in the distribution kit (identity-terms.ts), never from this file; a public checkout checks the rest.
const IDENTITY = identityRegex();
const HYGIENE: [string, RegExp][] = [
  ...(IDENTITY ? [['owner / host names (kit term list)', IDENTITY] as [string, RegExp]] : []),
  ['home path', /\/(Users|home)\/[a-z]/i], ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/],
  ['api key / secret words', /(api[-_]?key|apikey|secret|password|bearer|sk-[A-Za-z0-9]{8,}|helius\.key|PORKBUN)/i], ['tailnet hosts', /(tail[0-9a-f]{6}|ts\.net)/i],
  ['IP address', /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/], ['full base58 address', /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/], ['EVM address', /\b0x[0-9a-fA-F]{40}\b/],
  ['quote token / SOL price / live header', /(\bSOL \$\d|\bUSDC\b|\bUSDT\b|◉ live|● LIVE|● live)/], ['em or en dash', /[—–]/],
];
const CLAIMS: [string, RegExp][] = [
  ['claims', /\b(\d+x\b|100x|alpha|win rate|winners?|moon|will pump|guaranteed|rug-?proof|audited|profit|signals?|picks?|ai calls?)\b/i], ['"safe"', /\bsafe(ly|st)?\b/i],
  ['fill / execution claim', /\b(fill(s|ed)?|executed|landed on mainnet|swap succeeded)\b/i], ['price talk', /(\$\d|\bpump(s|ing|ed)?\b|\bdump(s|ing|ed)?\b|price target|\bATH\b|market cap of \d)/i],
  ['"financial advice" without "not"', /(?<!not )financial advice/i], ['"free forever"', /free forever/i], ['trenchscope token / airdrop', /\b(airdrop|fee share|holder rewards|our token|\$dexterm)\b/i],
];

test('default X text passes the GUARDRAILS scan: no coin, ticker, price, PnL or claim; stamp in words; fits a post', () => {
  for (const [src, input] of [['paper', profitInput()], ['live', lossInput()], ['tracked', longHoldInput()]] as const) {
    const text = shareText(src);
    for (const [name, re] of [...HYGIENE, ...CLAIMS]) assert.doesNotMatch(text, re, `${src}: ${name}`);
    assert.doesNotMatch(text, /PnL|return|%|\bSOL\b \d|NEON|GLYPH|DRIFT|\$[A-Z]/i, `${src}: no PnL, coin or ticker`);
    assert.ok(!text.includes(input.symbol) && !text.includes(input.mint));
    assert.match(text, src === 'paper' ? /PAPER: simulated/ : src === 'live' ? /LIVE:/ : /TRACKED WALLET:/);
    assert.match(text, /Not financial advice/); assert.ok(text.includes(`https://${DEXTERM_URL}`));
    assert.ok(text.replace(/https:\/\/\S+/, 'x'.repeat(23)).length <= 280);
    const u = new URL(xIntentUrl(text));
    assert.equal(u.origin + u.pathname, 'https://x.com/intent/post');
    assert.deepEqual([...u.searchParams.keys()], ['text']); assert.equal(u.searchParams.get('text'), text);
  }
});

function fakeDeps(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, runOk = true) {
  const calls = { run: [] as { cmd: string; args: string[]; stdinFile?: string }[], open: [] as string[], text: [] as string[] };
  const deps: ShareDeps = {
    platform, env: { DEXTERM_HOME: home, HOME: home, ...env }, now: NOW,
    run: async (cmd, args, stdinFile) => { calls.run.push({ cmd, args, stdinFile }); return runOk; },
    openUrl: (u) => { calls.open.push(u); return true; },
    copyText: (s) => { calls.text.push(s); },
  };
  return { deps, calls };
}

test('share flow (fakes): save writes 16:9 + 1:1 + txt privately; X = clipboard image + compose intent; text = clipboard text; no network', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network call during share'); }) as typeof fetch;
  const home = tmp();
  try {
    const s = computeCard(profitInput(), NOW);
    const { deps, calls } = fakeDeps(home, 'darwin');
    const saved = await shareCard(s, {}, 'save', deps);
    assert.equal(calls.run.length + calls.open.length + calls.text.length, 0, 'save only touches files');
    const dir = join(home, 'exports');
    assert.deepEqual(readdirSync(dir).sort(), [saved.files.square, saved.files.txt, saved.files.wide].map((p) => basename(p)).sort());
    await posixPermissions(t, () => { for (const f of Object.values(saved.files)) assert.equal(statSync(f).mode & 0o777, 0o600); });
    await posixPermissions(t, () => { assert.equal(statSync(dir).mode & 0o777, 0o700); });
    assert.match(saved.files.wide, /dexterm-pnl-paper-NEON-\d{8}-\d{6}-16x9\.png$/);
    assert.deepEqual([decodePng(readFileSync(saved.files.wide)).w, decodePng(readFileSync(saved.files.square)).h], [1200, 1080]);
    assert.match(saved.message, /^saved ~[\\/]exports[\\/]/);

    const x = await shareCard(s, {}, 'x', deps);
    assert.equal(x.clipboard, 'image');
    assert.equal(calls.run.length, 1);
    assert.equal(calls.run[0].cmd, 'osascript');
    assert.equal(calls.run[0].args.at(-1), x.files.wide, 'the PNG path is an argv item');
    assert.ok(!calls.run[0].args.slice(0, -1).join(' ').includes(x.files.wide), 'never interpolated into the script');
    assert.deepEqual(calls.open, [xIntentUrl(shareText('paper'))]);
    assert.equal(x.opened, calls.open[0]);
    assert.match(x.message, /image copied.*trenchscope posts nothing/);
    assert.equal(calls.text.length, 0);

    const tx = await shareCard(s, {}, 'text', deps);
    assert.equal(tx.clipboard, 'text'); assert.deepEqual(calls.text, [cardText(s)]); assert.equal(calls.open.length, 1);
  } finally { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); }
});

test('clipboard image per OS: wayland wl-copy (stdin), X11 xclip, none elsewhere (attach the saved file); failure is reported', async () => {
  assert.deepEqual(imageClipboardCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' }, '/x.png'), { cmd: 'wl-copy', args: ['--type', 'image/png'], stdinFile: '/x.png' });
  assert.deepEqual(imageClipboardCommand('linux', { DISPLAY: ':0' }, '/x.png'), { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-i', '/x.png'] });
  assert.equal(imageClipboardCommand('linux', {}, '/x.png'), null);
  assert.equal(imageClipboardCommand('win32', {}, '/x.png'), null);
  const home = tmp();
  try {
    const s = computeCard(lossInput(), NOW);
    const win = fakeDeps(home, 'win32');
    const r = await shareCard(s, {}, 'x', win.deps);
    assert.equal(r.clipboard, 'unsupported'); assert.equal(win.calls.run.length, 0);
    assert.match(r.message, /attach ~[\\/]exports[\\/]dexterm-pnl-live-GLYPH-.*-16x9\.png/);
    assert.equal(new URL(win.calls.open[0]).searchParams.get('text'), shareText('live'));
    const bad = fakeDeps(home, 'darwin', {}, false);
    assert.equal((await shareCard(s, {}, 'x', bad.deps)).clipboard, 'failed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('tracked adapter: transfers, airdrops, LP-like moves and token-to-token swaps are excluded and listed', () => {
  const base = { wallet: WALLET, slot: 1, tKnown: true, mint: MINT_DRIFT, lamportsDelta: 0, usd: null, solUsdAt: null };
  const input = trackedCardInput([
    { ...base, sig: 'a', t: NOW - DAY, side: 'buy', tokenDelta: '1000000', solDelta: -1, note: null },
    { ...base, sig: 'b', t: NOW - DAY + 1, side: 'transfer', tokenDelta: '5', solDelta: null, note: null },
    { ...base, sig: 'c', t: NOW - DAY + 2, side: 'buy', tokenDelta: '5', solDelta: 0, note: 'airdrop' },
    { ...base, sig: 'd', t: NOW - DAY + 3, side: 'buy', tokenDelta: '5', solDelta: -1, note: 'lp-like' },
    { ...base, sig: 'e', t: NOW - DAY + 4, side: 'sell', tokenDelta: '-1000000', solDelta: 1.5, note: null },
    { ...base, sig: 'f', t: NOW, side: 'buy', tokenDelta: '1', solDelta: -1, note: null, wallet: 'other' },
  ], { wallet: WALLET, mint: MINT_DRIFT, decimals: 6, complete: false });
  assert.equal(input.fills.length, 2);
  assert.match(input.excluded.join('; '), /1 transfer; 1 airdrop \(no cost\); 1 LP-like move; wallet history older than the fetched pages/);
  assert.equal(fmtPnlPct(computeCard(input, NOW).pnlPct), '+50.0%');
});

// ---------------------------------------------------------------------------------------------- app glue

function fakeLive(o: { paper?: ReturnType<typeof paperRecord>[]; liveRows?: ReturnType<typeof lossInput>['fills']; mark?: [number, number] | null } = {}) {
  const loss = lossInput();
  const rows = o.liveRows ? loss.fills.map((f, i) => ({ id: i, t: f.t, network: 'mainnet', signature: f.sig, mint: MINT_GLYPH, symbol: 'GLYPH', side: f.side, solDelta: String(BigInt(Math.round(f.solDelta * 1e9))), tokenDelta: String(f.tokenDelta), priceSol: 0, usd: null, decimals: 9, feeLamports: '15000', realizedLamports: '0', kind: 'swap' })) : [];
  return {
    wallet: { trades: () => [...(o.paper ?? [])].sort((a, b) => b.t - a.t) },
    livePositions: { records: (_n: number, mint?: string) => rows.filter((r) => !mint || r.mint === mint).map((r) => ({ ...r, t: r.t, mint: r.mint, symbol: r.symbol })), fills: (mint: string) => rows.filter((r) => r.mint === mint) },
    positions: { markOf: () => o.mark?.[0] ?? null, markAt: () => o.mark?.[1] ?? null, solUsd: () => 150 },
    linkedWallet: { publicKey: WALLET },
    token: null,
  };
}

test('H opens the preview on token / positions / follows and builds from the right ledger (LIVE wins over PAPER)', async () => {
  for (const screen of ['token', 'positions', 'follows']) assert.equal(DEFAULT_KEYMAP.resolve(parseKeys('H')[0], screen), 'pnl.card', screen);
  assert.ok(!DEFAULT_KEYMAP.resolve(parseKeys('H')[0], 'screener'), 'not bound where there is nothing to card');
  const state = makeFixtureState({});
  applyAction(state, 'pnl.card', []);
  assert.equal(state.pendingPnl, true);
  assert.match(openPnl(state)!, /run trenchscope live/, 'fixtures mode has no fills to card');

  const paper = [paperRecord(1, NOW - 2 * HOUR, 'buy', 0.5, 2_000_000), paperRecord(2, NOW - HOUR, 'sell', 0.6, 2_000_000)];
  state.live = fakeLive({ paper, liveRows: lossInput().fills }) as never;
  state.screen = 'positions';
  assert.equal(openPnl(state), null);
  assert.equal(state.overlay, 'pnl');
  assert.deepEqual(state.pnl!.choices.map((c) => c.mint), [MINT_NEON, MINT_GLYPH], 'newest activity first');
  await loadPnl(state, NOW);
  assert.equal(state.pnl!.stats!.input.source, 'paper'); assert.equal(fmtPnlPct(state.pnl!.stats!.pnlPct), '+20.0%');
  assert.deepEqual(pnlKey(state.pnl!, { name: 'right' }), { kind: 'reload' });
  await loadPnl(state, NOW);
  assert.equal(state.pnl!.stats!.input.source, 'live'); assert.equal(state.pnl!.stats!.input.wallet, WALLET);

  // toggles and share keys; esc closes
  const ui = state.pnl!;
  assert.deepEqual(pnlKey(ui, { name: 'char', ch: 'a' }), { kind: 'none' }); assert.equal(ui.opts.showWallet, true);
  assert.deepEqual(pnlKey(ui, { name: 'char', ch: 'z' }), { kind: 'none' }); assert.equal(ui.opts.exactSize, true);
  assert.deepEqual(pnlKey(ui, { name: 'char', ch: 'f' }), { kind: 'none' }); assert.equal(ui.opts.aspect, 'square');
  assert.deepEqual(pnlKey(ui, { name: 'char', ch: 'x' }), { kind: 'share', action: 'x' });
  assert.deepEqual(pnlKey(ui, { name: 'char', ch: 't' }), { kind: 'share', action: 'text' });
  assert.deepEqual(pnlKey(ui, { name: 'char', ch: 's' }), { kind: 'share', action: 'save' });
  ui.busy = true; assert.deepEqual(pnlKey(ui, { name: 'char', ch: 'x' }), { kind: 'none' }, 'one share at a time');
  assert.deepEqual(pnlKey(ui, { name: 'esc' }), { kind: 'close' });

  // an open paper position with no mark refuses with the reason (never a made-up number)
  state.live = fakeLive({ paper: [paperRecord(1, NOW - HOUR, 'buy', 0.5, 2_000_000)] }) as never;
  assert.equal(openPnl(state), null);
  await loadPnl(state, NOW);
  assert.equal(state.pnl!.stats, null); assert.match(state.pnl!.error!, /no price mark/);
  state.live = fakeLive({ paper: [paperRecord(1, NOW - HOUR, 'buy', 0.5, 2_000_000)], mark: [0.0000003, NOW - 3000] }) as never;
  assert.deepEqual(markFor(state, MINT_NEON), { priceSol: 0.0000003, at: NOW - 3000, via: 'dexscreener' });
  await loadPnl(state, NOW);
  assert.equal(state.pnl!.stats!.kind, 'unrealized');

  // the token screen cards the open coin only, and refuses a coin with no fills
  state.screen = 'token';
  (state.live as unknown as { token: unknown }).token = { view: { mint: MINT_DRIFT, symbol: 'DRIFT', name: 'Drift Sample', image: null, price: null, panels: { market: { fetchedAt: null } } } };
  assert.match(openPnl(state)!, /no paper or live fills for this coin/);
  state.screen = 'screener';
  assert.match(openPnl(state)!, /token, positions \(P\) or followed wallets \(U\)/);

  // followed wallets: the selected wallet's coins, TRACKED; decimals + a price come from the public-mint lookup
  state.screen = 'follows';
  const asked: string[] = [];
  state.copy = {
    follows: () => [{ addr: WALLET, name: null, since: NOW - 30 * DAY, tier: 'poll' }],
    trades: () => longHoldTrades(),
    status: () => ({ state: 'ok', why: null, polls: 3, lastPollAt: NOW - 4 * MIN, wallets: 1, alerts: 0 }),
    stats: () => ({ sample: { txs: 4, complete: true, note: '' } }),
    mirrorMarket: async (mint: string) => { asked.push(mint); return { symbol: 'DRIFT', decimals: 6, priceUsd: 0.000_000_31 * 150, priceAt: NOW - 20_000, liqUsd: null, mcapUsd: null, ageMs: null }; },
  } as never;
  state.copyUi = { selected: 0, input: null, notice: null, mirror: null } as never;
  state.live = fakeLive() as never;
  assert.equal(openPnl(state), null);
  assert.deepEqual(state.pnl!.choices.map((c) => c.mint), [MINT_DRIFT]);
  await loadPnl(state, NOW);
  const ts = state.pnl!.stats!;
  assert.equal(ts.input.source, 'tracked'); assert.equal(ts.input.wallet, WALLET); assert.deepEqual(asked, [MINT_DRIFT]);
  assert.equal(fmtPnlPct(ts.pnlPct), '+219.8%'); assert.match(ts.input.mark!.via, /SOL\/USD/);
});

test('the preview overlay draws the stamped card when the terminal fits it, its text when not, and the share keys', async () => {
  const state = makeFixtureState({});
  state.live = fakeLive({ paper: [paperRecord(1, NOW - 2 * HOUR, 'buy', 0.5, 2_000_000), paperRecord(2, NOW - HOUR, 'sell', 0.6, 2_000_000)] }) as never;
  state.screen = 'positions';
  openPnl(state); await loadPnl(state, NOW);
  const big = new Canvas(176, 48, t);
  renderPnlOverlay(big, state);
  const bt = canvasText(big).join('\n');
  assert.match(bt, /PnL CARD · \$NEON/); assert.match(bt, /PAPER/); assert.match(bt, /\+20\.0%/); assert.match(bt, /x share to X/);
  assert.match(bt, /SIMULATED TRADE · NO REAL FUNDS/);
  // through the app's own frame pipeline (renderFrame draws overlays last)
  // (the screen underneath is the fixture screener: the overlay reads only state.pnl)
  const live = state.live; state.live = undefined; state.screen = 'screener'; state.overlay = 'pnl';
  assert.match(canvasText(renderFrame(state, 176, 48)).join('\n'), /SIMULATED TRADE · NO REAL FUNDS/);
  state.live = live; state.screen = 'positions';
  const small = new Canvas(80, 24, t);
  renderPnlOverlay(small, state);
  const st = canvasText(small).join('\n');
  assert.match(st, /trenchscope PnL card · PAPER/); assert.match(st, /realized PnL \+20\.0%/);
  state.pnl!.stats = null; state.pnl!.error = 'no recorded fills';
  const err = new Canvas(120, 30, t);
  renderPnlOverlay(err, state);
  assert.match(canvasText(err).join('\n'), /no card: no recorded fills/);
  void MIN; void saveCard;
});

test('LivePositions.fills reads the signer ledger read-only with network + signature (swaps only) → a LIVE card', async () => {
  const { LiveLedger } = await import('@dexterm/data');
  const { LivePositions } = await import('../src/live/trade.ts');
  const { liveCardInput } = await import('../src/pnl-card.ts');
  const dir = tmp();
  try {
    const path = join(dir, 'live-trades.sqlite');
    const l = new LiveLedger({ path });
    const fill = (t: number, side: 'buy' | 'sell', sol: bigint, tok: bigint) => ({
      t, mint: MINT_GLYPH, symbol: 'GLYPH', side, decimals: 9, solDelta: side === 'buy' ? -sol : sol, tokenDelta: side === 'buy' ? tok : -tok,
      grossLamports: sol, feeLamports: 15_000n, priceSol: 0, priceUsd: null, priceImpactPct: null, slippageBps: 50, route: [], realizedLamports: 0n, paper: true as const,
    });
    l.record({ fill: fill(NOW - HOUR, 'buy', 1_000_000_000n, 1_000_000_000_000n), network: 'mainnet', signature: SIG1, usd: null });
    l.record({ fill: fill(NOW - HOUR + 1, 'buy', 1n, 1n), network: 'mainnet', signature: 'probe-sig', usd: null, kind: 'probe' });
    l.record({ fill: fill(NOW - MIN, 'sell', 1_300_000_000n, 1_000_000_000_000n), network: 'mainnet', signature: SIG2, usd: null });
    l.close();
    const rows = new LivePositions(path).fills(MINT_GLYPH);
    assert.deepEqual(rows.map((r) => r.signature), [SIG2, SIG1], 'newest first, the probe excluded');
    const s = computeCard(liveCardInput(rows, { mint: MINT_GLYPH, wallet: WALLET }), NOW);
    assert.equal(s.input.network, 'mainnet'); assert.equal(fmtPnlPct(s.pnlPct), '+30.0%');
    assert.deepEqual(new LivePositions(join(dir, 'missing.sqlite')).fills(MINT_GLYPH), [], 'no ledger file reads as no fills');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
