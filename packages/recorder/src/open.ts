// Shared read-only open for the recorder tables. Three consumers (the MCP `historyDb()`, `dexterm
// narrative`, and now `trenchscope backtest` / the `rug_backtest` MCP tool) each opened a read-only
// DatabaseSync and inline-checked that `token_snapshots` exists before querying; this is that one check.
//
// It never creates the schema (read-only; the live Recorder owns writes) and returns null when the file
// has no recorder history yet, so a caller can say "no history recorded" instead of throwing.

import { DatabaseSync } from 'node:sqlite';

/**
 * Open the app DB read-only and confirm the recorder schema exists. Returns null (and closes the handle)
 * when `token_snapshots` is absent — i.e. nothing has been recorded into this file yet. `:memory:` has no
 * on-disk history, so it returns null too. Throws only on a genuine open error (missing file, locked).
 */
export function openHistoryReadOnly(path: string): DatabaseSync | null {
  if (path === ':memory:') return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_snapshots'").get();
    if (!t) { db.close(); return null; }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
