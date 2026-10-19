// Minimal socket.io v4 client (Engine.IO v4, websocket transport only) for Shrine, over Node's global
// WebSocket. Zero dependencies. Only what the Shrine candle feed needs:
//
//   engine.io  '0{handshake}' open   '2' ping -> '3' pong   '1' close   '4<socket.io packet>' message
//   socket.io  '0{auth}' connect     '1' disconnect   '2[id][name,...args]' event   '3<id>[...args]' ack
//              '4{message}' connect error
//
// The host is pinned (wss://sol.shrine.trade, no URL option). The API key travels ONLY in the socket.io
// CONNECT packet's auth payload ('40{"api_key":...}') after the socket is open, never in the URL, so it
// cannot reach a log, a recording or an error string: every error this module builds is a fixed phrase.
//
// Lifecycle: connects lazily on the first request; every timer is unref'd and bounded (connect, ack,
// ping watchdog, reconnect backoff, idle close); a socket nobody holds closes after `idleCloseMs`; a held
// socket (live viewers) reconnects with doubling backoff and replays its `onConnect` hooks; close() is
// permanent and leaves no timer or socket behind, so quitting the app never waits on Shrine (task-1319).

import type { WsLike, WsFactory } from './pumpportal.ts';

export const SHRINE_HOST = 'sol.shrine.trade';
/** The one URL this client ever opens. Carries no credential. */
export const SHRINE_WS_URL = `wss://${SHRINE_HOST}/socket.io/?EIO=4&transport=websocket`;

export type ShrineSocketState = 'idle' | 'connecting' | 'open' | 'closed';

/** Injectable timers (tests count and fire them; production uses unref'd real timers). */
export interface ShrineTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: ShrineTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ShrineSocketOptions {
  apiKey: string;
  ws?: WsFactory;
  timers?: ShrineTimers;
  /** Open + socket.io CONNECT must complete within this (default 8 s). */
  connectTimeoutMs?: number;
  /** A request's ack must arrive within this (default 8 s). */
  ackTimeoutMs?: number;
  /** Close an unheld, quiet socket after this (default 15 s). */
  idleCloseMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Aborted on app shutdown: closes the socket for good (same signal as the HTTP transport). */
  shutdownSignal?: AbortSignal;
  /** Connection outcomes for the health registry. Messages are fixed phrases (no key, no server text). */
  onHealth?: (ok: boolean, error?: string) => void;
}

/** Thrown for every failure; the message never carries the key or raw server text. */
export class ShrineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShrineError';
  }
}

interface PendingAck { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }
interface Waiter { resolve: () => void; reject: (e: Error) => void }

export class ShrineSocket {
  // the key lives only in a true private field: never enumerable, never serialised or inspected with the data layer
  readonly #apiKey: string;
  private readonly opts: Omit<ShrineSocketOptions, 'apiKey'>;
  private readonly make: WsFactory;
  private readonly timers: ShrineTimers;
  private ws: WsLike | null = null;
  private _state: ShrineSocketState = 'idle';
  private nextAckId = 0;
  private readonly acks = new Map<number, PendingAck>();
  private waiters: Waiter[] = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  private readonly connectHooks = new Set<() => void>();
  private readonly disconnectHooks = new Set<() => void>();
  private holds = 0;
  private failures = 0;
  private connectTimer: unknown = null;
  private pingTimer: unknown = null;
  private retryTimer: unknown = null;
  private idleTimer: unknown = null;
  private pingWindowMs = 45_000;
  private readonly onShutdown = () => this.close();

  constructor(opts: ShrineSocketOptions) {
    const { apiKey, ...rest } = opts;
    this.#apiKey = apiKey;
    this.opts = rest;
    this.timers = opts.timers ?? realTimers;
    const g = globalThis as unknown as { WebSocket?: new (url: string) => WsLike };
    this.make = opts.ws ?? ((url) => {
      if (!g.WebSocket) throw new ShrineError('shrine: WebSocket is not available in this runtime');
      return new g.WebSocket(url);
    });
    if (opts.shutdownSignal?.aborted) this._state = 'closed';
    else opts.shutdownSignal?.addEventListener('abort', this.onShutdown, { once: true });
  }

  get state(): ShrineSocketState {
    return this._state;
  }

  /** Timers this client currently holds (connect, ping, retry, idle, acks). Zero after close(). */
  get pendingTimers(): number {
    return [this.connectTimer, this.pingTimer, this.retryTimer, this.idleTimer].filter((t) => t !== null).length + this.acks.size;
  }

  /** Subscribe to a server event. Returns the unsubscribe. */
  on(event: string, fn: (data: unknown) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  /** Runs on every (re)connect: live viewers resubscribe their pools here. */
  onConnect(fn: () => void): () => void {
    this.connectHooks.add(fn);
    return () => { this.connectHooks.delete(fn); };
  }

  onDisconnect(fn: () => void): () => void {
    this.disconnectHooks.add(fn);
    return () => { this.disconnectHooks.delete(fn); };
  }

  /**
   * Keep the socket open (and reconnecting after a drop) while held. Live viewers hold; one-shot
   * history reads do not. Returns the release; the last release starts the idle-close timer.
   */
  hold(): () => void {
    if (this._state === 'closed') return () => {};
    this.holds++;
    this.cancelIdle();
    if (this._state === 'idle' && this.retryTimer === null) this.connect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
      this.maybeIdle();
    };
  }

  /** Emit `event` with `data` and resolve the server's ack (its first argument). Bounded by ackTimeoutMs. */
  async request(event: string, data: unknown, timeoutMs = this.opts.ackTimeoutMs ?? 8_000): Promise<unknown> {
    if (this._state === 'closed') throw new ShrineError('shrine: closed');
    this.cancelIdle();
    try {
      await this.whenOpen();
      return await new Promise<unknown>((resolve, reject) => {
        const ws = this.ws;
        if (!ws || this._state !== 'open') { reject(new ShrineError('shrine: disconnected')); return; }
        const id = this.nextAckId++;
        const timer = this.timers.set(() => {
          if (this.acks.delete(id)) reject(new ShrineError(`shrine: ${event} timed out`));
          this.maybeIdle();
        }, timeoutMs);
        this.acks.set(id, { resolve, reject, timer });
        try {
          ws.send(`42${id}${JSON.stringify([event, data])}`);
        } catch {
          this.timers.clear(timer);
          this.acks.delete(id);
          reject(new ShrineError('shrine: send failed'));
        }
      });
    } finally {
      this.maybeIdle();
    }
  }

  /** Fire-and-forget emit; dropped when the socket is not open (a reconnect replays subscriptions). */
  emit(event: string, data: unknown): void {
    if (this._state !== 'open' || !this.ws) return;
    try { this.ws.send(`42${JSON.stringify([event, data])}`); } catch { /* the close handler takes over */ }
  }

  /** Permanent: rejects pending work, closes the socket, clears every timer. Idempotent. */
  close(): void {
    if (this._state === 'closed' && this.ws === null && this.pendingTimers === 0) return;
    this._state = 'closed';
    this.opts.shutdownSignal?.removeEventListener('abort', this.onShutdown);
    this.teardown(new ShrineError('shrine: closed'));
    this.cancelIdle();
    this.clearRetry();
    this.connectHooks.clear();
    this.disconnectHooks.clear();
    this.handlers.clear();
  }

  // ---------------------------------------------------------------------------------------------

  private whenOpen(): Promise<void> {
    if (this._state === 'open') return Promise.resolve();
    if (this._state === 'closed') return Promise.reject(new ShrineError('shrine: closed'));
    const p = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (this._state === 'idle') {
      // A request during a reconnect backoff connects now instead of waiting the backoff out.
      this.clearRetry();
      this.connect();
    }
    return p;
  }

  private connect(): void {
    if (this._state === 'closed' || this.ws) return;
    this._state = 'connecting';
    let ws: WsLike;
    try {
      ws = this.make(SHRINE_WS_URL);
    } catch {
      this.drop('shrine: connect failed');
      return;
    }
    this.ws = ws;
    this.connectTimer = this.timers.set(() => {
      this.connectTimer = null;
      if (this.ws === ws) this.drop('shrine: connect timed out');
    }, this.opts.connectTimeoutMs ?? 8_000);
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      const text = typeof ev.data === 'string' ? ev.data : ev.data instanceof ArrayBuffer ? Buffer.from(ev.data).toString('utf8') : String(ev.data ?? '');
      this.handle(text);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.drop('shrine: connection closed');
    });
    ws.addEventListener('error', () => {
      if (this.ws === ws) this.drop('shrine: connection error');
    });
  }

  /** One engine.io frame. Public for the framing tests; the live socket feeds it every message. */
  handle(text: string): void {
    const ws = this.ws;
    if (!ws || text.length === 0) return;
    const kind = text[0];
    if (kind === '0') {
      // Engine.IO open: learn the ping window, then join the default namespace with the key as auth.
      const hs = parseJson(text.slice(1)) as { pingInterval?: unknown; pingTimeout?: unknown } | null;
      const interval = typeof hs?.pingInterval === 'number' && hs.pingInterval > 0 ? hs.pingInterval : 25_000;
      const timeout = typeof hs?.pingTimeout === 'number' && hs.pingTimeout > 0 ? hs.pingTimeout : 20_000;
      this.pingWindowMs = Math.min(120_000, interval + timeout);
      this.armPing();
      try { ws.send(`40${JSON.stringify({ api_key: this.#apiKey })}`); } catch { this.drop('shrine: send failed'); }
      return;
    }
    if (kind === '2') {
      this.armPing();
      try { ws.send('3'); } catch { /* close handler */ }
      return;
    }
    if (kind === '1') { this.drop('shrine: server closed'); return; }
    if (kind !== '4') return;
    const body = text.slice(1);
    const type = body[0];
    let rest = body.slice(1);
    // Optional namespace ("/ns,"): only the default namespace is used.
    if (rest.startsWith('/')) {
      const comma = rest.indexOf(',');
      if (comma < 0) return;
      rest = rest.slice(comma + 1);
    }
    const idMatch = /^\d+/.exec(rest);
    const id = idMatch ? Number(idMatch[0]) : null;
    if (idMatch) rest = rest.slice(idMatch[0].length);
    if (type === '0') {
      this.opened();
      return;
    }
    if (type === '4') {
      // Auth refused. The server's message is not echoed (it is third-party text).
      this.opts.onHealth?.(false, 'shrine: connection refused (check ~/.dexterm/shrine.key)');
      this.drop('shrine: connection refused', true);
      return;
    }
    if (type === '1') { this.drop('shrine: server disconnected'); return; }
    if (type === '3') {
      if (id === null) return;
      const pending = this.acks.get(id);
      if (!pending) return;
      this.acks.delete(id);
      this.timers.clear(pending.timer);
      const args = parseJson(rest);
      pending.resolve(Array.isArray(args) ? args[0] : undefined);
      return;
    }
    if (type === '2') {
      const args = parseJson(rest);
      if (id !== null) { try { ws.send(`43${id}[]`); } catch { /* close handler */ } }
      if (!Array.isArray(args) || typeof args[0] !== 'string') return;
      const set = this.handlers.get(args[0]);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(args[1]); } catch { /* a handler bug never kills the socket */ }
      }
    }
  }

  private opened(): void {
    if (this.connectTimer !== null) { this.timers.clear(this.connectTimer); this.connectTimer = null; }
    this._state = 'open';
    this.failures = 0;
    this.opts.onHealth?.(true);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve();
    for (const fn of [...this.connectHooks]) {
      try { fn(); } catch { /* ignore */ }
    }
    this.maybeIdle();
  }

  private armPing(): void {
    if (this.pingTimer !== null) this.timers.clear(this.pingTimer);
    const ws = this.ws;
    this.pingTimer = this.timers.set(() => {
      this.pingTimer = null;
      if (this.ws === ws) this.drop('shrine: ping timed out');
    }, this.pingWindowMs);
  }

  /** Drop the current socket. Reconnects with backoff only while someone holds the socket. */
  private drop(reason: string, refused = false): void {
    const wasOpen = this._state === 'open';
    this.teardown(new ShrineError(reason));
    if (this._state === 'closed') return;
    this._state = 'idle';
    if (!refused) this.opts.onHealth?.(false, reason);
    this.failures++;
    if (wasOpen) for (const fn of [...this.disconnectHooks]) { try { fn(); } catch { /* ignore */ } }
    if (this.holds > 0 && !refused) this.scheduleRetry();
  }

  private teardown(err: Error): void {
    const ws = this.ws;
    this.ws = null;
    if (this.connectTimer !== null) { this.timers.clear(this.connectTimer); this.connectTimer = null; }
    if (this.pingTimer !== null) { this.timers.clear(this.pingTimer); this.pingTimer = null; }
    for (const [, p] of this.acks) { this.timers.clear(p.timer); p.reject(err); }
    this.acks.clear();
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
    if (ws) {
      try { ws.send('41'); } catch { /* not open */ }
      try { ws.close(1000, 'trenchscope'); } catch { /* already closed */ }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this._state === 'closed') return;
    const base = this.opts.baseBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 15_000;
    const wait = Math.min(max, base * 2 ** Math.max(0, this.failures - 1));
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null;
      if (this.holds > 0 && this._state === 'idle') this.connect();
    }, wait);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) { this.timers.clear(this.retryTimer); this.retryTimer = null; }
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) { this.timers.clear(this.idleTimer); this.idleTimer = null; }
  }

  /** Nobody holds the socket and nothing is in flight: close it after the idle window. */
  private maybeIdle(): void {
    if (this.holds > 0 || this.acks.size > 0 || this.waiters.length > 0 || this.idleTimer !== null) return;
    if (this._state === 'closed') return;
    this.clearRetry();
    if (this.ws === null) return;
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = null;
      if (this.holds > 0 || this.acks.size > 0 || this.waiters.length > 0) return;
      this.teardown(new ShrineError('shrine: idle'));
      if (this._state !== 'closed') this._state = 'idle';
    }, this.opts.idleCloseMs ?? 15_000);
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try { return JSON.parse(text); } catch { return null; }
}
