// trenchscope AI SCAN MODE (task-1324) — the `/scan …` command grammar and the `--scan-*` flag table. Pure.
import type { ScanConfig } from './engine.ts';

export type ScanCommand = 'on' | 'off' | 'toggle' | 'resume' | 'status';

/**
 * Parse a typed command: `/scan` (toggle) · `/scan on|start` · `/scan off|stop` · `/scan resume|next`
 * · `/scan status`. The leading slash is optional (the screener's `/` line already ate it). Anything
 * else — including a real screener filter — returns null and is handled as before.
 */
export function parseScanCommand(text: string): ScanCommand | { error: string } | null {
  const m = /^\s*\/?scan(?:\s+(\S+))?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const arg = (m[1] ?? '').toLowerCase();
  if (arg === '') return 'toggle';
  if (arg === 'on' || arg === 'start') return 'on';
  if (arg === 'off' || arg === 'stop') return 'off';
  if (arg === 'resume' || arg === 'next') return 'resume';
  if (arg === 'status') return 'status';
  return { error: `unknown /scan command "${arg.slice(0, 16)}" (on · off · stop · resume · status)` };
}

/** `--scan-*` flags → ScanConfig keys (values are numbers). */
export const SCAN_FLAGS: Readonly<Record<string, keyof ScanConfig>> = {
  '--scan-min-score': 'minScore',
  '--scan-min-triggers': 'minTriggers',
  '--scan-min-liq': 'minLiqUsd',
  '--scan-vol-x': 'volX',
  '--scan-flow-share': 'flowShare',
  '--scan-breakout-pct': 'breakoutPct',
  '--scan-liq-jump-pct': 'liqJumpPct',
  '--scan-holders-jump-pct': 'holdersJumpPct',
  '--scan-warmup-s': 'warmupS',
  '--scan-max-ai-per-hour': 'maxAiPerHour',
  '--scan-max-ai-per-coin': 'maxAiPerCoin',
  '--scan-refresh-s': 'refreshS',
  '--scan-move-pct': 'movePct',
  '--scan-cooldown-s': 'coinCooldownS',
  '--scan-post-lock-s': 'postLockS',
};

/** Range check for a flag value (non-negative; shares are 0..1; caps are integers ≥ 0). */
export function checkScanFlag(key: keyof ScanConfig, n: number): string | null {
  if (!Number.isFinite(n) || n < 0) return 'expects a non-negative number';
  if (key === 'flowShare' && n > 1) return 'expects a share 0..1 (e.g. 0.62)';
  if ((key === 'maxAiPerHour' || key === 'maxAiPerCoin' || key === 'minTriggers') && !Number.isInteger(n)) return 'expects a whole number';
  return null;
}

export const SCAN_HELP = `  --scan                    start AI SCAN MODE on launch (also: Z key, or /scan on|off|resume in the / line or chat)
  --scan-min-score N        lock when a coin scores ≥ N (default 45) with ≥ --scan-min-triggers (default 2) triggers
  --scan-vol-x N            volume-spike trigger: 5m volume ≥ N× the coin's own pace (default 3)
  --scan-max-ai-per-hour N  analyst turns the scan may start per hour (default 8; per coin --scan-max-ai-per-coin 4)
  --scan-refresh-s N        min seconds between reads of the locked coin (default 90; only when data moved)
  more: --scan-min-liq --scan-flow-share --scan-breakout-pct --scan-liq-jump-pct --scan-holders-jump-pct
        --scan-warmup-s --scan-move-pct --scan-cooldown-s --scan-post-lock-s`;
