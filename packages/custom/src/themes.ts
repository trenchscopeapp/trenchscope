// @dexterm/custom — user themes (task-1358 Tier 2). A theme file is `{ extends: <base>, tokens: {…} }` over
// the app's colour tokens (SPEC §7.1 + VISUAL-V2 §2); `config.theme.overrides` patches single tokens of
// whatever theme is active. Semantics never change (green up, red down, amber warn, coral AI): the validator
// refuses a theme whose text / warnings would fall under a contrast floor against the panel, and one whose
// `up` reads redder than its `down`, so a SHARED theme cannot hide a warning or make a sell look like a buy.
// A theme that fails validation is not loaded; the app keeps the current theme and says which token failed.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validate, THEME_TOKENS, THEME_RAMPS, BASE_THEMES, type SchemaError, type UserTheme, type DextermConfig } from './schema.ts';

/** The structural shape of @dexterm/tui's Theme (kept structural so this package stays dependency-free). */
export type ThemeDoc = Record<string, string | string[]> & { name: string };

export const THEME_FILE = /^[a-z][a-z0-9-]{0,39}\.json$/;

// ---- contrast (WCAG 2.x relative luminance), a small copy of @dexterm/tui color.ts so the floor is checkable here
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function hue(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const isGreenish = (hex: string): boolean => { const h = hue(hex); return h >= 60 && h <= 200; };
const isReddish = (hex: string): boolean => { const h = hue(hex); return h >= 320 || h <= 25; };
// r5 (verifier): a hue band says nothing about a near-grey tint (#7f807f has hue 120°, #807f7f hue 0°) — up and down must
// carry real colour and must be far apart to the eye. HSL saturation floor + CIE76 ΔE in Lab between the two.
function saturation(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  return d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
}
function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const [r, g, b] = lin;
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
/** CIE76 colour difference between two hex colours (0 = identical; ~2 just noticeable; built-in up/down pairs are > 80). */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
/** The least HSL saturation `up` and `down` may have (the built-ins sit at 0.63–0.91; a grey tint is ≈ 0). */
export const UP_DOWN_MIN_SATURATION = 0.35;
/** The least ΔE between `up` and `down` (the built-ins are 80–120; two greys are < 3). */
export const UP_DOWN_MIN_DELTA_E = 40;

/** The readability floors every theme must clear (named so a failure can say which pair). */
export const CONTRAST_FLOORS: Array<{ fg: string; bg: string; min: number }> = [
  { fg: 'text', bg: 'bg', min: 4.5 }, { fg: 'text', bg: 'panel', min: 4.5 },
  { fg: 'muted', bg: 'panel', min: 3 },
  { fg: 'up', bg: 'bg', min: 3 }, { fg: 'down', bg: 'bg', min: 3 }, { fg: 'warn', bg: 'bg', min: 3 },
  { fg: 'ai', bg: 'panel', min: 3 },
];

/** Semantic checks on a fully merged theme: the floors and the up/down hue guard. */
export function checkThemeSemantics(t: Record<string, unknown>): SchemaError[] {
  const errors: SchemaError[] = [];
  const hex = (k: string): string | null => (typeof t[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(t[k] as string) ? (t[k] as string) : null);
  for (const f of CONTRAST_FLOORS) {
    const a = hex(f.fg), b = hex(f.bg);
    if (!a || !b) continue;
    const c = contrast(a, b);
    if (c < f.min) errors.push({ path: `/tokens/${f.fg}`, msg: `${f.fg} on ${f.bg} contrast ${c.toFixed(2)} is under the ${f.min} floor (a theme may not hide ${f.fg === 'warn' ? 'warnings' : f.fg === 'text' ? 'numbers' : f.fg})` });
  }
  // r4 (verifier): the guard used to refuse only up-reddish / down-greenish, so an amber up with an amber down (or any
  // hue outside both bands, or up == down) passed and a SELL could look like a BUY. Now up MUST read green/cyan and down
  // MUST read red/pink — which also forces them apart — exactly what the header of this file promises.
  const up = hex('up'), down = hex('down');
  if (up && !isGreenish(up)) errors.push({ path: '/tokens/up', msg: `up (${up}, hue ${Math.round(hue(up))}°) must read green/cyan (hue 60–200°) so a buy never looks like a sell${isReddish(up) && down && isGreenish(down) ? ' (up and down are swapped)' : ''}` });
  if (down && !isReddish(down)) errors.push({ path: '/tokens/down', msg: `down (${down}, hue ${Math.round(hue(down))}°) must read red/pink (hue 320–25°) so a sell never looks like a buy` });
  if (up && down && up.toLowerCase() === down.toLowerCase()) errors.push({ path: '/tokens/down', msg: `down equals up (${down}): a sell would look like a buy` });
  // r5: the band is not enough — a grey with a green hue is still grey, and two greys read the same
  for (const [k, v] of [['up', up], ['down', down]] as const) {
    if (v && saturation(v) < UP_DOWN_MIN_SATURATION) errors.push({ path: `/tokens/${k}`, msg: `${k} (${v}) is too grey (saturation ${saturation(v).toFixed(2)} < ${UP_DOWN_MIN_SATURATION}): a buy or sell must carry real colour` });
  }
  if (up && down && deltaE(up, down) < UP_DOWN_MIN_DELTA_E) errors.push({ path: '/tokens/down', msg: `up (${up}) and down (${down}) are too alike (ΔE ${deltaE(up, down).toFixed(1)} < ${UP_DOWN_MIN_DELTA_E}): a sell would look like a buy` });
  return errors;
}

/** Merge a validated user theme over its base. The result carries the user theme's name. */
export function resolveTheme(doc: UserTheme & { name: string }, bases: Record<string, ThemeDoc>, overrides: Record<string, string | string[]> = {}): { theme: ThemeDoc | null; errors: SchemaError[] } {
  const schemaErrors = validate('userTheme', doc);
  if (schemaErrors.length) return { theme: null, errors: schemaErrors };
  const base = bases[doc.extends];
  if (!base) return { theme: null, errors: [{ path: '/extends', msg: `unknown base theme ${doc.extends}` }] };
  const merged: ThemeDoc = { ...structuredClone(base), ...sanitizeTokens(doc.tokens ?? {}), ...sanitizeTokens(overrides), name: doc.name };
  const sem = checkThemeSemantics(merged);
  return sem.length ? { theme: null, errors: sem } : { theme: merged, errors: [] };
}

/** Keep only known tokens (schema-validated callers pass clean input; this is defence in depth). */
function sanitizeTokens(tokens: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if ((THEME_TOKENS as readonly string[]).includes(k) && typeof v === 'string') out[k] = v;
    else if ((THEME_RAMPS as readonly string[]).includes(k) && Array.isArray(v) && v.length === 4) out[k] = [...v];
    else if (k === 'logo' && Array.isArray(v) && v.length === 3) out[k] = [...v];
  }
  return out;
}

/** Apply `config.theme.overrides` to an already-resolved (built-in or user) theme, with the same semantic guard. */
export function applyOverrides(theme: ThemeDoc, overrides: Record<string, string | string[]> | undefined): { theme: ThemeDoc; errors: SchemaError[] } {
  if (!overrides || !Object.keys(overrides).length) return { theme, errors: [] };
  const errors = validate({ type: 'object', additional: false, props: Object.fromEntries([...THEME_TOKENS.map((t) => [t, 'hex'] as const), ...THEME_RAMPS.map((t) => [t, 'ramp'] as const)]) }, overrides, '/theme/overrides');
  if (errors.length) return { theme, errors };
  const merged: ThemeDoc = { ...theme, ...sanitizeTokens(overrides) };
  const sem = checkThemeSemantics(merged);
  return sem.length ? { theme, errors: sem.map((e) => ({ ...e, path: e.path.replace('/tokens', '/theme/overrides') })) } : { theme: merged, errors: [] };
}

export interface ThemeFile { name: string; path: string | null; doc: UserTheme & { name: string }; error?: string; /** task-1358 Tier 4: set when the theme comes from an installed pack (`<pack>-<name>`). */ pack?: string }

export const themesDir = (home: string): string => join(home, 'themes');

/** User themes: ~/.dexterm/themes/<name>.json (file name = theme name) plus `config.theme.user`. Bad files are reported, not thrown. */
export function listUserThemes(home: string, config?: DextermConfig): ThemeFile[] {
  const out: ThemeFile[] = [];
  for (const [name, doc] of Object.entries(config?.theme?.user ?? {})) out.push({ name, path: null, doc: { ...doc, name } });
  let files: string[] = [];
  try { files = readdirSync(themesDir(home)).filter((f) => THEME_FILE.test(f)).sort(); } catch { return out; }
  for (const f of files) {
    const path = join(themesDir(home), f);
    const name = f.slice(0, -5);
    try {
      if (statSync(path).isSymbolicLink()) continue;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (raw && typeof raw === 'object' && raw.name !== undefined && raw.name !== name) throw new Error(`"name" must be "${name}" (the file name)`);
      const doc = { ...(raw as object), name } as UserTheme & { name: string };
      const errors = validate('userTheme', doc);
      if (errors.length) throw new Error(`${errors[0].path || '/'} ${errors[0].msg}`);
      if ((BASE_THEMES as readonly string[]).includes(name)) throw new Error(`"${name}" is a built-in theme name`);
      const i = out.findIndex((t) => t.name === name);
      const entry: ThemeFile = { name, path, doc };
      if (i >= 0) out[i] = entry; else out.push(entry);
    } catch (e) {
      out.push({ name, path, doc: { name, extends: 'cyberspace' }, error: (e as Error).message });
    }
  }
  return out;
}

/** A starter theme document a user can edit (`trenchscope theme init <name>`). */
export function starterTheme(name: string, base: (typeof BASE_THEMES)[number] = 'cyberspace'): UserTheme & { name: string } {
  return { name, extends: base, tokens: { accent: '#00f0ff', borderFocus: '#39ff14' } };
}
