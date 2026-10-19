// task-1443 — the MCP side of agent paper trading. When the running trenchscope has the spectator view open and the
// user named an armed mandate for agent paper trading, it writes a rendezvous under ~/.dexterm; this resolves it
// into a PaperAgentDesk the paper tools dispatch to. When the rendezvous is absent the resolver returns null and
// the tools refuse — so agent paper trading is OFF by default and nothing here ever signs, sends or touches a
// wallet/key.
//
// The desk books into the SAME paper wallet SQLite file the app uses (WAL, concurrent-safe). Its caps are
// REPLAYED from the app's hash-chained plans journal (never read from the rendezvous), re-checked on every call
// (mtime-cached), so a revoke or panic in the app halts the agent. It prices the mandate's USD caps from a
// keyless SOL/USD read (fail-closed when older than 60 s), reads the control file on every mutating call
// (pause / take-over / stop), and journals every call to its own hash chain. The only trade op it can reach is
// the keyless swap-QUOTE + the PAPER executor (see paper-desk.ts).

import {
  PaperAgentDesk, PaperWallet, PaperExecutor, SharedJournal, systemClock,
  readPaperAgentRendezvous, readDeskControl, rendezvousMtimeMs, fileMtimeMs, loadMandateFromJournal,
  plansJournalPathFor, paperAgentJournalPath, withPriority,
  type DataLayer, type PaperAgentRendezvous, type QuoteRequest,
} from '@dexterm/data';
import type { Mandate } from '@dexterm/data/plans';

const WSOL = 'So11111111111111111111111111111111111111112';
/** A SOL/USD read older than this prices no cap (same freshness rule as the signer's resolveSolUsd). */
export const PAPER_SOL_USD_MAX_AGE_MS = 60_000;
const SOL_USD_REFRESH_MS = 20_000;

interface DeskCacheEntry {
  mtimeMs: number;
  db: string;
  mandateId: string;
  wallet: PaperWallet;
  desk: PaperAgentDesk;
}

let cache: DeskCacheEntry | null = null;
let sol: { price: number; at: number } | null = null;
let mandateCache: { id: string; mtimeMs: number; m: Mandate | null } | null = null;

function teardown(): void {
  if (cache) { try { cache.wallet.close(); } catch { /* ignore */ } cache = null; }
  mandateCache = null;
}

/** Replay the mandate from the plans journal, re-read whenever the journal changes (revoke / panic / expiry). */
function currentMandate(env: NodeJS.ProcessEnv, id: string): Mandate | null {
  const path = plansJournalPathFor(env);
  const mtimeMs = fileMtimeMs(path);
  if (mandateCache && mandateCache.id === id && mandateCache.mtimeMs === mtimeMs) return mandateCache.m;
  const r = loadMandateFromJournal(path, id, systemClock);
  mandateCache = { id, mtimeMs, m: r.mandate };
  return r.mandate;
}

/** Keep the SOL/USD read fresh enough to price the USD caps; a failed read leaves the old one to age out. */
async function refreshSolUsd(data: DataLayer): Promise<void> {
  const now = Date.now();
  if (sol && now - sol.at < SOL_USD_REFRESH_MS) return;
  try {
    const p = (await data.jupiter.price([WSOL])).get(WSOL)?.usdPrice;
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) sol = { price: p, at: Date.now() };
  } catch { /* keep the last value; it ages out */ }
}

/**
 * Resolve the paper agent desk for this `trenchscope mcp` process, or null when agent paper trading is disabled.
 * Re-reads the rendezvous (mtime-cached) so enabling/disabling in the running app is picked up; the mandate
 * and the control state are re-read inside the desk on every call, not cached across journal changes.
 */
export async function resolvePaperAgentDesk(data: DataLayer, env: NodeJS.ProcessEnv = process.env): Promise<PaperAgentDesk | null> {
  const mtimeMs = rendezvousMtimeMs(env);
  if (mtimeMs === 0) { teardown(); return null; } // not enabled
  const rv = readPaperAgentRendezvous(env);
  if (!rv) { teardown(); return null; } // present but unreadable → off (fail closed)
  await refreshSolUsd(data);
  if (cache && cache.mtimeMs === mtimeMs && cache.db === rv.db && cache.mandateId === rv.mandateId) return cache.desk;

  // The rendezvous changed (or first use): rebuild on the current wallet + mandate.
  teardown();
  const wallet = new PaperWallet({ path: rv.db, clock: systemClock });
  const executor = new PaperExecutor(wallet, { clock: systemClock });
  const desk = new PaperAgentDesk({
    mandate: () => currentMandate(env, rv.mandateId),
    wallet,
    executor,
    // 'high', like the human ticket (task-1387): a paper exit must not queue behind the agent's own read polling on
    // the shared keyless `jupiter` bucket (task-1443 live run: a scale-out was refused on a 429 mid-poll).
    quote: (req: QuoteRequest, signal?: AbortSignal) => withPriority('high', () => data.jupiterSwap.quote(req, signal)),
    solUsd: () => (sol && Date.now() - sol.at <= PAPER_SOL_USD_MAX_AGE_MS ? sol.price : null),
    control: () => readDeskControl(env),
    journal: new SharedJournal(paperAgentJournalPath(env), systemClock),
    agent: rv.agent ?? 'mcp-agent',
  });
  cache = { mtimeMs, db: rv.db, mandateId: rv.mandateId, wallet, desk };
  return desk;
}

/** Exported for tests: the current cached rendezvous db, if any. */
export function paperAgentDeskDb(): string | null { return cache?.db ?? null; }

export type { PaperAgentRendezvous };
