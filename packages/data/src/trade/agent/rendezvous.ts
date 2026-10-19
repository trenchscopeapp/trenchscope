// task-1443 — the rendezvous a running trenchscope writes so an EXTERNAL `trenchscope mcp` server (spawned by the
// user's own agent: Claude Code, Cursor, a custom bot) may paper-trade inside an armed mandate.
//
// Agent paper trading is OFF unless the user turns it on. When the user starts the app with the spectator
// view open and names a mandate they ARMED by keypress (`--spectate-mcp --agent-paper <mandate-id>`), the app
// writes `~/.dexterm/paper-agent.json` naming the shared paper wallet DB and the mandate ID — never the caps.
// The MCP side REPLAYS that mandate from the hash-chained plans journal the app armed it in (verifying the
// chain and the caps hash), so editing the rendezvous cannot raise a cap, and a revoke / panic in the app is
// seen on the next call. A companion `~/.dexterm/paper-agent.control` carries the live control state (running /
// paused / stopped / takeover), re-read on every mutating call. Agent calls journal to their OWN chain
// (`paper-agent.journal`), so the app's plans journal keeps a single writer. All files are local and 0600;
// nothing here is a key, a signer or a send path.

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Clock } from '../../clock.ts';
import { Journal, type AppendFields, type JournalEvent } from '../plans/journal.ts';
import { capsHash, type Mandate } from '../plans/mandate.ts';
import type { DeskControl, DeskControlState } from './paper-desk.ts';

export const PAPER_AGENT_RENDEZVOUS = 'paper-agent.json';
export const PAPER_AGENT_CONTROL = 'paper-agent.control';
export const PAPER_AGENT_JOURNAL = 'paper-agent.journal';

/** The on-disk rendezvous (v2). It names the mandate; the caps are always replayed from the plans journal. */
export interface PaperAgentRendezvous {
  v: 2;
  /** Shared paper wallet SQLite path (same `--db` the app uses). */
  db: string;
  /** The id of a mandate the user armed (by keypress) in the plans journal. */
  mandateId: string;
  /** Optional label the spectator/journal uses for this agent (never a real name). */
  agent?: string;
}

function home(env: NodeJS.ProcessEnv): string {
  return env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
}

export function paperAgentRendezvousPath(env: NodeJS.ProcessEnv = process.env): string { return join(home(env), PAPER_AGENT_RENDEZVOUS); }
export function paperAgentControlPath(env: NodeJS.ProcessEnv = process.env): string { return join(home(env), PAPER_AGENT_CONTROL); }
export function paperAgentJournalPath(env: NodeJS.ProcessEnv = process.env): string { return join(home(env), PAPER_AGENT_JOURNAL); }
/** The plans/mandate journal (same location as plans/service.ts `defaultPlansJournalPath`, which this module
 *  deliberately does not import: the service graph reaches the live executor). Never taken from the rendezvous. */
export function plansJournalPathFor(env: NodeJS.ProcessEnv = process.env): string { return join(home(env), 'plans.journal'); }

/** Turn agent paper trading ON: write the rendezvous (0600) and a `running` control state. */
export function writePaperAgentRendezvous(rv: Omit<PaperAgentRendezvous, 'v'>, env: NodeJS.ProcessEnv = process.env): void {
  const p = paperAgentRendezvousPath(env);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify({ v: 2, db: rv.db, mandateId: rv.mandateId, ...(rv.agent ? { agent: rv.agent } : {}) }), { mode: 0o600 });
  writeDeskControl({ state: 'running' }, env);
}

/** Turn it OFF: remove both files. Idempotent. */
export function clearPaperAgentRendezvous(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(paperAgentRendezvousPath(env), { force: true });
  rmSync(paperAgentControlPath(env), { force: true });
}

/** Read the rendezvous, or null when agent paper trading is not enabled (or the file is malformed). Never throws. */
export function readPaperAgentRendezvous(env: NodeJS.ProcessEnv = process.env): PaperAgentRendezvous | null {
  const p = paperAgentRendezvousPath(env);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, 'utf8')) as Partial<PaperAgentRendezvous>;
    if (!o || o.v !== 2 || typeof o.db !== 'string' || !o.db || typeof o.mandateId !== 'string' || !o.mandateId) return null;
    return { v: 2, db: o.db, mandateId: o.mandateId, ...(typeof o.agent === 'string' ? { agent: o.agent.slice(0, 40) } : {}) };
  } catch {
    return null;
  }
}

const VALID_STATES: readonly DeskControlState[] = ['running', 'paused', 'stopped', 'takeover'];

/** Write the live control state (0600). The app calls this on pause / take-over / stop / resume. */
export function writeDeskControl(control: DeskControl, env: NodeJS.ProcessEnv = process.env): void {
  const p = paperAgentControlPath(env);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(control), { mode: 0o600 });
}

/**
 * Read the control state, re-read on EVERY call (never cached), fail-closed:
 *   - file absent         → stopped (the app writes `running` when it enables agent paper trading)
 *   - a known state       → that state
 *   - present but broken  → stopped
 */
export function readDeskControl(env: NodeJS.ProcessEnv = process.env): DeskControl {
  const p = paperAgentControlPath(env);
  if (!existsSync(p)) return { state: 'stopped', reason: 'agent paper trading is not running in the app' };
  try {
    const o = JSON.parse(readFileSync(p, 'utf8')) as Partial<DeskControl>;
    const state = typeof o.state === 'string' && (VALID_STATES as readonly string[]).includes(o.state) ? (o.state as DeskControlState) : 'stopped';
    return { state, reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : undefined };
  } catch {
    return { state: 'stopped', reason: 'control file unreadable (treated as stopped)' };
  }
}

/** Freshest mtime of a file (for mtime caches); 0 when absent. */
export function fileMtimeMs(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}
export function rendezvousMtimeMs(env: NodeJS.ProcessEnv = process.env): number { return fileMtimeMs(paperAgentRendezvousPath(env)); }

/**
 * Replay ONE mandate from the hash-chained plans journal, read-only. Fails closed (null + reason) when the
 * journal is absent, its chain does not verify, the mandate was never drafted, or the caps hash recorded at
 * arming does not match the drafted caps. Status follows the journal: draft → armed → revoked/expired.
 */
export function loadMandateFromJournal(path: string, mandateId: string, clock: Clock): { mandate: Mandate } | { mandate: null; reason: string } {
  if (!existsSync(path)) return { mandate: null, reason: 'no plans journal (arm a mandate first)' };
  let j: Journal;
  try { j = new Journal({ path, clock }); } catch { return { mandate: null, reason: 'plans journal unreadable' }; }
  const v = j.verify();
  if (!v.ok) return { mandate: null, reason: `plans journal chain broken at seq ${v.atSeq} (${v.why})` };
  let m: Mandate | null = null;
  for (const e of j.events) {
    if (e.mandateId !== mandateId) continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === 'mandate.draft') {
      const drafted = structuredClone(d.mandate) as Mandate;
      if (!drafted || drafted.id !== mandateId || capsHash(drafted) !== d.capsHash) return { mandate: null, reason: 'mandate draft does not match its caps hash' };
      m = drafted;
    } else if (e.type === 'mandate.armed' && m) {
      if (d.capsHash !== capsHash(m)) return { mandate: null, reason: 'mandate armed with different caps than drafted' };
      m.status = 'armed'; m.armedAt = d.armedAt as number; m.armedBy = d.armedBy as Mandate['armedBy'];
    } else if (e.type === 'mandate.revoked' && m) {
      m.status = (d.status as Mandate['status']) ?? 'revoked'; m.revokedAt = e.ts; m.revokedReason = (d.reason as string) ?? null;
    }
  }
  if (!m) return { mandate: null, reason: `no mandate ${mandateId} in the plans journal` };
  Object.freeze(m.budget); Object.freeze(m.limits); Object.freeze(m.fees); Object.freeze(m.allowed);
  return { mandate: Object.freeze(m) };
}

/**
 * A journal that may have several writers (one per `trenchscope mcp` process): it re-loads the chain from disk
 * before every append so each event links to the true head. Append-only, 0600 directory, same hash chain and
 * `redact()` as the plans journal.
 */
export class SharedJournal {
  readonly path: string;
  private readonly j: Journal;
  constructor(path: string, clock: Clock) { this.path = path; this.j = new Journal({ path, clock }); }
  append(type: string, fields: AppendFields = {}): JournalEvent {
    if (existsSync(this.path)) this.j.load(this.path);
    return this.j.append(type, fields);
  }
  verify() { if (existsSync(this.path)) this.j.load(this.path); return this.j.verify(); }
  types(): string[] { if (existsSync(this.path)) this.j.load(this.path); return this.j.types(); }
}
