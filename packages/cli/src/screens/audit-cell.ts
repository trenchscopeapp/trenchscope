// The no-flags RISK/FLAGS cell shared by the screener and new-pairs tables.
import { mix, type Canvas, type Hex } from '@dexterm/tui';
import { auditState } from '../screener/rows.ts';

/**
 * The no-flags cell: "✓ clean" only when every check came back (auditState), "◐ partial" when some did,
 * "? unaudited" when none did. A missing check is never drawn as a pass.
 */
export function auditCell(cv: Canvas, x: number, y: number, r: Parameters<typeof auditState>[0], bg: Hex): void {
  const t = cv.theme;
  const s = auditState(r);
  if (s === 'clean') cv.text(x, y, '✓ clean', { fg: mix(bg, t.up, 0.7), bg });
  else if (s === 'partial') cv.text(x, y, '◐ partial', { fg: t.muted, bg });
  else if (s === 'unaudited') cv.text(x, y, '? unaudited', { fg: t.dim, bg });
}

