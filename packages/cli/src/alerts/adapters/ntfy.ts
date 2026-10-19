// trenchscope: the `ntfy` adapter. Publishes to the user's OWN ntfy topic (https://ntfy.sh/<topic>, or a
// self-hosted https server), read from ~/.dexterm/ntfy.json (0600). On ntfy the topic name IS the secret
// (anyone who knows it can read and post), so the topic is NEVER logged and NEVER returned in a result/reason
// (only the HTTP status is). `fetch` is injectable; no test makes a real call to ntfy.
import type { AlertDelivery, DeliveryAdapter, AdapterResult } from '../types.ts';
import type { NtfyCreds } from '../creds.ts';
import type { FetchLike } from './telegram.ts';
import { deliveryLine } from '../format.ts';

export interface NtfyDeps { creds: NtfyCreds | null; fetch?: FetchLike; timeoutMs?: number }

const nodeFetch: FetchLike = (url, init) => (globalThis.fetch as unknown as FetchLike)(url, init);

/** ntfy priority per alert level: a dump or a warning buzzes, an up move or info does not. */
const PRIORITY: Record<AlertDelivery['level'], string> = { down: '4', warn: '4', up: '3', info: '2' };
const TAGS: Record<AlertDelivery['level'], string> = { down: 'small_red_triangle_down', warn: 'warning', up: 'chart_with_upwards_trend', info: 'information_source' };

/** HTTP header values must be single-line Latin-1; strip anything else (the text is already firewalled). */
const headerSafe = (s: string): string => s.replace(/[^\x20-\x7e]/g, '').slice(0, 120).trim();

export function createNtfyAdapter(deps: NtfyDeps): DeliveryAdapter {
  const creds = deps.creds;
  const doFetch = deps.fetch ?? nodeFetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  return {
    name: 'ntfy',
    available: () => !!creds?.topic,
    deliver: async (d: AlertDelivery): Promise<AdapterResult> => {
      if (!creds) return { ok: false, skipped: true, reason: 'ntfy not configured (trenchscope alerts set-ntfy)' };
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await doFetch(`${creds.server}/${creds.topic}`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain; charset=utf-8', title: headerSafe(d.title) || 'trenchscope', priority: PRIORITY[d.level], tags: TAGS[d.level] },
          body: deliveryLine(d).slice(0, 3800),
          signal: ac.signal,
        });
        if (!res.ok) return { ok: false, reason: `ntfy ${res.status}` };
        return { ok: true };
      } catch (e) {
        const name = (e as Error).name;
        return { ok: false, reason: name === 'AbortError' ? 'ntfy timed out' : 'ntfy unreachable' };
      } finally { clearTimeout(t); }
    },
  };
}
