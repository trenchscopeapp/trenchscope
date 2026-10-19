// trenchscope paper bot: one entry/exit as a firewalled AlertDelivery for the existing notifier (so whatever
// channels the user enabled with `trenchscope alerts` get it). Pure. Every line says PAPER and carries no
// recommendation: these are simulated fills, priced from live quotes.
import { firewallText } from '@dexterm/data/core';
import { sanitizeSpeech } from '@dexterm/voice';
import type { AlertDelivery } from '../alerts/types.ts';
import type { ExitReason } from './strategy.ts';

export type BotEvent =
  | { kind: 'entry'; symbol: string; mint: string; sizeUsd: number; mcap: number | null; verdict: string | null; rugP: number | null; at: number }
  | { kind: 'exit'; symbol: string; mint: string; reason: ExitReason; pnlPct: number; pnlUsd: number; heldMin: number; at: number };

const fw = (s: string, max: number, mint?: string): string => firewallText(s, { keepMint: mint ?? null, keepUrls: false, max }).text;

function usd(n: number): string {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(2);
  return `${n < 0 ? '-' : ''}$${s}`;
}

function held(min: number): string {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export function botEventToDelivery(ev: BotEvent): AlertDelivery {
  const symbol = fw(ev.symbol, 24) || '?';
  if (ev.kind === 'entry') {
    const parts = [`PAPER buy ${usd(ev.sizeUsd)}`];
    if (ev.mcap !== null) parts.push(`mcap ${usd(ev.mcap)}`);
    if (ev.verdict) parts.push(ev.rugP !== null ? `${ev.verdict}, p(rug) ${ev.rugP.toFixed(2)}` : ev.verdict);
    parts.push('simulated, not financial advice');
    const body = fw(parts.join(' · '), 180, ev.mint);
    return {
      kind: 'alert', level: 'info', title: `paper bot: bought ${symbol}`.slice(0, 64), body,
      spoken: sanitizeSpeech(`paper bot bought ${symbol}`), symbol, mint: ev.mint, source: 'bot', rule: 'paper-bot', at: ev.at,
    };
  }
  const sign = ev.pnlPct >= 0 ? '+' : '';
  const body = fw(`PAPER sell (${ev.reason}) ${sign}${ev.pnlPct.toFixed(1)}% (${sign}${usd(ev.pnlUsd)}) after ${held(ev.heldMin)} · simulated, not financial advice`, 180, ev.mint);
  return {
    kind: 'alert', level: ev.pnlPct >= 0 ? 'up' : 'down', title: `paper bot: sold ${symbol} ${sign}${ev.pnlPct.toFixed(1)}%`.slice(0, 64), body,
    spoken: sanitizeSpeech(`paper bot sold ${symbol}, ${ev.reason}, ${sign}${ev.pnlPct.toFixed(0)} percent`), symbol, mint: ev.mint, source: 'bot', rule: 'paper-bot', at: ev.at,
  };
}
