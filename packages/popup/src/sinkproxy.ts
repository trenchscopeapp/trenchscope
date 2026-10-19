// trenchscope popup host — the loopback SINK PROXY (task-1358 r4). The native shell's WebViews send EVERY connection they
// make through this proxy (wry `with_proxy_config`; on macOS that is WKWebsiteDataStore.proxyConfigurations, 14+), and
// it tunnels to exactly one place: the popup server's own origin, http://127.0.0.1:<targetPort>. Anything else — any
// other host, any other port — is answered 403 and dropped, and the attempt is reported.
//
// Why: the r3 verifier showed that WebKit opens a TCP connection for a RUNTIME `<link rel=preconnect>` to a page-chosen
// host:port. No CSP directive covers preconnect (nothing is fetched), Trusted Types do not see it, and the text audit
// cannot (the element is built at run time). A proxy is below all of that: the WebView never resolves a name or opens
// a socket itself; the connection reaches this process, which refuses it. The hostname is the only thing that ever
// leaves the page, and it goes no further than the log line below.
//
// What the proxy understands is exactly what a WebView needs to reach our server, and nothing more:
//   * `CONNECT 127.0.0.1:<targetPort>` → a raw tunnel (how CFNetwork carries ws:// and wss://, and any https — there
//     is none here);
//   * absolute-form requests `GET http://127.0.0.1:<targetPort>/path` → rewritten to origin-form and forwarded, one
//     request head at a time (our server takes GET without a body: a request with a body is refused); an `Upgrade`
//     request switches the connection to a raw tunnel after its head;
//   * everything else (another host or port, a body, an origin-form request, junk) → 403, closed, counted, reported.
// Zero dependencies beyond node:net.
import net from 'node:net';

export interface SinkProxyRefusal { method: string; target: string; remote: string }
export interface SinkProxyOptions {
  /** The popup server's port: the one place the proxy will connect to. */
  targetPort: number;
  onRefused?: (r: SinkProxyRefusal) => void;
}
export interface SinkProxy {
  readonly port: number;
  /** `127.0.0.1:<port>` — what the shell is told (DEXTERM_POPUP_PROXY). */
  readonly address: string;
  readonly refused: number;
  readonly forwarded: number;
  /** Connections accepted from the shell (forwarded + refused + still-parsing): "was the proxy contacted at all". */
  readonly accepted: number;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);
const MAX_HEAD = 8192;
const HEAD_TIMEOUT_MS = 5000;
const sanitize = (s: string, n = 80): string => s.replace(/[^\x21-\x7e]/g, '?').slice(0, n);

/** Start the sink proxy on a random loopback port. */
export async function createSinkProxy(opts: SinkProxyOptions): Promise<SinkProxy> {
  const target = opts.targetPort;
  const authority = `127.0.0.1:${target}`;
  const authorityRe = new RegExp(`^http://127\\.0\\.0\\.1:${target}(/|$)`, 'i');
  let refused = 0, forwarded = 0, accepted = 0;
  const sockets = new Set<net.Socket>();

  const refuse = (sock: net.Socket, method: string, targetStr: string): void => {
    refused++;
    try { opts.onRefused?.({ method: sanitize(method, 16), target: sanitize(targetStr), remote: `${sock.remoteAddress}:${sock.remotePort}` }); } catch { /* reporter failed; still refuse */ }
    try { sock.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); } catch { /* gone */ }
    sock.destroy();
  };

  const tunnel = (client: net.Socket, firstBytes: Buffer, reply: boolean): void => {
    const up = net.connect(target, '127.0.0.1');
    sockets.add(up);
    up.on('connect', () => {
      forwarded++;
      if (reply) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (firstBytes.length) up.write(firstBytes);
      client.pipe(up); up.pipe(client);
    });
    const drop = (): void => { client.destroy(); up.destroy(); sockets.delete(up); };
    up.on('error', drop); up.on('close', drop); client.on('close', () => { up.destroy(); sockets.delete(up); });
  };

  const server = net.createServer((client) => {
    accepted++;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    if (!LOOPBACK.has(client.remoteAddress ?? '')) { client.destroy(); return; }
    let buf = Buffer.alloc(0);
    let mode: 'head' | 'done' = 'head';
    let upstream: net.Socket | null = null; // absolute-form mode: one upstream per client connection
    const timer = setTimeout(() => { if (mode === 'head') client.destroy(); }, HEAD_TIMEOUT_MS);
    client.on('data', (d: Buffer) => {
      if (mode === 'done') return; // piped
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) { if (buf.length > MAX_HEAD) { clearTimeout(timer); refuse(client, '?', 'head too large'); } return; }
        const head = buf.subarray(0, end).toString('latin1');
        const rest = buf.subarray(end + 4);
        const lines = head.split('\r\n');
        const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
        if (!m) { clearTimeout(timer); refuse(client, '?', lines[0] ?? ''); return; }
        const [, method, targetStr] = m;
        const headers = new Map<string, string>();
        for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()); }
        if (method === 'CONNECT') {
          clearTimeout(timer);
          if (targetStr.toLowerCase() !== authority) { refuse(client, method, targetStr); return; }
          mode = 'done'; client.removeAllListeners('data'); tunnel(client, rest, true); return;
        }
        if (!authorityRe.test(targetStr)) { clearTimeout(timer); refuse(client, method, targetStr); return; }
        if ((headers.get('content-length') ?? '0') !== '0' || headers.has('transfer-encoding')) { clearTimeout(timer); refuse(client, method, `${targetStr} (body)`); return; }
        // rewrite to origin-form; drop the proxy-only header
        const path = targetStr.slice(targetStr.indexOf('/', 'http://'.length));
        const outLines = [`${method} ${path || '/'} HTTP/1.1`, ...lines.slice(1).filter((l) => !/^proxy-connection\s*:/i.test(l))];
        const outHead = Buffer.from(outLines.join('\r\n') + '\r\n\r\n', 'latin1');
        buf = Buffer.from(rest);
        if (!upstream) {
          upstream = net.connect(target, '127.0.0.1');
          sockets.add(upstream);
          const u = upstream;
          u.on('connect', () => { forwarded++; });
          u.pipe(client);
          const drop = (): void => { client.destroy(); u.destroy(); sockets.delete(u); };
          u.on('error', drop); u.on('close', drop); client.on('close', () => { u.destroy(); sockets.delete(u); });
        }
        upstream.write(outHead);
        if (/upgrade/i.test(headers.get('connection') ?? '') || headers.has('upgrade')) {
          // the WebSocket: from here on the bytes are frames, both ways — hand the connection over
          clearTimeout(timer); mode = 'done';
          if (buf.length) upstream.write(buf);
          client.removeAllListeners('data'); client.pipe(upstream);
          return;
        }
        // next request on the same connection (keep-alive)
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    address: `127.0.0.1:${port}`,
    get refused() { return refused; },
    get forwarded() { return forwarded; },
    get accepted() { return accepted; },
    close() { for (const s of sockets) s.destroy(); sockets.clear(); return new Promise<void>((r) => server.close(() => r())); },
  };
}
