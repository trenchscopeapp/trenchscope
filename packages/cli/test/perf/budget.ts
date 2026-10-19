import assert from 'node:assert/strict';

/** One 60 Hz frame: the per-tick budget on both clocks (task-1330 contract). */
export const FRAME_BUDGET_MS = 16;

type Clocks = { p95: number; cpuP95: number };

/** Which number the CPU half of the frame budget judges.
 *  POSIX: the thread CPU p95 (high resolution). Windows: thread CPU accounting advances in ~16 ms quanta (hosted
 *  samples read 16.0/16.0/16.0 for a 2 ms frame), so the quantized counter is not a measurement; a single thread
 *  cannot consume more CPU time than its elapsed wall time, so the wall p95 is a conservative upper bound.
 *  The wall-clock assertion itself is never relaxed anywhere (render-1330.test.ts keeps it inline; lanes-1424
 *  guards that text). */
export function cpuBudgetBound(b: Clocks, platform: NodeJS.Platform = process.platform): { value: number; label: string } {
  return platform === 'win32' ? { value: b.p95, label: 'CPU upper bound (wall p95)' } : { value: b.cpuP95, label: 'CPU p95' };
}

/** The same two assertions render-1330.test.ts makes, with an injectable platform so render-budget-1440.test.ts
 *  can prove the contract for every platform value: a 16 ms+ wall p95 fails everywhere, and POSIX keeps the
 *  high-resolution CPU guard. */
export function assertFrameBudget(name: string, b: Clocks, detail: string, platform: NodeJS.Platform = process.platform): void {
  const cpu = cpuBudgetBound(b, platform);
  assert.ok(cpu.value < FRAME_BUDGET_MS, `${name} ${cpu.label} ${cpu.value.toFixed(2)} ms (${detail}) must be under ${FRAME_BUDGET_MS} ms`);
  assert.ok(b.p95 < FRAME_BUDGET_MS, `${name} wall p95 ${b.p95.toFixed(2)} ms (${detail}) must be under ${FRAME_BUDGET_MS} ms`);
}
