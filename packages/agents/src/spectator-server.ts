// @dexterm/agents — the read-only spectator STREAM (task-1406). A loopback-only WebSocket a streamer (or
// a capture tool) can watch the agent's session through. It is OUTBOUND ONLY: the server is constructed
// with a SpectatorHub and nothing else — no bus, no registry, no executor, no controls — so there is no
// code path from the socket to anything mutable. The ONLY inbound messages it honors are `hello` (auth
// with the per-session token) and `ping`; every other inbound frame is counted as `dropped` and ignored.
// Every event leaving the server is REDACTED (wallet addresses, keys, sensitive fields). This is how the
// stream "cannot send commands back" — structurally, not by a filter that could be bypassed.

import { writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createWsServer, type WsConn, type WsServer } from './ws.ts';
import { dextermHome } from './identity.ts';
import { SPECTATOR_PROTOCOL, redactSpectatorEvent, type SpectatorHub, type SpectatorEvent } from './spectator.ts';

/** A connection that does not authenticate within this window is closed. */
export const SPECTATOR_HELLO_TIMEOUT_MS = 10_000;
/** Overall cap on simultaneous spectator sockets. */
export const SPECTATOR_MAX_CONNS = 32;

export interface SpectatorServerOptions {
  hub: SpectatorHub;
  /** Per-session token; one is generated when omitted. Compared with timingSafeEqual. */
  token?: string;
  now?: () => number;
  /** How many recent events to replay to a viewer on connect. Default 200. */
  backlog?: number;
  /** Discovery file (port + token, mode 0600) so a local viewer finds the stream. Default <home>/spectator.json; null disables. */
  discoveryPath?: string | null;
  env?: NodeJS.ProcessEnv;
}

interface Conn { ws: WsConn; authed: boolean; off: (() => void) | null; helloTimer: ReturnType<typeof setTimeout> | null }

export class SpectatorServer {
  private server: WsServer | null = null;
  private readonly conns = new Set<Conn>();
  private readonly hub: SpectatorHub;
  private readonly now: () => number;
  private readonly backlog: number;
  private readonly discoveryPath: string | null;
  readonly token: string;
  private droppedCount = 0;

  constructor(opts: SpectatorServerOptions) {
    this.hub = opts.hub;
    this.now = opts.now ?? (() => Date.now());
    this.backlog = Math.max(0, opts.backlog ?? 200);
    this.token = opts.token ?? randomBytes(32).toString('base64url');
    this.discoveryPath = opts.discoveryPath === undefined ? join(dextermHome(opts.env), 'spectator.json') : opts.discoveryPath;
  }

  get port(): number { return this.server?.port ?? 0; }
  get connectionCount(): number { return this.conns.size; }
  /** Inbound frames that were ignored because the stream is outbound-only (anything but hello/ping). */
  get dropped(): number { return this.droppedCount; }

  async start(): Promise<number> {
    this.server = await createWsServer({ port: undefined, onConnection: (ws) => this.onConnection(ws) });
    this.writeDiscovery();
    return this.server.port;
  }

  async close(): Promise<void> {
    for (const c of [...this.conns]) { c.off?.(); if (c.helloTimer) clearTimeout(c.helloTimer); try { c.ws.close(1001); } catch { /* ignore */ } }
    this.conns.clear();
    if (this.discoveryPath) { try { rmSync(this.discoveryPath); } catch { /* ignore */ } }
    if (this.server) { await this.server.close(); this.server = null; }
  }

  private onConnection(ws: WsConn): void {
    if (this.conns.size >= SPECTATOR_MAX_CONNS) { ws.close(1013); return; }
    const conn: Conn = { ws, authed: false, off: null, helloTimer: null };
    this.conns.add(conn);
    conn.helloTimer = setTimeout(() => { if (!conn.authed) { try { ws.close(4001); } catch { /* ignore */ } } }, SPECTATOR_HELLO_TIMEOUT_MS);
    (conn.helloTimer as { unref?: () => void }).unref?.();
    ws.onMessage = (text) => this.onMessage(conn, text);
    ws.onClose = () => this.onClose(conn);
  }

  private onClose(conn: Conn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.off?.();
    this.conns.delete(conn);
  }

  private onMessage(conn: Conn, text: string): void {
    if (text.length > 64 * 1024) { conn.ws.close(1009); return; }
    let msg: { method?: unknown; token?: unknown };
    try { msg = JSON.parse(text) as { method?: unknown }; } catch { this.droppedCount++; return; }
    const method = msg && typeof msg === 'object' ? msg.method : undefined;
    if (method === 'hello') { this.onHello(conn, msg.token); return; }
    if (method === 'ping') { conn.ws.send({ type: 'pong', t: this.now() }); return; }
    // Outbound-only: anything else is ignored. There is NO branch that reaches a control.
    this.droppedCount++;
  }

  private onHello(conn: Conn, token: unknown): void {
    if (conn.authed) return;
    if (typeof token !== 'string' || !this.tokenOk(token)) { try { conn.ws.close(4002); } catch { /* ignore */ } return; }
    conn.authed = true;
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    conn.ws.send({ type: 'welcome', protocol: SPECTATOR_PROTOCOL, redacted: true, t: this.now() });
    for (const ev of this.hub.recent(this.backlog)) conn.ws.send(this.frame(ev, true));
    conn.off = this.hub.on((ev) => conn.ws.send(this.frame(ev, false)));
  }

  private frame(ev: SpectatorEvent, snapshot: boolean): Record<string, unknown> {
    return { type: 'event', snapshot, event: redactSpectatorEvent(ev) };
  }

  private tokenOk(given: string): boolean {
    const a = Buffer.from(given), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private writeDiscovery(): void {
    if (!this.discoveryPath) return;
    try {
      mkdirSync(dirname(this.discoveryPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.discoveryPath, JSON.stringify({ protocol: SPECTATOR_PROTOCOL, port: this.port, token: this.token, pid: process.pid, startedAt: this.now() }, null, 2) + '\n', { mode: 0o600 });
      try { chmodSync(this.discoveryPath, 0o600); } catch { /* ignore */ }
    } catch { /* discovery is best-effort */ }
  }
}
