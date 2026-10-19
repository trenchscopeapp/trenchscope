// trenchscope — `trenchscope record` (task-1414): a HEADLESS collector that keeps the history recorder fed when
// nobody has the TUI open. The recorder (task-1329) only grows while the interactive app runs; the backtest
// (task-1401) is only worth re-running on fresh data, so this command runs the exact same recorder jobs
// (observe snapshots + feed membership, the 1 h/2 h/6 h/24 h/72 h outcome sweeps, labels, retention) with no
// TUI, to be driven by a user-level launchd LaunchAgent on the Mac mini.
//
//   trenchscope record [run] [--interval S] [--ticks N | --once] [--maintain S] [--max-db-mb N] [--no-newpairs] [--db PATH] [--verbose]
//   trenchscope record install   [--interval S] [--max-db-mb N] [--load] [--dry-run]
//   trenchscope record uninstall [--unload]
//   trenchscope record status    [--db PATH]
//
// SAFETY / BUDGETS: this builds the keyless live feed and the recorder exactly as the live app does, so every
// request goes through the data layer's rate limiter + health gate and the sweep's own per-sweep / per-day caps
// (DEFAULT_SWEEP). It never builds a signer, never trades, never prints the Helius key (the URL is built inside
// the data layer; only the provider name is ever logged). Modest CPU: one feed refresh per `--interval` (60 s
// default) and recorder maintenance at most every `--maintain` seconds. A soft disk cap pauses OBSERVATION
// (the growth source) above `--max-db-mb` while labels + retention keep running, so the DB cannot run away.
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDbPath, resolveRpcUrl, resolveTrackerKey, resolveShrineKey, extraRpcUrls, redactSecrets, type DataLayer } from '@dexterm/data';
import { PumpPortalClient } from '@dexterm/data';
import { Recorder, recorderEnabled } from '@dexterm/recorder';
import { createLiveFeed } from './feed.ts';
import { NewPairsLive } from './live/index.ts';

export interface RecordIo { stdout: { write(s: string): void }; stderr: { write(s: string): void }; env: NodeJS.ProcessEnv }

/** The LaunchAgent label (reverse-DNS). One collector per user. */
export const COLLECTOR_LABEL = 'xyz.dexterm.collector';
/** Default spacing between feed refreshes (one observation pass). Background work: keep it unhurried. */
export const DEFAULT_INTERVAL_MS = 60_000;
/** Default spacing between recorder maintenance passes (sweeps/labels/retention). */
export const DEFAULT_MAINTAIN_MS = 60_000;
/** Default soft cap on the whole DB file. Above it, observation pauses; sweeps/labels/retention continue. */
export const DEFAULT_MAX_DB_MB = 1024;

// ---------------------------------------------------------------- the collector engine (production + test seam)

/** What the collector loop drives. The production engine wraps the live feed + recorder; tests inject a fake. */
export interface CollectorEngine {
  /** One observation pass (a feed refresh): the recorder writes snapshots via the store listener. Returns rows written. */
  observe(): Promise<number>;
  /** Recorder maintenance: the outcome sweep (budgeted, low priority), labelling, and retention. */
  maintain(): Promise<void>;
  /** Force a retention pass now (disk-cap recovery). */
  prune(): void;
  /** Whole DB file size in bytes (cheap PRAGMA), or null when unavailable. */
  dbBytes(): number | null;
  /** New-pair mints currently tracked from the PumpPortal stream (diagnostics). */
  newPairs(): number;
  /** Close: labels whatever outcomes are due, then releases the DB + stream. */
  close(): void;
}

/** Build the real collector engine: the keyless live feed, the recorder attached to its store, and (unless
 *  disabled) the PumpPortal new-pairs stream folded into the feed's candidate pool so fresh launches get
 *  recorded before the REST feeds index them. */
export function buildLiveEngine(env: NodeJS.ProcessEnv, opts: { dbPath: string; noNewpairs?: boolean; verbose?: boolean; onLog?: (s: string) => void }): CollectorEngine {
  const rpc = resolveRpcUrl({ env });
  const feed = createLiveFeed({
    dbPath: opts.dbPath, rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl, rpcPublicPool: true, rpcExtraUrls: extraRpcUrls(env), trackerKey: resolveTrackerKey({ env })?.key ?? null,
    shrineKey: resolveShrineKey({ env })?.key ?? null,
    onRequest: opts.verbose ? (req, meta, o) => opts.onLog?.(`  ${meta.source.padEnd(14)} ${String(o.status ?? 'ERR').padStart(3)} ${String(o.latencyMs).padStart(5)}ms ${redactSecrets(req.url).slice(0, 110)}\n`) : undefined,
  });
  const recorder = new Recorder({ path: opts.dbPath, onLog: opts.verbose ? opts.onLog : undefined });
  recorder.attach(feed.dl.store);
  let newpairs: NewPairsLive | null = null;
  if (!opts.noNewpairs) {
    newpairs = new NewPairsLive(feed.dl, {});
    // 0.1.5 dev history: keep the creator of every new pair in the recorder's creator index.
    newpairs.onCreator = (mint, creator, source, createdAt) => { recorder.recordCreator(mint, creator, source, undefined, createdAt); };
    const client = new PumpPortalClient({ health: feed.dl.health, clock: feed.dl.clock, onEvent: (ev) => newpairs!.handleEvent(ev), onStatus: () => {} });
    newpairs.attach(client, 'live');
    newpairs.start();
    const np = newpairs;
    feed.extraMints = () => [...np.rows.keys()];
  }
  const dl: DataLayer = feed.dl;
  return {
    async observe(): Promise<number> {
      const before = recorder.counters.written;
      await feed.refresh();
      return recorder.counters.written - before;
    },
    async maintain(): Promise<void> { await recorder.maintain(dl); },
    prune(): void { try { recorder.prune(); } catch { /* logged inside; never fatal */ } },
    dbBytes(): number | null {
      try {
        const db = recorder.database;
        const pc = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
        const ps = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
        return Number(pc) * Number(ps);
      } catch { return null; }
    },
    newPairs(): number { return newpairs ? newpairs.rows.size : 0; },
    close(): void {
      try { newpairs?.stop(); } catch { /* ignore */ }
      try { feed.close(); } catch { /* ignore */ }
      try { recorder.close(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------- the loop (pure over the engine + clock)

export interface CollectorLoopOptions {
  intervalMs: number;
  /** How many observation ticks to run; Infinity for the service. */
  ticks: number;
  maintainEveryMs: number;
  /** Soft cap on the whole DB file in bytes; null = off. */
  maxDbBytes: number | null;
  now: () => number;
  /** Cancellable sleep (resolves early on abort). */
  sleep: (ms: number) => Promise<void>;
  /** True once a stop was requested. */
  aborted: () => boolean;
  onLog?: (s: string) => void;
}

export interface CollectorRunResult {
  ticks: number;
  observePasses: number;
  rowsWritten: number;
  maintainPasses: number;
  cappedTicks: number;
}

/**
 * Drive the engine. Each tick (after the first waits `intervalMs`): if a disk cap is set and the DB is at/over
 * it, force a retention pass; if it is still over, SKIP observation this tick (so the growth source pauses) but
 * keep running maintenance. Otherwise observe one pass. Maintenance runs at most every `maintainEveryMs`.
 * Never throws out of the loop: an engine error is logged and the loop continues to the next tick.
 */
export async function runCollectorLoop(engine: CollectorEngine, opts: CollectorLoopOptions): Promise<CollectorRunResult> {
  const res: CollectorRunResult = { ticks: 0, observePasses: 0, rowsWritten: 0, maintainPasses: 0, cappedTicks: 0 };
  let lastMaintain = -Infinity;
  for (let i = 0; i < opts.ticks && !opts.aborted(); i++) {
    if (i > 0) { await opts.sleep(opts.intervalMs); if (opts.aborted()) break; }
    res.ticks++;
    let over = false;
    if (opts.maxDbBytes !== null) {
      const b = engine.dbBytes();
      if (b !== null && b >= opts.maxDbBytes) {
        engine.prune();
        const b2 = engine.dbBytes();
        over = b2 !== null && b2 >= opts.maxDbBytes;
        if (over) { res.cappedTicks++; opts.onLog?.(`record: DB at ${(b2! / 1e6).toFixed(0)} MB ≥ cap ${(opts.maxDbBytes / 1e6).toFixed(0)} MB — observation paused this tick (labels + retention still run)\n`); }
      }
    }
    if (!over) {
      try { res.rowsWritten += await engine.observe(); res.observePasses++; } catch (e) { opts.onLog?.(`record: observe failed: ${redactSecrets((e as Error).message)}\n`); }
    }
    const now = opts.now();
    if (now - lastMaintain >= opts.maintainEveryMs) {
      lastMaintain = now;
      try { await engine.maintain(); res.maintainPasses++; } catch (e) { opts.onLog?.(`record: maintain failed: ${redactSecrets((e as Error).message)}\n`); }
    }
  }
  return res;
}

// ---------------------------------------------------------------- the launchd plist (generated, user-level)

export interface PlistOptions {
  label: string;
  /** Absolute node executable. */
  nodePath: string;
  /** Absolute path to the trenchscope bin (or the compiled CLI entry). */
  binPath: string;
  intervalMs: number;
  maxDbMb: number;
  /** Where the agent writes its stdout/stderr. */
  logPath: string;
  /** The collector's working directory (the checkout, so the source bin resolves its workspaces). */
  workingDir: string;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A user-level LaunchAgent (no sudo). KeepAlive so a crash or a reboot-after-login brings it back, RunAtLoad,
 * ProcessType Background + Nice 10 + Low throttling so it never competes with foreground work, and a
 * ThrottleInterval so a crash-loop cannot spin. It writes to `logPath`. NOTE (documented, and in `install`
 * output): a LaunchAgent does NOT start before the user logs in — this Mac must be logged in for the
 * collector to run; a true pre-login daemon would be a LaunchDaemon under sudo, which this task does not use.
 */
export function renderCollectorPlist(o: PlistOptions): string {
  const args = [o.nodePath, o.binPath, 'record', 'run', '--interval', String(Math.round(o.intervalMs / 1000)), '--max-db-mb', String(o.maxDbMb)];
  const argXml = args.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(o.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(o.logPath)}</string>
</dict>
</plist>
`;
}

/** `~/Library/LaunchAgents/<label>.plist` for the invoking user (HOME from env). */
export function plistPath(env: NodeJS.ProcessEnv, label = COLLECTOR_LABEL): string {
  const home = env.HOME || env.USERPROFILE || '';
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

/** The data directory that holds the DB (and the collector log), from the resolved DB path. */
function dataDir(env: NodeJS.ProcessEnv, db?: string): string {
  return dirname(db && db !== ':memory:' ? db : defaultDbPath(env));
}

/** The source bin shim this file ships next to (…/packages/cli/bin/dexterm.mjs). */
function sourceBin(): string {
  return fileURLToPath(new URL('../bin/dexterm.mjs', import.meta.url));
}

// ---------------------------------------------------------------- arg parsing + the command

interface RunArgs { intervalMs: number; ticks: number; maintainMs: number; maxDbBytes: number | null; noNewpairs: boolean; db: string | null; verbose: boolean }

export function parseRun(argv: string[]): RunArgs | { error: string } {
  const a: RunArgs = { intervalMs: DEFAULT_INTERVAL_MS, ticks: Infinity, maintainMs: DEFAULT_MAINTAIN_MS, maxDbBytes: DEFAULT_MAX_DB_MB * 1_000_000, noNewpairs: false, db: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--verbose' || t === '-v') a.verbose = true;
    else if (t === '--no-newpairs') a.noNewpairs = true;
    else if (t === '--once') a.ticks = 1;
    else if (t === '--ticks') { const n = Number(argv[++i]); if (!Number.isInteger(n) || n < 1) return { error: '--ticks needs an integer ≥ 1' }; a.ticks = n; }
    else if (t === '--interval') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) return { error: '--interval needs seconds ≥ 1' }; a.intervalMs = Math.round(n * 1000); }
    else if (t === '--maintain') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) return { error: '--maintain needs seconds ≥ 1' }; a.maintainMs = Math.round(n * 1000); }
    else if (t === '--max-db-mb') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 0) return { error: '--max-db-mb needs a number ≥ 0 (0 = no cap)' }; a.maxDbBytes = n === 0 ? null : Math.round(n * 1_000_000); }
    else if (t === '--db') { a.db = argv[++i] ?? null; if (!a.db) return { error: '--db needs a PATH' }; }
    else return { error: `unknown option "${t}"` };
  }
  return a;
}

export const RECORD_USAGE = `trenchscope record: keep the history recorder fed with no TUI open (task-1414).

  trenchscope record [run] [--interval S] [--ticks N | --once] [--maintain S] [--max-db-mb N] [--no-newpairs] [--db PATH] [--verbose]
  trenchscope record install   [--interval S] [--max-db-mb N] [--load] [--dry-run]
  trenchscope record uninstall [--unload]
  trenchscope record status    [--db PATH]

run        the collector loop: one keyless feed refresh per --interval (default 60 s) feeds the recorder
           (snapshots + feed membership + new pairs), recorder maintenance (outcome sweeps, labels, retention)
           every --maintain seconds. --max-db-mb is a soft cap (default 1024): above it observation pauses while
           labels + retention keep running. --no-newpairs drops the PumpPortal stream. Ctrl-C stops cleanly
           (labels whatever is due). Requests honour the data layer's rate limits, health gate and sweep budgets.
install    write a user-level launchd LaunchAgent (no sudo) that runs \`record run\`; prints the launchctl
           command. --load also runs launchctl (off by default). --dry-run prints the plist, writes nothing.
uninstall  remove the LaunchAgent plist; --unload also runs launchctl bootout.
status     recorder stats + whether the LaunchAgent is installed + DB size vs the cap.

NOTE: a LaunchAgent does not start before the user logs in on this Mac (it is not a pre-login daemon). The
collector runs only while this user is logged in. Free-tier APIs only; the Helius key is never printed.`;

export async function recordCommand(argv: string[], io: RecordIo, deps: { engine?: CollectorEngine; now?: () => number } = {}): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;
  if (sub === 'help' || argv.includes('--help') || argv.includes('-h')) { io.stdout.write(RECORD_USAGE + '\n'); return 0; }
  if (sub === 'install') return install(rest, io);
  if (sub === 'uninstall') return uninstall(rest, io);
  if (sub === 'status') return status(rest, io);
  if (sub === 'run') return run(rest, io, deps);
  io.stderr.write(`trenchscope record: unknown subcommand "${sub}"\n\n${RECORD_USAGE}\n`);
  return 2;
}

async function run(argv: string[], io: RecordIo, deps: { engine?: CollectorEngine; now?: () => number }): Promise<number> {
  const parsed = parseRun(argv);
  if ('error' in parsed) { io.stderr.write(`trenchscope record: ${parsed.error}\n\n${RECORD_USAGE}\n`); return 2; }
  const now = deps.now ?? (() => Date.now());
  const dbPath = parsed.db ?? defaultDbPath(io.env);
  if (!deps.engine && dbPath === ':memory:') { io.stderr.write('trenchscope record: an in-memory DB keeps no history; give a --db PATH\n'); return 2; }
  if (!deps.engine && !recorderEnabled(io.env, false)) { io.stderr.write('trenchscope record: the recorder is disabled (DEXTERM_RECORDER=0); nothing to collect\n'); return 2; }

  // SIGINT/SIGTERM-aware cancellable sleeper (launchd sends SIGTERM to stop the agent).
  const stop = (() => {
    let aborted = false; let wake: () => void = () => {};
    return {
      get aborted() { return aborted; },
      abort() { aborted = true; wake(); },
      sleep(ms: number): Promise<void> { return new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); wake = () => { clearTimeout(t); r(); }; }); },
    };
  })();

  const log = (s: string): void => io.stderr.write(s);
  const engine = deps.engine ?? buildLiveEngine(io.env, { dbPath, noNewpairs: parsed.noNewpairs, verbose: parsed.verbose, onLog: log });
  const own = !deps.engine;
  const onSig = (): void => { io.stderr.write('\ndexterm record: stopping…\n'); stop.abort(); };
  if (own) { process.on('SIGINT', onSig); process.on('SIGTERM', onSig); }
  if (parsed.verbose || parsed.ticks !== Infinity) io.stderr.write(`trenchscope record: db ${dbPath} · interval ${Math.round(parsed.intervalMs / 1000)}s · maintain ${Math.round(parsed.maintainMs / 1000)}s · cap ${parsed.maxDbBytes === null ? 'off' : `${Math.round(parsed.maxDbBytes / 1e6)} MB`} · newpairs ${parsed.noNewpairs ? 'off' : 'on'}\n`);

  let result: CollectorRunResult;
  try {
    result = await runCollectorLoop(engine, {
      intervalMs: parsed.intervalMs, ticks: parsed.ticks, maintainEveryMs: parsed.maintainMs, maxDbBytes: parsed.maxDbBytes,
      now, sleep: (ms) => stop.sleep(ms), aborted: () => stop.aborted, onLog: log,
    });
  } finally {
    if (own) { process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig); }
    engine.close();
  }
  if (parsed.verbose || parsed.ticks !== Infinity) io.stdout.write(`record: ${result.observePasses} observe pass(es), ${result.rowsWritten} snapshot row(s), ${result.maintainPasses} maintenance pass(es)${result.cappedTicks ? `, ${result.cappedTicks} tick(s) paused at the disk cap` : ''}\n`);
  return 0;
}

function install(argv: string[], io: RecordIo): number {
  let intervalMs = DEFAULT_INTERVAL_MS, maxDbMb = DEFAULT_MAX_DB_MB, load = false, dry = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--load') load = true;
    else if (t === '--dry-run') dry = true;
    else if (t === '--interval') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) { io.stderr.write('trenchscope record: --interval needs seconds ≥ 1\n'); return 2; } intervalMs = Math.round(n * 1000); }
    else if (t === '--max-db-mb') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) { io.stderr.write('trenchscope record: --max-db-mb needs a number ≥ 1\n'); return 2; } maxDbMb = n; }
    else { io.stderr.write(`trenchscope record install: unknown option "${t}"\n`); return 2; }
  }
  const path = plistPath(io.env);
  const logPath = join(dataDir(io.env), 'collector.log');
  const bin = sourceBin();
  const plist = renderCollectorPlist({ label: COLLECTOR_LABEL, nodePath: process.execPath, binPath: bin, intervalMs, maxDbMb, logPath, workingDir: resolve(dirname(bin), '..', '..', '..') });
  if (dry) { io.stdout.write(plist); io.stderr.write(`\ndexterm record: dry run — would write ${path}\n`); return 0; }
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(path, plist);
  io.stdout.write(`wrote ${path}\nlog     ${logPath}\n\nEnable it (user-level, no sudo):\n  launchctl bootstrap gui/$(id -u) ${path}\n  launchctl kickstart -k gui/$(id -u)/${COLLECTOR_LABEL}\nStop/remove it:  trenchscope record uninstall --unload\n\nNOTE: a LaunchAgent does NOT start before you log in on this Mac; the collector runs only while logged in.\n`);
  if (load) return runLaunchctl(['bootstrap', `gui/${process.getuid?.() ?? 0}`, path], io);
  io.stderr.write('trenchscope record: plist written but NOT loaded (pass --load, or run the launchctl command above) once you have checked it.\n');
  return 0;
}

function uninstall(argv: string[], io: RecordIo): number {
  const unload = argv.includes('--unload');
  const path = plistPath(io.env);
  if (unload) runLaunchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${COLLECTOR_LABEL}`], io);
  if (existsSync(path)) { rmSync(path, { force: true }); io.stdout.write(`removed ${path}\n`); }
  else io.stdout.write(`no LaunchAgent at ${path}\n`);
  return 0;
}

function status(argv: string[], io: RecordIo): number {
  let db: string | null = null;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--db') { db = argv[++i] ?? null; if (!db) { io.stderr.write('trenchscope record: --db needs a PATH\n'); return 2; } } }
  const path = plistPath(io.env);
  const installed = existsSync(path);
  const dbPath = db ?? defaultDbPath(io.env);
  io.stdout.write(`LaunchAgent     ${installed ? `installed (${path})` : 'not installed (trenchscope record install)'}\n`);
  io.stdout.write(`service note    LaunchAgents do not start before login; the collector runs only while logged in\n`);
  if (dbPath === ':memory:') { io.stdout.write('recorder        in-memory DB (no history)\n'); return 0; }
  let rec: Recorder | null = null;
  try {
    rec = new Recorder({ path: dbPath, enabled: false });
    const s = rec.stats();
    const when = (t: number | null): string => (t === null ? '—' : new Date(t).toISOString());
    io.stdout.write([
      `db              ${dbPath} (${s.dbBytes === null ? '—' : `${(s.dbBytes / 1e6).toFixed(1)} MB`})`,
      `snapshots       ${s.snapshots} (live ${s.live}, sweep ${s.sweep}, t0 anchors ${s.t0})`,
      `outcomes        ${s.outcomes}${s.outcomes ? ` (${Object.entries(s.outcomesByLabel).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`,
      `sweeps          ${s.sweeps} runs · ${s.sweepCallsToday} DexScreener calls today`,
      `span            ${when(s.oldestT)} → ${when(s.newestT)}`,
    ].join('\n') + '\n');
  } catch (e) {
    io.stderr.write(`trenchscope record status: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally { rec?.close(); }
  return 0;
}

/** Run launchctl best-effort (only on --load/--unload). Never throws: a failure is reported, the plist stays. */
function runLaunchctl(args: string[], io: RecordIo): number {
  try {
    const r = spawnSync('launchctl', args, { stdio: 'inherit' });
    if (r.status !== 0) { io.stderr.write(`trenchscope record: launchctl ${args[0]} exited ${r.status ?? 'null'}\n`); return 1; }
    io.stdout.write(`launchctl ${args[0]} ok\n`);
    return 0;
  } catch (e) {
    io.stderr.write(`trenchscope record: launchctl failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
