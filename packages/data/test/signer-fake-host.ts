// task-1328 — a signer HOST on FAKES, run as a real child process by signer-1328.test.ts. Same host
// loop and protocol as production (serveSigner over stdio); only the executor's dependencies are fakes
// (no network, no wallet, a throwaway in-memory key). Argv: --dir <tmpdir> [--network mainnet] [--fast].
// task-1363: `--fast` creates a devnet fast wallet in the tmp dir and loads it (the fill path over the real channel).
import { serveSigner, SignerService, LiveExecutor, LiveLedger, CapLedger, KillSwitch, WalletLinkStore, defaultCaps, DEVNET_RPC, MAINNET_RPC, FastWalletStore, DevnetProbeBuilder, type LiveExecutorDeps } from '../src/index.ts';
import { keypair, buildTx, jupiterSwapIxs, fakeRpc, solUsdSamples, type BuiltTx } from './trade-helpers.ts';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const dir = argv[argv.indexOf('--dir') + 1];
const mainnet = argv.includes('--network') && argv[argv.indexOf('--network') + 1] === 'mainnet';
const withFast = argv.includes('--fast');
const USER = keypair();
const linkStore = new WalletLinkStore(join(dir, 'wallet-link.json'));
if (!argv.includes('--no-link')) linkStore.set(USER.address, { network: mainnet ? 'mainnet' : 'devnet' });
const txs = new Map<string, BuiltTx>();
const fresh = (): BuiltTx => { const t = buildTx({ feePayer: USER.pub, ixs: jupiterSwapIxs(USER, 500_000_000n) }); txs.set(t.unsigned, t); return t; };
const rawQuote = { inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: '500000000', outAmount: '2000000', otherAmountThreshold: '1990000', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.005', platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '3' };
// With --fast the simulation reports only fees leaving the wallet (a wrap-and-unwrap); otherwise the swap default.
const rpc0 = fakeRpc({ url: mainnet ? MAINNET_RPC : DEVNET_RPC, ...(withFast ? { solOut: 5_000n } : {}) });
const rpc = { ...rpc0, latestBlockhash: async () => ({ blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', lastValidBlockHeight: 1 }) };
const ledger = new CapLedger({ path: join(dir, 'caps.sqlite') });
const liveLedger = new LiveLedger({ path: join(dir, 'live.sqlite') });
const fastStore = new FastWalletStore(join(dir, 'fast-wallet.json'));
if (withFast && !fastStore.exists()) fastStore.create({ network: 'devnet' });
const fastSigner = withFast && !mainnet ? fastStore.load() ?? undefined : undefined;
const deps: LiveExecutorDeps = {
  build: { quoteRaw: async () => rawQuote, buildSwap: async () => ({ swapTransactionBase64: fresh().unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 0, quote: rawQuote }) } as unknown as LiveExecutorDeps['build'],
  rpc: rpc as unknown as LiveExecutorDeps['rpc'],
  bridge: { signTransaction: async (a: { unsignedTxBase64: string }) => { const t = txs.get(a.unsignedTxBase64); if (!t) throw new Error('unknown tx'); return { signedTxBase64: t.sign(USER), provider: 'fake', roundTripMs: 1 }; } } as unknown as LiveExecutorDeps['bridge'],
  caps: defaultCaps({ network: mainnet ? 'mainnet' : 'devnet', mainnetEnabled: mainnet }),
  ledger, liveLedger,
  solUsd: () => solUsdSamples(6, Date.now()),
  killSwitch: new KillSwitch(join(dir, 'trading.panic')),
  probe: new DevnetProbeBuilder(rpc as never),
  fastSigner,
};
const service = new SignerService({ executor: new LiveExecutor(deps), deps, linkStore, liveLedger, fastStore });
// Deterministic real-pipe timeout fixture: Windows has no SIGSTOP/SIGCONT.
if (process.argv.includes('--stall-status')) {
  const call = service.call.bind(service);
  service.call = (method, params) => method === 'status' ? new Promise(() => {}) : call(method, params);
}
process.stderr.write(`fake-host: user ${USER.address}${fastSigner ? ` fast ${fastSigner.publicKey}` : ''}\n`);
serveSigner({ service, input: process.stdin, output: process.stdout, log: (l) => process.stderr.write(`${l}\n`) }).then((why) => {
  process.stderr.write(`fake-host: stopped (${why})\n`);
  process.exitCode = why === 'input closed' ? 0 : 1;
  process.stdin.destroy();
});
