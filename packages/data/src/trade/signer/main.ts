// trenchscope T2 — the signer PROCESS entry (task-1328). `node main.ts [caps flags]`. Wires the real
// dependencies — its OWN HTTP client for Jupiter + RPC, its OWN SOL/USD feed, the wallet bridge (opens
// the system browser for Phantom), the kill-switch file, the shared daily-cap ledger and the live fill
// ledger — and serves the authenticated stdio channel until the parent closes it.
//
// Caps come from THIS process's argv (what the user typed when starting dexterm), clamped to the hard
// ceilings and, without --mainnet, only ever DOWN from the defaults. Nothing on the channel can change
// them. The RPC defaults to DEVNET; `--mainnet` switches to the user's configured mainnet RPC
// (DEXTERM_RPC_URL / ~/.dexterm/helius.key / public). `--rpc URL` is honoured but the NETWORK the
// signer reports and caps by is always classified from the URL it will actually talk to.

import { createDataLayer } from '../../index.ts';
import { JupiterSwapBuild } from '../swap-build.ts';
import { TradeRpc, DEVNET_RPC, rpcNetwork } from '../rpc-exec.ts';
import { WalletBridge } from '../bridge.ts';
import { defaultCaps, capsOnlyDownward, CapLedger, defaultCapLedgerPath, HARD_MAX_PER_TRADE_USD, HARD_MAX_DAILY_USD, HARD_MAX_SOL_OUT, HARD_MAX_SLIPPAGE_BPS, type TradeCaps } from '../caps.ts';
import { LiveExecutor, LiveLedger, defaultLiveLedgerPath } from '../executor.ts';
import { KillSwitch, defaultPanicPath } from '../kill-switch.ts';
import { WalletLinkStore, defaultLinkPath } from '../link-store.ts';
import { resolveRpcUrl } from '../../rpc-config.ts';
import { DevnetProbeBuilder } from './probe-builder.ts';
import { SolUsdFeed } from './sol-usd-feed.ts';
import { FastWalletStore, defaultFastWalletPath } from './fast-wallet.ts';
import { SignerService } from './service.ts';
import { serveSigner } from './host.ts';

export interface SignerArgs {
  caps: TradeCaps;
  rpcUrl: string;
  ledgerPath: string;
  liveLedgerPath: string;
  linkPath: string;
  panicPath: string;
  /** task-1363: where the capped devnet fast wallet lives (loaded only when the RPC is devnet). */
  fastWalletPath: string;
  /** Test hook: do not open a browser; the bridge page URL is printed to stderr instead. */
  noBrowser: boolean;
}

/** Parse the signer's argv. Over-ceiling caps are an error (never silently accepted). */
export function parseSignerArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SignerArgs {
  let mainnet = false;
  let perTradeUsd: number | undefined, dailyUsd: number | undefined, maxSolOut: number | undefined, maxSlippageBps: number | undefined;
  let rpcUrl: string | undefined;
  let ledgerPath = defaultCapLedgerPath(), liveLedgerPath = defaultLiveLedgerPath(), linkPath = defaultLinkPath(), panicPath = defaultPanicPath();
  let fastWalletPath = defaultFastWalletPath(env);
  let noBrowser = false;
  const take = (flag: string, raw: string | undefined, ceiling: number): number | undefined => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    if (n > ceiling) throw new Error(`${flag} ${n} exceeds the hard ceiling of ${ceiling}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--mainnet') mainnet = true;
    else if (k === '--max-usd') perTradeUsd = take(k, argv[++i], HARD_MAX_PER_TRADE_USD);
    else if (k === '--daily-usd') dailyUsd = take(k, argv[++i], HARD_MAX_DAILY_USD);
    else if (k === '--max-sol-out') maxSolOut = take(k, argv[++i], HARD_MAX_SOL_OUT);
    else if (k === '--max-slippage-bps') maxSlippageBps = take(k, argv[++i], HARD_MAX_SLIPPAGE_BPS);
    else if (k === '--rpc') rpcUrl = argv[++i];
    else if (k === '--ledger') ledgerPath = argv[++i];
    else if (k === '--live-ledger') liveLedgerPath = argv[++i];
    else if (k === '--link') linkPath = argv[++i];
    else if (k === '--panic-file') panicPath = argv[++i];
    else if (k === '--fast-wallet') fastWalletPath = argv[++i];
    else if (k === '--no-browser') noBrowser = true;
  }
  const caps = capsOnlyDownward(defaultCaps({ network: mainnet ? 'mainnet' : 'devnet', mainnetEnabled: mainnet, perTradeUsd, dailyUsd, maxSolOut, maxSlippageBps }));
  // The RPC: explicit --rpc, else devnet; with --mainnet the user's configured mainnet endpoint.
  const url = rpcUrl ?? (mainnet ? resolveRpcUrl({ env }).url : DEVNET_RPC);
  // Never let a devnet-labelled signer talk to mainnet by accident: without --mainnet a non-devnet URL is refused.
  if (!mainnet && rpcNetwork(url) !== 'devnet') throw new Error('without --mainnet the signer RPC must be a devnet endpoint');
  return { caps, rpcUrl: url, ledgerPath, liveLedgerPath, linkPath, panicPath, fastWalletPath, noBrowser };
}

/**
 * task-1368: the signer's own `jupiter` bucket carries only its quote/build calls (a handful per ticket), so after a
 * 429 it pauses from this base (doubling per consecutive 429, capped as before) instead of the data layer's 30 s —
 * which was tuned for the terminal's enrichment flood and made every retry inside the 10 s budget impossible.
 * Retry-After from the server still wins when it is longer.
 */
export const SIGNER_RATE_LIMIT_PAUSE_MS = 3_000;

export function buildSignerService(a: SignerArgs, log: (l: string) => void): SignerService {
  const dl = createDataLayer({ dbPath: ':memory:', rpcUrl: a.rpcUrl, rpcFallbackUrl: null, rateLimitPauseMs: SIGNER_RATE_LIMIT_PAUSE_MS });
  const rpc = new TradeRpc(dl.http, { url: a.rpcUrl, clock: dl.clock });
  const build = new JupiterSwapBuild(dl.http);
  const bridge = new WalletBridge(a.noBrowser ? { open: (url) => { log(`signer: open this page to approve: ${url}`); } } : {});
  const ledger = new CapLedger({ path: a.ledgerPath, clock: dl.clock });
  const liveLedger = new LiveLedger({ path: a.liveLedgerPath, clock: dl.clock });
  const killSwitch = new KillSwitch(a.panicPath);
  const linkStore = new WalletLinkStore(a.linkPath);
  const feed = new SolUsdFeed({ clock: dl.clock });
  // task-1363: the capped fast wallet is loaded ONLY against a devnet RPC (by classification of the URL the
  // signer will actually talk to). On mainnet there is no fast signer, so `fill` and fast-lane confirms refuse.
  const fastStore = new FastWalletStore(a.fastWalletPath);
  const fastSigner = rpc.network === 'devnet' ? fastStore.load() ?? undefined : undefined;
  if (fastSigner) log(`signer: fast wallet loaded (devnet) ${fastSigner.publicKey}`);
  const deps = { build, rpc, bridge, caps: a.caps, ledger, liveLedger, clock: dl.clock, solUsd: () => feed.samples(), killSwitch, probe: new DevnetProbeBuilder(rpc), fastSigner };
  const executor = new LiveExecutor(deps);
  return new SignerService({ executor, deps, linkStore, liveLedger, solUsdFeed: feed, clock: dl.clock, fastStore, log });
}

export async function main(argv: string[]): Promise<number> {
  const log = (l: string) => process.stderr.write(`${l}\n`);
  let args: SignerArgs;
  try { args = parseSignerArgs(argv); } catch (e) { log(`signer: ${e instanceof Error ? e.message : String(e)}`); return 2; }
  const service = buildSignerService(args, log);
  const why = await serveSigner({ service, input: process.stdin, output: process.stdout, log });
  log(`signer: stopped (${why})`);
  return why === 'input closed' ? 0 : 1;
}

// Run when executed directly (never when imported by the client or the tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; process.stdin.destroy(); }, (e) => { process.stderr.write(`signer: fatal ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
}
