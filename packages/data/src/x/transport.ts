// @dexterm/data — the one HTTP transport for X (task-1357). Separate from http.ts's keyless client because
// X needs an `Authorization: Bearer …` header (user-context reads) and form-encoded POSTs (token/revoke).
// Built on node:http(s) directly so it works even where tests replace `globalThis.fetch` (helpers.ts blocks
// the network for keyless code; the X tests talk to a loopback mock server through this transport).
//
// Rules: GET/POST only; the bearer is set per request and never stored here; every error message is passed
// through redactXSecrets(); the URL is never logged with a query (search queries are the user's business).

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { redactXSecrets } from './config.ts';

export interface XHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  /** Already-encoded body (form or JSON); the caller sets content-type. */
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface XHttpResponse {
  status: number;
  /** Lower-cased header names; only the ones X documents as useful are kept. */
  headers: Record<string, string>;
  body: string;
  latencyMs: number;
}

export type XTransport = (req: XHttpRequest) => Promise<XHttpResponse>;

/** Headers worth keeping: content type, rate-limit windows (X uses `x-rate-limit-*`), retry-after. */
const KEEP = ['content-type', 'retry-after', 'x-rate-limit-limit', 'x-rate-limit-remaining', 'x-rate-limit-reset', 'x-user-limit-24hour-limit', 'x-user-limit-24hour-remaining', 'x-user-limit-24hour-reset', 'x-app-limit-24hour-limit', 'x-app-limit-24hour-remaining', 'x-app-limit-24hour-reset'];

export const X_USER_AGENT = 'dexterm/0.0.1 (+local terminal screener; user-authorized X reads only)';

export function nodeXTransport(defaults: { timeoutMs?: number; userAgent?: string } = {}): XTransport {
  const userAgent = defaults.userAgent ?? X_USER_AGENT;
  return (req) => new Promise<XHttpResponse>((resolve, reject) => {
    const t0 = performance.now();
    let url: URL;
    try { url = new URL(req.url); } catch { reject(new Error('x transport: bad URL')); return; }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
      reject(new Error(`x transport: refusing ${url.protocol}//${url.hostname} (https only, http on loopback only)`));
      return;
    }
    const headers: Record<string, string> = { 'user-agent': userAgent, accept: 'application/json', ...(req.headers ?? {}) };
    if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
    const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const timeoutMs = req.timeoutMs ?? defaults.timeoutMs ?? 15_000;
    const r = fn(url, { method: req.method, headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const kept: Record<string, string> = {};
        for (const h of KEEP) { const v = res.headers[h]; if (typeof v === 'string') kept[h] = v; else if (Array.isArray(v)) kept[h] = v[0]; }
        resolve({ status: res.statusCode ?? 0, headers: kept, body: Buffer.concat(chunks).toString('utf8'), latencyMs: Math.round(performance.now() - t0) });
      });
      res.on('error', (e) => reject(new Error(redactXSecrets(`x transport: ${e.message}`))));
    });
    const fail = (msg: string) => { try { r.destroy(); } catch { /* ignore */ } reject(new Error(redactXSecrets(msg))); };
    r.on('timeout', () => fail(`x transport: timed out after ${timeoutMs} ms`));
    r.on('error', (e) => fail(`x transport: ${e.message}`));
    if (req.signal) {
      if (req.signal.aborted) { fail('x transport: aborted'); return; }
      req.signal.addEventListener('abort', () => fail('x transport: aborted'), { once: true });
    }
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
