// task-1310 round 2 — worker for the cross-process daily-cap race test. Each worker opens its OWN
// SQLite connection to one ledger file (= a separate trenchscope process), waits on a barrier, then runs
// exactly one atomic `tryReserve`. The parent counts how many were admitted.
import { workerData, parentPort } from 'node:worker_threads';
import { CapLedger } from '../src/trade/caps.ts';

const { path, sab, usd, cap, day } = workerData as { path: string; sab: SharedArrayBuffer; usd: number; cap: number; day: number };
let ledger: CapLedger | null = null;
for (let i = 0; i < 200 && !ledger; i++) {
  try { ledger = new CapLedger({ path }); } catch { await new Promise((r) => setTimeout(r, 5)); }
}
if (!ledger) throw new Error('could not open the ledger');
const flag = new Int32Array(sab);
parentPort!.postMessage('ready');
Atomics.wait(flag, 0, 0);
const res = ledger.tryReserve(usd, cap, day);
ledger.close();
parentPort!.postMessage(res.ok);
