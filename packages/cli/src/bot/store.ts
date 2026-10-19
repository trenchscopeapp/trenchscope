// trenchscope paper bot: the ledger and the audit journal, in node:sqlite, in the SAME db file as the cache,
// watchlist and recorder (one --db controls everything). Two tables:
//
//   bot_positions  one row per paper position (book, mint, entry, exit, PnL, last mark). A partial UNIQUE
//                  index allows at most ONE open position per (book, mint), so a crash/restart can never book a
//                  duplicate: a second open for the same coin is refused by the database itself.
//   bot_journal    append-only: every entry, exit, skip and error with its reason, the full row snapshot the
//                  decision read, the quote and the fill, so a result can be audited later.
//
// Opening a position and writing its journal line is one SQL transaction (likewise closing). The bot never
// touches the user's manual paper wallet tables (paper_*): its books are separate ledgers here.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Book, ExitReason } from './strategy.ts';

export type JournalKind = 'entry' | 'exit' | 'skip' | 'error' | 'start' | 'stop';

export interface BotPosition {
  id: number;
  book: Book;
  mint: string;
  symbol: string;
  decimals: number;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  sizeUsd: number;
  /** USD per SOL when the position was opened (PnL in USD is converted at this rate). */
  solUsdEntry: number;
  /** SOL spent including simulated fees, lamports. */
  costLamports: bigint;
  tokensRaw: bigint;
  entryPriceUsd: number | null;
  entryImpactPct: number | null;
  /** Net SOL received on exit after simulated fees, lamports (0 for a no-route write-off). */
  exitLamports: bigint | null;
  exitReason: ExitReason | null;
  exitImpactPct: number | null;
  solUsdExit: number | null;
  pnlLamports: bigint | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  /** Latest net sell-quote value while open, lamports, and when. */
  markLamports: bigint | null;
  markAt: number | null;
  quoteFailures: number;
}

export interface JournalLine {
  id: number;
  t: number;
  book: Book | 'bot';
  kind: JournalKind;
  positionId: number | null;
  mint: string | null;
  symbol: string | null;
  reason: string;
  row: unknown;
  data: unknown;
}

export interface OpenInput {
  book: Book;
  mint: string;
  symbol: string;
  decimals: number;
  openedAt: number;
  sizeUsd: number;
  solUsdEntry: number;
  costLamports: bigint;
  tokensRaw: bigint;
  entryPriceUsd: number | null;
  entryImpactPct: number | null;
  /** Journal payloads (the decision's row snapshot, checks, quote, fill, config). */
  reason: string;
  row: unknown;
  data: unknown;
}

export interface CloseInput {
  id: number;
  closedAt: number;
  exitLamports: bigint;
  exitReason: ExitReason;
  exitImpactPct: number | null;
  solUsdExit: number | null;
  reason: string;
  row: unknown;
  data: unknown;
}

/** JSON with bigints as decimal strings (the journal is read by humans and by `bot stats --json`). */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class BotStore {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = ':memory:') {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS bot_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book TEXT NOT NULL CHECK (book IN ('strategy', 'baseline')),
        mint TEXT NOT NULL, symbol TEXT NOT NULL, decimals INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        opened_at INTEGER NOT NULL, closed_at INTEGER,
        size_usd REAL NOT NULL, sol_usd_entry REAL NOT NULL,
        cost_lamports TEXT NOT NULL, tokens_raw TEXT NOT NULL,
        entry_price_usd REAL, entry_impact_pct REAL,
        exit_lamports TEXT, exit_reason TEXT, exit_impact_pct REAL, sol_usd_exit REAL,
        pnl_lamports TEXT, pnl_usd REAL, pnl_pct REAL,
        mark_lamports TEXT, mark_at INTEGER, quote_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bot_positions_one_open ON bot_positions(book, mint) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS bot_positions_book ON bot_positions(book, status, opened_at);
      CREATE TABLE IF NOT EXISTS bot_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        t INTEGER NOT NULL, book TEXT NOT NULL, kind TEXT NOT NULL,
        position_id INTEGER, mint TEXT, symbol TEXT, reason TEXT NOT NULL,
        row TEXT, data TEXT
      );
      CREATE INDEX IF NOT EXISTS bot_journal_t ON bot_journal(t);
    `);
  }

  /** Append one journal line (outside a position transaction: skips, errors, start/stop). */
  journal(line: { t: number; book: Book | 'bot'; kind: JournalKind; positionId?: number | null; mint?: string | null; symbol?: string | null; reason: string; row?: unknown; data?: unknown }): number {
    const r = this.db.prepare('INSERT INTO bot_journal (t, book, kind, position_id, mint, symbol, reason, row, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(line.t, line.book, line.kind, line.positionId ?? null, line.mint ?? null, line.symbol ?? null, line.reason,
        line.row === undefined ? null : toJson(line.row), line.data === undefined ? null : toJson(line.data));
    return Number(r.lastInsertRowid);
  }

  /**
   * Open a position and journal the entry in one transaction. Returns the new position, or null when this
   * book already holds an open position in the mint (the partial unique index refuses it): idempotent.
   */
  openPosition(p: OpenInput): BotPosition | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.db.prepare("SELECT id FROM bot_positions WHERE book = ? AND mint = ? AND status = 'open'").get(p.book, p.mint);
      if (exists) { this.db.exec('ROLLBACK'); return null; }
      const r = this.db.prepare(`INSERT INTO bot_positions (book, mint, symbol, decimals, status, opened_at, size_usd, sol_usd_entry, cost_lamports, tokens_raw, entry_price_usd, entry_impact_pct)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.book, p.mint, p.symbol, p.decimals, p.openedAt, p.sizeUsd, p.solUsdEntry, p.costLamports.toString(), p.tokensRaw.toString(), p.entryPriceUsd, p.entryImpactPct);
      const id = Number(r.lastInsertRowid);
      this.journal({ t: p.openedAt, book: p.book, kind: 'entry', positionId: id, mint: p.mint, symbol: p.symbol, reason: p.reason, row: p.row, data: p.data });
      this.db.exec('COMMIT');
      return this.position(id);
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return null;
      throw err;
    }
  }

  /** Close an open position (PnL from net exit proceeds vs cost) and journal the exit, in one transaction. */
  closePosition(c: CloseInput): BotPosition | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pos = this.position(c.id);
      if (!pos || pos.status !== 'open') { this.db.exec('ROLLBACK'); return null; }
      const pnlLamports = c.exitLamports - pos.costLamports;
      const pnlPct = pos.costLamports > 0n ? (Number(pnlLamports) / Number(pos.costLamports)) * 100 : 0;
      const pnlUsd = (Number(pnlLamports) / 1e9) * pos.solUsdEntry;
      this.db.prepare(`UPDATE bot_positions SET status = 'closed', closed_at = ?, exit_lamports = ?, exit_reason = ?, exit_impact_pct = ?, sol_usd_exit = ?,
        pnl_lamports = ?, pnl_usd = ?, pnl_pct = ?, mark_lamports = ?, mark_at = ? WHERE id = ? AND status = 'open'`)
        .run(c.closedAt, c.exitLamports.toString(), c.exitReason, c.exitImpactPct, c.solUsdExit, pnlLamports.toString(), pnlUsd, pnlPct, c.exitLamports.toString(), c.closedAt, c.id);
      this.journal({ t: c.closedAt, book: pos.book, kind: 'exit', positionId: c.id, mint: pos.mint, symbol: pos.symbol, reason: c.reason, row: c.row, data: c.data });
      this.db.exec('COMMIT');
      return this.position(c.id);
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /** Record the latest net sell-quote value of an open position (resets the quote-failure count). */
  mark(id: number, lamports: bigint, at: number): void {
    this.db.prepare("UPDATE bot_positions SET mark_lamports = ?, mark_at = ?, quote_failures = 0 WHERE id = ? AND status = 'open'").run(lamports.toString(), at, id);
  }

  /** Count one failed sell quote; returns the new consecutive-failure count. */
  quoteFailed(id: number): number {
    this.db.prepare("UPDATE bot_positions SET quote_failures = quote_failures + 1 WHERE id = ? AND status = 'open'").run(id);
    return this.position(id)?.quoteFailures ?? 0;
  }

  position(id: number): BotPosition | null {
    const r = this.db.prepare('SELECT * FROM bot_positions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToPosition(r) : null;
  }

  openPositions(book?: Book): BotPosition[] {
    const rows = (book
      ? this.db.prepare("SELECT * FROM bot_positions WHERE status = 'open' AND book = ? ORDER BY opened_at, id").all(book)
      : this.db.prepare("SELECT * FROM bot_positions WHERE status = 'open' ORDER BY opened_at, id").all()) as Record<string, unknown>[];
    return rows.map(rowToPosition);
  }

  /** Every position of a book (or all), oldest first. */
  positions(book?: Book): BotPosition[] {
    const rows = (book
      ? this.db.prepare('SELECT * FROM bot_positions WHERE book = ? ORDER BY opened_at, id').all(book)
      : this.db.prepare('SELECT * FROM bot_positions ORDER BY opened_at, id').all()) as Record<string, unknown>[];
    return rows.map(rowToPosition);
  }

  /** Entries this book made at or after `since` (the rolling entries-per-hour cap). */
  entriesSince(book: Book, since: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM bot_positions WHERE book = ? AND opened_at >= ?').get(book, since) as { n: number };
    return Number(r.n);
  }

  /** When this book last closed a position in the mint (re-entry cooldown), or null. */
  lastExit(book: Book, mint: string): number | null {
    const r = this.db.prepare("SELECT MAX(closed_at) AS t FROM bot_positions WHERE book = ? AND mint = ? AND status = 'closed'").get(book, mint) as { t: number | null };
    return r.t === null || r.t === undefined ? null : Number(r.t);
  }

  journalLines(opts: { since?: number; kinds?: JournalKind[]; limit?: number } = {}): JournalLine[] {
    const rows = this.db.prepare('SELECT * FROM bot_journal WHERE t >= ? ORDER BY id DESC LIMIT ?').all(opts.since ?? 0, opts.limit ?? 1000) as Record<string, unknown>[];
    return rows
      .filter((r) => !opts.kinds || opts.kinds.includes(String(r.kind) as JournalKind))
      .map((r) => ({
        id: Number(r.id), t: Number(r.t), book: String(r.book) as Book | 'bot', kind: String(r.kind) as JournalKind,
        positionId: numOrNull(r.position_id), mint: r.mint === null ? null : String(r.mint), symbol: r.symbol === null ? null : String(r.symbol),
        reason: String(r.reason), row: r.row === null ? null : JSON.parse(String(r.row)), data: r.data === null ? null : JSON.parse(String(r.data)),
      }));
  }

  close(): void { this.db.close(); }
}

export interface PaperBotSummary { open: number; closed: number; lastAt: number | null }

/**
 * A read-only summary of the bot ledger for the doctor: null when the db or the bot tables do not exist yet.
 * Opens the file read-only, so it never creates a db or a table.
 */
export function readBotSummary(path: string): PaperBotSummary | null {
  if (path === ':memory:' || !existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_positions'").get();
    if (!has) return null;
    const r = db.prepare("SELECT SUM(status = 'open') AS open, SUM(status = 'closed') AS closed, MAX(MAX(opened_at), COALESCE(MAX(closed_at), 0)) AS last FROM bot_positions").get() as { open: number | null; closed: number | null; last: number | null };
    return { open: Number(r.open ?? 0), closed: Number(r.closed ?? 0), lastAt: r.last ? Number(r.last) : null };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function rowToPosition(r: Record<string, unknown>): BotPosition {
  return {
    id: Number(r.id),
    book: String(r.book) as Book,
    mint: String(r.mint),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    status: r.status === 'closed' ? 'closed' : 'open',
    openedAt: Number(r.opened_at),
    closedAt: numOrNull(r.closed_at),
    sizeUsd: Number(r.size_usd),
    solUsdEntry: Number(r.sol_usd_entry),
    costLamports: BigInt(String(r.cost_lamports)),
    tokensRaw: BigInt(String(r.tokens_raw)),
    entryPriceUsd: numOrNull(r.entry_price_usd),
    entryImpactPct: numOrNull(r.entry_impact_pct),
    exitLamports: big(r.exit_lamports),
    exitReason: r.exit_reason === null || r.exit_reason === undefined ? null : (String(r.exit_reason) as ExitReason),
    exitImpactPct: numOrNull(r.exit_impact_pct),
    solUsdExit: numOrNull(r.sol_usd_exit),
    pnlLamports: big(r.pnl_lamports),
    pnlUsd: numOrNull(r.pnl_usd),
    pnlPct: numOrNull(r.pnl_pct),
    markLamports: big(r.mark_lamports),
    markAt: numOrNull(r.mark_at),
    quoteFailures: Number(r.quote_failures ?? 0),
  };
}
