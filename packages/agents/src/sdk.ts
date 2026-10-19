// @dexterm/agents/sdk — the small TypeScript SDK (task-1345, tier 2). A bring-your-own-agent connects to
// a running dexterm's loopback bus with its registered name + token, lists the tools its tier allows,
// calls read/navigation tools, subscribes to live topics, and creates proposals the user confirms. Uses
// Node's built-in global `WebSocket` client (Node ≥ 22) so the SDK ships with zero dependencies. It can
// never arm, sign, send or raise a cap — those tools do not exist and the server refuses the shape.
//
// Usage:
//   const agent = await connectAgent({ name: 'scanbot', token: process.env.DEXTERM_AGENT_TOKEN! });
//   const tools = await agent.listTools();
//   const rows = await agent.call('screener_query', { preset: 'new', limit: 8 });
//   const off = agent.on('new_pairs', (ev) => console.log(ev.data));
//   await agent.subscribe(['new_pairs']);
//   await agent.propose('propose_alert', { mint, when: 'mcap crosses 1M', idempotency_key: 'k-'+Date.now() });
//   agent.close();

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ConnectOptions {
  name: string;
  token: string;
  /** Explicit ws URL (ws://127.0.0.1:PORT). Omit to read the discovery file. */
  url?: string;
  /** Explicit port on 127.0.0.1. Omit to read the discovery file. */
  port?: number;
  /** Lower the tier you run at (you can never raise it above your grant). */
  tier?: 'observe' | 'annotate' | 'propose';
  /** A short display label for the roster, e.g. "my-python-bot 1.0". Firewalled server-side. */
  client?: string;
  /** Override $DEXTERM_HOME / ~/.dexterm for the discovery file. */
  home?: string;
  timeoutMs?: number;
}

export interface BusEvent { topic: string; seq: number; t: number; data: Record<string, unknown>; snapshot?: boolean }

export interface HelloResult { protocol: string; agent: string; tier: string; grantedTier: string; tools: string[]; paused: boolean }

/** Read the bus discovery file a running trenchscope writes (<home>/agent-bus.json). */
export function loadBusDiscovery(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): { port: number } | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm'));
  try {
    const d = JSON.parse(readFileSync(join(home, 'agent-bus.json'), 'utf8')) as { port?: number };
    return typeof d.port === 'number' && d.port > 0 ? { port: d.port } : null;
  } catch { return null; }
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export class DextermAgent {
  private ws: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(ev: BusEvent) => void>>();
  private seq = 0;
  private closed = false;
  hello: HelloResult | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e: MessageEvent) => this.onMessage(String(e.data)));
    ws.addEventListener('close', () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('connection closed')); this.pending.clear(); });
  }

  static async connect(opts: ConnectOptions): Promise<DextermAgent> {
    let port = opts.port;
    let url = opts.url;
    if (!url) {
      if (!port) { const d = loadBusDiscovery({ home: opts.home }); if (!d) throw new Error('no --port/--url and no agent-bus.json discovery file: is trenchscope running with the agent bus enabled?'); port = d.port; }
      url = `ws://127.0.0.1:${port}`;
    }
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timed out opening the bus socket')), opts.timeoutMs ?? 5000);
      ws.addEventListener('open', () => { clearTimeout(to); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('could not open the bus socket')); }, { once: true });
    });
    const agent = new DextermAgent(ws);
    const hello = await agent.request('hello', { name: opts.name, token: opts.token, tier: opts.tier, client: opts.client }, opts.timeoutMs);
    agent.hello = hello as unknown as HelloResult;
    return agent;
  }

  private onMessage(text: string): void {
    let msg: { id?: unknown; result?: Record<string, unknown>; error?: { message?: string; data?: Record<string, unknown> }; method?: string; params?: BusEvent };
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.method === 'event' && msg.params) { const ev = msg.params; for (const l of this.listeners.get(ev.topic) ?? []) { try { l(ev); } catch { /* ignore */ } } return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
      if (msg.error) { const err = new Error(msg.error.message ?? 'bus error') as Error & { data?: unknown }; err.data = msg.error.data; p.reject(err); }
      else p.resolve(msg.result ?? {});
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = ++this.seq;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const to = setTimeout(() => { this.pending.delete(id); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** List the tools this agent's tier may call. */
  async listTools(): Promise<Array<{ name: string; tier: string; description: string }>> {
    const r = await this.request('tools/list', {});
    return (r.tools as Array<{ name: string; tier: string; description: string }>) ?? [];
  }

  /** Call a read or navigation tool and return its result (or an object with an `error` field). */
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request('tools/call', { name, arguments: args });
  }

  /** Create a proposal the user must confirm. Alias of call() with a clearer name. */
  async propose(name: 'propose_alert' | 'propose_order_plan' | 'add_to_watchlist', args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call(name, args);
  }

  async whoami(): Promise<Record<string, unknown>> { return this.call('agent_whoami'); }

  /** Register a listener for a topic. Call subscribe() to actually start the server-side stream. */
  on(topic: string, listener: (ev: BusEvent) => void): () => void {
    let set = this.listeners.get(topic); if (!set) { set = new Set(); this.listeners.set(topic, set); }
    set.add(listener); return () => set!.delete(listener);
  }

  async subscribe(topics: string[]): Promise<string[]> { const r = await this.call('subscribe', { topics }); return (r.subscribed as string[]) ?? []; }
  async unsubscribe(topics?: string[]): Promise<string[]> { const r = await this.call('unsubscribe', topics ? { topics } : {}); return (r.subscribed as string[]) ?? []; }
  async ping(): Promise<boolean> { const r = await this.request('ping', {}); return r.pong === true; }

  close(): void { this.closed = true; try { this.ws.close(); } catch { /* ignore */ } }
}

export function connectAgent(opts: ConnectOptions): Promise<DextermAgent> { return DextermAgent.connect(opts); }
