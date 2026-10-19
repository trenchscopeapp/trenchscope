// @dexterm/agents — the audit log (task-1345). Every agent connection, call, refusal, proposal and
// roster action is one row. Two stores behind one interface: in memory (tests, --fixtures) and
// node:sqlite in the shared trenchscope DB (live / replay), so `trenchscope agent audit` and the roster popup
// read the same rows. Detail strings are firewalled at write time (agent-supplied text can never carry
// an escape sequence or a 10 KB payload into the terminal or a model).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { firewallText } from '@dexterm/data';

export type AuditKind = 'connect' | 'disconnect' | 'call' | 'refused' | 'proposal' | 'decision' | 'pause' | 'resume' | 'kick' | 'flood' | 'note' | 'subscribe';

export interface AuditEntry {
  id: number;
  t: number;
  agentId: string | null;
  agentName: string;
  session: string | null;
  kind: AuditKind;
  /** Tool / method / proposal kind. */
  tool: string;
  /** Short printable detail (firewalled, ≤ 160 chars). */
  detail: string;
  ok: boolean;
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 't'> & { t?: number };

export interface AuditLog {
  append(e: NewAuditEntry): AuditEntry;
  /** Newest first. */
  recent(limit?: number, filter?: { agentId?: string; agentName?: string; kind?: AuditKind; since?: number }): AuditEntry[];
  /** Counts for the roster: calls, refusals and proposals per agent. */
  counts(agentId: string): { calls: number; refused: number; proposals: number; lastAt: number | null };
  close(): void;
}

export const AUDIT_DETAIL_MAX = 160;

/** Make a detail string safe for the terminal and the log: firewall, single line, capped. */
export function auditDetail(s: unknown): string {
  const r = firewallText(s === undefined || s === null ? '' : String(s), { max: AUDIT_DETAIL_MAX, keepUrls: false });
  return r.text.replace(/\s+/g, ' ').trim();
}

export class MemoryAuditLog implements AuditLog {
  private rows: AuditEntry[] = [];
  private seq = 0;
  private readonly now: () => number;
  private readonly cap: number;
  constructor(opts: { now?: () => number; cap?: number } = {}) { this.now = opts.now ?? (() => Date.now()); this.cap = opts.cap ?? 5000; }
  append(e: NewAuditEntry): AuditEntry {
    const row: AuditEntry = { ...e, id: ++this.seq, t: e.t ?? this.now(), detail: auditDetail(e.detail), agentName: auditDetail(e.agentName).slice(0, 24), tool: auditDetail(e.tool).slice(0, 64) };
    this.rows.push(row);
    if (this.rows.length > this.cap) this.rows.splice(0, this.rows.length - this.cap);
    return row;
  }
  recent(limit = 50, filter: { agentId?: string; agentName?: string; kind?: AuditKind; since?: number } = {}): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (let i = this.rows.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.rows[i];
      if (filter.agentId && r.agentId !== filter.agentId) continue;
      if (filter.agentName && r.agentName !== filter.agentName) continue;
      if (filter.kind && r.kind !== filter.kind) continue;
      if (filter.since !== undefined && r.t < filter.since) continue;
      out.push({ ...r });
    }
    return out;
  }
  counts(agentId: string): { calls: number; refused: number; proposals: number; lastAt: number | null } {
    let calls = 0, refused = 0, proposals = 0, lastAt: number | null = null;
    for (const r of this.rows) {
      if (r.agentId !== agentId) continue;
      if (r.kind === 'call') calls++; else if (r.kind === 'refused') refused++; else if (r.kind === 'proposal') proposals++;
      if (lastAt === null || r.t > lastAt) lastAt = r.t;
    }
    return { calls, refused, proposals, lastAt };
  }
  close(): void { /* nothing */ }
}

export class SqliteAuditLog implements AuditLog {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(path: string, opts: { now?: () => number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = opts.now ?? (() => Date.now());
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, agent_id TEXT, agent_name TEXT NOT NULL, session TEXT,
        kind TEXT NOT NULL, tool TEXT NOT NULL, detail TEXT NOT NULL, ok INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_audit_agent ON agent_audit(agent_id, t);
    `);
  }
  append(e: NewAuditEntry): AuditEntry {
    const t = e.t ?? this.now();
    const detail = auditDetail(e.detail); const name = auditDetail(e.agentName).slice(0, 24); const tool = auditDetail(e.tool).slice(0, 64);
    const r = this.db.prepare('INSERT INTO agent_audit (t, agent_id, agent_name, session, kind, tool, detail, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t, e.agentId, name, e.session, e.kind, tool, detail, e.ok ? 1 : 0);
    return { ...e, id: Number(r.lastInsertRowid), t, detail, agentName: name, tool };
  }
  recent(limit = 50, filter: { agentId?: string; agentName?: string; kind?: AuditKind; since?: number } = {}): AuditEntry[] {
    const where: string[] = []; const params: Array<string | number> = [];
    if (filter.agentId) { where.push('agent_id = ?'); params.push(filter.agentId); }
    if (filter.agentName) { where.push('agent_name = ?'); params.push(filter.agentName); }
    if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
    if (filter.since !== undefined) { where.push('t >= ?'); params.push(filter.since); }
    const sql = `SELECT id, t, agent_id, agent_name, session, kind, tool, detail, ok FROM agent_audit${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, Math.max(1, Math.min(limit, 2000))) as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r.id), t: Number(r.t), agentId: (r.agent_id as string | null) ?? null, agentName: String(r.agent_name), session: (r.session as string | null) ?? null, kind: r.kind as AuditKind, tool: String(r.tool), detail: String(r.detail), ok: Number(r.ok) === 1 }));
  }
  counts(agentId: string): { calls: number; refused: number; proposals: number; lastAt: number | null } {
    const r = this.db.prepare(`SELECT
      SUM(CASE WHEN kind = 'call' THEN 1 ELSE 0 END) AS calls, SUM(CASE WHEN kind = 'refused' THEN 1 ELSE 0 END) AS refused,
      SUM(CASE WHEN kind = 'proposal' THEN 1 ELSE 0 END) AS proposals, MAX(t) AS last FROM agent_audit WHERE agent_id = ?`).get(agentId) as Record<string, unknown>;
    return { calls: Number(r.calls ?? 0), refused: Number(r.refused ?? 0), proposals: Number(r.proposals ?? 0), lastAt: r.last === null || r.last === undefined ? null : Number(r.last) };
  }
  close(): void { try { this.db.close(); } catch { /* ignore */ } }
}
