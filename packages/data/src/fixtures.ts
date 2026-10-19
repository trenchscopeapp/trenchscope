// Fixture recorder / replayer. The recorder wraps a live transport and captures
// responses into a JSON file; the replayer serves only from that file and fails
// loudly on a miss, so tests can never fall through to the network.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HttpRequest, HttpResponse, Transport } from './http.ts';
import { containsSecret, redactSecrets } from './rpc-config.ts';

export interface FixtureEntry {
  method: 'GET' | 'POST';
  url: string;
  /** JSON-RPC request body (POST only), part of the match key. */
  requestBody?: unknown;
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the body was JSON (keeps fixtures diffable), else the raw string. */
  body: unknown;
  bodyIsJson: boolean;
  latencyMs: number;
  recordedAt: string;
}

export interface FixtureFile {
  version: 1;
  recordedAt: string;
  note?: string;
  entries: FixtureEntry[];
  /** WebSocket sessions captured alongside the HTTP entries (task-1298: PumpPortal). */
  streams?: StreamRecording[];
}

/** One recorded WebSocket session: text frames with their offset from the session start. */
export interface StreamRecording {
  url: string;
  startedAt: string;
  /** Messages the client sent on open (subscriptions), for the record. */
  sent: string[];
  messages: { tMs: number; text: string }[];
}

/**
 * Match key: method + normalized URL, plus the canonical JSON body for POSTs. Secret query
 * values (`api-key=`) are redacted in the key, so a recording made with a Helius key replays
 * with any key or none, and the key itself never reaches a fixture file.
 */
export function requestKey(req: Pick<HttpRequest, 'method' | 'url' | 'body'>): string {
  const base = `${req.method} ${redactSecrets(new URL(req.url).toString())}`;
  return req.body === undefined ? base : `${base} ${canonicalBody(req.body)}`;
}

function canonicalBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}

function entryKey(e: FixtureEntry): string {
  return requestKey({ method: e.method, url: e.url, body: e.requestBody === undefined ? undefined : JSON.stringify(e.requestBody) });
}

export class FixtureStore {
  private readonly entries = new Map<string, FixtureEntry>();
  note?: string;
  recordedAt?: string;
  /** Recorded WebSocket sessions (see StreamRecording). */
  streams: StreamRecording[] = [];

  static load(path: string): FixtureStore {
    const file = JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;
    if (file.version !== 1) throw new Error(`unsupported fixture version in ${path}`);
    const store = new FixtureStore();
    store.note = file.note;
    store.recordedAt = file.recordedAt;
    store.streams = file.streams ?? [];
    for (const e of file.entries) store.add(e);
    return store;
  }

  static fromEntries(entries: FixtureEntry[]): FixtureStore {
    const store = new FixtureStore();
    for (const e of entries) store.add(e);
    return store;
  }

  add(entry: FixtureEntry): void {
    this.entries.set(entryKey(entry), entry);
  }

  find(req: Pick<HttpRequest, 'method' | 'url' | 'body'>): FixtureEntry | undefined {
    return this.entries.get(requestKey(req));
  }

  list(): FixtureEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  save(path: string, note?: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const raw: FixtureFile = {
      version: 1,
      recordedAt: new Date().toISOString(),
      note: note ?? this.note,
      entries: this.list(),
    };
    if (this.streams.length) raw.streams = this.streams;
    // Request URLs are redacted at capture time, but live response bodies echo third-party URLs with key-shaped
    // params (DexScreener image URLs carry `&key=<cache id>`); refusing those threw away whole live sessions at
    // quit (task-1443). Redact every string instead. Replay still matches: requestKey() redacts the same way.
    const file = scrubSecrets(raw);
    // Belt and braces: never write a file that still carries a key value (checked per string, so escaping is moot).
    if (anyString(file, containsSecret)) throw new Error('refusing to save a recording that contains an api-key value');
    writeFileSync(path, JSON.stringify(file, null, 1) + '\n');
  }
}

/** A deep copy of `v` with redactSecrets() applied to every string. */
function scrubSecrets<T>(v: T): T {
  if (typeof v === 'string') return redactSecrets(v) as T;
  if (Array.isArray(v)) return v.map(scrubSecrets) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubSecrets(x)])) as T;
  return v;
}

function anyString(v: unknown, pred: (s: string) => boolean): boolean {
  if (typeof v === 'string') return pred(v);
  if (Array.isArray(v)) return v.some((x) => anyString(x, pred));
  if (v && typeof v === 'object') return Object.values(v).some((x) => anyString(x, pred));
  return false;
}

export function toEntry(req: HttpRequest, res: HttpResponse, recordedAt = new Date().toISOString()): FixtureEntry {
  let body: unknown = res.body;
  let bodyIsJson = false;
  try {
    body = JSON.parse(res.body);
    bodyIsJson = true;
  } catch {
    // keep raw text
  }
  const entry: FixtureEntry = { method: req.method, url: redactSecrets(new URL(req.url).toString()), status: res.status, headers: res.headers, body, bodyIsJson, latencyMs: res.latencyMs, recordedAt };
  if (req.body !== undefined) {
    try {
      entry.requestBody = JSON.parse(req.body);
    } catch {
      entry.requestBody = req.body;
    }
  }
  return entry;
}

export interface RecorderOptions {
  /** Hard cap on live requests; the recorder refuses to exceed it. */
  maxRequests: number;
  onRequest?: (n: number, req: HttpRequest, res: HttpResponse) => void;
}

/** Live transport + capture. Throws once `maxRequests` would be exceeded. */
export function recordingTransport(live: Transport, store: FixtureStore, opts: RecorderOptions): Transport & { readonly count: () => number } {
  let n = 0;
  const t = (async (req: HttpRequest) => {
    if (n >= opts.maxRequests) throw new Error(`recorder request budget exhausted (${opts.maxRequests})`);
    const seq = ++n;
    const res = await live(req);
    store.add(toEntry(req, res));
    opts.onRequest?.(seq, req, res);
    return res;
  }) as Transport & { count: () => number };
  t.count = () => n;
  return t;
}

export class FixtureMissError extends Error {
  constructor(key: string) {
    super(`no recorded fixture for ${key} (tests never hit the network; re-record with scripts/record-fixtures.ts)`);
    this.name = 'FixtureMissError';
  }
}

/** Serve recorded responses only. Misses throw FixtureMissError. */
export function replayTransport(store: FixtureStore): Transport {
  return async (req) => {
    const e = store.find(req);
    if (!e) throw new FixtureMissError(requestKey(req));
    return {
      status: e.status,
      headers: { ...e.headers },
      body: e.bodyIsJson ? JSON.stringify(e.body) : String(e.body),
      latencyMs: e.latencyMs,
    };
  };
}
