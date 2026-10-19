// trenchscope — the `toast` adapter (task-1398). "Toast" means the in-app transient line in the running TUI,
// and the stdout line in `trenchscope watch`. It just hands the one-liner to a sink the caller owns; it makes
// no network or process call, so it is always available.
import type { AlertDelivery, DeliveryAdapter } from '../types.ts';
import { deliveryLine } from '../format.ts';

export function createToastAdapter(sink: (line: string, d: AlertDelivery) => void): DeliveryAdapter {
  return {
    name: 'toast',
    available: () => true,
    deliver: async (d: AlertDelivery) => {
      try { sink(deliveryLine(d), d); return { ok: true }; }
      catch (e) { return { ok: false, reason: (e as Error).message }; }
    },
  };
}
