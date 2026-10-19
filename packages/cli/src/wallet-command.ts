// trenchscope T2 — the in-app `/wallet …` command grammar (task-1328). Pure: parse only. The LiveContext
// performs the command. `/wallet` alone = status.
export type WalletCommand = 'status' | 'link' | 'unlink' | 'panic' | 'probe';

/**
 * Parse a typed command: `/wallet` · `/wallet status` · `/wallet link` · `/wallet unlink` ·
 * `/wallet panic` · `/wallet probe`. The leading slash is optional (the screener's `/` line ate it).
 * Anything else — including a real filter — returns null. `resume` is deliberately NOT a command here:
 * re-enabling live trading needs a real TTY keypress in `trenchscope wallet resume`.
 */
export function parseWalletCommand(text: string): WalletCommand | { error: string } | null {
  const m = /^\s*\/?wallet(?:\s+(\S+))?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const arg = (m[1] ?? '').toLowerCase();
  if (arg === '' || arg === 'status') return 'status';
  if (arg === 'link') return 'link';
  if (arg === 'unlink') return 'unlink';
  if (arg === 'panic') return 'panic';
  if (arg === 'probe') return 'probe';
  if (arg === 'resume') return { error: 'resume needs a real terminal keypress: run `trenchscope wallet resume` in a shell' };
  return { error: `unknown /wallet command "${arg.slice(0, 16)}" (status · link · unlink · panic · probe)` };
}

export const WALLET_HELP = `  /wallet [status]          linked wallet (pubkey only), the signer's network + caps, panic state
  /wallet link              open the browser to link a Phantom wallet (sign-a-message proof; no transaction)
  /wallet unlink            forget the linked public key
  /wallet panic             disable live signing at once (kill-switch file + cap-ledger lock); resume needs \`trenchscope wallet resume\`
  /wallet probe             devnet plumbing test: a wrap-and-unwrap transaction you sign in Phantom (fees only)
  trenchscope wallet fast …     the capped DEVNET fast wallet armed order plans fire from: create (TTY keypress) · status · airdrop · remove`;
