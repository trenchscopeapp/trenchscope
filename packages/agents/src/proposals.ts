// @dexterm/agents — the proposal store (task-1345, tier 2 interface; tier 3 enriches it).
//
// An agent can only ever create a PROPOSAL: a draft alert / order plan / watchlist add, labelled with the
// agent that made it, that the user confirms with a physical keypress. The store NEVER confirms a proposal
// on an agent's behalf (`confirm`/`dismiss` are user actions, keyed by a separate caller), enforces
// idempotency (the same agent + key returns the same proposal instead of a second one), and firewalls the
// agent-authored display text before it reaches the terminal or the roster. Nothing here arms, signs or
// sends anything; an order-plan proposal is a draft with `armed: false`, full stop.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { firewallText } from '@dexterm/data';
import type { AgentSession } from './gate.ts';

export type ProposalKind = 'alert' | 'order_plan' | 'watchlist';
export type ProposalStatus = 'pending' | 'confirmed' | 'dismissed';

export interface Proposal {
  id: string;
  agentId: string;
  agentName: string;
  kind: ProposalKind;
  mint: string;
  idempotencyKey: string;
  createdAt: number;
  status: ProposalStatus;
  /** One firewalled line for the roster / confirm popup. */
  summary: string;
  /** Firewalled, display-safe detail (side/size/triggers/when/note). Never a tradeable instruction. */
  detail: Record<string, unknown>;
  /** Invariant for order plans: a proposal is never armed by its creation. Only a user keypress arms. */
  armed: false;
}

export const TOOL_TO_KIND: Readonly<Record<string, ProposalKind>> = Object.freeze({
  propose_alert: 'alert', propose_order_plan: 'order_plan', add_to_watchlist: 'watchlist',
});

export interface ProposalStore {
  /** Create (or return the idempotent duplicate of) a proposal from an already-gated propose_* call. */
  create(session: AgentSession, tool: string, args: Record<string, unknown>): { proposal: Proposal; duplicate: boolean };
  list(filter?: { agentId?: string; status?: ProposalStatus; limit?: number }): Proposal[];
  get(id: string): Proposal | undefined;
  /** User action ONLY (the caller must be the user/UI, never an agent path). Returns the updated proposal. */
  setStatus(id: string, status: Exclude<ProposalStatus, 'pending'>): Proposal | undefined;
  close(): void;
}

const fw = (s: unknown, max = 200): string => firewallText(s === undefined || s === null ? '' : String(s), { max }).text.replace(/\s+/g, ' ').trim();

/** Build the firewalled summary + detail for a proposal. Pure. */
export function proposalView(kind: ProposalKind, mint: string, args: Record<string, unknown>): { summary: string; detail: Record<string, unknown> } {
  const short = mint.slice(0, 6);
  if (kind === 'alert') {
    const when = fw(args.when, 120);
    return { summary: `alert ${short}… when ${when}`, detail: { mint, when, note: fw(args.note) } };
  }
  if (kind === 'order_plan') {
    const side = args.side === 'sell' ? 'sell' : 'buy';
    const size = fw(args.size, 40);
    const triggers = Array.isArray(args.triggers) ? args.triggers.slice(0, 8).map((t) => fw(t, 80)) : [];
    return { summary: `PAPER ${side} ${short}… size ${size} (DRAFT — not armed)`, detail: { mint, side, size, triggers, note: fw(args.note), armed: false } };
  }
  return { summary: `watchlist add ${short}…`, detail: { mint, note: fw(args.note) } };
}

export class MemoryProposalStore implements ProposalStore {
  private readonly rows: Proposal[] = [];
  private seq = 0;
  private readonly now: () => number;
  constructor(opts: { now?: () => number } = {}) { this.now = opts.now ?? (() => Date.now()); }

  create(session: AgentSession, tool: string, args: Record<string, unknown>): { proposal: Proposal; duplicate: boolean } {
    const kind = TOOL_TO_KIND[tool];
    if (!kind) throw new Error(`not a proposal tool: ${tool}`);
    const key = String(args.idempotency_key);
    const existing = this.rows.find((p) => p.agentId === session.agentId && p.idempotencyKey === key);
    if (existing) return { proposal: { ...existing }, duplicate: true };
    const mint = String(args.mint);
    const { summary, detail } = proposalView(kind, mint, args);
    const proposal: Proposal = {
      id: `prop_${(++this.seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: session.agentId, agentName: session.agentName, kind, mint, idempotencyKey: key,
      createdAt: this.now(), status: 'pending', summary, detail, armed: false,
    };
    this.rows.push(proposal);
    return { proposal: { ...proposal }, duplicate: false };
  }

  list(filter: { agentId?: string; status?: ProposalStatus; limit?: number } = {}): Proposal[] {
    const out: Proposal[] = [];
    for (let i = this.rows.length - 1; i >= 0 && out.length < (filter.limit ?? 100); i--) {
      const p = this.rows[i];
      if (filter.agentId && p.agentId !== filter.agentId) continue;
      if (filter.status && p.status !== filter.status) continue;
      out.push({ ...p });
    }
    return out;
  }

  get(id: string): Proposal | undefined { const p = this.rows.find((x) => x.id === id); return p ? { ...p } : undefined; }

  setStatus(id: string, status: Exclude<ProposalStatus, 'pending'>): Proposal | undefined {
    const p = this.rows.find((x) => x.id === id);
    if (!p) return undefined;
    p.status = status; // confirming NEVER arms: an order plan still needs a physical keypress in the signer flow
    return { ...p };
  }

  close(): void { /* nothing */ }
}

/**
 * Persistent store in the shared trenchscope SQLite DB so the TUI roster, `trenchscope agent proposals` and a
 * later confirm flow read the same rows across processes. The UNIQUE (agent_id, idempotency_key) index
 * makes idempotency a database guarantee, not just a scan. Display strings are firewalled before insert.
 */
export class SqliteProposalStore implements ProposalStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private seq = 0;
  constructor(path: string, opts: { now?: () => number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = opts.now ?? (() => Date.now());
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_proposal (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, kind TEXT NOT NULL,
        mint TEXT NOT NULL, idem TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        summary TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_proposal_idem ON agent_proposal(agent_id, idem);
      CREATE INDEX IF NOT EXISTS agent_proposal_agent ON agent_proposal(agent_id, created_at);
    `);
  }

  private row(r: Record<string, unknown>): Proposal {
    return { id: String(r.id), agentId: String(r.agent_id), agentName: String(r.agent_name), kind: r.kind as ProposalKind, mint: String(r.mint), idempotencyKey: String(r.idem), createdAt: Number(r.created_at), status: r.status as ProposalStatus, summary: String(r.summary), detail: JSON.parse(String(r.detail)) as Record<string, unknown>, armed: false };
  }

  create(session: AgentSession, tool: string, args: Record<string, unknown>): { proposal: Proposal; duplicate: boolean } {
    const kind = TOOL_TO_KIND[tool];
    if (!kind) throw new Error(`not a proposal tool: ${tool}`);
    const key = String(args.idempotency_key);
    const existingRow = this.db.prepare('SELECT * FROM agent_proposal WHERE agent_id = ? AND idem = ?').get(session.agentId, key) as Record<string, unknown> | undefined;
    if (existingRow) return { proposal: this.row(existingRow), duplicate: true };
    const mint = String(args.mint);
    const { summary, detail } = proposalView(kind, mint, args);
    const id = `prop_${(++this.seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = this.now();
    try {
      this.db.prepare('INSERT INTO agent_proposal (id, agent_id, agent_name, kind, mint, idem, created_at, status, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, session.agentId, session.agentName, kind, mint, key, createdAt, 'pending', summary, JSON.stringify(detail));
    } catch {
      // a concurrent insert won the UNIQUE race: return the row that landed
      const r = this.db.prepare('SELECT * FROM agent_proposal WHERE agent_id = ? AND idem = ?').get(session.agentId, key) as Record<string, unknown> | undefined;
      if (r) return { proposal: this.row(r), duplicate: true };
      throw new Error('proposal insert failed');
    }
    return { proposal: { id, agentId: session.agentId, agentName: session.agentName, kind, mint, idempotencyKey: key, createdAt, status: 'pending', summary, detail, armed: false }, duplicate: false };
  }

  list(filter: { agentId?: string; status?: ProposalStatus; limit?: number } = {}): Proposal[] {
    const where: string[] = []; const params: Array<string | number> = [];
    if (filter.agentId) { where.push('agent_id = ?'); params.push(filter.agentId); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    const sql = `SELECT * FROM agent_proposal${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, Math.max(1, Math.min(filter.limit ?? 100, 500))) as Record<string, unknown>[]).map((r) => this.row(r));
  }

  get(id: string): Proposal | undefined { const r = this.db.prepare('SELECT * FROM agent_proposal WHERE id = ?').get(id) as Record<string, unknown> | undefined; return r ? this.row(r) : undefined; }

  setStatus(id: string, status: Exclude<ProposalStatus, 'pending'>): Proposal | undefined {
    this.db.prepare('UPDATE agent_proposal SET status = ? WHERE id = ?').run(status, id);
    return this.get(id);
  }

  close(): void { try { this.db.close(); } catch { /* ignore */ } }
}
