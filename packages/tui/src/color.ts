// @dexterm/tui — color math and terminal color-depth detection.
// Colors are hex strings ('#rrggbb') everywhere in the theme and the canvas; the emitters
// convert them to 24-bit SGR, the nearest xterm-256 index, or drop them (NO_COLOR).

export type Hex = string;
export type Rgb = readonly [number, number, number];

/** How many colors the output terminal can show. */
export type ColorDepth = 'truecolor' | '256' | 'none';

const hexCache = new Map<string, Rgb>();

export function hexToRgb(hex: Hex): Rgb {
  let v = hexCache.get(hex);
  if (v) return v;
  const h = hex.replace('#', '');
  v = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  hexCache.set(hex, v);
  return v;
}

export function rgbToHex(r: number, g: number, b: number): Hex {
  return '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
}

const mixCache = new Map<string, Hex>();

/** Linear blend of two hex colors; t = 0 returns a, t = 1 returns b. Memoised on the exact t: the rain mixes thousands of cells per frame. */
export function mix(a: Hex, b: Hex, t: number): Hex {
  const key = a + b + t;
  const hit = mixCache.get(key);
  if (hit !== undefined) return hit;
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bb = Math.round(b1 + (b2 - b1) * t);
  const out = '#' + [r, g, bb].map((n) => n.toString(16).padStart(2, '0')).join('');
  if (mixCache.size > 50_000) mixCache.clear();
  mixCache.set(key, out);
  return out;
}

const lumCache = new Map<string, number>();

/** WCAG 2.x relative luminance of a hex colour (0 black .. 1 white). */
export function luminance(hex: Hex): number {
  const hit = lumCache.get(hex);
  if (hit !== undefined) return hit;
  const [r, g, b] = hexToRgb(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  lumCache.set(hex, v);
  return v;
}

/** WCAG contrast ratio between two colours (1 .. 21). The readability gate wants ≥ 4.5 for every numeric cell. */
export function contrast(fg: Hex, bg: Hex): number {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// xterm-256 palette: 16 system colors (not used as targets, their RGB varies per terminal),
// a 6×6×6 cube (16..231) and a 24-step gray ramp (232..255).
const CUBE = [0, 95, 135, 175, 215, 255];

function nearestCubeIndex(v: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < CUBE.length; i++) {
    const d = Math.abs(CUBE[i] - v);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const ansi256Cache = new Map<string, number>();

/** Nearest xterm-256 color index (16..255) for a hex color. */
export function hexToAnsi256(hex: Hex): number {
  const cached = ansi256Cache.get(hex);
  if (cached !== undefined) return cached;
  const [r, g, b] = hexToRgb(hex);
  const ri = nearestCubeIndex(r), gi = nearestCubeIndex(g), bi = nearestCubeIndex(b);
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeD = (CUBE[ri] - r) ** 2 + (CUBE[gi] - g) ** 2 + (CUBE[bi] - b) ** 2;
  // gray ramp: 232 + i has value 8 + 10*i
  const avg = Math.round((r + g + b) / 3);
  const gi2 = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + 10 * gi2;
  const grayD = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  const idx = grayD < cubeD ? 232 + gi2 : cubeIdx;
  ansi256Cache.set(hex, idx);
  return idx;
}

export interface DepthEnv {
  NO_COLOR?: string;
  FORCE_COLOR?: string;
  COLORTERM?: string;
  TERM?: string;
  TERM_PROGRAM?: string;
  WT_SESSION?: string;
}

/**
 * Decide the color depth from the environment (SPEC §7.1):
 * NO_COLOR wins; COLORTERM=truecolor/24bit or a known 24-bit terminal gives truecolor;
 * a 256color TERM gives 256; anything else falls back to 256 (every modern terminal has it)
 * unless TERM is dumb.
 */
export function detectColorDepth(env: DepthEnv = process.env as DepthEnv, isTTY = true): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    if (force === '0') return 'none';
    if (force === '3') return 'truecolor';
    if (force === '2' || force === '1') return '256';
  }
  if (!isTTY) return 'none';
  const term = (env.TERM || '').toLowerCase();
  if (term === 'dumb') return 'none';
  const ct = (env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  const prog = (env.TERM_PROGRAM || '').toLowerCase();
  if (['iterm.app', 'wezterm', 'ghostty', 'vscode', 'hyper', 'alacritty', 'kitty', 'rio', 'tabby'].includes(prog)) return 'truecolor';
  if (env.WT_SESSION) return 'truecolor';
  if (term.includes('truecolor') || term.includes('24bit') || term.startsWith('xterm-kitty') || term.startsWith('wezterm') || term.startsWith('alacritty')) return 'truecolor';
  if (term.includes('256color') || prog === 'apple_terminal') return '256';
  return '256';
}

export function parseColorDepth(s: string | undefined): ColorDepth | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v === 'truecolor' || v === '24bit' || v === '24-bit' || v === '16m') return 'truecolor';
  if (v === '256' || v === 'ansi256') return '256';
  if (v === 'none' || v === 'no' || v === 'off' || v === 'mono') return 'none';
  return undefined;
}
