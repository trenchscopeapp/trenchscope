// Popup host configuration (task-1290). decision: keep the spike's hotkey chord and rain cadence
// defaults, but make both configurable in a config file. The file is ~/.dexterm/popup.json (DEXTERM_HOME
// overrides the directory, same convention as state.json / helius.key). Everything is optional; a missing
// or malformed file degrades to the defaults and never throws — a popup must open even with a bad config.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PopupRainConfig } from './protocol.ts';

/** The spike's global-hotkey chord (⌃⌥⌘⇧B). Accelerator syntax: `Mod+Mod+Code`, matched by the shell. */
export const DEFAULT_HOTKEY = 'Control+Alt+Super+Shift+KeyB';

/** task-1325: the global chord that closes every popup window (⌃⌥⌘⇧W). */
export const DEFAULT_HOTKEY_CLOSE = 'Control+Alt+Super+Shift+KeyW';

/** task-1325: dock the chart window beside the terminal (right edge, matching height) and follow it. */
export interface DockConfig {
  enabled: boolean;
  /** Window width in points (the height matches the terminal). */
  width: number;
  /** Re-dock when the terminal moves/resizes (one lightweight osascript loop while a popup is open). */
  follow: boolean;
  /** Seconds between follow checks. */
  followEvery: number;
}
export const DEFAULT_DOCK: DockConfig = { enabled: true, width: 560, follow: true, followEvery: 0.5 };

/** The rain cadence approved in the spike. speedScale 1 = the bubble-map default fall speed. */
export const DEFAULT_RAIN: PopupRainConfig = { enabled: true, speedScale: 1, density: 0.55 };

export interface PopupConfig {
  /** Global hotkey accelerator passed to the shell (empty string disables registration). Toggles show/hide. */
  hotkey: string;
  /** task-1325: global chord that closes every popup (empty disables). */
  hotkeyClose: string;
  /** task-1325: docking beside the terminal. */
  dock: DockConfig;
  rain: PopupRainConfig;
  /** Frame cap for the popup rAF loop (page self-throttles to this). */
  fpsCap: number;
  /** Where the config was read from, for `doctor` / `--self-test` output. */
  source: 'defaults' | 'file';
}

export const DEFAULT_CONFIG: PopupConfig = { hotkey: DEFAULT_HOTKEY, hotkeyClose: DEFAULT_HOTKEY_CLOSE, dock: { ...DEFAULT_DOCK }, rain: { ...DEFAULT_RAIN }, fpsCap: 60, source: 'defaults' };

/** `DEXTERM_HOME` overrides `~/.dexterm` (tests point it at a temp dir). */
export function dexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dexHome(env), 'popup.json');
}

function num(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

/**
 * Validate a parsed config object into a PopupConfig, clamping every field and keeping the defaults for
 * anything missing or out of range. The hotkey must be a short printable accelerator; an unexpected value
 * is ignored so a bad file can never register a nonsense chord or an oversized string.
 */
export function normalizeConfig(raw: unknown, source: PopupConfig['source'] = 'file'): PopupConfig {
  const o = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
  const rrain = (o.rain && typeof o.rain === 'object' ? o.rain as Record<string, unknown> : {});
  // empty = disabled; otherwise a short accelerator of letters/digits/+ only (no shell metacharacters)
  const chord = (v: unknown, dflt: string): string => {
    if (typeof v !== 'string') return dflt;
    const h = v.trim();
    return h === '' ? '' : (/^[A-Za-z0-9+]{1,64}$/.test(h) ? h : dflt);
  };
  const hotkey = chord(o.hotkey, DEFAULT_HOTKEY);
  const rdock = (o.dock && typeof o.dock === 'object' ? o.dock as Record<string, unknown> : {});
  return {
    hotkey,
    hotkeyClose: chord(o.hotkeyClose, DEFAULT_HOTKEY_CLOSE),
    dock: {
      enabled: typeof rdock.enabled === 'boolean' ? rdock.enabled : DEFAULT_DOCK.enabled,
      width: Math.round(num(rdock.width, 360, 1600, DEFAULT_DOCK.width)),
      follow: typeof rdock.follow === 'boolean' ? rdock.follow : DEFAULT_DOCK.follow,
      followEvery: num(rdock.followEvery, 0.25, 5, DEFAULT_DOCK.followEvery),
    },
    rain: {
      enabled: typeof rrain.enabled === 'boolean' ? rrain.enabled : DEFAULT_RAIN.enabled,
      speedScale: num(rrain.speedScale, 0.1, 5, DEFAULT_RAIN.speedScale),
      density: num(rrain.density, 0, 1, DEFAULT_RAIN.density),
    },
    fpsCap: Math.round(num(o.fpsCap, 15, 120, DEFAULT_CONFIG.fpsCap)),
    source,
  };
}

/** Load ~/.dexterm/popup.json, or the defaults when it is missing/unreadable/malformed. Never throws. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PopupConfig {
  try {
    const text = readFileSync(configPath(env), 'utf8');
    return normalizeConfig(JSON.parse(text), 'file');
  } catch {
    return { ...DEFAULT_CONFIG, dock: { ...DEFAULT_DOCK }, rain: { ...DEFAULT_RAIN } };
  }
}
