// trenchscope — `trenchscope watch` (task-1398): run the rules engine against the live feed with NO TUI and PUSH
// every fired alert (and, when alerts.proposals is on, a one-line proposal summary) through the delivery
// layer — so a price / holder / LARP / new-pair alert reaches you when the terminal is closed.
//
//   trenchscope watch [--interval S] [--ticks N | --once] [--replay FILE] [--db PATH] [--verbose]
//
// SAFETY: this builds NO signer and passes no `trade` option; a rule can only alert / annotate / open an
// inert PROPOSAL (RulesEngine's money-safety invariant). The notifier only reads an AlertDelivery. There is
// no arm/sign/confirm/cap path anywhere under here (asserted by alerts-1398.test.ts).
import { dextermHome, loadConfig, RulesEngine, type RuleRow } from '@dexterm/custom';
import { openHistoryReadOnly, LARP_PACK } from '@dexterm/recorder';
import type { ScreenerRow } from './screener/rows.ts';
import { buildNotifier, type Notifier } from './alerts/notifier.ts';
import { alertToDelivery, proposalToDelivery } from './alerts/format.ts';
import { redactCreds } from './alerts/creds.ts';
import { larpGrade } from './rules.ts';

export interface WatchIo { stdout: { write(s: string): void }; stderr: { write(s: string): void }; env: NodeJS.ProcessEnv }

/** One tick of rows to evaluate. The source yields these; `null` ends the run (end of a replay, or aborted). */
export interface WatchSnapshot { rows: RuleRow[]; now: number; watchlist?: ReadonlySet<string>; positions?: ReadonlySet<string> }
export interface WatchSource { next(): Promise<WatchSnapshot | null>; close?(): void | Promise<void> }

export interface RunWatchDeps {
  /** Inject a scripted source (tests) instead of the live feed. */
  source?: WatchSource;
  /** Inject a Notifier (tests pass fake adapters) instead of building one from config + creds. */
  notifier?: Notifier;
  now?: () => number;
}

export const WATCH_USAGE = `usage: trenchscope watch [--interval S] [--ticks N | --once] [--replay FILE] [--db PATH] [--verbose]

  Runs your rules headless and pushes alerts to the channels you enabled with \`trenchscope alerts\`
  (terminal line + desktop notification + your Telegram bot / Discord webhook). Ctrl-C to stop.
`;

interface WatchArgs { intervalMs: number; ticks: number; replay: string | null; db: string | null; verbose: boolean; help: boolean }
function parseArgs(argv: string[]): WatchArgs | { error: string } {
  const a: WatchArgs = { intervalMs: 15_000, ticks: Infinity, replay: null, db: null, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--verbose' || t === '-v') a.verbose = true;
    else if (t === '--once') a.ticks = 1;
    else if (t === '--interval') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 1) return { error: '--interval needs seconds ≥ 1' }; a.intervalMs = Math.round(n * 1000); }
    else if (t === '--ticks') { const n = Number(argv[++i]); if (!Number.isInteger(n) || n < 1) return { error: '--ticks needs an integer ≥ 1' }; a.ticks = n; }
    else if (t === '--replay') { a.replay = argv[++i] ?? null; if (!a.replay) return { error: '--replay needs a FILE' }; }
    else if (t === '--db') { a.db = argv[++i] ?? null; if (!a.db) return { error: '--db needs a PATH' }; }
    else return { error: `unknown option "${t}"` };
  }
  return a;
}

/** Latest LARP verdict per mint from a read-only recorder DB (best effort; empty map on any problem). */
function larpMapFromDb(path: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!path || path === ':memory:') return map;
  const db = openHistoryReadOnly(path);
  if (!db) return map;
  try {
    const rows = db.prepare('SELECT mint, verdict FROM verdicts WHERE pack = ? AND verdict IS NOT NULL ORDER BY t').all(LARP_PACK) as Array<{ mint: string; verdict: string }>;
    for (const r of rows) map.set(r.mint, r.verdict); // ORDER BY t → last write per mint wins
  } catch { /* table may not exist yet */ }
  finally { try { db.close(); } catch { /* ignore */ } }
  return map;
}

/** Map a screener row to a rule row (cluster is only known with the wallet-intel scan, absent headless; larp from the DB). */
export function toRuleRow(r: ScreenerRow, larp: Map<string, string>): RuleRow {
  return Object.assign(Object.create(null), r, { cluster: null, larp: larpGrade(larp.get(r.mint)) }) as RuleRow;
}

/** The production source: refresh the live (or replay) feed, map rows, yield a snapshot. Replay yields once. */
function createFeedSource(opts: { replay: string | null; db: string | null; intervalMs: number; verbose: boolean; io: WatchIo; now: () => number; stop: { aborted: boolean; wake: () => void; wait: (ms: number) => Promise<void> } }): WatchSource {
  let feed: import('./feed.ts').ScreenerFeed | null = null;
  let yielded = 0;
  const larp = larpMapFromDb(opts.db);
  return {
    async next(): Promise<WatchSnapshot | null> {
      if (opts.stop.aborted) return null;
      const { createLiveFeed, createReplayFeed } = await import('./feed.ts');
      if (!feed) feed = opts.replay ? createReplayFeed(opts.replay, {}) : createLiveFeed({ dbPath: opts.db ?? undefined });
      else {
        if (opts.replay) return null; // a recording is a single snapshot: one evaluate, then stop
        await opts.stop.wait(opts.intervalMs);
        if (opts.stop.aborted) return null;
      }
      const rows = await feed.refresh();
      yielded++;
      if (opts.verbose) opts.io.stderr.write(`watch: tick ${yielded}, ${rows.length} rows\n`);
      return { rows: rows.map((r) => toRuleRow(r as ScreenerRow, larp)), now: opts.now() };
    },
    close() { try { feed?.close(); } catch { /* ignore */ } },
  };
}

export async function watchCommand(argv: string[], io: WatchIo, deps: RunWatchDeps = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) { io.stderr.write(`trenchscope watch: ${parsed.error}\n\n${WATCH_USAGE}`); return 2; }
  if (parsed.help) { io.stdout.write(WATCH_USAGE); return 0; }

  const now = deps.now ?? (() => Date.now());
  const home = dextermHome(io.env);
  const loaded = loadConfig(home);
  for (const e of loaded.errors) io.stderr.write(`trenchscope watch: config: ${e}\n`);
  const rules = loaded.config.rules ?? [];
  const engine = new RulesEngine({ rules, now: now() });
  for (const e of engine.errors) io.stderr.write(`trenchscope watch: rule ${e.id}: ${e.msg}\n`);
  const enabled = engine.rules.filter((r) => r.enabled).length;
  if (enabled === 0) io.stderr.write('trenchscope watch: no enabled rules (add some with `trenchscope rules add`); nothing will fire\n');

  // SIGINT-aware sleeper for the production loop.
  const stop = (() => {
    let aborted = false; let wake: () => void = () => {};
    return {
      get aborted() { return aborted; },
      abort() { aborted = true; wake(); },
      wake() { wake(); },
      wait(ms: number): Promise<void> { return new Promise<void>((res) => { const t = setTimeout(res, ms); wake = () => { clearTimeout(t); res(); }; }); },
    };
  })();

  const notifier = deps.notifier ?? buildNotifier(home, loaded.config.alerts, {
    toastSink: (line) => io.stdout.write(`${new Date(now()).toISOString().slice(11, 19)} ${line}\n`),
  });
  const source = deps.source ?? createFeedSource({ replay: parsed.replay, db: parsed.db, intervalMs: parsed.intervalMs, verbose: parsed.verbose, io, now, stop });

  const ready = notifier.readyChannels();
  if (parsed.verbose || !deps.notifier) io.stderr.write(`trenchscope watch: ${enabled} rule(s), channels: ${ready.length ? ready.join(', ') : 'toast'}\n`);

  const onSigint = (): void => { io.stderr.write('\ndexterm watch: stopping…\n'); stop.abort(); };
  const addSig = !deps.source; // only own SIGINT for the real loop (tests drive a finite source)
  if (addSig) process.on('SIGINT', onSigint);

  let delivered = 0;
  try {
    for (let tick = 0; tick < parsed.ticks; tick++) {
      const snap = await source.next();
      if (!snap) break;
      engine.observe(snap.rows, snap.now);
      const res = engine.evaluate(snap.rows, snap.now, { watchlist: snap.watchlist, positions: snap.positions });
      for (const a of res.alerts) { await notifier.deliver(alertToDelivery(a)); delivered++; }
      if (loaded.config.alerts?.proposals) for (const p of res.proposals) { await notifier.deliver(proposalToDelivery(p)); delivered++; }
    }
  } catch (e) {
    io.stderr.write(`trenchscope watch: ${redactCreds((e as Error).message)}\n`);
    return 1;
  } finally {
    if (addSig) process.removeListener('SIGINT', onSigint);
    await source.close?.();
  }
  if (parsed.verbose || !deps.notifier) io.stderr.write(`trenchscope watch: delivered ${delivered} alert(s)\n`);
  return 0;
}
