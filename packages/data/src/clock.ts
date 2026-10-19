// Injectable clock so the limiter, health registry and cache can be tested
// deterministically with a fake clock (no real timers in tests).

export interface Clock {
  now(): number;
  /**
   * Resolve after `ms`. An optional `signal` cancels the wait and resolves at once, clearing the
   * underlying timer so a pending backoff/pacing sleep never keeps a quitting process alive
   * (task-1311: the WS reconnect backoff must not survive a stop()/quit).
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, Math.max(0, ms));
      function done() { signal?.removeEventListener('abort', done); clearTimeout(t); resolve(); }
      signal?.addEventListener('abort', done, { once: true });
    });
  },
};

interface Timer { at: number; seq: number; resolve: () => void }

/** Manual clock: time only moves when the test calls advance()/runUntil(). */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer: Timer = { at: this.t + Math.max(0, ms), seq: this.seq++, resolve };
      this.timers.push(timer);
      // Cancellation resolves the wait at once and drops the pending timer, matching systemClock.
      signal?.addEventListener('abort', () => {
        const i = this.timers.indexOf(timer);
        if (i >= 0) this.timers.splice(i, 1);
        resolve();
      }, { once: true });
    });
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Advance time by `ms`, firing due timers in order and letting their continuations run. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await flushMicrotasks();
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    this.t = target;
    await flushMicrotasks();
  }
}

/** Let every queued microtask (and their follow-ups) run before returning. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
