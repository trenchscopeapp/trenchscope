// @dexterm/agents — a tiny loopback WebSocket server (task-1345, tier 2). RFC 6455 text frames only,
// bound to 127.0.0.1 on a random port, remote address must be loopback. Adapted from the proven popup
// host (packages/popup/src/server.ts). The agent bus (bus.ts) layers JSON-RPC and per-agent auth on top.
//
// Why WebSocket and not a raw TCP line protocol or a unix socket (task-1295 evaluation):
//   - loopback TCP + a per-session token is reachable from any SDK/runtime (Node's built-in WebSocket
//     client, Python `websockets`, a browser) with no extra dependency, and it reuses this repo's
//     existing, tested framing;
//   - a unix socket is marginally more private but not portable to a browser agent and awkward on
//     Windows; the loopback bind + loopback-only remote check + per-agent token gives the same "nothing
//     reachable from another machine or user" guarantee that matters here;
//   - message size is capped and clients MUST mask (RFC 6455), so a malformed or oversized frame closes
//     the socket rather than allocating unboundedly.

import http from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Max inbound frame payload (a JSON-RPC call is tiny; this is a flood guard). */
export const MAX_WS_MSG = 256 * 1024;

export function wsEncode(str: string | Buffer, opcode = 1): Buffer {
  const payload = typeof str === 'string' ? Buffer.from(str) : str;
  let head: Buffer;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, payload]);
}

export class WsConn {
  private socket: Duplex;
  private buf: Buffer = Buffer.alloc(0);
  closed = false;
  /** Loopback remote address for the audit log. */
  readonly remote: string;
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};
  constructor(socket: Duplex, remote: string) {
    this.socket = socket; this.remote = remote;
    socket.on('data', (d: Buffer) => this.feed(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
  }
  private feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_WS_MSG) { this.close(1009); return; } // clients MUST mask; cap size
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (opcode === 8) { this.close(1000); return; }
      if (opcode === 9) { this.socket.write(wsEncode(data, 10)); continue; }
      if (opcode === 1) { try { this.onMessage(data.toString('utf8')); } catch { /* handler is responsible for its own errors */ } }
    }
  }
  send(obj: unknown): void { if (!this.closed) { try { this.socket.write(wsEncode(JSON.stringify(obj))); } catch { this.end(); } } }
  close(code = 1000): void {
    if (this.closed) return;
    try { const b = Buffer.alloc(2); b.writeUInt16BE(code); this.socket.write(wsEncode(b, 8)); } catch { /* socket gone */ }
    this.end();
  }
  end(): void { if (this.closed) return; this.closed = true; try { this.socket.destroy(); } catch { /* ignore */ } this.onClose(); }
}

export interface WsServer {
  readonly port: number;
  close(): Promise<void>;
  readonly connections: number;
}

export interface WsServerOptions {
  /** Called once per accepted loopback WebSocket; wire conn.onMessage / conn.onClose inside. */
  onConnection: (conn: WsConn) => void;
  /** Optional fixed port (0 = random). Always 127.0.0.1. */
  port?: number;
}

/** Start a loopback-only WebSocket server. Resolves once it is listening. */
export function createWsServer(opts: WsServerOptions): Promise<WsServer> {
  let count = 0;
  const server = http.createServer((_req, res) => { res.writeHead(426, { 'content-length': '0' }); res.end(); });
  server.on('upgrade', (req, socket) => {
    const remote = req.socket.remoteAddress ?? '';
    const fail = (): void => { try { socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); } catch { /* ignore */ } socket.destroy(); };
    if (!LOOPBACK.has(remote)) return fail();
    if (String(req.headers['sec-websocket-version']) !== '13' || !req.headers['sec-websocket-key']) return fail();
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    count++;
    const conn = new WsConn(socket, remote);
    conn.onClose = () => { count--; };
    opts.onConnection(conn);
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        get connections() { return count; },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
