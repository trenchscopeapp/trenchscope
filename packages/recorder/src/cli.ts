// `trenchscope recorder <cmd>` / `dexterm-recorder <cmd>`: stats, label, prune, export. No network.
import { writeFileSync } from 'node:fs';
import { defaultDbPath } from '@dexterm/data';
import { Recorder } from './recorder.ts';
import { exportRecorded } from './export.ts';

export interface CliIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
}

export const RECORDER_HELP = `trenchscope recorder: the history recorder's tables (snapshots, feed membership, outcomes)

  trenchscope recorder stats  [--db PATH]                     rows, labels, bytes per snapshot, DB size
  trenchscope recorder label  [--db PATH]                     label every due t0 anchor now (code only, no model)
  trenchscope recorder prune  [--db PATH]                     run retention now (raw 7 d, 1/min after 24 h, columns 90 d)
  trenchscope recorder export [--db PATH] [--out FILE] [--since T] [--until T] [--labelled-only] [--limit N]
                                                          eval export (T = ISO date or unix ms); stdout without --out

  --db defaults to DEXTERM_DB_PATH, else ~/.local/share/dexterm/dexterm.db. The recorder itself runs
  inside the live app; switch it off with --no-recorder or DEXTERM_RECORDER=0.`;

function parse(argv: string[]): { cmd: string; opts: Record<string, string | true> } {
  const opts: Record<string, string | true> = {};
  let cmd = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--') && k !== 'labelled-only') { opts[k] = v; i++; } else opts[k] = true;
    } else if (!cmd) cmd = a;
  }
  return { cmd, opts };
}

function time(v: string | true | undefined): number | undefined {
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`bad time ${JSON.stringify(v)} (ISO date or unix ms)`);
  return t;
}

export async function recorderCli(argv: string[], io: CliIo): Promise<number> {
  const { cmd, opts } = parse(argv);
  if (!cmd || cmd === 'help' || opts.help || opts.h) { io.stdout.write(RECORDER_HELP + '\n'); return cmd ? 0 : 2; }
  const path = typeof opts.db === 'string' ? opts.db : (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
  if (path === ':memory:') { io.stderr.write('trenchscope recorder: an in-memory DB has no history\n'); return 2; }
  let rec: Recorder | null = null;
  try {
    rec = new Recorder({ path });
    if (cmd === 'stats') {
      const s = rec.stats();
      const mb = (b: number | null) => (b === null ? '—' : `${(b / 1e6).toFixed(1)} MB`);
      const when = (t: number | null) => (t === null ? '—' : new Date(t).toISOString());
      io.stdout.write([
        `db              ${path} (${mb(s.dbBytes)}, every table)`,
        `recorder bytes  ${s.recorderBytes === null ? '—' : s.recorderBytes} (${mb(s.recorderBytes)}, its own tables + indexes)`,
        `schema          v${s.schemaVersion} · labeler ${s.labelerVersion}`,
        `snapshots       ${s.snapshots} (live ${s.live}, sweep ${s.sweep}, t0 anchors ${s.t0}, with raw JSON ${s.withRaw})`,
        `bytes/snapshot  ${s.bytesPerSnapshot === null ? '—' : s.bytesPerSnapshot.toFixed(0)}`,
        `mints           ${s.mints}`,
        `feed_members    ${s.feedMembers}`,
        `outcomes        ${s.outcomes}${s.outcomes ? ' (' + Object.entries(s.outcomesByLabel).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : ''}`,
        `sweeps          ${s.sweeps} runs · ${s.sweepCallsToday} DexScreener calls today`,
        `span            ${when(s.oldestT)} → ${when(s.newestT)}`,
      ].join('\n') + '\n');
      return 0;
    }
    if (cmd === 'label') {
      const r = rec.labelPending(Date.now(), 1_000_000);
      io.stdout.write(`labelled ${r.labelled} (${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing due'}); ${r.pending} t0 rows still open\n`);
      return 0;
    }
    if (cmd === 'prune') {
      const r = rec.prune();
      io.stdout.write(`raw cleared ${r.rawCleared} · downsampled ${r.downsampled} · expired ${r.expired} snapshots, ${r.membersExpired} feed rows\n`);
      return 0;
    }
    if (cmd === 'export') {
      const doc = exportRecorded(rec.database, {
        since: time(opts.since), until: time(opts.until), labelledOnly: opts['labelled-only'] === true,
        limit: typeof opts.limit === 'string' ? Number(opts.limit) : undefined,
      });
      const text = JSON.stringify(doc, null, 1);
      if (typeof opts.out === 'string') {
        writeFileSync(opts.out, text);
        io.stderr.write(`wrote ${opts.out}: ${doc.counts.records} records, ${doc.counts.with_any_outcome} with outcomes\n`);
      } else io.stdout.write(text + '\n');
      return 0;
    }
    io.stderr.write(`trenchscope recorder: unknown command ${cmd}\n${RECORDER_HELP}\n`);
    return 2;
  } catch (err) {
    io.stderr.write(`trenchscope recorder: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    rec?.close();
  }
}
