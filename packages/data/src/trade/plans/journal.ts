// task-1355 — the append-only, hash-chained JOURNAL (audit log + crash-recovery source of truth; §6.13.3/§6.13.12).
//
// Every state change is an event: {seq, ts, type, planId?, mandateId?, data, prev, hash}. `hash` covers
// the whole event including `prev`, so a removed, reordered or edited line breaks the chain and
// `verify()` reports exactly where. Signatures are journaled BEFORE a send (CL-03), so a crash between
// "sent" and "confirmed" is recoverable by looking the signature up, never by re-sending. Secrets never
// enter the journal: there is no field for keys, and `redact()` scrubs anything key-shaped defensively.
// Ported from the task-1292 reference simulation (research/task-1292/sim/journal.mjs), typed.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock } from '../../clock.ts';

const KEY_SHAPED = /(?:[1-9A-HJ-NP-Za-km-z]{85,90})|(?:\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\])/g;
export function redact(s: unknown): string { return String(s).replace(KEY_SHAPED, '[REDACTED]'); }

export interface JournalEvent {
  seq: number;
  ts: number;
  type: string;
  planId: string | null;
  mandateId: string | null;
  data: Record<string, unknown> | null;
  prev: string;
  hash: string;
}

export interface AppendFields {
  planId?: string | null;
  mandateId?: string | null;
  data?: Record<string, unknown> | null;
}

export type VerifyResult = { ok: true; count: number } | { ok: false; atSeq: number; why: string };

export function eventHash(e: Omit<JournalEvent, 'hash'>): string {
  const body = JSON.stringify({ seq: e.seq, ts: e.ts, type: e.type, planId: e.planId ?? null, mandateId: e.mandateId ?? null, data: e.data ?? null, prev: e.prev });
  return createHash('sha256').update(body).digest('hex');
}

export class Journal {
  readonly path: string | null;
  private clock: Clock;
  events: JournalEvent[] = [];
  head = 'genesis';
  private dirReady = false;

  /** `path` optional: when given, every event is also appended to a JSONL file (crash recovery / audit export). */
  constructor({ path = null, clock }: { path?: string | null; clock: Clock }) {
    this.path = path;
    this.clock = clock;
    if (path && existsSync(path)) this.load(path);
  }

  append(type: string, fields: AppendFields = {}): JournalEvent {
    const base: Omit<JournalEvent, 'hash'> = {
      seq: this.events.length + 1,
      ts: this.clock.now(),
      type,
      planId: fields.planId ?? null,
      mandateId: fields.mandateId ?? null,
      data: fields.data ?? null,
      prev: this.head,
    };
    const e: JournalEvent = { ...base, hash: eventHash(base) };
    this.events.push(e);
    this.head = e.hash;
    if (this.path) {
      // task-1376: a fresh HOME has no ~/.dexterm yet; create it (owner-only) on the first write instead of ENOENT.
      if (!this.dirReady) { mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 }); this.dirReady = true; }
      appendFileSync(this.path, redact(JSON.stringify(e)) + '\n');
    }
    return e;
  }

  load(path: string): void {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    this.events = lines.map((l) => JSON.parse(l) as JournalEvent);
    this.head = this.events.length ? this.events[this.events.length - 1].hash : 'genesis';
  }

  /** Verify the chain. Returns {ok:true} or {ok:false, atSeq, why}. */
  verify(): VerifyResult {
    let prev = 'genesis';
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (e.seq !== i + 1) return { ok: false, atSeq: e.seq, why: 'seq gap' };
      if (e.prev !== prev) return { ok: false, atSeq: e.seq, why: 'prev mismatch' };
      const { hash, ...rest } = e;
      if (eventHash(rest) !== hash) return { ok: false, atSeq: e.seq, why: 'hash mismatch' };
      prev = e.hash;
    }
    return { ok: true, count: this.events.length };
  }

  byPlan(planId: string): JournalEvent[] { return this.events.filter((e) => e.planId === planId); }
  types(): string[] { return this.events.map((e) => e.type); }
}
