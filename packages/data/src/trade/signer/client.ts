// trenchscope T2 — the signer CLIENT (task-1328): the UI's only handle on the signer process. It spawns the
// signer as a child with piped stdio, hands it the session secret as the first stdin line, and sends
// authenticated requests with per-call timeouts. Every failure is a REFUSAL (fail closed): a dead or
// silent signer never becomes a "maybe it signed". The client never respawns a signer that died — LIVE
// trading stays off for the rest of the run, and the user restarts dexterm.
//
// The client forwards exactly the argv the user started trenchscope with (caps flags, --mainnet, --rpc).
// It cannot change caps afterwards: there is no such message.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrame, encodeHello, isEvent, isResponse, newSecret, type SignerMessage, type PlanView, type ConfirmView, type StatusView, type VerdictView, type FastView, type FillParams, type QuoteView } from './protocol.ts';

/** What the UI's LIVE ticket (and, task-1363, the plan engine's live executor) needs from a signer (the real client, or a fake in tests). */
export interface SignerPort {
  readonly alive: boolean;
  status(): Promise<StatusView>;
  plan(params: { mint: string; symbol: string; side: 'buy' | 'sell'; decimals: number; amountRaw: string; slippageBps: number }): Promise<PlanView>;
  probe(): Promise<PlanView>;
  precheck(hash: string): Promise<VerdictView>;
  confirm(hash: string): Promise<ConfirmView>;
  drop(hash: string): Promise<void>;
  panic(reason: string): Promise<void>;
  /** task-1363: the fast wallet's public status (never a key). */
  fast(): Promise<FastView>;
  /** task-1363: build a DEVNET FILL for the fast wallet from an order-plan leg; confirm it with `confirm(hash)`. */
  fill(params: FillParams): Promise<PlanView>;
  /**
   * task-1368: the keyless Jupiter quote for an order through the SIGNER's limiter (preview + re-quote + build
   * paced as one). Optional so a fake signer without it falls back to the terminal's own quote adapter.
   */
  quote?(params: Parameters<SignerPort['plan']>[0]): Promise<QuoteView>;
  close(): void;
}

export class SignerUnavailableError extends Error {
  /** The signer's refusal/error reason when it sent one (`rate-limited`, `build-failed`, a CapRefusal, …). */
  readonly reason: string | null;
  /** task-1368: for `rate-limited`, how long to wait before asking the signer again. */
  readonly retryAfterMs: number | null;
  constructor(message: string, detail: { reason?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'SignerUnavailableError';
    this.reason = detail.reason ?? null;
    this.retryAfterMs = typeof detail.retryAfterMs === 'number' && Number.isFinite(detail.retryAfterMs) ? detail.retryAfterMs : null;
  }
}

export interface SignerClientOptions {
  /** argv for the signer host (caps flags etc.). */
  argv?: string[];
  /** The host entry; default the production main.ts next to this file. Tests point it at a fake host. */
  entry?: string;
  env?: NodeJS.ProcessEnv;
  /** Handshake deadline. */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

export const DEFAULT_TIMEOUTS = { status: 8_000, plan: 60_000, probe: 30_000, precheck: 8_000, confirm: 240_000, drop: 8_000, panic: 8_000, fast: 12_000, fill: 30_000, quote: 20_000 } as const;

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export function defaultSignerEntry(): string {
  return fileURLToPath(new URL('./main.ts', import.meta.url));
}

export class SignerClient implements SignerPort {
  private child: ChildProcess | null = null;
  private readonly secret = newSecret();
  private outSeq = 0;
  private inSeq = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private dead: string | null = null;
  private readonly opts: SignerClientOptions;
  readonly argv: string[];
  pid: number | null = null;

  constructor(opts: SignerClientOptions = {}) {
    this.opts = opts;
    this.argv = [...(opts.argv ?? [])];
  }

  /**
   * Available for LIVE work: not dead. A client that has not started yet IS alive — the signer is
   * spawned lazily on the first request. task-1337: the old `child !== null && …` made every real run
   * refuse `L` with "the signer process died" before the signer had ever been started (the ticket
   * checks `alive` before its first call); only the fake signer in the tests, alive from construction,
   * ever reached LIVE. `dead` is the fail-closed marker: set once on exit/error/timeout/close, never reset.
   */
  get alive(): boolean { return this.dead === null; }

  /** Spawn + handshake (idempotent). Rejects when the signer cannot start; never retries. */
  start(): Promise<void> {
    if (this.dead) return Promise.reject(new SignerUnavailableError(this.dead));
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const entry = this.opts.entry ?? defaultSignerEntry();
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [entry, ...this.argv], { stdio: ['pipe', 'pipe', 'pipe'], env: this.opts.env ?? process.env });
      } catch (e) {
        this.dead = `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
        reject(new SignerUnavailableError(this.dead));
        return;
      }
      this.child = child;
      this.pid = child.pid ?? null;
      let settled = false;
      const readyTimer = setTimeout(() => { if (!settled) { settled = true; this.kill('signer did not become ready'); reject(new SignerUnavailableError('signer did not become ready')); } }, this.opts.readyTimeoutMs ?? 15_000);
      (readyTimer as unknown as { unref?: () => void }).unref?.();
      child.on('error', (e) => { this.markDead(`signer error: ${e.message}`); if (!settled) { settled = true; clearTimeout(readyTimer); reject(new SignerUnavailableError(this.dead ?? 'signer error')); } });
      child.on('exit', (code, signal) => { this.markDead(`signer exited (${code ?? signal ?? '?'})`); if (!settled) { settled = true; clearTimeout(readyTimer); reject(new SignerUnavailableError(this.dead ?? 'signer exited')); } });
      if (child.stderr) createInterface({ input: child.stderr }).on('line', (l) => this.opts.log?.(l));
      if (child.stdout) {
        createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
          const d = decodeFrame(this.secret, line, this.inSeq);
          if (!d.ok) { this.opts.log?.(`signer client: dropped frame (${d.why})`); return; }
          this.inSeq = d.seq + 1;
          this.onMessage(d.message, () => { if (!settled) { settled = true; clearTimeout(readyTimer); resolve(); } });
        });
      }
      child.stdin?.on('error', () => { /* a closed pipe surfaces as exit */ });
      child.stdin?.write(encodeHello(this.secret));
    });
    return this.ready;
  }

  private onMessage(m: SignerMessage, onReady: () => void): void {
    if (isEvent(m)) { if (m.event === 'ready') onReady(); return; }
    if (!isResponse(m)) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new SignerUnavailableError(m.error, { reason: m.reason, retryAfterMs: m.retryAfterMs }));
  }

  private markDead(why: string): void {
    if (this.dead) return;
    this.dead = why;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new SignerUnavailableError(why)); }
  }

  private kill(why: string): void {
    this.markDead(why);
    try { this.child?.kill('SIGTERM'); } catch { /* ignore */ }
  }

  private async request<T>(method: keyof typeof DEFAULT_TIMEOUTS, params: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUTS[method] ?? 8_000): Promise<T> {
    if (this.dead) throw new SignerUnavailableError(this.dead);
    await this.start();
    if (this.dead || !this.child?.stdin) throw new SignerUnavailableError(this.dead ?? 'signer has no stdin');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new SignerUnavailableError(`signer ${method} timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { this.child!.stdin!.write(encodeFrame(this.secret, this.outSeq++, { id, method, params })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(new SignerUnavailableError(`write failed: ${e instanceof Error ? e.message : String(e)}`)); }
    });
  }

  status(): Promise<StatusView> { return this.request<StatusView>('status', {}); }
  plan(params: Parameters<SignerPort['plan']>[0]): Promise<PlanView> { return this.request<PlanView>('plan', { ...params }); }
  probe(): Promise<PlanView> { return this.request<PlanView>('probe', {}); }
  precheck(hash: string): Promise<VerdictView> { return this.request<VerdictView>('precheck', { hash }); }
  confirm(hash: string): Promise<ConfirmView> { return this.request<ConfirmView>('confirm', { hash }); }
  async drop(hash: string): Promise<void> { await this.request('drop', { hash }); }
  async panic(reason: string): Promise<void> { await this.request('panic', { reason }); }
  fast(): Promise<FastView> { return this.request<FastView>('fast', {}); }
  fill(params: FillParams): Promise<PlanView> { return this.request<PlanView>('fill', { ...params }); }
  quote(params: Parameters<SignerPort['plan']>[0]): Promise<QuoteView> { return this.request<QuoteView>('quote', { ...params }); }

  close(): void {
    this.markDead('closed');
    try { this.child?.stdin?.end(); } catch { /* ignore */ }
    const c = this.child;
    if (c) {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000);
      (t as unknown as { unref?: () => void }).unref?.();
      c.on('exit', () => clearTimeout(t));
      try { c.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}
