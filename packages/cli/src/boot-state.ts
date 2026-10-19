// trenchscope — launch bookkeeping in ~/.dexterm/state.json (task-1297): the first launch gets the full
// glitch boot, every later launch a one-second boot (product decision, 2026-10-06). The directory is
// the same one that holds the Helius key; this module only ever touches state.json and never reads
// anything else from it. Any filesystem failure is swallowed: a missing or unwritable home just
// means every launch is a "first" launch.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BootState {
  version: 1;
  /** Number of completed boots. */
  boots: number;
  firstBoot?: string;
  lastBoot?: string;
}

export interface BootPlan {
  /** Full glitch boot (first launch) or the short one. */
  full: boolean;
  /** Seconds the logo/status sequence runs (t 0 → 1). */
  seconds: number;
  /** Seconds the "jacked in" frame holds before the blink to the screener. */
  holdSeconds: number;
}

export const FULL_BOOT = { seconds: 1.8, holdSeconds: 0.6 };
export const SHORT_BOOT = { seconds: 0.75, holdSeconds: 0.25 };

/** `DEXTERM_HOME` overrides `~/.dexterm` (tests point it at a temp dir). */
export function dextermHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
}

export function stateFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dextermHome(env), 'state.json');
}

export function readBootState(env: NodeJS.ProcessEnv = process.env): BootState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(env), 'utf8')) as Partial<BootState> | null;
    if (raw && typeof raw === 'object' && typeof raw.boots === 'number' && raw.boots >= 0) {
      return { version: 1, boots: Math.floor(raw.boots), firstBoot: typeof raw.firstBoot === 'string' ? raw.firstBoot : undefined, lastBoot: typeof raw.lastBoot === 'string' ? raw.lastBoot : undefined };
    }
  } catch { /* no state yet, unreadable, or malformed: treat as first launch */ }
  return { version: 1, boots: 0 };
}

/** Decide the boot sequence for this launch without touching the file. */
export function bootPlan(state: BootState): BootPlan {
  const full = state.boots === 0;
  return { full, ...(full ? FULL_BOOT : SHORT_BOOT) };
}

/** Record a completed boot. Never throws; returns false when the file could not be written. */
export function recordBoot(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): boolean {
  try {
    const prev = readBootState(env);
    const next: BootState = { version: 1, boots: prev.boots + 1, firstBoot: prev.firstBoot ?? now.toISOString(), lastBoot: now.toISOString() };
    mkdirSync(dextermHome(env), { recursive: true, mode: 0o700 });
    writeFileSync(stateFile(env), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * task-1323: first-paint trace for the boot measurements. `DEXTERM_TRACE=<file>` appends one line per
 * milestone (`<ms since process start> <event> <detail>`), each event at most once, so a pty harness
 * can time cold/warm time-to-first-rows without scraping the screen. Off (null) unless the env var is
 * set; any filesystem failure is swallowed (a trace must never break the app).
 */
export interface BootTrace { mark(event: string, detail?: string): void }

export function bootTrace(env: NodeJS.ProcessEnv = process.env): BootTrace | null {
  const file = env.DEXTERM_TRACE;
  if (!file || !file.trim()) return null;
  const seen = new Set<string>();
  return {
    mark(event, detail = '') {
      if (seen.has(event)) return;
      seen.add(event);
      try { appendFileSync(file, `${performance.now().toFixed(0)} ${event}${detail ? ` ${detail}` : ''}\n`); } catch { /* ignore */ }
    },
  };
}
