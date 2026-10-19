// Outcome-sweep scheduling (AI-SUITE-DESIGN §4.1 "outcome": re-observe every recorded mint at the
// horizons 1 h, 2 h, 6 h, 24 h, 72 h). Pure functions over the per-mint summary so the rule is testable
// without a database.
//
// The rule. The app observes a token continuously while it is on screen (every refresh writes a row
// when something changed, and a heartbeat row otherwise), so a horizon measured from any t0 while the
// token stayed visible is already covered by the live rows. A re-observation is only needed once the
// token has LEFT the screen: with L = the newest live observation of a mint and A = its newest
// observation of any kind, horizon h is due iff
//     h <= now - L < 2h      (the window [L+h, L+2h] is open; labels.md: first observation at or after
//                             t0+h within 2x)
//     A < L + h              (nothing, live or sweep, has been seen since the window opened)
// One sweep row at `now` then serves every t0 of that mint whose window contains `now` — including the
// earlier t0s (first sighting F): if the token was visible for less than h, L+h lands inside
// [F+h, F+2h]; if it was visible longer, the live rows already covered F's horizon h.
// Because a sweep row is `kind = 'sweep'`, it moves A but not L, so the same horizon is never re-swept
// and the next horizon comes due relative to the same L: five re-observations per departure, no more.

import { HORIZONS_SEC } from './schema.ts';

export interface MintSummary {
  mint: string;
  last_live_t: number;
  last_any_t: number;
}

export interface DueMint {
  mint: string;
  horizon_sec: number;
  /** When the 2x window closes (unix ms); sweeps are ordered by it so nothing is lost to the queue. */
  closes_at: number;
}

/** Horizons due for one mint at `now`, smallest first. */
export function dueHorizons(m: MintSummary, now: number, horizons: readonly number[] = HORIZONS_SEC): number[] {
  const out: number[] = [];
  const age = now - m.last_live_t;
  for (const h of horizons) {
    const ms = h * 1000;
    if (age >= ms && age < 2 * ms && m.last_any_t < m.last_live_t + ms) out.push(h);
  }
  return out;
}

/**
 * The mints to re-observe now, at most `max`, soonest-closing window first. A mint with several horizons
 * due at once (it left the screen hours ago and the app was closed) is listed once: one observation
 * serves all of them.
 */
export function selectDue(rows: readonly MintSummary[], now: number, max: number, horizons: readonly number[] = HORIZONS_SEC): DueMint[] {
  const due: DueMint[] = [];
  for (const m of rows) {
    const hs = dueHorizons(m, now, horizons);
    if (!hs.length) continue;
    const h = hs[0];
    due.push({ mint: m.mint, horizon_sec: h, closes_at: m.last_live_t + 2 * h * 1000 });
  }
  due.sort((a, b) => a.closes_at - b.closes_at || a.mint.localeCompare(b.mint));
  return due.slice(0, max);
}

/** Bounds on `last_live_t` outside which no horizon can be due: [now - 2*maxH, now - minH]. */
export function dueBounds(now: number, horizons: readonly number[] = HORIZONS_SEC): { from: number; to: number } {
  const min = Math.min(...horizons) * 1000;
  const max = Math.max(...horizons) * 1000;
  return { from: now - 2 * max, to: now - min };
}
