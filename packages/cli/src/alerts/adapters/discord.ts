// trenchscope — the `discord` adapter (task-1398). Posts to the user's OWN webhook URL (read from
// ~/.dexterm/discord.json, 0600). The webhook URL is itself the credential, so it is NEVER logged and
// NEVER returned in a result/reason (only the HTTP status is). `fetch` is injectable; no test makes a real
// call to Discord.
import type { AlertDelivery, DeliveryAdapter, AdapterResult } from '../types.ts';
import type { DiscordCreds } from '../creds.ts';
import type { FetchLike } from './telegram.ts';
import { deliveryLine } from '../format.ts';

export interface DiscordDeps { creds: DiscordCreds | null; fetch?: FetchLike; timeoutMs?: number }

const nodeFetch: FetchLike = (url, init) => (globalThis.fetch as unknown as FetchLike)(url, init);

export function createDiscordAdapter(deps: DiscordDeps): DeliveryAdapter {
  const creds = deps.creds;
  const doFetch = deps.fetch ?? nodeFetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  return {
    name: 'discord',
    available: () => !!creds?.webhook,
    deliver: async (d: AlertDelivery): Promise<AdapterResult> => {
      if (!creds) return { ok: false, skipped: true, reason: 'discord not configured (trenchscope alerts set-discord)' };
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await doFetch(creds.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Content is already firewalled; cap to Discord's 2000-char limit for safety.
          body: JSON.stringify({ content: deliveryLine(d).slice(0, 1900) }),
          signal: ac.signal,
        });
        if (!res.ok) return { ok: false, reason: `discord ${res.status}` };
        return { ok: true };
      } catch (e) {
        const name = (e as Error).name;
        return { ok: false, reason: name === 'AbortError' ? 'discord timed out' : 'discord unreachable' };
      } finally { clearTimeout(t); }
    },
  };
}
