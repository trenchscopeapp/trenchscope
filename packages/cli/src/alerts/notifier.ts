// trenchscope — the Notifier (task-1398). Holds the channel adapters and the pure routing, and delivers one
// AlertDelivery to every routed+available channel. It never throws and never logs a credential (a thrown
// adapter error is caught and scrubbed with redactCreds). Build it from config + creds on disk with
// `buildNotifier`, or inject your own adapters (the tests pass fakes) with `createNotifier`.
import type { AlertsConfig } from '@dexterm/custom';
import { CHANNELS, type ChannelName, type AlertDelivery, type DeliveryAdapter, type DeliveryResult } from './types.ts';
import { routeChannels } from './route.ts';
import { redactCreds, readTelegramCreds, readDiscordCreds, readNtfyCreds } from './creds.ts';
import { createNtfyAdapter } from './adapters/ntfy.ts';
import { createToastAdapter } from './adapters/toast.ts';
import { createDesktopAdapter, type DesktopDeps } from './adapters/desktop.ts';
import { createTelegramAdapter, type FetchLike } from './adapters/telegram.ts';
import { createDiscordAdapter } from './adapters/discord.ts';

export interface Notifier {
  /** Deliver to every routed + available channel. Resolves with one result per attempted channel. */
  deliver(d: AlertDelivery): Promise<DeliveryResult[]>;
  /** The channels that are both enabled (by config) and available (platform / creds) right now. */
  readyChannels(level?: AlertDelivery['level']): ChannelName[];
}

export function createNotifier(cfg: AlertsConfig | undefined, adapters: Partial<Record<ChannelName, DeliveryAdapter>>): Notifier {
  return {
    async deliver(d) {
      const results: DeliveryResult[] = [];
      for (const name of routeChannels(cfg, d)) {
        const ad = adapters[name];
        if (!ad) { results.push({ channel: name, ok: false, skipped: true, reason: 'no adapter' }); continue; }
        if (!ad.available()) { results.push({ channel: name, ok: false, skipped: true, reason: `${name} not configured` }); continue; }
        try { results.push({ channel: name, ...(await ad.deliver(d)) }); }
        catch (e) { results.push({ channel: name, ok: false, reason: redactCreds((e as Error).message) }); }
      }
      return results;
    },
    readyChannels(level) {
      const probe: Pick<AlertDelivery, 'kind' | 'level'> = { kind: 'alert', level: level ?? 'info' };
      return routeChannels(cfg, probe).filter((n) => adapters[n]?.available());
    },
  };
}

export interface BuildNotifierDeps {
  /** The in-app / stdout sink for the `toast` channel. */
  toastSink: (line: string, d: AlertDelivery) => void;
  /** Injected for tests; production uses the platform default. */
  desktop?: DesktopDeps;
  fetch?: FetchLike;
}

/** Build a Notifier with the real adapters: toast + desktop + telegram/discord read from ~/.dexterm. */
export function buildNotifier(home: string, cfg: AlertsConfig | undefined, deps: BuildNotifierDeps): Notifier {
  const adapters: Partial<Record<ChannelName, DeliveryAdapter>> = {
    toast: createToastAdapter(deps.toastSink),
    desktop: createDesktopAdapter(deps.desktop),
    telegram: createTelegramAdapter({ creds: readTelegramCreds(home), fetch: deps.fetch }),
    discord: createDiscordAdapter({ creds: readDiscordCreds(home), fetch: deps.fetch }),
    ntfy: createNtfyAdapter({ creds: readNtfyCreds(home), fetch: deps.fetch }),
  };
  return createNotifier(cfg, adapters);
}

/** True when config enables at least one PUSH channel (desktop/telegram/discord) — i.e. a Notifier is worth building. */
export function hasPushChannel(cfg: AlertsConfig | undefined): boolean {
  const ch = cfg?.channels;
  if (!ch) return false;
  return CHANNELS.filter((c) => c !== 'toast').some((c) => ch[c]?.enabled === true);
}
