// Shared test helpers. Importing this module blocks the network for the whole
// test file: any accidental live call fails loudly instead of leaving the box.

import { fileURLToPath } from 'node:url';
import { FakeClock } from '../src/clock.ts';
import { FixtureStore, replayTransport } from '../src/fixtures.ts';
import type { HttpRequest, HttpResponse, Transport } from '../src/http.ts';
import { createDataLayer } from '../src/index.ts';
import type { DataLayerOptions } from '../src/index.ts';

export class NetworkBlockedError extends Error {}

globalThis.fetch = (async (input: unknown) => {
  throw new NetworkBlockedError(`network access blocked in tests: ${String(input)}`);
}) as typeof fetch;
// Streams too (Shrine, PumpPortal, RPC sockets): tests pass a scripted fake WebSocket factory instead.
(globalThis as { WebSocket?: unknown }).WebSocket = class {
  constructor(url: string) {
    throw new NetworkBlockedError(`network access blocked in tests: ${url}`);
  }
};

export const SAMPLE_PATH = fileURLToPath(new URL('../fixtures/live-sample.json', import.meta.url));

export function loadSample(): FixtureStore {
  return FixtureStore.load(SAMPLE_PATH);
}

/** Fake clock starting at the moment the sample was recorded (so header resets line up). */
export function sampleClock(store: FixtureStore): FakeClock {
  return new FakeClock(Date.parse(store.recordedAt ?? '2026-10-06T00:58:56Z'));
}

/** Transport wrapper that counts and optionally rewrites responses. */
export function spy(inner: Transport, rewrite?: (req: HttpRequest) => HttpResponse | undefined): Transport & { calls: string[] } {
  const calls: string[] = [];
  const t = (async (req: HttpRequest) => {
    calls.push(req.url);
    const r = rewrite?.(req);
    return r ?? inner(req);
  }) as Transport & { calls: string[] };
  t.calls = calls;
  return t;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), latencyMs: 5 };
}

/** Advance the fake clock until `p` settles (limiter waits are real timers on the fake clock). */
export async function drive<T>(clock: FakeClock, p: Promise<T>, stepMs = 500, maxMs = 3_600_000): Promise<T> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let elapsed = 0; !settled; elapsed += stepMs) {
    if (elapsed > maxMs) throw new Error(`drive(): promise did not settle within ${maxMs} ms of fake time`);
    await clock.advance(stepMs);
  }
  return p;
}

export function sampleLayer(opts: Partial<DataLayerOptions> & { transport?: Transport } = {}) {
  const fixtures = loadSample();
  const clock = sampleClock(fixtures);
  const replay = replayTransport(fixtures);
  const dl = createDataLayer({ clock, transport: opts.transport ?? replay, ...opts });
  return { dl, clock, fixtures, replay };
}

/** Deterministic PRNG for property tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Max number of timestamps inside any half-open window [t, t + windowMs). */
export function maxInWindow(times: number[], windowMs: number): number {
  const ts = [...times].sort((a, b) => a - b);
  let best = 0;
  let j = 0;
  for (let i = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] >= windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}
