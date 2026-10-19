// trenchscope paper bot: the strategy config. `config.bot` in ~/.dexterm/config.json (validated by the
// @dexterm/custom schema like every other section) is merged over these conservative defaults. PAPER ONLY:
// nothing here can arm, sign or size a real order; the bot books simulated fills from live quotes.
import type { BotSettings } from '@dexterm/custom';

export type BotVerdictGate = 'NO RED FLAGS' | 'CAREFUL';

export interface BotEntryRules {
  /** Worst safety verdict allowed at entry: 'NO RED FLAGS' (default) or 'CAREFUL'. AVOID never enters. */
  verdict: BotVerdictGate;
  /** Max H2 p(rug) allowed at entry (the screener's risk score; a ranking, not a calibrated probability). */
  maxRugP: number;
  /** Market cap band, USD. */
  minMcapUsd: number;
  maxMcapUsd: number;
  /** Minimum pool liquidity, USD. */
  minLiqUsd: number;
  /** Minimum age since launch, minutes (unknown age never enters). */
  minAgeMin: number;
  /** 1 h price change band, percent (unknown change never enters). */
  minChg1hPct: number;
  maxChg1hPct: number;
  /** Top-10 holder share must be KNOWN and below this, percent. */
  maxTop10Pct: number;
}

export interface BotConfig {
  /** Fixed paper size per entry, USD (converted to SOL at the live SOL/USD price). */
  sizeUsd: number;
  /** Slippage tolerance sent with each Jupiter quote, bps. */
  slippageBps: number;
  /** Simulated priority fee added to every fill, lamports (on top of the 5 000 lamport base fee). */
  priorityFeeLamports: number;
  /** Skip an entry whose buy quote shows more price impact than this, percent. */
  maxEntryImpactPct: number;
  /** Take profit when the net exit quote is up this much on cost, percent. */
  takeProfitPct: number;
  /** Stop loss when the net exit quote is down this much on cost, percent. */
  stopLossPct: number;
  /** Close any position held this long, minutes. */
  timeStopMin: number;
  /** Max open paper positions per book. */
  maxOpen: number;
  /** Max new entries per rolling hour per book. */
  maxEntriesPerHour: number;
  /** No re-entry into a mint for this long after its last exit, minutes. */
  reentryCooldownMin: number;
  entry: BotEntryRules;
  /** Which bot events go through the alert notifier (strategy book only). */
  alerts: { entries: boolean; exits: boolean };
}

/** Conservative defaults: only clean, established, not-yet-pumped coins; small fixed size; tight caps. */
export const DEFAULT_BOT_CONFIG: BotConfig = {
  sizeUsd: 50,
  slippageBps: 300,
  priorityFeeLamports: 100_000,
  maxEntryImpactPct: 3,
  takeProfitPct: 40,
  stopLossPct: 20,
  timeStopMin: 360,
  maxOpen: 5,
  maxEntriesPerHour: 4,
  reentryCooldownMin: 360,
  entry: {
    verdict: 'NO RED FLAGS',
    maxRugP: 0.2,
    minMcapUsd: 50_000,
    maxMcapUsd: 5_000_000,
    minLiqUsd: 20_000,
    minAgeMin: 30,
    minChg1hPct: 0,
    maxChg1hPct: 60,
    maxTop10Pct: 30,
  },
  alerts: { entries: false, exits: true },
};

/** One line per knob (the `bot config` print and the docs use these). */
export const BOT_KNOBS: Array<[path: string, doc: string]> = [
  ['sizeUsd', 'fixed paper size per entry, USD'],
  ['slippageBps', 'slippage tolerance sent with every Jupiter quote, bps'],
  ['priorityFeeLamports', 'simulated priority fee per fill on top of the 5 000 lamport base fee'],
  ['maxEntryImpactPct', 'skip an entry whose buy quote shows more price impact than this, %'],
  ['takeProfitPct', 'exit when the net sell quote is up this much on cost, %'],
  ['stopLossPct', 'exit when the net sell quote is down this much on cost, %'],
  ['timeStopMin', 'exit any position held this long, minutes'],
  ['maxOpen', 'max open paper positions per book'],
  ['maxEntriesPerHour', 'max new entries per rolling hour per book'],
  ['reentryCooldownMin', 'no re-entry into a mint for this long after its exit, minutes'],
  ['entry.verdict', "worst safety verdict allowed at entry: 'NO RED FLAGS' or 'CAREFUL' (AVOID never enters)"],
  ['entry.maxRugP', 'max H2 p(rug) risk score at entry (0..1)'],
  ['entry.minMcapUsd', 'minimum market cap at entry, USD'],
  ['entry.maxMcapUsd', 'maximum market cap at entry, USD'],
  ['entry.minLiqUsd', 'minimum pool liquidity at entry, USD'],
  ['entry.minAgeMin', 'minimum age since launch at entry, minutes'],
  ['entry.minChg1hPct', 'lowest 1 h price change allowed at entry, %'],
  ['entry.maxChg1hPct', 'highest 1 h price change allowed at entry, % (skip coins that already ran)'],
  ['entry.maxTop10Pct', 'top-10 holder share must be known and below this, %'],
  ['alerts.entries', 'send an alert through your notifier channels on each paper entry'],
  ['alerts.exits', 'send an alert through your notifier channels on each paper exit'],
];

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** Merge `config.bot` (already schema-validated by loadConfig) over the defaults. Pure. */
export function resolveBotConfig(s: BotSettings | undefined | null): BotConfig {
  const d = DEFAULT_BOT_CONFIG;
  const e = s?.entry ?? {};
  return {
    sizeUsd: num(s?.sizeUsd, d.sizeUsd),
    slippageBps: Math.round(num(s?.slippageBps, d.slippageBps)),
    priorityFeeLamports: Math.round(num(s?.priorityFeeLamports, d.priorityFeeLamports)),
    maxEntryImpactPct: num(s?.maxEntryImpactPct, d.maxEntryImpactPct),
    takeProfitPct: num(s?.takeProfitPct, d.takeProfitPct),
    stopLossPct: num(s?.stopLossPct, d.stopLossPct),
    timeStopMin: num(s?.timeStopMin, d.timeStopMin),
    maxOpen: Math.round(num(s?.maxOpen, d.maxOpen)),
    maxEntriesPerHour: Math.round(num(s?.maxEntriesPerHour, d.maxEntriesPerHour)),
    reentryCooldownMin: num(s?.reentryCooldownMin, d.reentryCooldownMin),
    entry: {
      verdict: e.verdict === 'CAREFUL' || e.verdict === 'NO RED FLAGS' ? e.verdict : d.entry.verdict,
      maxRugP: num(e.maxRugP, d.entry.maxRugP),
      minMcapUsd: num(e.minMcapUsd, d.entry.minMcapUsd),
      maxMcapUsd: num(e.maxMcapUsd, d.entry.maxMcapUsd),
      minLiqUsd: num(e.minLiqUsd, d.entry.minLiqUsd),
      minAgeMin: num(e.minAgeMin, d.entry.minAgeMin),
      minChg1hPct: num(e.minChg1hPct, d.entry.minChg1hPct),
      maxChg1hPct: num(e.maxChg1hPct, d.entry.maxChg1hPct),
      maxTop10Pct: num(e.maxTop10Pct, d.entry.maxTop10Pct),
    },
    alerts: { entries: bool(s?.alerts?.entries, d.alerts.entries), exits: bool(s?.alerts?.exits, d.alerts.exits) },
  };
}

/** Cross-field checks the JSON schema cannot express. Empty = fine. */
export function botConfigProblems(c: BotConfig): string[] {
  const out: string[] = [];
  if (c.entry.minMcapUsd > c.entry.maxMcapUsd) out.push('bot.entry.minMcapUsd is above maxMcapUsd');
  if (c.entry.minChg1hPct > c.entry.maxChg1hPct) out.push('bot.entry.minChg1hPct is above maxChg1hPct');
  return out;
}
