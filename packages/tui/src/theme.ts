// @dexterm/tui — themes (SPEC §7.1, VISUAL-V2 §2). Every color is a hex string; semantics never
// change across themes: green up/ok, red down/bad, amber warn, coral/violet AI, pink pump.fun,
// orange Meteora DBC, blue Raydium, yellow Bonk. `cyberspace` is the default (task-1281, approved by
// design decision 2026-10-06); midnight / ember / paper stay one key away. Every theme also carries the ten
// effect tokens the fx engine reads, so effects are theme-agnostic (quiet on the v1 themes).
import type { Hex } from './color.ts';
import type { Launchpad } from '@dexterm/data';

export type Ramp = [Hex, Hex, Hex, Hex];

export interface Theme {
  name: string;
  bg: Hex;
  panel: Hex;
  panelAlt: Hex;
  border: Hex;
  borderFocus: Hex;
  text: Hex;
  muted: Hex;
  dim: Hex;
  accent: Hex;
  accentSoft: Hex;
  up: Hex;
  upSoft: Hex;
  down: Hex;
  downSoft: Hex;
  warn: Hex;
  warnSoft: Hex;
  ai: Hex;
  aiSoft: Hex;
  pump: Hex;
  dbc: Hex;
  raydium: Hex;
  meteora: Hex;
  bonk: Hex;
  selBg: Hex;
  headBg: Hex;
  tabActiveBg: Hex;
  sparkUp: Hex;
  sparkDown: Hex;
  heat: Ramp;
  // ---- effect tokens (VISUAL-V2 §2)
  /** Matrix rain, tail → head (head is bold, near-white). */
  rain: Ramp;
  /** Rain ramp while the market pumps (gold). Whole ramp swaps, never a tint. */
  rainPump: Ramp;
  /** Rain ramp while the market dumps (red-shift). */
  rainDump: Ramp;
  /** Chromatic-aberration fringes and datamosh row tints. */
  magenta: Hex;
  cyan: Hex;
  /** Aliases for effect code that must not depend on semantic tokens. */
  coral: Hex;
  acid: Hex;
  /** Halo colour for cells neighbouring bright viz. */
  glow: Hex;
  /** Scanline mix target (black; paper uses white). */
  scan: Hex;
  /** Boot logo row colours. */
  logo: [Hex, Hex, Hex];
  /** Flat look: % cells are coloured text with no heat fill, trends are a thin single-colour line. */
  flat?: boolean;
  /** Black-and-white look: states that are not direction or a warning (healthy, pending, ordinary bars) draw in ink, not green or amber. */
  mono?: boolean;
  /** Colour pop for live moments (wordmark cursor, row marker, sort column, filter caret, live dot). Falls back to accent. */
  pop?: Hex;
}

export type ThemeName = 'mono' | 'slate' | 'cyberspace' | 'midnight' | 'ember' | 'paper';

/** Effect tokens for the non-cyberspace themes: effects still run, but their glyphs sit close to the theme's own dim/border. */
const BASE_FX: Pick<Theme, 'rain' | 'rainPump' | 'rainDump' | 'magenta' | 'cyan' | 'coral' | 'acid' | 'glow' | 'scan' | 'logo'> = {
  rain: ['#1a2230', '#243244', '#33465c', '#5b7893'],
  rainPump: ['#2a2414', '#5a4a1a', '#a98a2a', '#ffe08a'],
  rainDump: ['#2a1418', '#5a1f2a', '#a93145', '#ff9db0'],
  magenta: '#f472b6',
  cyan: '#22d3ee',
  coral: '#d97757',
  acid: '#fbbf24',
  glow: '#1b3d2c',
  scan: '#000000',
  logo: ['#22d3ee', '#2dd4bf', '#34d399'],
};

export const THEMES: Record<ThemeName, Theme> = {
  // The default look (owner, 2026-10-18): black and white, matching the site. Ink on black for every label,
  // number and frame; the only hues left are a muted green/red for direction and amber for real warnings.
  // Launchpads, the analyst and the accent are greys, told apart by their labels and glyphs.
  mono: {
    name: 'mono',
    bg: '#0a0a0a',
    panel: '#0c0c0c',
    panelAlt: '#111111',
    border: '#2c2c2c',
    borderFocus: '#d9d9d9',
    text: '#ededed',
    muted: '#a6a6a6',
    dim: '#8c8c8c',
    accent: '#ffffff',
    accentSoft: '#262626',
    up: '#7cc794',
    upSoft: '#15211a',
    down: '#e8847c',
    downSoft: '#271614',
    warn: '#d9b46a',
    warnSoft: '#26200f',
    ai: '#f2f2f2',
    aiSoft: '#1c1c1c',
    pump: '#c8c8c8',
    dbc: '#b4b4b4',
    raydium: '#b4b4b4',
    meteora: '#b4b4b4',
    bonk: '#b4b4b4',
    selBg: '#242424',
    headBg: '#070707',
    tabActiveBg: '#2e2e2e',
    sparkUp: '#7cc794',
    sparkDown: '#e8847c',
    heat: ['#141414', '#262626', '#5c5c5c', '#ededed'],
    ...BASE_FX,
    rain: ['#101010', '#161616', '#1e1e1e', '#2a2a2a'],
    rainPump: ['#141414', '#2a2a2a', '#5c5c5c', '#d9d9d9'],
    rainDump: ['#141414', '#2a2a2a', '#5c5c5c', '#d9d9d9'],
    magenta: '#8c8c8c',
    cyan: '#d9d9d9',
    coral: '#f2f2f2',
    acid: '#d9b46a',
    glow: '#161616',
    logo: ['#ffffff', '#cfcfcf', '#8c8c8c'],
    flat: true,
    mono: true,
    pop: '#52e08a',
  },
  // The previous default: neutral dark slate, white numbers, colour only where it carries meaning
  // (direction, risk, warnings). No heat fills, no neon gradients, no rain.
  slate: {
    name: 'slate',
    bg: '#0e1116',
    panel: '#11151b',
    panelAlt: '#151a21',
    border: '#272f3a',
    borderFocus: '#8ab4ff',
    text: '#e8ecf2',
    muted: '#a3adbb',
    dim: '#8590a0',
    accent: '#8ab4ff',
    accentSoft: '#1b2a44',
    up: '#4ade80',
    upSoft: '#10291b',
    down: '#ff7b7b',
    downSoft: '#2e1517',
    warn: '#f5c451',
    warnSoft: '#2e2610',
    ai: '#e08a6a',
    aiSoft: '#2a1a12',
    pump: '#f472b6',
    dbc: '#fb923c',
    raydium: '#60a5fa',
    meteora: '#f59e0b',
    bonk: '#fde047',
    selBg: '#1a2230',
    headBg: '#0b0e12',
    tabActiveBg: '#1c2638',
    sparkUp: '#4ade80',
    sparkDown: '#ff7b7b',
    heat: ['#151a21', '#1b2a44', '#3b5a9a', '#8ab4ff'],
    ...BASE_FX,
    rain: ['#12161c', '#151a21', '#1a2029', '#232b36'],
    glow: '#151a21',
    logo: ['#8ab4ff', '#e8ecf2', '#4ade80'],
    flat: true,
  },
  cyberspace: {
    name: 'cyberspace',
    bg: '#020507',
    panel: '#03090c',
    panelAlt: '#051017',
    border: '#0c3a24',
    borderFocus: '#39ff14',
    text: '#eafff0',        // numbers, tickers: near-white with a phosphor cast (≈ 19:1 on bg)
    muted: '#62c98a',       // secondary labels (≈ 9:1 on bg)
    dim: '#3aa866',         // tertiary: gridlines, hints (6.8:1 on bg, 4.9:1 on the selected row)
    accent: '#00f0ff',      // electric cyan: selection, sort, links
    accentSoft: '#043a40',
    up: '#5dff6e',          // phosphor green (direction also carries a ▲ glyph)
    upSoft: '#0a3a16',
    down: '#ff3b6b',        // hot red/pink (direction also carries a ▼ glyph)
    downSoft: '#3d0a1a',
    warn: '#f5ff2d',        // acid yellow
    warnSoft: '#35380a',
    ai: '#d97757',          // Claude coral/terracotta: the analyst's voice
    aiSoft: '#3a1a10',
    pump: '#ff2bd6',        // hot magenta
    dbc: '#ff8a3d',
    raydium: '#00f0ff',
    meteora: '#ffb02e',
    bonk: '#f5ff2d',
    selBg: '#082618',       // was #0a2e1b; darkened after the calm audit so `down` digits on the selected row clear 4.5:1 (4.29 → 4.68)
    headBg: '#020a08',
    tabActiveBg: '#0b3b22',
    sparkUp: '#5dff6e',
    sparkDown: '#ff3b6b',
    heat: ['#062013', '#0a4a2a', '#13a04a', '#39ff14'],
    rain: ['#06301a', '#0b5a2c', '#16a848', '#b8ffc8'],
    rainPump: ['#3a2a05', '#8a6410', '#f0b429', '#fff1b3'],
    rainDump: ['#3a0a12', '#7a1226', '#d12a4a', '#ffb3c1'],
    magenta: '#ff2bd6',
    cyan: '#00f0ff',
    coral: '#d97757',
    acid: '#f5ff2d',
    glow: '#0f4d2a',
    scan: '#000000',
    logo: ['#39ff14', '#00f0ff', '#ff2bd6'],
  },
  midnight: {
    name: 'midnight',
    bg: '#0b0e14',
    panel: '#0f131b',
    panelAlt: '#121823',
    border: '#1f2733',
    borderFocus: '#2dd4bf',
    text: '#d6dde6',
    muted: '#7c8794',
    dim: '#4b5563',
    accent: '#22d3ee',
    accentSoft: '#164e63',
    up: '#34d399',
    upSoft: '#064e3b',
    down: '#f87171',
    downSoft: '#4c1d24',
    warn: '#fbbf24',
    warnSoft: '#3f2f05',
    ai: '#a78bfa',
    aiSoft: '#2e1065',
    pump: '#f472b6',
    dbc: '#fb923c',
    raydium: '#60a5fa',
    meteora: '#f59e0b',
    bonk: '#fde047',
    selBg: '#182233',
    headBg: '#0d1118',
    tabActiveBg: '#1b2a36',
    sparkUp: '#34d399',
    sparkDown: '#f87171',
    heat: ['#1b2a36', '#164e63', '#0e7490', '#22d3ee'],
    ...BASE_FX,
  },
  ember: {
    name: 'ember',
    bg: '#120d0b',
    panel: '#17110e',
    panelAlt: '#1d1512',
    border: '#3a2a22',
    borderFocus: '#fb923c',
    text: '#eadfd6',
    muted: '#9a8578',
    dim: '#5e4a3f',
    accent: '#fb923c',
    accentSoft: '#5a2e0f',
    up: '#4ade80',
    upSoft: '#113b26',
    down: '#fb7185',
    downSoft: '#4c1a27',
    warn: '#facc15',
    warnSoft: '#433a07',
    ai: '#c4b5fd',
    aiSoft: '#2d1b55',
    pump: '#f472b6',
    dbc: '#fdba74',
    raydium: '#7dd3fc',
    meteora: '#fcd34d',
    bonk: '#fde68a',
    selBg: '#2a1c15',
    headBg: '#150f0c',
    tabActiveBg: '#3a2416',
    sparkUp: '#4ade80',
    sparkDown: '#fb7185',
    heat: ['#2a1c15', '#5a2e0f', '#b45309', '#fb923c'],
    ...BASE_FX,
    rain: ['#2a1c15', '#3f2a1c', '#5e3f2a', '#9a6a45'],
    logo: ['#fb923c', '#facc15', '#fb7185'],
  },
  paper: {
    name: 'paper',
    bg: '#f6f3ee',
    panel: '#fbfaf7',
    panelAlt: '#f0ece5',
    border: '#d9d2c7',
    borderFocus: '#0f766e',
    text: '#1f2933',
    muted: '#6b7280',
    dim: '#a8a29e',
    accent: '#0e7490',
    accentSoft: '#cffafe',
    up: '#15803d',
    upSoft: '#dcfce7',
    down: '#b91c1c',
    downSoft: '#fee2e2',
    warn: '#b45309',
    warnSoft: '#fef3c7',
    ai: '#6d28d9',
    aiSoft: '#ede9fe',
    pump: '#be185d',
    dbc: '#c2410c',
    raydium: '#1d4ed8',
    meteora: '#b45309',
    bonk: '#a16207',
    selBg: '#e7e1d6',
    headBg: '#ebe6dd',
    tabActiveBg: '#dcd5c8',
    sparkUp: '#15803d',
    sparkDown: '#b91c1c',
    heat: ['#e7e1d6', '#a5f3fc', '#22d3ee', '#0e7490'],
    ...BASE_FX,
    rain: ['#ece7df', '#ddd6cb', '#c6bdb0', '#9c9184'],
    glow: '#dcefe4',
    scan: '#ffffff',
    logo: ['#0e7490', '#0f766e', '#6d28d9'],
  },
};

/** `t` cycles in this order: mono → slate → cyberspace → midnight → ember → paper. */
export const THEME_NAMES: ThemeName[] = ['mono', 'slate', 'cyberspace', 'midnight', 'ember', 'paper'];

export const DEFAULT_THEME: ThemeName = 'mono';

export function isThemeName(s: string): s is ThemeName {
  return (THEME_NAMES as string[]).includes(s);
}

export function nextTheme(current: Theme): Theme {
  const i = THEME_NAMES.indexOf(current.name as ThemeName);
  return THEMES[THEME_NAMES[(i + 1) % THEME_NAMES.length]];
}

export function launchpadColor(theme: Theme, lp: Launchpad | string | null | undefined): Hex {
  switch (lp) {
    case 'pump.fun': return theme.pump;
    case 'dbc': return theme.dbc;
    case 'raydium': return theme.raydium;
    case 'meteora': return theme.meteora;
    case 'bonk': return theme.bonk;
    default: return theme.muted;
  }
}
