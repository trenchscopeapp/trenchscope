// `trenchscope narrative [--window 1h|24h] [--summary] [--db PATH]` (task-1356, AI-SUITE-DESIGN §7).
// Computes the narrative board from the history recorder's snapshots and prints it (or the deterministic
// 90-second morning summary with --summary). No network, no model. Read-only on the DB.
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath } from '@dexterm/data';
import { computeBoard, recentNarrativeRows, loadDefaultLexicon, renderBoardText, summaryText } from '@dexterm/packs';

export interface NarrativeIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
}

export const NARRATIVE_HELP = `trenchscope narrative: the narrative board over recorded history (task-1356). No network, no model.

  trenchscope narrative [--window 1h|24h] [--summary] [--db PATH]

  --window   1h (default) or 24h: which window the "what is working" score uses.
  --summary  print the deterministic 90-second spoken summary instead of the table (keyless, no model).
  --db       defaults to DEXTERM_DB_PATH, else ~/.local/share/dexterm/dexterm.db.

  Narratives are clustered from token names against a versioned lexicon (owner: maintainers); X/Telegram-only
  narratives are missed and the honest unclassified share is shown. The board needs the app to have been
  running with the recorder on (switch off with --no-recorder / DEXTERM_RECORDER=0).`;

function parse(argv: string[]): Record<string, string | true> {
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--') && k !== 'summary') { opts[k] = v; i++; } else opts[k] = true;
  }
  return opts;
}

export function narrativeCommand(argv: string[], io: NarrativeIo): number {
  const opts = parse(argv);
  if (opts.help || opts.h) { io.stdout.write(NARRATIVE_HELP + '\n'); return 0; }
  const path = typeof opts.db === 'string' ? opts.db : (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
  if (path === ':memory:') { io.stderr.write('trenchscope narrative: an in-memory DB has no history\n'); return 2; }
  const window = opts.window === '24h' ? '24h' : '1h';
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_snapshots'").get();
    if (!hasTable) { io.stderr.write(`trenchscope narrative: no recorded history in ${path} (run the app with the recorder on first)\n`); return 2; }
    const rows = recentNarrativeRows(db, {});
    const board = computeBoard(rows, loadDefaultLexicon(), { window });
    if (opts.summary) {
      const s = summaryText(board);
      io.stdout.write(`${s.text}\n\n[${s.words} words ≈ ${s.approx_sec}s at 150 wpm; deterministic template, no model]\n`);
    } else {
      io.stdout.write(renderBoardText(board));
    }
    return 0;
  } catch (e) {
    io.stderr.write(`trenchscope narrative: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
