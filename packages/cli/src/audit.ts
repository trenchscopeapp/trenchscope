// trenchscope — the readability audit behind the contrast gate (VISUAL-V2 §6.4): WCAG contrast of every
// hard cell against its own background with effects ON at a glitch frame. Used by test/contrast.test.ts
// (the gate) and tools/contrast.mjs (the report).
import { contrast } from '@dexterm/tui';
import { renderFrame, type AppState } from './state.ts';
import { parseArgs, stateFromArgs, applyEffectArgs } from './main.ts';

export interface ContrastCase { screen: 'screener' | 'token' | 'newpairs' | 'watchlist' | 'analyst' | 'boot'; w: number; h: number; frame: number; event?: 'newpair' | 'pump'; t?: number }

export const CONTRAST_CASES: ContrastCase[] = [];
for (const [w, h] of [[176, 48], [120, 40], [90, 36]] as const) {
  for (const screen of ['screener', 'token', 'newpairs', 'watchlist', 'analyst'] as const) CONTRAST_CASES.push({ screen, w, h, frame: 41, event: screen === 'newpairs' ? 'newpair' : undefined });
}
CONTRAST_CASES.push({ screen: 'token', w: 176, h: 50, frame: 41, event: 'pump' });
CONTRAST_CASES.push({ screen: 'boot', w: 176, h: 48, frame: 30, t: 0.78 });

export function contrastCaseState(cs: ContrastCase, theme = 'cyberspace'): AppState {
  const a = ['--fixtures', '--theme', theme, '--screen', cs.screen, '--frame', String(cs.frame), '--selected', '3'];
  if (cs.event) a.push('--event', cs.event);
  if (cs.t != null) a.push('--t', String(cs.t));
  const args = parseArgs(a);
  const st = stateFromArgs(args);
  applyEffectArgs(st, args);
  return st;
}

export interface WorstCell { x: number; y: number; ch: string; fg: string; bg: string; r: number }
export interface ContrastRow { screen: string; size: string; event: string; hardCells: number; min: number; p05: number; median: number; numericMin: number | null; numericMedian: number | null; below: number; worst: WorstCell[] }

const DIGIT = /[0-9]/;

export function auditContrast(cs: ContrastCase, min = 4.5, theme = 'cyberspace'): ContrastRow {
  const c = renderFrame(contrastCaseState(cs, theme), cs.w, cs.h);
  const ratios: number[] = [];
  const numeric: number[] = [];
  const worst: WorstCell[] = [];
  for (let i = 0; i < c.ch.length; i++) {
    if (!c.hard[i]) continue;
    const r = contrast(c.fg[i], c.bg[i]);
    ratios.push(r);
    if (DIGIT.test(c.ch[i])) numeric.push(r);
    if (r < min) worst.push({ x: i % c.w, y: Math.floor(i / c.w), ch: c.ch[i], fg: c.fg[i], bg: c.bg[i], r: +r.toFixed(2) });
  }
  ratios.sort((p, q) => p - q);
  numeric.sort((p, q) => p - q);
  const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  return {
    screen: cs.screen, size: `${cs.w}×${cs.h}`, event: cs.event ?? '', hardCells: ratios.length,
    min: +ratios[0].toFixed(2), p05: +pct(ratios, 0.05).toFixed(2), median: +pct(ratios, 0.5).toFixed(2),
    numericMin: numeric.length ? +numeric[0].toFixed(2) : null, numericMedian: numeric.length ? +pct(numeric, 0.5).toFixed(2) : null,
    below: worst.length, worst: worst.slice(0, 4),
  };
}

export function isDigit(ch: string): boolean { return DIGIT.test(ch); }
