// trenchscope T1 — the PANIC kill switch (SPEC §6.4 "panic key", §6.5 `panic()`; task-1310 round 2).
//
// The cheapest safe version of the signer's panic path tonight: a marker file under ~/.dexterm. While
// it exists, the live executor refuses every plan and every confirm, in EVERY process that reads it
// (the file is re-read on each check, never cached), so `trenchscope wallet panic` from a second terminal
// stops a trade that another trenchscope is about to sign. A file we cannot parse counts as ENGAGED
// (fail closed). Releasing it (`trenchscope wallet resume`) requires a real TTY keypress — see the CLI.
// This module holds no keys and performs no network I/O.

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface PanicRecord {
  engagedAt: number;
  reason: string;
}

export function defaultPanicPath(): string {
  return join(homedir(), '.dexterm', 'trading.panic');
}

export class KillSwitch {
  readonly path: string;
  constructor(path: string = defaultPanicPath()) { this.path = path; }

  /** The engaged record, or null when live trading is allowed. Always re-reads the file. */
  engaged(): PanicRecord | null {
    if (!existsSync(this.path)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PanicRecord>;
      return { engagedAt: Number(raw.engagedAt) || 0, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : 'panic' };
    } catch {
      return { engagedAt: 0, reason: 'panic file unreadable (treated as engaged)' };
    }
  }

  /** Engage: disable live trading everywhere. Idempotent; the first reason is kept. */
  engage(reason = 'panic', now = Date.now()): PanicRecord {
    const existing = this.engaged();
    if (existing) return existing;
    const rec: PanicRecord = { engagedAt: now, reason: reason.slice(0, 200) };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
    return rec;
  }

  /** Release: returns true when a panic was engaged. The CLI gates this behind a TTY keypress. */
  release(): boolean {
    if (!existsSync(this.path)) return false;
    rmSync(this.path, { force: true });
    return true;
  }
}
