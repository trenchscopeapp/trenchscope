// @dexterm/tui — breakpoints (SPEC §7.4): compact < 100 cols, standard 100..139, wide ≥ 140.

export type Breakpoint = 'compact' | 'standard' | 'wide';

export const BREAKPOINTS = { compact: 0, standard: 100, wide: 140 } as const;

export function breakpoint(w: number): Breakpoint {
  if (w < BREAKPOINTS.standard) return 'compact';
  if (w < BREAKPOINTS.wide) return 'standard';
  return 'wide';
}

/** Minimum supported terminal (SPEC §7.4): screener only, 7 columns. */
export const MIN_SIZE = { w: 80, h: 24 } as const;
