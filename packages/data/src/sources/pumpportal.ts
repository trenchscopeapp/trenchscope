// PumpPortal real-time data stream (SPEC §3.1 S7; inventory 2026-10-06 §1b). Keyless, read-only.
//   wss://pumpportal.fun/api/data
//   -> { method: 'subscribeNewToken' }   creates: { signature, mint, traderPublicKey, txType: 'create',
//        initialBuy, solAmount, bondingCurveKey, vTokensInBondingCurve, vSolInBondingCurve, marketCapSol,
//        name, symbol, uri, is_mayhem_mode, pool }
//   -> { method: 'subscribeMigration' }  migrations (shape varies; we keep mint + signature + pool)
// One connection per client (their rule). Measured 2026-10-06: connect 116 ms, first message 139 ms,
// ~15 creates/min, ~3 migrations/min. The trade streams are paid and never subscribed here.
//
// The client reconnects with exponential backoff (1 s doubling to 30 s), reports every message / error
// to the health registry under `pumpportal`, can record the session into a FixtureStore stream, and the
// same event path replays a recording (tests, --replay) with the original timing or instantly.

import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { HealthRegistry } from '../health.ts';
import type { StreamRecording } from '../fixtures.ts';
import type { Create } from '../model.ts';
import { numOrNull } from '../util.ts';

export const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';
/** pump.fun Global config (docs/pump-fun/docs-overview.md): the curve starts with these virtual/real reserves. */
export const PUMP_INITIAL_VIRTUAL_TOKENS = 1_073_000_000; // UI units (6 decimals)
export const PUMP_INITIAL_REAL_TOKENS = 793_100_000;
export const PUMP_INITIAL_VIRTUAL_SOL = 30;

export interface PumpRawCreate {
  signature?: string;
  mint?: string;
  traderPublicKey?: string;
  txType?: string;
  initialBuy?: number | string;
  solAmount?: number | string;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number | string;
  vSolInBondingCurve?: number | string;
  marketCapSol?: number | string;
  name?: string;
  symbol?: string;
  uri?: string;
  is_mayhem_mode?: boolean;
  pool?: string;
}

export type PumpEvent =
  | { kind: 'create'; create: Create; receivedAt: number }
  | { kind: 'migrate'; mint: string | null; signature: string | null; pool: string | null; receivedAt: number }
  | { kind: 'info'; message: string; receivedAt: number }
  | { kind: 'other'; receivedAt: number };

/**
 * Curve completion estimate from the virtual token reserves: real tokens left = vTokens − (virtual − real
 * initial offset); complete when none are left. Returns 0..100, or null when the reserves are missing.
 */
export function bondingProgress(vTokens: number | null): number | null {
  if (vTokens === null || !Number.isFinite(vTokens)) return null;
  const offset = PUMP_INITIAL_VIRTUAL_TOKENS - PUMP_INITIAL_REAL_TOKENS; // 279.9M never sold on the curve
  const realLeft = vTokens - offset;
  const pct = (1 - realLeft / PUMP_INITIAL_REAL_TOKENS) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

function launchpadFor(pool: string | undefined, mint: string): Create['launchpad'] {
  const p = (pool ?? '').toLowerCase();
  if (p.includes('bonk')) return 'bonk';
  if (p.includes('pump') || mint.endsWith('pump')) return 'pump.fun';
  return 'unknown';
}

export function createFromRaw(raw: PumpRawCreate, receivedAt: number): Create | null {
  if (!raw.mint || typeof raw.mint !== 'string') return null;
  const vToken = numOrNull(raw.vTokensInBondingCurve);
  return {
    source: 'pumpportal',
    fetchedAt: receivedAt,
    mint: raw.mint,
    creator: typeof raw.traderPublicKey === 'string' ? raw.traderPublicKey : '',
    launchpad: launchpadFor(raw.pool, raw.mint),
    name: typeof raw.name === 'string' ? raw.name : '',
    symbol: typeof raw.symbol === 'string' ? raw.symbol : '',
    uri: typeof raw.uri === 'string' && raw.uri ? raw.uri : null,
    signature: typeof raw.signature === 'string' ? raw.signature : null,
    initialBuyTokens: numOrNull(raw.initialBuy),
    initialBuySol: numOrNull(raw.solAmount),
    vSol: numOrNull(raw.vSolInBondingCurve),
    vToken,
    marketCapSol: numOrNull(raw.marketCapSol),
    bondingCurve: typeof raw.bondingCurveKey === 'string' ? raw.bondingCurveKey : null,
    pool: typeof raw.pool === 'string' ? raw.pool : null,
    bondingPct: bondingProgress(vToken),
    receivedAt,
  };
}

/** Classify one text frame. Never throws: junk is `other`. */
export function parsePumpMessage(text: string, receivedAt: number): PumpEvent {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { kind: 'other', receivedAt };
  }
  if (!j || typeof j !== 'object') return { kind: 'other', receivedAt };
  const o = j as PumpRawCreate & { message?: string; errors?: unknown };
  if (typeof o.message === 'string' && !o.mint) return { kind: 'info', message: o.message, receivedAt };
  if (o.txType === 'create' || (o.mint && (o.name !== undefined || o.vTokensInBondingCurve !== undefined))) {
    const create = createFromRaw(o, receivedAt);
    return create ? { kind: 'create', create, receivedAt } : { kind: 'other', receivedAt };
  }
  if (o.txType === 'migrate' || o.txType === 'migration' || /migrat/i.test(text.slice(0, 200))) {
    return { kind: 'migrate', mint: typeof o.mint === 'string' ? o.mint : null, signature: typeof o.signature === 'string' ? o.signature : null, pool: typeof o.pool === 'string' ? o.pool : null, receivedAt };
  }
  return { kind: 'other', receivedAt };
}

/** The subset of the WHATWG WebSocket the client uses (Node 22+ has it globally; tests inject a fake). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}
export type WsFactory = (url: string) => WsLike;

export type PumpState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface PumpStatus {
  state: PumpState;
  attempts: number;
  /** Consecutive failed connects / drops since the last open socket. */
  failures: number;
  messages: number;
  creates: number;
  migrations: number;
  bytes: number;
  connectedAt: number | null;
  lastMessageAt: number | null;
  lastError: string | null;
  nextRetryMs: number | null;
}

export interface PumpPortalOptions {
  url?: string;
  ws?: WsFactory;
  clock?: Clock;
  health?: HealthRegistry;
  /** Fires for every parsed event (creates, migrations, info). */
  onEvent?: (ev: PumpEvent) => void;
  onStatus?: (s: PumpStatus) => void;
  /** When set, every frame is appended here (recording mode). */
  record?: StreamRecording;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Methods to subscribe on open. Only the free ones by default. */
  subscriptions?: string[];
}

export const PUMP_FREE_METHODS = ['subscribeNewToken', 'subscribeMigration'];

export class PumpPortalClient {
  private readonly url: string;
  private readonly make: WsFactory;
  private readonly clock: Clock;
  private readonly health?: HealthRegistry;
  private readonly opts: PumpPortalOptions;
  private ws: WsLike | null = null;
  private status: PumpStatus = { state: 'idle', attempts: 0, failures: 0, messages: 0, creates: 0, migrations: 0, bytes: 0, connectedAt: null, lastMessageAt: null, lastError: null, nextRetryMs: null };
  private stopped = false;
  private startedAt = 0;
  /** Aborts a pending reconnect-backoff sleep so stop() never leaves a timer holding the loop (task-1311). */
  private retryAbort: AbortController | null = null;

  constructor(opts: PumpPortalOptions = {}) {
    this.opts = opts;
    this.url = opts.url ?? PUMPPORTAL_WS;
    this.clock = opts.clock ?? systemClock;
    this.health = opts.health;
    const g = globalThis as unknown as { WebSocket?: new (url: string) => WsLike };
    this.make = opts.ws ?? ((url) => {
      if (!g.WebSocket) throw new Error('WebSocket is not available in this runtime (Node 22+ required)');
      return new g.WebSocket(url);
    });
    for (const m of opts.subscriptions ?? PUMP_FREE_METHODS) {
      if (!PUMP_FREE_METHODS.includes(m)) throw new Error(`refusing paid PumpPortal method ${m}`);
    }
  }

  getStatus(): PumpStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.status.state !== 'idle' && this.status.state !== 'stopped') return;
    this.stopped = false;
    this.startedAt = this.clock.now();
    if (this.opts.record) this.opts.record.startedAt = new Date(this.startedAt).toISOString();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.retryAbort?.abort(); // cancel a pending backoff sleep so the process can exit at once (task-1311)
    this.set({ state: 'stopped', nextRetryMs: null });
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000, 'trenchscope stop'); } catch { /* already closed */ }
  }

  private set(patch: Partial<PumpStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus?.(this.getStatus());
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.set({ state: this.status.attempts === 0 ? 'connecting' : 'reconnecting', attempts: this.status.attempts + 1, nextRetryMs: null });
    let ws: WsLike;
    try {
      ws = this.make(this.url);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return this.retry();
    }
    this.ws = ws;
    let opened = false;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      opened = true;
      this.set({ state: 'open', failures: 0, connectedAt: this.clock.now(), lastError: null });
      for (const method of this.opts.subscriptions ?? PUMP_FREE_METHODS) {
        const text = JSON.stringify({ method });
        try { ws.send(text); } catch { /* close handler will retry */ }
        this.opts.record?.sent.push(text);
      }
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      const text = typeof ev.data === 'string' ? ev.data : ev.data instanceof ArrayBuffer ? Buffer.from(ev.data).toString('utf8') : String(ev.data ?? '');
      this.handle(text);
    });
    ws.addEventListener('error', (ev) => {
      if (this.ws !== ws) return;
      const msg = (ev as { message?: string }).message ?? 'websocket error';
      this.set({ lastError: msg });
    });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      const reason = `closed ${ev.code ?? '?'}${ev.reason ? ` ${ev.reason}` : ''}${opened ? '' : ' before open'}`;
      this.fail(reason);
      void this.retry();
    });
  }

  private fail(message: string): void {
    this.health?.record('pumpportal', { ok: false, error: message });
    this.set({ failures: this.status.failures + 1, lastError: message });
  }

  private async retry(): Promise<void> {
    if (this.stopped) return;
    const base = this.opts.baseBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const wait = Math.min(max, base * 2 ** Math.max(0, this.status.failures - 1));
    this.set({ state: 'reconnecting', nextRetryMs: wait });
    this.retryAbort = new AbortController();
    await this.clock.sleep(wait, this.retryAbort.signal);
    if (this.stopped) return; // stop() fired during the backoff: do not reconnect
    await this.connect();
  }

  /** Parse one frame, record it, report health, emit. Shared by live and replay. */
  handle(text: string, receivedAt: number = this.clock.now()): PumpEvent {
    const ev = parsePumpMessage(text, receivedAt);
    const bytes = Buffer.byteLength(text, 'utf8');
    this.opts.record?.messages.push({ tMs: Math.max(0, receivedAt - this.startedAt), text });
    this.set({
      messages: this.status.messages + 1,
      bytes: this.status.bytes + bytes,
      lastMessageAt: receivedAt,
      creates: this.status.creates + (ev.kind === 'create' ? 1 : 0),
      migrations: this.status.migrations + (ev.kind === 'migrate' ? 1 : 0),
    });
    if (ev.kind === 'create' || ev.kind === 'migrate') this.health?.record('pumpportal', { ok: true, latencyMs: 0 });
    this.opts.onEvent?.(ev);
    return ev;
  }

  /**
   * Replay a recorded session through the same handler. `speed` 1 keeps the recorded gaps (on the
   * client's clock), 0 delivers everything at once. Resolves when the last message was delivered.
   */
  async replay(rec: StreamRecording, speed = 0): Promise<number> {
    this.startedAt = this.clock.now();
    this.set({ state: 'open', connectedAt: this.startedAt, attempts: 1 });
    let last = 0;
    for (const m of rec.messages) {
      if (this.stopped) break;
      if (speed > 0 && m.tMs > last) await this.clock.sleep((m.tMs - last) / speed);
      last = m.tMs;
      // Anchor each message's receive time to the recording's own `tMs` offset, not `clock.now()`. Reading the
      // live clock per message makes `receivedAt` (and the row's `createdAt`) depend on where real-time
      // millisecond boundaries happen to fall inside this synchronous loop, so the newest-first row order
      // flipped between runs — a Node-22 CI flake in the new-pairs replay test (task-1394). Offsets from one
      // clock read are monotonic and deterministic, so replay now sorts identically on every run and engine.
      this.handle(m.text, this.startedAt + m.tMs);
    }
    return rec.messages.length;
  }
}
