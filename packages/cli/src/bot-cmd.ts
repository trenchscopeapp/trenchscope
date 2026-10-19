// trenchscope: `trenchscope bot`, a headless PAPER-trading bot over the live screener feed. Its purpose is to
// measure whether trenchscope's signals make money, with zero risk, before anyone considers real auto-buys.
//
//   trenchscope bot run   [--interval S] [--once | --ticks N] [--db PATH] [--verbose]
//   trenchscope bot stats [--since 24h|7d|90m|all] [--json] [--db PATH]
//   trenchscope bot config
//
// PAPER ONLY, structurally: this file and everything it imports (packages/cli/src/bot/*, the screener feed,
// '@dexterm/data/core') never import the signer, the live executor, the fast wallet, the Phantom bridge, the swap
// build or the rpc send path. test/bot-paper-guard.test.ts walks the whole static + dynamic import graph from here
// and fails if any of those files becomes reachable. The bin shims route `bot` here BEFORE loading the app, so
// the process running the bot never even loads those modules.
import { dextermHome, loadConfig } from '@dexterm/custom';
import { defaultDbPath, redactSecrets } from '@dexterm/data/core';
import { buildNotifier, type Notifier } from './alerts/notifier.ts';
import { redactCreds } from './alerts/creds.ts';
import { resolveBotConfig, botConfigProblems, BOT_KNOBS, DEFAULT_BOT_CONFIG, type BotConfig } from './bot/config.ts';
import { BotEngine, type BotEngineDeps, type TickReport } from './bot/engine.ts';
import { BotStore } from './bot/store.ts';
import { computeStats, renderStats, parseSince, statsJson, STATS_LABEL } from './bot/stats.ts';
import { botEventToDelivery } from './bot/alerts.ts';
import type { ScreenerRow } from './screener/rows.ts';

export interface BotIo { stdout: { write(s: string): void }; stderr: { write(s: string): void }; env: NodeJS.ProcessEnv }

/** What the run loop needs from the outside world. Production: bot/live.ts. Tests: a scripted fake. */
export interface BotSource {
  rows(): Promise<ScreenerRow[]>;
  quote: BotEngineDeps['quote'];
  solUsd: BotEngineDeps['solUsd'];
  decimals: BotEngineDeps['decimals'];
  larp?: (mint: string) => string | null;
  requests?(): number;
  close(): void;
}

export interface BotDeps {
  source?: BotSource;
  notifier?: Notifier;
  now?: () => number;
  /** Cancellable sleep (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_BOT_INTERVAL_MS = 60_000;

export const BOT_USAGE = `trenchscope bot: a headless PAPER-trading bot over the live screener feed.
It books simulated fills priced from live Jupiter quotes (route fees, price impact and slippage included, plus a
simulated network fee), never a mid price, so you can see whether the signals make money with zero risk.

  trenchscope bot run   [--interval S] [--once | --ticks N] [--db PATH] [--verbose]
  trenchscope bot stats [--since 24h|7d|90m|all] [--json] [--db PATH]
  trenchscope bot config

run     each tick (default every 60 s): refresh the feed, mark every open paper position with a real sell
        quote and exit on take-profit, stop-loss, the time stop, or when the coin turns AVOID / DEAD / gains a
        mint or freeze authority; then enter coins that pass the entry rules, within the caps (one position per
        coin, max open, max entries per hour, fixed USD size). A second "baseline" book enters every coin that
        passes the market filters alone, so the safety checks can be judged. Every entry and exit is journaled
        (reason + the full row the decision read) in the same SQLite db. Ctrl-C stops; restarts never duplicate.
stats   the scoreboard: trades, open positions, win rate, PnL (USD and %), best/worst, average hold, PnL by
        exit reason, and the comparison with the baseline. Always printed with its sample size.
config  the effective strategy (config.json \`bot\` section over the defaults), one line per knob.

Alerts: exits (and, when bot.alerts.entries is on, entries) go through your \`trenchscope alerts\` channels.
PAPER ONLY: no key, no wallet, no signer, nothing is ever sent. Not financial advice.`;

interface RunArgs { intervalMs: number; ticks: number; db: string | null; verbose: boolean }

export function parseBotRun(argv: string[]): RunArgs | { error: string } {
  const a: RunArgs = { intervalMs: DEFAULT_BOT_INTERVAL_MS, ticks: Infinity, db: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--verbose' || t === '-v') a.verbose = true;
    else if (t === '--once') a.ticks = 1;
    else if (t === '--ticks') { const n = Number(argv[++i]); if (!Number.isInteger(n) || n < 1) return { error: '--ticks needs an integer >= 1' }; a.ticks = n; }
    else if (t === '--interval') { const n = Number(argv[++i]); if (!Number.isFinite(n) || n < 5) return { error: '--interval needs seconds >= 5' }; a.intervalMs = Math.round(n * 1000); }
    else if (t === '--db') { a.db = argv[++i] ?? null; if (!a.db) return { error: '--db needs a PATH' }; }
    else return { error: `unknown option "${t}"` };
  }
  return a;
}

function loadBotConfig(io: BotIo): { cfg: BotConfig; alerts: ReturnType<typeof loadConfig>['config']['alerts']; home: string } | null {
  const home = dextermHome(io.env);
  const loaded = loadConfig(home);
  for (const e of loaded.errors) io.stderr.write(`trenchscope bot: config: ${e}\n`);
  const cfg = resolveBotConfig(loaded.config.bot);
  const problems = botConfigProblems(cfg);
  if (problems.length) { for (const p of problems) io.stderr.write(`trenchscope bot: config: ${p}\n`); return null; }
  return { cfg, alerts: loaded.config.alerts, home };
}

export async function botCommand(argv: string[], io: BotIo, deps: BotDeps = {}): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const rest = argv.slice(argv[0] && !argv[0].startsWith('-') ? 1 : 0);
  if (sub === 'help' || rest.includes('--help') || rest.includes('-h')) { io.stdout.write(BOT_USAGE + '\n'); return 0; }
  if (sub === 'run') return run(rest, io, deps);
  if (sub === 'stats') return stats(rest, io, deps);
  if (sub === 'config') return config(io);
  io.stderr.write(`trenchscope bot: unknown subcommand "${sub}"\n\n${BOT_USAGE}\n`);
  return 2;
}

function fmtTick(r: TickReport, n: number): string {
  const t = new Date(r.at).toISOString().slice(11, 19);
  return `${t} tick ${n}: ${r.rows} rows · candidates ${r.candidates.strategy} strategy / ${r.candidates.baseline} baseline · `
    + `entered ${r.entries.filter((p) => p.book === 'strategy').length}/${r.entries.filter((p) => p.book === 'baseline').length} · `
    + `exited ${r.exits.filter((p) => p.book === 'strategy').length}/${r.exits.filter((p) => p.book === 'baseline').length} · `
    + `open ${r.open.strategy}/${r.open.baseline} · marked ${r.marked}${r.solUsd ? ` · SOL $${r.solUsd.toFixed(2)}` : ''}${r.errors.length ? ` · ${r.errors.length} issue(s)` : ''}\n`;
}

function fmtDetails(r: TickReport): string {
  const out: string[] = [];
  for (const p of r.entries) out.push(`  ENTER  [${p.book}] ${p.symbol} ${p.mint} $${p.sizeUsd} = ${(Number(p.costLamports) / 1e9).toFixed(4)} SOL incl. fees, impact ${p.entryImpactPct?.toFixed(2) ?? 'n/a'}%`);
  for (const p of r.exits) out.push(`  EXIT   [${p.book}] ${p.symbol} ${p.exitReason} ${p.pnlPct !== null ? `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%` : ''} (${p.pnlUsd !== null ? `${p.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(p.pnlUsd).toFixed(2)}` : 'n/a'})`);
  for (const s of r.skips) out.push(`  SKIP   [${s.book}] ${s.symbol} ${s.reason}`);
  for (const e of r.errors) out.push(`  ISSUE  ${redactSecrets(e)}`);
  return out.length ? out.join('\n') + '\n' : '';
}

async function run(argv: string[], io: BotIo, deps: BotDeps): Promise<number> {
  const parsed = parseBotRun(argv);
  if ('error' in parsed) { io.stderr.write(`trenchscope bot: ${parsed.error}\n\n${BOT_USAGE}\n`); return 2; }
  const loaded = loadBotConfig(io);
  if (!loaded) return 2;
  const { cfg } = loaded;
  const now = deps.now ?? (() => Date.now());
  const dbPath = parsed.db ?? defaultDbPath(io.env);
  if (!deps.source && dbPath === ':memory:') { io.stderr.write('trenchscope bot: an in-memory DB keeps no ledger; give a --db PATH\n'); return 2; }

  const stop = (() => {
    let aborted = false; let wake: () => void = () => {};
    return {
      get aborted() { return aborted; },
      abort() { aborted = true; wake(); },
      sleep(ms: number): Promise<void> { return new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; }); },
    };
  })();
  const sleep = deps.sleep ?? ((ms: number) => stop.sleep(ms));
  const log = (s: string): void => io.stderr.write(s);

  const store = new BotStore(dbPath);
  let source: BotSource;
  if (deps.source) source = deps.source;
  else {
    const { buildBotLive } = await import('./bot/live.ts');
    source = buildBotLive(io.env, { dbPath, verbose: parsed.verbose, onLog: log });
  }
  const notifier = deps.notifier ?? buildNotifier(loaded.home, loaded.alerts, {
    toastSink: (line) => io.stdout.write(`${new Date(now()).toISOString().slice(11, 19)} ALERT ${line}\n`),
  });
  const engine = new BotEngine({
    store, cfg, now, log,
    quote: (req) => source.quote(req), solUsd: () => source.solUsd(), decimals: (m) => source.decimals(m),
    larp: source.larp ? (m) => source.larp!(m) : undefined,
    notify: async (ev) => {
      const results = await notifier.deliver(botEventToDelivery(ev));
      for (const r of results) if (!r.ok && !r.skipped) log(`trenchscope bot: alert via ${r.channel} failed: ${redactCreds(r.reason ?? '')}\n`);
    },
  });

  const own = !deps.source;
  const onSig = (): void => { io.stderr.write('\ntrenchscope bot: stopping…\n'); stop.abort(); };
  if (own) { process.on('SIGINT', onSig); process.on('SIGTERM', onSig); }
  io.stderr.write(`trenchscope bot: PAPER only · db ${dbPath} · every ${Math.round(parsed.intervalMs / 1000)}s · $${cfg.sizeUsd}/entry · TP +${cfg.takeProfitPct}% SL -${cfg.stopLossPct}% time ${cfg.timeStopMin}m · max ${cfg.maxOpen} open, ${cfg.maxEntriesPerHour}/h · open now ${store.openPositions('strategy').length}/${store.openPositions('baseline').length} (strategy/baseline)\n`);
  store.journal({ t: now(), book: 'bot', kind: 'start', reason: 'bot run started', data: { config: cfg, intervalMs: parsed.intervalMs, ticks: Number.isFinite(parsed.ticks) ? parsed.ticks : null, pid: process.pid, paper: true } });

  let ticks = 0;
  let failed = 0;
  try {
    for (let i = 0; i < parsed.ticks && !stop.aborted; i++) {
      if (i > 0) { await sleep(parsed.intervalMs); if (stop.aborted) break; }
      ticks++;
      try {
        const rows = await source.rows();
        const report = await engine.tick(rows);
        io.stdout.write(fmtTick(report, ticks));
        if (parsed.verbose || report.entries.length || report.exits.length) io.stdout.write(fmtDetails(parsed.verbose ? report : { ...report, skips: [], errors: [] }));
      } catch (e) {
        failed++;
        const msg = redactSecrets(e instanceof Error ? e.message : String(e));
        io.stderr.write(`trenchscope bot: tick ${ticks} failed: ${msg}\n`);
        try { store.journal({ t: now(), book: 'bot', kind: 'error', reason: `tick failed: ${msg}` }); } catch { /* db gone */ }
      }
    }
  } finally {
    if (own) { process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig); }
    try { store.journal({ t: now(), book: 'bot', kind: 'stop', reason: `bot run stopped after ${ticks} tick(s)`, data: { requests: source.requests?.() ?? null } }); } catch { /* ignore */ }
    source.close();
    store.close();
  }
  if (parsed.ticks !== Infinity || parsed.verbose) io.stderr.write(`trenchscope bot: ${ticks} tick(s)${failed ? `, ${failed} failed` : ''}${source.requests ? `, ${source.requests()} request(s)` : ''} · ${STATS_LABEL}\n`);
  return failed && failed === ticks ? 1 : 0;
}

async function stats(argv: string[], io: BotIo, deps: BotDeps): Promise<number> {
  let sinceArg = 'all', json = false, db: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') json = true;
    else if (t === '--since') { sinceArg = argv[++i] ?? ''; }
    else if (t === '--db') { db = argv[++i] ?? null; if (!db) { io.stderr.write('trenchscope bot: --db needs a PATH\n'); return 2; } }
    else { io.stderr.write(`trenchscope bot stats: unknown option "${t}"\n`); return 2; }
  }
  const now = (deps.now ?? (() => Date.now()))();
  const since = parseSince(sinceArg, now);
  if (since !== null && typeof since === 'object') { io.stderr.write(`trenchscope bot: ${since.error}\n`); return 2; }
  const store = new BotStore(db ?? defaultDbPath(io.env));
  try {
    const s = computeStats(store.positions(), { since, now });
    io.stdout.write(json ? JSON.stringify(statsJson(s), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n' : renderStats(s));
  } finally { store.close(); }
  return 0;
}

function config(io: BotIo): number {
  const loaded = loadBotConfig(io);
  if (!loaded) return 2;
  const get = (c: BotConfig, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], c);
  const lines = ['trenchscope bot: effective strategy (config.json `bot` section over the defaults; PAPER only)'];
  for (const [path, doc] of BOT_KNOBS) {
    const v = get(loaded.cfg, path);
    const d = get(DEFAULT_BOT_CONFIG, path);
    lines.push(`  bot.${path.padEnd(22)} ${JSON.stringify(v).padEnd(16)} ${doc}${JSON.stringify(v) !== JSON.stringify(d) ? ` (default ${JSON.stringify(d)})` : ''}`);
  }
  io.stdout.write(lines.join('\n') + '\n');
  return 0;
}
