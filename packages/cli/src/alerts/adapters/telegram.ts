// trenchscope — the `telegram` adapter (task-1398). Posts to the user's OWN bot via the Bot API
// (https://api.telegram.org/bot<token>/sendMessage). The token and chat id are the user's, read from
// ~/.dexterm/telegram.json (0600); they are NEVER logged and NEVER returned in a result/reason. `fetch` is
// injectable so tests use a fake — no test ever makes a real call to Telegram.
import type { AlertDelivery, DeliveryAdapter, AdapterResult } from '../types.ts';
import type { TelegramCreds } from '../creds.ts';
import { deliveryLine } from '../format.ts';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TelegramDeps { creds: TelegramCreds | null; fetch?: FetchLike; timeoutMs?: number }

const nodeFetch: FetchLike = (url, init) => (globalThis.fetch as unknown as FetchLike)(url, init);

export function createTelegramAdapter(deps: TelegramDeps): DeliveryAdapter {
  const creds = deps.creds;
  const doFetch = deps.fetch ?? nodeFetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  return {
    name: 'telegram',
    available: () => !!creds?.token && !!creds?.chatId,
    deliver: async (d: AlertDelivery): Promise<AdapterResult> => {
      if (!creds) return { ok: false, skipped: true, reason: 'telegram not configured (trenchscope alerts set-telegram)' };
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await doFetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: creds.chatId, text: deliveryLine(d), disable_web_page_preview: true }),
          signal: ac.signal,
        });
        // Never echo the token/url: only the status code and Telegram's own error description.
        if (!res.ok) {
          let desc = '';
          try { const j = JSON.parse(await res.text()) as { description?: string }; desc = j.description ? `: ${j.description}` : ''; } catch { /* ignore body */ }
          return { ok: false, reason: `telegram ${res.status}${desc}`.slice(0, 160) };
        }
        return { ok: true };
      } catch (e) {
        const name = (e as Error).name;
        return { ok: false, reason: name === 'AbortError' ? 'telegram timed out' : 'telegram unreachable' };
      } finally { clearTimeout(t); }
    },
  };
}
