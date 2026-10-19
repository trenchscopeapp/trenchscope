// trenchscope T2 — the signer HOST loop (task-1328): runs inside the signer process, reads authenticated
// frames from `input` (the child's stdin), dispatches to the SignerService, and writes authenticated
// responses to `output` (the child's stdout). Diagnostics go to `log` (stderr) and never carry bytes,
// keys or the secret. Fails closed: a bad hello, too many bad frames, or a closed input ends the loop
// (and the production entry exits the process).

import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { SignerService } from './service.ts';
import { decodeFrame, encodeFrame, isRequest, parseHello, MAX_BAD_FRAMES, MAX_FRAME_BYTES, SIGNER_METHODS, type SignerMessage } from './protocol.ts';

export interface ServeOptions {
  service: SignerService;
  input: Readable;
  output: Writable;
  log?: (line: string) => void;
  /** Called when the loop ends (input closed, bad hello, too many bad frames). */
  onEnd?: (why: string) => void;
}

/** Serve until the input ends. Resolves with the reason the loop stopped. */
export function serveSigner(opts: ServeOptions): Promise<string> {
  const log = opts.log ?? (() => {});
  return new Promise<string>((resolve) => {
    let secret: Buffer | null = null;
    let inSeq = 0;
    let outSeq = 0;
    let bad = 0;
    let ended = false;
    const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
    const end = (why: string): void => {
      if (ended) return;
      ended = true;
      try { rl.close(); } catch { /* ignore */ }
      opts.onEnd?.(why);
      resolve(why);
    };
    const send = (m: SignerMessage): void => {
      if (!secret) return;
      try { opts.output.write(encodeFrame(secret, outSeq++, m)); } catch (e) { log(`signer: write failed: ${e instanceof Error ? e.message : String(e)}`); end('output closed'); }
    };
    const strike = (why: string): void => {
      bad++;
      log(`signer: dropped frame (${why}) ${bad}/${MAX_BAD_FRAMES}`);
      if (bad >= MAX_BAD_FRAMES) end('too many bad frames');
    };
    rl.on('line', (line: string) => {
      if (ended) return;
      if (line.length > MAX_FRAME_BYTES) { strike('too large'); return; }
      if (!secret) {
        const h = parseHello(line);
        if (!h) { end('bad hello'); return; }
        secret = h.secret;
        send({ event: 'ready', detail: { pid: process.pid } });
        return;
      }
      const d = decodeFrame(secret, line, inSeq);
      if (!d.ok) { strike(d.why); return; }
      inSeq = d.seq + 1;
      const m = d.message;
      if (!isRequest(m)) { strike('not a request'); return; }
      const id = m.id;
      if (!SIGNER_METHODS.has(m.method)) { send({ id, ok: false, error: `unknown method ${JSON.stringify(String(m.method).slice(0, 32))}` }); return; }
      void opts.service.call(m.method, m.params).then(
        (result) => send({ id, ok: true, result }),
        (e: unknown) => {
          if (!(e instanceof Error)) { send({ id, ok: false, error: String(e) }); return; }
          const reason = (e as { reason?: unknown }).reason;
          const retryAfterMs = (e as { retryAfterMs?: unknown }).retryAfterMs;
          send({
            id, ok: false,
            error: `${typeof reason === 'string' ? `${reason}: ` : ''}${e.message}`,
            ...(typeof reason === 'string' ? { reason } : {}),
            ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
          });
        },
      );
    });
    rl.on('close', () => end('input closed'));
    opts.input.on('error', () => end('input error'));
  });
}
