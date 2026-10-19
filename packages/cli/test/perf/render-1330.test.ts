// task-1330 render budget, moved to the serial perf lane by task-1410 (`npm run test:perf`, run by `npm test`
// AFTER the parallel suite, one file at a time). Under the parallel suite ~150 test processes share the CPU
// and the wall-clock p95 measured scheduler noise (~40 ms), not render cost (~3 ms alone).
//
// Two guards per screen (trending, token + social panel, KOL) at 176×48:
//  1. FRAME BUDGET — wall-clock p95 per tick under 16 ms (one 60 Hz frame; the product requirement),
//     unconditionally. task-1424 also records the main thread's CPU p95 and scheduler-preemption count so a
//     load-related failure is diagnosable, but those diagnostics never replace or suppress the wall-clock
//     assertion. Of the three runs, the lowest wall p95 is judged, matching the original task-1330 contract.
//  2. REGRESSION GUARD — the median render time divided by the median of a fixed reference workload
//     (plain string/array work shaped like a frame build), measured interleaved frame by frame, so machine
//     speed and background load scale both sides alike. It must stay under 2× the ratio recorded below:
//     a 2× or worse render slowdown fails even though the frame would still fit the 16 ms budget.
//     Recalibrate RATIO_BASELINE (the printed `ratio` values) only after an intentional render change, and
//     say so in the handoff.
import assert from 'node:assert/strict';
import { makeFixtureState, renderFrame, type AppState } from '../../src/state.ts';
import { socialOf } from '../../src/social/view.ts';
import { serialLane } from '../serial/lane.ts';
import { FRAME_BUDGET_MS, cpuBudgetBound } from './budget.ts';

const laneTest = serialLane(import.meta.url);

/** render ms ÷ reference ms, medians, on this repo at task-1410 (load-independent; see the header). */
const RATIO_BASELINE = { trending: 2.35, social: 2.85, kol: 2.05 } as const;
const REGRESSION_FACTOR = 2;
/** A tick whose wall time exceeds its own CPU time by more than this waited for the core. */
const PREEMPT_MS = 1;

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

let sink = 0;
/** A fixed reference workload (~1 ms): build a 176×48 frame of styled rows and sort a few thousand numbers. */
function reference(): void {
  const rows: string[] = [];
  for (let y = 0; y < 48; y++) {
    let row = '';
    for (let x = 0; x < 176; x++) row += String.fromCharCode(33 + ((x * 7 + y * 13) % 90));
    rows.push(`\x1b[38;2;${y};${y * 2};200m` + row);
  }
  const nums = Array.from({ length: 4000 }, (_, i) => (i * 2654435761) % 10007);
  nums.sort((a, b) => a - b);
  sink += rows.join('\n').length + nums[7];
}

const cpuMs = (): number => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
const volSwitches = (): number => process.resourceUsage().voluntaryContextSwitches;

/** Budget stats for one run of ticks, timed on both clocks. */
type Budget = { p50: number; p95: number; max: number; cpuP95: number; preempted: number; n: number; blocked: boolean };
function budget(wall: number[], cpu: number[], vol: number): Budget {
  const preempted = wall.filter((w, i) => w - cpu[i] > PREEMPT_MS).length;
  return { p50: quantile(wall, 0.5), p95: quantile(wall, 0.95), max: quantile(wall, 1), cpuP95: quantile(cpu, 0.95), preempted, n: wall.length, blocked: vol > 0 };
}
/** The frame budget on two clocks. The wall-clock line is the product requirement and stays a literal, unconditional
 *  assertion in THIS file (lanes-1424 guards the text). The CPU line judges cpuBudgetBound(): the thread CPU p95 on
 *  POSIX; on Windows, whose thread CPU counter is quantized (~16 ms), the wall p95 as a conservative upper bound (a
 *  single thread cannot consume more CPU than elapsed time). Nothing is relaxed on any platform. */
function assertBudget(name: string, b: Budget, detail: string): void {
  const cpu = cpuBudgetBound(b);
  assert.ok(cpu.value < FRAME_BUDGET_MS, `${name} ${cpu.label} ${cpu.value.toFixed(2)} ms (${detail}) must be under ${FRAME_BUDGET_MS} ms`);
  assert.ok(b.p95 < FRAME_BUDGET_MS, `${name} wall p95 ${b.p95.toFixed(2)} ms (${detail}) must be under ${FRAME_BUDGET_MS} ms`);
}
const wallNote = (b: Budget): string => process.platform === 'win32'
  ? 'wall p95 asserted; CPU bounded by wall time; raw Windows CPU counter is quantized, preemption count unavailable'
  : `wall p95 asserted (${b.preempted}/${b.n} ticks lost > ${PREEMPT_MS} ms to other processes${b.blocked ? '; voluntary switch observed' : ''})`;

type Measured = Budget & { ratio: number; runs: number[]; cpuRuns: number[]; ratios: number[] };

/** The run the frame budget judges: the lowest wall p95, matching the original best-of-three contract. */
function pickRun(all: Budget[]): Budget {
  return [...all].sort((a, b) => a.p95 - b.p95)[0];
}

/** Three runs of 150 ticks; the frame budget judges pickRun()'s run, the regression guard the median run ratio. */
function measure(mk: () => AppState, n = 150): Measured {
  const state = mk();
  socialOf(state);
  renderFrame(state, 176, 48); // warm (lazy demo, memo)
  for (let i = 0; i < 20; i++) reference();
  const all: Budget[] = [];
  const runs: number[] = [];
  const cpuRuns: number[] = [];
  const ratios: number[] = [];
  for (let r = 0; r < 3; r++) {
    const times: number[] = [];
    const cpus: number[] = [];
    const refs: number[] = [];
    let vol = 0;
    for (let i = 0; i < n; i++) {
      state.now = new Date(state.now.getTime() + 500); // every tick moves the clock half a second (busts the 2 s memo every 4th frame)
      const v0 = volSwitches();
      const c0 = cpuMs();
      let t0 = performance.now();
      renderFrame(state, 176, 48);
      times.push(performance.now() - t0);
      cpus.push(cpuMs() - c0);
      vol += volSwitches() - v0;
      t0 = performance.now();
      reference();
      refs.push(performance.now() - t0);
    }
    const run = budget(times, cpus, vol);
    runs.push(run.p95);
    cpuRuns.push(run.cpuP95);
    ratios.push(run.p50 / quantile(refs, 0.5));
    all.push(run);
  }
  return { ...pickRun(all), ratio: quantile(ratios, 0.5), runs, cpuRuns, ratios };
}

laneTest('p95 render under 16 ms per tick, and no 2× render regression, for the trending screen, the token social panel and the KOL screen at 176×48', {}, () => {
  const measured = {
    trending: measure(() => makeFixtureState({ screen: 'trending', calm: true })),
    social: measure(() => { const s = makeFixtureState({ screen: 'token', calm: true }); s.tokenSocial = true; return s; }),
    kol: measure(() => makeFixtureState({ screen: 'kol', calm: true })),
  };
  assert.ok(sink > 0);
  const detail = (m: Measured) => `p50 ${m.p50.toFixed(2)}, max ${m.max.toFixed(2)}; runs ${m.runs.map((x) => x.toFixed(1)).join('/')}; CPU p95 ${m.cpuP95.toFixed(2)}, CPU runs ${m.cpuRuns.map((x) => x.toFixed(1)).join('/')}; ${wallNote(m)}`;
  for (const [name, m] of Object.entries(measured)) {
    process.stderr.write(`  render ${name}: p95 ${m.p95.toFixed(2)} ms (${detail(m)}) · ratio ${m.ratio.toFixed(2)} (runs ${m.ratios.map((x) => x.toFixed(2)).join('/')})\n`);
  }
  for (const [name, m] of Object.entries(measured)) {
    assertBudget(name, m, detail(m));
    const limit = RATIO_BASELINE[name as keyof typeof RATIO_BASELINE] * REGRESSION_FACTOR;
    assert.ok(m.ratio < limit, `${name} render/reference ratio ${m.ratio.toFixed(2)} (runs ${m.ratios.map((x) => x.toFixed(2)).join('/')}) must be under ${limit.toFixed(2)} (${REGRESSION_FACTOR}× the recorded ${RATIO_BASELINE[name as keyof typeof RATIO_BASELINE]}): the render got slower`);
  }
  // the engine's own board recompute (memo busted every call) also fits the tick budget
  const state = makeFixtureState({ screen: 'trending', calm: true });
  const feed = socialOf(state)!;
  const times: number[] = [];
  const cpus: number[] = [];
  let vol = 0;
  for (let i = 0; i < 100; i++) {
    feed.invalidate();
    const v0 = volSwitches();
    const c0 = cpuMs();
    const t0 = performance.now();
    feed.trendRows();
    times.push(performance.now() - t0);
    cpus.push(cpuMs() - c0);
    vol += volSwitches() - v0;
  }
  const rb = budget(times, cpus, vol);
  const rdetail = `CPU p95 ${rb.cpuP95.toFixed(2)} ms; ${wallNote(rb)}`;
  process.stderr.write(`  trendRows() recompute p95 ${rb.p95.toFixed(2)} ms (${rdetail})\n`);
  assertBudget('trendRows() recompute', rb, rdetail);
});
