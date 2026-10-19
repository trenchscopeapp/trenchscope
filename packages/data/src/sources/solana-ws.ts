// Solana JSON-RPC WebSocket subscription client (SPEC §3.9 fast lane, task-1312). Read-only.
//   accountSubscribe(pubkey, { encoding: 'base64', commitment: 'processed' })
//   -> accountNotification { params: { subscription, result: { context:{slot}, value:{ data:[b64,'base64'] } } } }
//
// One connection multiplexes every watched account's subscription (SPEC §3.9.4: "multiplex all watchlist
// subs on one connection"). The price is computed on-chain from the account bytes by the caller (the
// fast lane decodes a pump.fun bonding curve), so this client is a pure transport: it owns the socket,
// the desired-subscription set, reconnect with doubling backoff, and resubscribe on reopen (a reconnect
// resets the server's subscription ids). It reports health under `helius-ws` (keyed) or `solana-ws`
// (keyless public RPC), meters streamed bytes for the Helius credit budget, and records/replays a session
// through the same handler (tests, --replay). The URL may carry an api-key: it is never logged — every
// error/health string goes through redactSecrets().

import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { HealthRegistry } from '../health.ts';
import type { StreamRecording } from '../fixtures.ts';
import type { SourceId } from '../model.ts';
import { redactSecrets } from '../rpc-config.ts';
import type { WsLike, WsFactory } from './pumpportal.ts';

/** One decoded account change: the caller computes price from `base64`. */
export interface AccountUpdate {
  account: string;
  slot: number | null;
  base64: string;
  receivedAt: number;
  /** Bytes of this frame, for the credit meter. */
  bytes: number;
}

export type SolanaWsState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface SolanaWsStatus {
  state: SolanaWsState;
  attempts: number;
  /** Consecutive failed connects / drops since the last open socket. */
  failures: number;
  /** Accounts the caller wants subscribed (survives reconnects). */
  desired: number;
  /** Accounts with a live server subscription id right now. */
  active: number;
  messages: number;
  notifications: number;
  bytes: number;
  connectedAt: number | null;
  lastMessageAt: number | null;
  lastError: string | null;
  nextRetryMs: number | null;
}

export interface SolanaWsOptions {
  url: string;
  /** `helius-ws` for a keyed endpoint (metered), else `solana-ws`. */
  source?: Extract<SourceId, 'solana-ws' | 'helius-ws'>;
  ws?: WsFactory;
  clock?: Clock;
  health?: HealthRegistry;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Fires for every account change. */
  onAccount?: (u: AccountUpdate) => void;
  onStatus?: (s: SolanaWsStatus) => void;
  /** Charge streamed bytes (keyed endpoints only): the Helius credit meter's chargeBytes. */
  onBytes?: (bytes: number) => void;
  /** When set, every frame is appended here (recording mode). */
  record?: StreamRecording;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

interface Pending {
  account: string;
  id: number;
}

export class SolanaWsClient {
  private readonly url: string;
  private readonly source: Extract<SourceId, 'solana-ws' | 'helius-ws'>;
  private readonly make: WsFactory;
  private readonly clock: Clock;
  private readonly health?: HealthRegistry;
  private readonly opts: SolanaWsOptions;
  private readonly commitment: string;
  private ws: WsLike | null = null;
  /** Accounts the caller wants (persists across reconnects). */
  private readonly desired = new Set<string>();
  /** server subId -> account (active subscriptions on the current socket). */
  private readonly bySubId = new Map<number, string>();
  /** request id -> account (subscribe acks still pending on the current socket). */
  private readonly pending = new Map<number, string>();
  private nextReqId = 1;
  private status: SolanaWsStatus = { state: 'idle', attempts: 0, failures: 0, desired: 0, active: 0, messages: 0, notifications: 0, bytes: 0, connectedAt: null, lastMessageAt: null, lastError: null, nextRetryMs: null };
  private stopped = false;
  private startedAt = 0;
  /** Aborts a pending reconnect-backoff sleep so stop() never leaves a timer holding the loop (task-1311). */
  private retryAbort: AbortController | null = null;

  constructor(opts: SolanaWsOptions) {
    this.opts = opts;
    this.url = opts.url;
    this.source = opts.source ?? 'solana-ws';
    this.clock = opts.clock ?? systemClock;
    this.health = opts.health;
    this.commitment = opts.commitment ?? 'processed';
    const g = globalThis as unknown as { WebSocket?: new (url: string) => WsLike };
    this.make = opts.ws ?? ((url) => {
      if (!g.WebSocket) throw new Error('WebSocket is not available in this runtime (Node 22+ required)');
      return new g.WebSocket(url);
    });
  }

  getStatus(): SolanaWsStatus {
    return { ...this.status, desired: this.desired.size, active: this.bySubId.size };
  }

  /** Number of accounts with a live server subscription right now. */
  get activeCount(): number {
    return this.bySubId.size;
  }

  /** True when this specific account has an acked server subscription on the current socket. */
  isActive(account: string): boolean {
    if (this.status.state !== 'open') return false;
    for (const acct of this.bySubId.values()) if (acct === account) return true;
    return false;
  }

  /** Accounts the caller wants subscribed (the cap the fast lane enforces applies to this set). */
  get desiredCount(): number {
    return this.desired.size;
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
    this.bySubId.clear();
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000, 'trenchscope stop'); } catch { /* already closed */ }
  }

  /** Add an account to the desired set and subscribe it now if the socket is open. Idempotent. */
  subscribe(account: string): void {
    if (this.desired.has(account)) return;
    this.desired.add(account);
    this.set({});
    if (this.ws && this.status.state === 'open') this.sendSubscribe(this.ws, account);
  }

  /** Remove an account; unsubscribe it on the server if it has a live id. Idempotent. */
  unsubscribe(account: string): void {
    if (!this.desired.delete(account)) return;
    for (const [subId, acct] of this.bySubId) {
      if (acct !== account) continue;
      this.bySubId.delete(subId);
      if (this.ws && this.status.state === 'open') {
        try { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextReqId++, method: 'accountUnsubscribe', params: [subId] })); } catch { /* socket will drop */ }
      }
    }
    for (const [id, acct] of this.pending) if (acct === account) this.pending.delete(id);
    this.set({});
  }

  /** Replace the desired set wholesale (add new, drop missing). */
  setAccounts(accounts: Iterable<string>): void {
    const next = new Set(accounts);
    for (const a of [...this.desired]) if (!next.has(a)) this.unsubscribe(a);
    for (const a of next) this.subscribe(a);
  }

  private set(patch: Partial<SolanaWsStatus>): void {
    this.status = { ...this.status, ...patch, desired: this.desired.size, active: this.bySubId.size };
    this.opts.onStatus?.(this.getStatus());
  }

  private sendSubscribe(ws: WsLike, account: string): void {
    const id = this.nextReqId++;
    this.pending.set(id, account);
    const text = JSON.stringify({ jsonrpc: '2.0', id, method: 'accountSubscribe', params: [account, { encoding: 'base64', commitment: this.commitment }] });
    try { ws.send(text); } catch { this.pending.delete(id); }
    this.opts.record?.sent.push(text);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.set({ state: this.status.attempts === 0 ? 'connecting' : 'reconnecting', attempts: this.status.attempts + 1, nextRetryMs: null });
    this.bySubId.clear();
    this.pending.clear();
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
      // Resubscribe every desired account: a reconnect reset the server's subscription ids.
      for (const account of this.desired) this.sendSubscribe(ws, account);
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      const text = typeof ev.data === 'string' ? ev.data : ev.data instanceof ArrayBuffer ? Buffer.from(ev.data).toString('utf8') : String(ev.data ?? '');
      this.handle(text);
    });
    ws.addEventListener('error', (ev) => {
      if (this.ws !== ws) return;
      this.set({ lastError: redactSecrets((ev as { message?: string }).message ?? 'websocket error') });
    });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.bySubId.clear();
      this.pending.clear();
      if (this.stopped) return;
      const reason = `closed ${ev.code ?? '?'}${ev.reason ? ` ${ev.reason}` : ''}${opened ? '' : ' before open'}`;
      this.fail(reason);
      void this.retry();
    });
  }

  private fail(message: string): void {
    const msg = redactSecrets(message);
    this.health?.record(this.source, { ok: false, error: msg });
    this.set({ failures: this.status.failures + 1, lastError: msg });
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

  /** Parse one frame: subscribe ack, account notification, or ignorable. Shared by live and replay. */
  handle(text: string, receivedAt: number = this.clock.now()): AccountUpdate | null {
    const bytes = Buffer.byteLength(text, 'utf8');
    this.opts.record?.messages.push({ tMs: Math.max(0, receivedAt - this.startedAt), text });
    this.status.messages += 1;
    this.status.bytes += bytes;
    this.status.lastMessageAt = receivedAt;
    if (bytes > 0) this.opts.onBytes?.(bytes);
    let j: unknown;
    try { j = JSON.parse(text); } catch { this.set({}); return null; }
    if (!j || typeof j !== 'object') { this.set({}); return null; }
    const o = j as { id?: number; result?: unknown; method?: string; params?: { subscription?: number; result?: { context?: { slot?: number }; value?: { data?: [string, string] | string } } } };
    // subscribe ack: { id, result: <subId number> }
    if (typeof o.id === 'number' && typeof o.result === 'number' && this.pending.has(o.id)) {
      const account = this.pending.get(o.id)!;
      this.pending.delete(o.id);
      if (this.desired.has(account)) this.bySubId.set(o.result, account);
      this.set({});
      return null;
    }
    if (o.method === 'accountNotification' && o.params) {
      const account = typeof o.params.subscription === 'number' ? this.bySubId.get(o.params.subscription) : undefined;
      const data = o.params.result?.value?.data;
      const base64 = Array.isArray(data) ? data[0] : typeof data === 'string' ? data : null;
      if (account && base64) {
        const slot = typeof o.params.result?.context?.slot === 'number' ? o.params.result.context.slot : null;
        const update: AccountUpdate = { account, slot, base64, receivedAt, bytes };
        this.status.notifications += 1;
        this.health?.record(this.source, { ok: true, latencyMs: 0 });
        this.set({});
        this.opts.onAccount?.(update);
        return update;
      }
    }
    this.set({});
    return null;
  }

  /** Replay a recorded session through the same handler. `speed` 0 = instant, 1 = recorded gaps. */
  async replay(rec: StreamRecording, speed = 0): Promise<number> {
    this.startedAt = this.clock.now();
    // Seed the subscription map from the recorded subscribe frames so notifications resolve.
    for (const sent of rec.sent) {
      try {
        const m = JSON.parse(sent) as { id?: number; params?: unknown[] };
        if (typeof m.id === 'number' && Array.isArray(m.params) && typeof m.params[0] === 'string') {
          this.desired.add(m.params[0]);
          this.pending.set(m.id, m.params[0]);
        }
      } catch { /* ignore */ }
    }
    this.set({ state: 'open', connectedAt: this.startedAt, attempts: 1 });
    let last = 0;
    for (const m of rec.messages) {
      if (this.stopped) break;
      if (speed > 0 && m.tMs > last) await this.clock.sleep((m.tMs - last) / speed);
      last = m.tMs;
      this.handle(m.text, this.clock.now());
    }
    return rec.messages.length;
  }
}
