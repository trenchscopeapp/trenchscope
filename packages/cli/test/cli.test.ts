import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { parseArgs, stateFromArgs, applyAction, colorDepthFor, main, HELP, makeFixtureState, renderFrame } from '../src/index.ts';
import type { ScreenKey } from '@dexterm/tui';

function fakeIo(env: NodeJS.ProcessEnv = {}, isTTY = false) {
  let out = '';
  let err = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY, columns: 120, rows: 40 });
  Object.assign(stderr, { isTTY });
  const stdin = { isTTY } as unknown as NodeJS.ReadStream & { fd: 0 };
  return { io: { stdout, stderr, stdin, env }, out: () => out, err: () => err };
}

test('parseArgs reads the prototype flags', () => {
  const a = parseArgs(['--screen', 'token', '--fixtures', '--width', '120', '--height', '40', '--theme', 'ember', '--selected', '3', '--seed', '9', '--no-ai', '--plain', '--color', '256', '--tz', 'UTC']);
  assert.equal(a.screen, 'token');
  assert.equal(a.fixtures, true);
  assert.equal(a.width, 120);
  assert.equal(a.height, 40);
  assert.equal(a.theme, 'ember');
  assert.equal(a.selected, 3);
  assert.equal(a.seed, 9);
  assert.equal(a.noAi, true);
  assert.equal(a.plain, true);
  assert.equal(a.color, '256');
  assert.equal(a.tz, 'UTC');
});

test('parseArgs rejects bad screens, numbers and color depths', () => {
  assert.throws(() => parseArgs(['--screen', 'nope']), /unknown screen/);
  assert.throws(() => parseArgs(['--width', 'wide']), /expects a number/);
  assert.throws(() => parseArgs(['--color', 'rainbow']), /unknown color depth/);
  assert.deepEqual(parseArgs(['--bogus']).unknown, ['--bogus']);
});

test('stateFromArgs rejects unknown themes and sets the token for the token screen', () => {
  assert.throws(() => stateFromArgs(parseArgs(['--fixtures', '--theme', 'neon'])), /unknown theme/);
  assert.equal(stateFromArgs(parseArgs(['--fixtures', '--theme', 'cyberspace'])).theme.name, 'cyberspace');
  const s = stateFromArgs(parseArgs(['--fixtures', '--screen', 'token', '--selected', '2']));
  assert.equal(s.screen, 'token');
  assert.equal(s.token, s.fx.tokens[2]);
  assert.equal(s.timeZone, 'America/New_York');
  assert.equal(stateFromArgs(parseArgs(['--fixtures', '--tz', 'UTC'])).timeZone, 'UTC');
  assert.equal(stateFromArgs(parseArgs(['--fixtures', '--tz', 'local'])).timeZone, undefined);
});

test('main: --help prints usage, DEXTERM_OFFLINE refuses live data, unknown options fail', async () => {
  const h = fakeIo();
  assert.equal(await main(['--help'], h.io), 0);
  assert.equal(h.out().trim(), HELP);
  const n = fakeIo({ DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'screener'], n.io), 2);
  assert.match(n.err(), /DEXTERM_OFFLINE/);
  assert.match(n.err(), /--fixtures or --replay/);
  const u = fakeIo();
  assert.equal(await main(['--fixtures', '--wat'], u.io), 2);
  assert.match(u.err(), /unknown option --wat/);
  const i = fakeIo({ DEXTERM_OFFLINE: '1' });
  assert.equal(await main([], i.io), 1, 'interactive without a TTY');
  assert.match(i.err(), /needs a TTY/);
});

test('parseArgs: screener flags, their errors and exclusive modes', () => {
  const a = parseArgs(['--replay', 'x.json', '--filter', 'vol24 > 1M', '--sort', 'liq:asc', '--preset', 'Organic', '--max-requests', '10', '--db', 'z.db', '--verbose']);
  assert.equal(a.replay, 'x.json');
  assert.equal(parseArgs(['--record', 'y.json']).record, 'y.json');
  assert.equal(a.filter, 'vol24 > 1M');
  assert.deepEqual(a.sort, { key: 'liq', dir: 'asc' });
  assert.equal(a.preset, 'organic');
  assert.equal(a.maxRequests, 10);
  assert.equal(a.db, 'z.db');
  assert.equal(a.verbose, true);
  assert.throws(() => parseArgs(['--filter', 'vol24 >']), /bad --filter at column 8: "vol24 >" needs a value/);
  assert.throws(() => parseArgs(['--sort', 'wat']), /unknown sort key/);
  assert.throws(() => parseArgs(['--preset', 'moon']), /unknown preset moon/);
  assert.throws(() => parseArgs(['--fixtures', '--replay', 'x']), /exclusive/);
  assert.throws(() => parseArgs(['--fixtures', '--record', 'x']), /--record needs live data/);
});

test('main: --fixtures with --filter/--sort/--preset renders the filtered, sorted table', async () => {
  const f = fakeIo();
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--width', '120', '--height', '30', '--plain', '--filter', 'launchpad:pump', '--sort', 'liq'], f.io), 0);
  assert.match(f.out(), /⌕ launchpad:pump/);
  assert.match(f.out(), /of 34 tokens · sorted by liquidity/);
  assert.match(f.out(), /▼ LIQ/);
  const p = fakeIo();
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--width', '120', '--height', '30', '--plain', '--preset', 'graduating'], p.io), 0, 'fixtures mode offers every preset');
  const bad = fakeIo();
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--filter', 'liq > 50X'], bad.io), 2);
  assert.match(bad.err(), /unknown unit "x"/);
});

test('main: --replay renders a frame from a recording without the network and matches the library render', async () => {
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const sample = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'fixtures', 'live-sample.json');
  const f = fakeIo({ DEXTERM_OFFLINE: '1' });
  // `--db :memory:`: never open the user's real default database from a test (a running `trenchscope record run`
  // holding its write lock made this exit 2 with "database is locked" under the parallel suite).
  assert.equal(await main(['--screen', 'screener', '--replay', sample, '--width', '120', '--height', '40', '--plain', '--selected', '3', '--db', ':memory:'], f.io), 0);
  const { createReplayFeed, makeFeedState } = await import('../src/index.ts');
  const feed = createReplayFeed(sample);
  await feed.refresh();
  const want = renderFrame(makeFeedState(feed, 'replay', { selected: 3 }), 120, 40).toPlain() + '\n';
  feed.close();
  assert.equal(f.out(), want);
  assert.match(f.out(), /30 tokens/);
  assert.equal(f.err(), '', 'a clean replay logs nothing');
});

test('main: one-shot plain render matches renderFrame', async () => {
  const f = fakeIo();
  assert.equal(await main(['--screen', 'watchlist', '--fixtures', '--width', '120', '--height', '30', '--plain', '--selected', '1'], f.io), 0);
  const want = renderFrame(makeFixtureState({ screen: 'watchlist', selected: 1 }), 120, 30).toPlain() + '\n';
  assert.equal(f.out(), want);
});

test('main: non-TTY stdout without --ansi falls back to plain', async () => {
  const f = fakeIo({ COLORTERM: 'truecolor' });
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--width', '100', '--height', '20'], f.io), 0);
  assert.ok(!f.out().includes('\x1b['), 'no escape codes expected');
});

test('main: --ansi on a pipe implies 24-bit colour (no --color, no COLORTERM needed); NO_COLOR still wins', async () => {
  const piped = fakeIo({});
  await main(['--screen', 'screener', '--fixtures', '--width', '100', '--height', '20', '--ansi'], piped.io);
  assert.match(piped.out(), /\x1b\[0;38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+m/, '--ansi without --color on a non-TTY must carry 24-bit colour');
  assert.doesNotMatch(piped.out(), /38;5;/);
  assert.equal(colorDepthFor({ color: null, ansi: true }, {}, false), 'truecolor');
  assert.equal(colorDepthFor({ color: null, ansi: true }, { NO_COLOR: '1' }, false), 'none');
  assert.equal(colorDepthFor({ color: '256', ansi: true }, {}, false), '256');
  assert.equal(colorDepthFor({ color: null, ansi: false }, { TERM: 'xterm-256color' }, true), '256', 'TTY detection unchanged');
  assert.equal(colorDepthFor({ color: null, ansi: true }, { TERM: 'xterm-256color' }, true), '256', 'on a real TTY --ansi defers to detection');
  const nc2 = fakeIo({ NO_COLOR: '1' });
  await main(['--screen', 'screener', '--fixtures', '--width', '100', '--height', '20', '--ansi'], nc2.io);
  assert.doesNotMatch(nc2.out(), /38;[25];/);
});

test('main: --ansi emits 24-bit SGR when COLORTERM=truecolor, 256 when forced, none under NO_COLOR', async () => {
  const tc = fakeIo({ COLORTERM: 'truecolor' });
  await main(['--screen', 'screener', '--fixtures', '--width', '100', '--height', '20', '--ansi', '--color', 'truecolor'], tc.io);
  assert.match(tc.out(), /\x1b\[0;38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+m/);
  assert.doesNotMatch(tc.out(), /38;5;/);

  const c256 = fakeIo();
  await main(['--screen', 'screener', '--fixtures', '--width', '100', '--height', '20', '--ansi', '--color', '256'], c256.io);
  assert.match(c256.out(), /38;5;\d+;48;5;\d+m/);
  assert.doesNotMatch(c256.out(), /38;2;/);

  const nc = fakeIo({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true);
  await main(['--screen', 'screener', '--fixtures', '--width', '100', '--height', '20', '--ansi'], nc.io);
  assert.doesNotMatch(nc.out(), /38;[25];/);
  assert.doesNotMatch(nc.out(), /48;[25];/);
  assert.match(nc.out(), /\x1b\[0;1m/, 'bold attribute still emitted without color');
});

test('main: --html writes a page', async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fakeIo();
  const file = join(dir, 'x.html');
  assert.equal(await main(['--screen', 'token', '--fixtures', '--width', '120', '--height', '40', '--html', file, '--title', 'T'], f.io), 0);
  const html = readFileSync(file, 'utf8');
  assert.match(html, /<title>T<\/title>/);
  assert.match(html, /ANALYST · claude/);
});

test('applyAction walks the prototype key model', () => {
  const s = makeFixtureState({ screen: 'screener' });
  const stack: ScreenKey[] = [];
  applyAction(s, 'move.down', stack); applyAction(s, 'move.down', stack);
  assert.equal(s.selected, 2);
  applyAction(s, 'move.up', stack);
  assert.equal(s.selected, 1);
  applyAction(s, 'open', stack);
  assert.equal(s.screen, 'token');
  assert.equal(s.token, s.fx.tokens[1]);
  applyAction(s, 'analyst.toggle', stack);
  assert.equal(s.aiOpen, false);
  applyAction(s, 'back', stack);
  assert.equal(s.screen, 'screener');
  applyAction(s, 'screen.next', stack);
  assert.equal(s.screen, 'newpairs');
  applyAction(s, 'screen.watchlist', stack);
  applyAction(s, 'open', stack);
  assert.equal(s.screen, 'token');
  assert.equal(s.token, s.fx.watch[0].token, 'watch rows open their token');
  assert.equal(s.theme.name, 'mono', 'mono is the default theme');
  applyAction(s, 'theme.next', stack);
  assert.equal(s.theme.name, 'slate');
  applyAction(s, 'pause.toggle', stack);
  assert.equal(s.paused, true);
  assert.equal(applyAction(s, 'quit', stack), 'quit');
  for (let i = 0; i < 100; i++) applyAction(s, 'move.down', stack);
  assert.equal(s.selected, s.fx.tokens.length - 1, 'selection clamps to the last row');
});

test('renders at the minimum supported size without throwing', () => {
  for (const screen of ['screener', 'token', 'newpairs', 'watchlist', 'analyst'] as const) {
    const c = renderFrame(makeFixtureState({ screen }), 80, 24);
    assert.equal(c.toPlain().split('\n').length, 24);
  }
});

test('task-1376: --version and the help banner match packages/cli/package.json (release.yml refuses a tag that differs)', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(pkg.version, '0.1.5');
  const v = fakeIo();
  assert.equal(await main(['--version'], v.io), 0);
  assert.equal(v.out(), `${pkg.version}\n`);
  assert.ok(HELP.startsWith(`trenchscope ${pkg.version} `), 'the help banner names the package version');
});
