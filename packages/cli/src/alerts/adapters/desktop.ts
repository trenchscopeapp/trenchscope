// trenchscope — the `desktop` adapter (task-1398). macOS `osascript -e 'display notification …'`, Linux
// `notify-send`. The command is run via execFile with an argv array (NO shell), so a crafted title/body
// cannot inject a command. macOS osascript takes one AppleScript string on argv; the already-firewalled
// title/body are additionally AppleScript-escaped (\\, ") and newline-stripped there. The runner is
// injectable so tests assert the command without spawning anything.
import { execFile } from 'node:child_process';
import type { AlertDelivery, DeliveryAdapter, AdapterResult } from '../types.ts';
import { deliveryLine } from '../format.ts';

/** Run a command (no shell). Resolves on success, rejects with a short reason on failure. */
export type DesktopRunner = (cmd: string, args: string[]) => Promise<void>;

export interface DesktopDeps { platform?: NodeJS.Platform; run?: DesktopRunner }

const defaultRunner: DesktopRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => (err ? reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} not found` : err.message)) : resolve()));
  });

/** AppleScript string literal body: escape backslash and quote, drop any residual control chars. */
function osaString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, ' ') + '"';
}

export function createDesktopAdapter(deps: DesktopDeps = {}): DeliveryAdapter {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRunner;
  return {
    name: 'desktop',
    available: () => platform === 'darwin' || platform === 'linux',
    deliver: async (d: AlertDelivery): Promise<AdapterResult> => {
      try {
        if (platform === 'darwin') {
          const script = `display notification ${osaString(d.body)} with title ${osaString(d.title)}`;
          await run('osascript', ['-e', script]);
        } else if (platform === 'linux') {
          await run('notify-send', ['--app-name=dexterm', d.title, d.body || deliveryLine(d)]);
        } else {
          return { ok: false, skipped: true, reason: `desktop notifications unsupported on ${platform}` };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  };
}
