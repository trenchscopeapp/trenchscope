// task-1414: the headless collector command — the loop (observe / maintain scheduling + the soft disk cap +
// clean abort), the generated launchd plist, and the install/status/uninstall subcommands over a temp HOME.
// No network: the loop is driven by a fake CollectorEngine; the production engine (buildLiveEngine) is only
// exercised by a real `trenchscope record run --once` smoke, documented in the handoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  runCollectorLoop, renderCollectorPlist, plistPath, recordCommand, parseRun as parseRunForTest,
  COLLECTOR_LABEL, type CollectorEngine, type CollectorLoopOptions,
} from '../src/record-cmd.ts';

function sink() {
  const chunks: string[] = [];
  return { w: new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }), text: () => chunks.join('') };
}
function io(env: NodeJS.ProcessEnv = {}) {
  const out = sink(); const err = sink();
  return { io: { stdout: out.w, stderr: err.w, env }, out, err };
}

/** A fake engine with a programmable DB size and a clock the loop's sleep advances. */
function fakeEngine(over: { dbBytes: number; pruneTo?: number } = { dbBytes: 0 }) {
  const calls = { observe: 0, maintain: 0, prune: 0, close: 0, rows: 0 };
  let size = over.dbBytes;
  const engine: CollectorEngine = {
    async observe() { calls.observe++; calls.rows += 2; return 2; },
    async maintain() { calls.maintain++; },
    prune() { calls.prune++; if (over.pruneTo !== undefined) size = over.pruneTo; },
    dbBytes() { return size; },
    newPairs() { return 0; },
    close() { calls.close++; },
  };
  return { engine, calls, setSize: (n: number) => { size = n; } };
}

function clockedLoop(ticks: number, extra: Partial<CollectorLoopOptions> = {}) {
  let t = 0;
  const stop = { aborted: false };
  const opts: CollectorLoopOptions = {
    intervalMs: 1000, ticks, maintainEveryMs: 60_000, maxDbBytes: null,
    now: () => t, sleep: async (ms) => { t += ms; }, aborted: () => stop.aborted,
    ...extra,
  };
  return { opts, stop };
}

test('loop: observes each tick and maintains on the first tick, then at the maintain interval', async () => {
  const { engine, calls } = fakeEngine();
  const { opts } = clockedLoop(5, { intervalMs: 1000, maintainEveryMs: 2000 });
  const r = await runCollectorLoop(engine, opts);
  assert.equal(r.observePasses, 5);
  assert.equal(r.rowsWritten, 10);
  // maintain at t=0, then when now-last ≥ 2000: ticks land at t=0,1000,2000,3000,4000 → maintain at 0,2000,4000
  assert.equal(calls.maintain, 3, `maintain passes: ${calls.maintain}`);
  assert.equal(r.ticks, 5);
});

test('loop: a soft disk cap pauses observation when a forced prune cannot bring it under', async () => {
  const { engine, calls } = fakeEngine({ dbBytes: 2_000_000 }); // over, prune does nothing
  const { opts } = clockedLoop(3, { maxDbBytes: 1_000_000 });
  const r = await runCollectorLoop(engine, opts);
  assert.equal(r.cappedTicks, 3, 'every tick is capped');
  assert.equal(r.observePasses, 0, 'observation never runs while over the cap');
  assert.equal(calls.prune, 3, 'a forced prune is attempted each capped tick');
  assert.ok(calls.maintain >= 1, 'maintenance still runs while capped');
});

test('loop: prune under the cap lets observation resume the same tick', async () => {
  const { engine, calls } = fakeEngine({ dbBytes: 2_000_000, pruneTo: 500_000 });
  const { opts } = clockedLoop(2, { maxDbBytes: 1_000_000 });
  const r = await runCollectorLoop(engine, opts);
  assert.equal(r.cappedTicks, 0);
  assert.equal(r.observePasses, 2);
  assert.equal(calls.prune, 1, 'pruned once on the first tick, then under the cap');
});

test('loop: abort stops before the next observe and the engine is closed by the caller', async () => {
  const { engine, calls } = fakeEngine();
  const { opts, stop } = clockedLoop(Infinity, { sleep: async () => { stop.aborted = true; } });
  const r = await runCollectorLoop(engine, opts);
  assert.equal(r.observePasses, 1, 'first tick runs, then the abort during the sleep stops the loop');
  assert.equal(calls.close, 0, 'the loop does not close the engine; the command does');
});

test('loop: an engine error is swallowed and the loop continues', async () => {
  let n = 0;
  const engine: CollectorEngine = {
    async observe() { n++; if (n === 1) throw new Error('boom'); return 1; },
    async maintain() {}, prune() {}, dbBytes() { return 0; }, newPairs() { return 0; }, close() {},
  };
  const { opts } = clockedLoop(2);
  const r = await runCollectorLoop(engine, opts);
  assert.equal(r.ticks, 2, 'the loop did not throw out');
  assert.equal(r.observePasses, 1, 'only the second observe succeeded');
});

test('plist: user-level LaunchAgent with KeepAlive, background priority, the record args and XML-escaped paths', () => {
  const xml = renderCollectorPlist({
    label: COLLECTOR_LABEL, nodePath: '/usr/bin/node', binPath: '/opt/d&d/bin/dexterm.mjs',
    intervalMs: 90_000, maxDbMb: 512, logPath: '/tmp/c.log', workingDir: '/opt/app',
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>xyz\.dexterm\.collector<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(xml, /<string>record<\/string>/);
  assert.match(xml, /<string>--interval<\/string>\s*<string>90<\/string>/, 'ms rendered as seconds');
  assert.match(xml, /<string>--max-db-mb<\/string>\s*<string>512<\/string>/);
  assert.match(xml, /\/opt\/d&amp;d\/bin\/dexterm\.mjs/, 'ampersand escaped');
  assert.doesNotMatch(xml, /sudo|LaunchDaemon/, 'user-level agent, no sudo');
});

test('parseRun: defaults, --once, cap off, and bad values', () => {
  const ok = (argv: string[]): { ticks: number; maxDbBytes: number | null; noNewpairs: boolean } => {
    const r = parseRunForTest(argv);
    assert.ok(!('error' in r), `expected ok for ${argv.join(' ')}`);
    return r;
  };
  const d = ok([]);
  assert.ok(d.ticks === Infinity && d.maxDbBytes !== null && !d.noNewpairs);
  assert.equal(ok(['--once']).ticks, 1);
  assert.equal(ok(['--max-db-mb', '0']).maxDbBytes, null, '0 = no cap');
  assert.ok(ok(['--no-newpairs']).noNewpairs);
  assert.ok('error' in parseRunForTest(['--ticks', '0']));
  assert.ok('error' in parseRunForTest(['--bogus']));
});

test('install --dry-run prints the plist and writes nothing; install writes a user-level plist; uninstall removes it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rec-1414-'));
  try {
    const env = { HOME: home, DEXTERM_DB_PATH: join(home, 'd.db') };
    const dry = io(env);
    assert.equal(await recordCommand(['install', '--dry-run', '--interval', '120'], dry.io as never), 0);
    assert.match(dry.out.text(), /<key>Label<\/key>/);
    assert.ok(!existsSync(plistPath(env)), 'dry run writes no file');

    const ins = io(env);
    assert.equal(await recordCommand(['install', '--interval', '120', '--max-db-mb', '256'], ins.io as never), 0);
    assert.ok(existsSync(plistPath(env)), 'plist written');
    const written = readFileSync(plistPath(env), 'utf8');
    assert.match(written, /--interval<\/string>\s*<string>120<\/string>/);
    assert.match(ins.out.text(), /launchctl bootstrap gui/);
    assert.match(ins.err.text(), /NOT loaded/, 'never loads launchctl without --load');

    const un = io(env);
    assert.equal(await recordCommand(['uninstall'], un.io as never), 0);
    assert.ok(!existsSync(plistPath(env)), 'plist removed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('status reports the LaunchAgent state and the login caveat', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rec-1414s-'));
  try {
    const env = { HOME: home };
    const s = io(env);
    assert.equal(await recordCommand(['status', '--db', ':memory:'], s.io as never), 0);
    assert.match(s.out.text(), /not installed/);
    assert.match(s.out.text(), /do not start before login/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('run with an injected engine: --once observes once and closes the engine', async () => {
  const { engine, calls } = fakeEngine();
  const r = io({ DEXTERM_DB_PATH: '/tmp/never-opened.db' });
  const code = await recordCommand(['run', '--once'], r.io as never, { engine, now: () => 0 });
  assert.equal(code, 0, r.err.text());
  assert.equal(calls.observe, 1);
  assert.equal(calls.close, 1, 'the command closes the engine it was given');
});
