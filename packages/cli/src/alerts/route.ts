// trenchscope — alert delivery routing (task-1398). Pure: which channels receive a delivery, per config.
//
// Defaults (config.alerts absent or a channel unspecified): toast ON, desktop/telegram/discord OFF.
// So the in-app behaviour is unchanged until the user enables a push channel. Proposal-kind deliveries go
// out only when `alerts.proposals` is true (never the ticket itself — just a one-line summary).
import type { AlertsConfig } from '@dexterm/custom';
import { CHANNELS, type ChannelName, type AlertDelivery } from './types.ts';

/** The channels a delivery is routed to, given config. Pure; order is CHANNELS order. */
export function routeChannels(cfg: AlertsConfig | undefined, d: Pick<AlertDelivery, 'kind' | 'level'>): ChannelName[] {
  if (d.kind === 'proposal' && !cfg?.proposals) return [];
  const channels = cfg?.channels ?? {};
  const out: ChannelName[] = [];
  for (const name of CHANNELS) {
    const c = channels[name];
    const enabled = name === 'toast' ? c?.enabled !== false : c?.enabled === true;
    if (!enabled) continue;
    const levels = c?.levels;
    if (levels && levels.length > 0 && !levels.includes(d.level)) continue;
    out.push(name);
  }
  return out;
}
