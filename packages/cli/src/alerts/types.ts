// trenchscope — alert delivery types (task-1398). One normalised, already-firewalled alert; interchangeable
// channel adapters; pure routing. The delivery layer only READS these values and hands them to a channel;
// it imports nothing from trade/paper/executor/signer/wallet/mandate and has no arm/sign/confirm path.
import type { AlertLevel } from '@dexterm/custom';

export const CHANNELS = ['toast', 'desktop', 'telegram', 'discord', 'ntfy'] as const;
export type ChannelName = (typeof CHANNELS)[number];

export type DeliveryKind = 'alert' | 'proposal';

/**
 * A normalised alert ready for any channel. `title`/`body`/`symbol` are ALREADY run through the prompt
 * firewall (`@dexterm/data` firewallText); `spoken` is additionally say-sanitised (`@dexterm/voice`
 * sanitizeSpeech) so a channel that speaks is safe too. `mint` is a validated base58 address.
 */
export interface AlertDelivery {
  kind: DeliveryKind;
  level: AlertLevel;
  title: string;
  body: string;
  spoken: string;
  symbol: string;
  mint: string;
  /** Rule source: user | pack:* | jarvis | plugin:* */
  source: string;
  /** Rule id that fired. */
  rule: string;
  at: number;
}

/** The outcome of one adapter's delivery attempt. Never a thrown error; a failure is `{ ok:false, reason }`. */
export interface AdapterResult { ok: boolean; reason?: string; skipped?: boolean }
export interface DeliveryResult extends AdapterResult { channel: ChannelName }

export interface DeliveryAdapter {
  readonly name: ChannelName;
  /** True when this channel is usable here (platform present / credentials configured). Cheap, synchronous. */
  available(): boolean;
  /** Deliver one alert. MUST NOT throw and MUST NOT log or return a credential. */
  deliver(d: AlertDelivery): Promise<AdapterResult>;
}
