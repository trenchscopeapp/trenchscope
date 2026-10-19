// Persisted watchlist + alert proposals (task-1298, SPEC §4.5). `node:sqlite`, same file as the cache
// (default XDG path) so one `--db` controls everything. Tables:
//   watchlist(mint PK, symbol, name, launchpad, added_at, entry_price, note)
//   alert_rules(id, mint, kind, op, value, status proposed|armed|fired|dismissed, created_at, note)
//   alert_events(id, t, mint, kind, level, text)
// Rules: proposals are only ever *proposed* by code (or later by the Analyst); a user keypress arms
// them. Firing a rule writes an event and marks the rule `fired` (one shot). Nothing here trades.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { Launchpad } from './model.ts';

export interface WatchEntry {
  mint: string;
  symbol: string;
  name: string;
  launchpad: Launchpad;
  addedAt: number;
  /** Price when added (USD), null when no source had one. */
  entryPrice: number | null;
  note: string;
}

export type AlertKind = 'price' | 'liq' | 'holders' | 'mcap';
export type AlertOp = '>' | '<';
export type AlertStatus = 'proposed' | 'armed' | 'fired' | 'dismissed';

export interface AlertRule {
  id: number;
  mint: string;
  kind: AlertKind;
  op: AlertOp;
  value: number;
  status: AlertStatus;
  createdAt: number;
  note: string;
}

export type AlertLevel = 'up' | 'down' | 'info' | 'ai';

export interface AlertEvent {
  id: number;
  t: number;
  mint: string | null;
  kind: string;
  level: AlertLevel;
  text: string;
}

export interface WatchlistStoreOptions {
  /** File path or ':memory:' (default). */
  path?: string;
  clock?: Clock;
}

export class WatchlistStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(opts: WatchlistStoreOptions = {}) {
    const path = opts.path ?? ':memory:';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.clock = opts.clock ?? systemClock;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS watchlist (
        mint TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL, launchpad TEXT NOT NULL,
        added_at INTEGER NOT NULL, entry_price REAL, note TEXT NOT NULL DEFAULT ''
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, kind TEXT NOT NULL, op TEXT NOT NULL, value REAL NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS alert_rules_mint ON alert_rules(mint, status);
      CREATE TABLE IF NOT EXISTS alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, mint TEXT, kind TEXT NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------- watchlist

  list(): WatchEntry[] {
    const rows = this.db.prepare('SELECT mint, symbol, name, launchpad, added_at, entry_price, note FROM watchlist ORDER BY added_at DESC').all() as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  get(mint: string): WatchEntry | undefined {
    const row = this.db.prepare('SELECT mint, symbol, name, launchpad, added_at, entry_price, note FROM watchlist WHERE mint = ?').get(mint) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  has(mint: string): boolean {
    return this.get(mint) !== undefined;
  }

  /** Insert (or update identity fields of) a watched token. Returns true when it was new. */
  add(e: { mint: string; symbol: string; name: string; launchpad: Launchpad; entryPrice: number | null; note?: string }): boolean {
    const existed = this.has(e.mint);
    if (existed) {
      this.db.prepare('UPDATE watchlist SET symbol = ?, name = ?, launchpad = ? WHERE mint = ?').run(e.symbol, e.name, e.launchpad, e.mint);
      return false;
    }
    this.db
      .prepare('INSERT INTO watchlist (mint, symbol, name, launchpad, added_at, entry_price, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.mint, e.symbol, e.name, e.launchpad, this.clock.now(), e.entryPrice, e.note ?? '');
    return true;
  }

  remove(mint: string): boolean {
    const r = this.db.prepare('DELETE FROM watchlist WHERE mint = ?').run(mint);
    this.db.prepare("UPDATE alert_rules SET status = 'dismissed' WHERE mint = ? AND status IN ('proposed', 'armed')").run(mint);
    return Number(r.changes) > 0;
  }

  setNote(mint: string, note: string): void {
    this.db.prepare('UPDATE watchlist SET note = ? WHERE mint = ?').run(note, mint);
  }

  setEntry(mint: string, entryPrice: number | null): void {
    this.db.prepare('UPDATE watchlist SET entry_price = ? WHERE mint = ?').run(entryPrice, mint);
  }

  // ---------------------------------------------------------------- alert rules

  /** Record a proposal. Nothing fires until confirm() arms it. */
  propose(r: { mint: string; kind: AlertKind; op: AlertOp; value: number; note?: string }): AlertRule {
    const res = this.db
      .prepare("INSERT INTO alert_rules (mint, kind, op, value, status, created_at, note) VALUES (?, ?, ?, ?, 'proposed', ?, ?)")
      .run(r.mint, r.kind, r.op, r.value, this.clock.now(), r.note ?? '');
    return this.rule(Number(res.lastInsertRowid))!;
  }

  confirm(id: number): AlertRule | undefined {
    this.db.prepare("UPDATE alert_rules SET status = 'armed' WHERE id = ? AND status = 'proposed'").run(id);
    return this.rule(id);
  }

  dismiss(id: number): AlertRule | undefined {
    this.db.prepare("UPDATE alert_rules SET status = 'dismissed' WHERE id = ? AND status IN ('proposed', 'armed')").run(id);
    return this.rule(id);
  }

  rule(id: number): AlertRule | undefined {
    const row = this.db.prepare('SELECT id, mint, kind, op, value, status, created_at, note FROM alert_rules WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRule(row) : undefined;
  }

  rules(status?: AlertStatus | AlertStatus[], mint?: string): AlertRule[] {
    const statuses = status === undefined ? null : Array.isArray(status) ? status : [status];
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (statuses) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
    if (mint) { where.push('mint = ?'); args.push(mint); }
    const sql = `SELECT id, mint, kind, op, value, status, created_at, note FROM alert_rules${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToRule);
  }

  /**
   * Evaluate the armed rules against current values; each rule that trips fires once (status `fired`)
   * and writes an event. `values` maps mint -> {price, liq, holders, mcap} with nulls for unknowns.
   */
  evaluate(values: Map<string, Partial<Record<AlertKind, number | null>>>, symbolOf: (mint: string) => string = (m) => m.slice(0, 6)): AlertEvent[] {
    const fired: AlertEvent[] = [];
    for (const r of this.rules('armed')) {
      const v = values.get(r.mint)?.[r.kind];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const hit = r.op === '>' ? v > r.value : v < r.value;
      if (!hit) continue;
      this.db.prepare("UPDATE alert_rules SET status = 'fired' WHERE id = ?").run(r.id);
      const level: AlertLevel = r.kind === 'price' || r.kind === 'mcap' ? (r.op === '>' ? 'up' : 'down') : r.op === '<' ? 'down' : 'info';
      fired.push(this.log({ mint: r.mint, kind: r.kind, level, text: `${symbolOf(r.mint)} ${r.kind} ${r.op} ${fmtValue(r.kind, r.value)} (now ${fmtValue(r.kind, v)})` }));
    }
    return fired;
  }

  // ---------------------------------------------------------------- events

  log(e: { mint: string | null; kind: string; level: AlertLevel; text: string }): AlertEvent {
    const t = this.clock.now();
    const res = this.db.prepare('INSERT INTO alert_events (t, mint, kind, level, text) VALUES (?, ?, ?, ?, ?)').run(t, e.mint, e.kind, e.level, e.text);
    return { id: Number(res.lastInsertRowid), t, mint: e.mint, kind: e.kind, level: e.level, text: e.text };
  }

  events(limit = 50): AlertEvent[] {
    const rows = this.db.prepare('SELECT id, t, mint, kind, level, text FROM alert_events ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r.id), t: Number(r.t), mint: (r.mint as string | null) ?? null, kind: String(r.kind), level: r.level as AlertLevel, text: String(r.text) }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToEntry(r: Record<string, unknown>): WatchEntry {
  return {
    mint: String(r.mint),
    symbol: String(r.symbol),
    name: String(r.name),
    launchpad: r.launchpad as Launchpad,
    addedAt: Number(r.added_at),
    entryPrice: r.entry_price === null || r.entry_price === undefined ? null : Number(r.entry_price),
    note: String(r.note ?? ''),
  };
}

function rowToRule(r: Record<string, unknown>): AlertRule {
  return {
    id: Number(r.id),
    mint: String(r.mint),
    kind: r.kind as AlertKind,
    op: r.op as AlertOp,
    value: Number(r.value),
    status: r.status as AlertStatus,
    createdAt: Number(r.created_at),
    note: String(r.note ?? ''),
  };
}

export function fmtValue(kind: AlertKind, v: number): string {
  if (kind === 'holders') return String(Math.round(v));
  if (kind === 'price') return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`;
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
