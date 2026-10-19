// When the app lets the recorder run maintenance (task-1361).
//
// Why this exists: before task-1361 the interactive loop started its maintenance timer at launch with a
// full RECORDER_TICK_MS (60 s) of silence, and nothing ran at quit. Every real run of the app up to
// 2026-10-12 had been a pty smoke / capture run of 8–14 s (reconstructed from the snapshot timestamps in
// ~/.local/share/dexterm/dexterm.db), so in two days of recording — 1676 t0 anchors, 762 mints — not one
// sweep ran and not one outcome was labelled, and both backtests only ever saw fixtures. The jobs
// themselves were fine: the first `labelPending()` over that DB wrote 1106 outcomes.
//
// The rule now: the first maintenance pass runs RECORDER_FIRST_TICK_MS after launch (after the first
// paint, before a short run ends), then every RECORDER_TICK_MS; and `Recorder.close()` labels whatever
// is due (code only, no network) so even a run shorter than the first tick leaves its outcomes behind.

/** How often the app lets the recorder run maintenance (sweep / label / prune checks); each job has its own spacing. */
export const RECORDER_TICK_MS = 60_000;
/** The first maintenance pass after launch: late enough to be after the first paint, early enough for a short run. */
export const RECORDER_FIRST_TICK_MS = 5_000;

/** Decides, from the app's tick, when `Recorder.maintain()` is called. Pure over the clock values it is given. */
export class MaintenanceSchedule {
  private lastAt: number | null = null;
  private readonly launchedAt: number;
  private readonly firstAfterMs: number;
  private readonly everyMs: number;
  constructor(launchedAt: number, firstAfterMs: number = RECORDER_FIRST_TICK_MS, everyMs: number = RECORDER_TICK_MS) {
    this.launchedAt = launchedAt;
    this.firstAfterMs = firstAfterMs;
    this.everyMs = everyMs;
  }

  /** True (once per window) when a maintenance pass is due at `now`; records the pass. */
  due(now: number): boolean {
    const ok = this.lastAt === null ? now - this.launchedAt >= this.firstAfterMs : now - this.lastAt >= this.everyMs;
    if (ok) this.lastAt = now;
    return ok;
  }

  /** Time of the last pass this schedule granted (null before the first). */
  get lastRunAt(): number | null {
    return this.lastAt;
  }

  /** When the next pass becomes due. */
  nextDueAt(): number {
    return this.lastAt === null ? this.launchedAt + this.firstAfterMs : this.lastAt + this.everyMs;
  }
}
