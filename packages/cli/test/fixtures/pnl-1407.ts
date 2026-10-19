// task-1407 PnL card fixtures: recorded-fill shapes from the three ledgers (paper TradeRecords, signer live-ledger
// rows, a tracked wallet's decoded WalletTrades). Made-up tickers and addresses (marketing GUARDRAILS §4: no real
// tokens). The three visual-review fixtures are PROFIT (paper, closed), LOSS (live mainnet, closed) and LONG HOLD
// (tracked wallet, 11 days, still open, marked). Clock: NOW below; every time is relative to it.
import type { TradeRecord, LiveFillRow } from '@dexterm/data';
import type { WalletTrade } from '@dexterm/data/copy';
import { paperCardInput, liveCardInput, trackedCardInput, type CardInput } from '../../src/pnl-card.ts';

export const NOW = Date.UTC(2026, 9, 16, 5, 0, 0);
export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const MINT_NEON = 'NEoNxrXq4sBYc6x7GQd2fWZ3h8uKkTnp9EJmVRaLbump';
export const MINT_GLYPH = 'GLYPHa8sKq2Vd5mXz9RtCw4nB7eHfJuYpE3gN6kTcAoM';
export const MINT_DRIFT = 'DRiFTz4Lw8qN2xVb6YpKc9RmT3sHgE5jAuF7nWdXaBkQ';
export const WALLET = '7vYq3kPzRm2CdN8sFhJx5TbWu9GeLcQaKXn4oHtSpB6E';
export const SIG1 = '5h3kQx9yVb2Lm8NwT4rZc7Pd6Fs1Ja3Ue9Gt2Hk5Mn8Rq4Wx7Yz1Ab6Cd3Ef9Gh2Jk5Lm8Np4Qr7St1Uv3Wx';
export const SIG2 = '3Ab6Cd9Ef2Gh5Jk8Lm1Np4Qr7St3Uv6Wx9Yz2Ab5Cd8Ef1Gh4Jk7Lm3Np6Qr9St2Uv5Wx8Yz1Ab4Cd7Ef3Gh';

const LAMPORTS = 1_000_000_000;
const lam = (sol: number) => BigInt(Math.round(sol * LAMPORTS));
const raw = (tokens: number, decimals = 6) => BigInt(Math.round(tokens * 10 ** decimals));

/** A paper TradeRecord as PaperWallet.trades() returns it (solDelta net of the 5 000-lamport sim fee). */
export function paperRecord(id: number, t: number, side: 'buy' | 'sell', sol: number, tokens: number, mint = MINT_NEON, symbol = 'NEON'): TradeRecord {
  const fee = 5000n;
  const solDelta = side === 'buy' ? -(lam(sol) + fee) : lam(sol) - fee;
  return {
    id, t, mint, symbol, side, decimals: 6, solDelta, tokenDelta: side === 'buy' ? raw(tokens) : -raw(tokens),
    grossLamports: lam(sol), feeLamports: fee, priceSol: sol / tokens, priceUsd: null, priceImpactPct: 0.4, slippageBps: 50, route: ['Fixture AMM'],
    realizedLamports: 0n, paper: true,
  };
}

/** PROFIT: paper, two buys, two sells, closed after 5 h. */
export function profitInput(): CardInput {
  const t0 = NOW - DAY - 6 * HOUR;
  const records = [
    paperRecord(1, t0, 'buy', 0.5, 2_000_000),
    paperRecord(2, t0 + 20 * MIN, 'buy', 0.3, 1_000_000),
    paperRecord(3, t0 + 2 * HOUR, 'sell', 0.62, 1_500_000),
    paperRecord(4, t0 + 5 * HOUR, 'sell', 0.71, 1_500_000),
  ].reverse(); // newest first, as the wallet returns them
  return paperCardInput(records, { mint: MINT_NEON, name: 'Neon Sample' });
}

function liveRow(id: number, t: number, side: 'buy' | 'sell', sol: number, tokens: number, sig: string, network: 'mainnet' | 'devnet' = 'mainnet'): LiveFillRow {
  const fee = 15_000n;
  const solDelta = side === 'buy' ? -(lam(sol) + fee) : lam(sol) - fee;
  return {
    id, t, network, signature: sig, mint: MINT_GLYPH, symbol: 'GLYPH', side, solDelta: String(solDelta), tokenDelta: String(side === 'buy' ? raw(tokens, 9) : -raw(tokens, 9)),
    priceSol: sol / tokens, usd: null, decimals: 9, feeLamports: String(fee), realizedLamports: '0', kind: 'swap',
  };
}

/** LOSS: live mainnet, one buy, one sell 40 minutes later. */
export function lossInput(network: 'mainnet' | 'devnet' = 'mainnet'): CardInput {
  const t0 = NOW - 3 * HOUR;
  const rows = [liveRow(2, t0 + 40 * MIN, 'sell', 1.54, 820_000, SIG2, network), liveRow(1, t0, 'buy', 2.5, 820_000, SIG1, network)];
  return liveCardInput(rows, { mint: MINT_GLYPH, name: 'Glyph Sample', wallet: WALLET });
}

function walletTrade(t: number, side: 'buy' | 'sell' | 'transfer', sol: number | null, tokens: number, sig: string, note: WalletTrade['note'] = null): WalletTrade {
  return {
    wallet: WALLET, sig, slot: 300_000_000 + Math.floor(t / 400), t, tKnown: true, mint: MINT_DRIFT, side,
    tokenDelta: String(side === 'sell' ? -raw(tokens) : raw(tokens)), lamportsDelta: sol === null ? 0 : Math.round(sol * LAMPORTS),
    solDelta: sol, usd: null, solUsdAt: null, note,
  };
}

/** LONG HOLD: tracked wallet, bought 11 days ago, a partial sell, still open and marked 20 s ago; one token-swap excluded. */
export function longHoldTrades(): WalletTrade[] {
  const t0 = NOW - 11 * DAY - 4 * HOUR;
  return [
    walletTrade(t0, 'buy', -3.2, 40_000_000, 'trk1'),
    walletTrade(t0 + 2 * DAY, 'buy', -1.1, 10_000_000, 'trk2'),
    walletTrade(t0 + 7 * DAY, 'sell', 2.9, 15_000_000, 'trk3'),
    walletTrade(t0 + 8 * DAY, 'buy', null, 1_000_000, 'trk4', 'token-swap'),
  ];
}

export function longHoldInput(): CardInput {
  return trackedCardInput(longHoldTrades(), {
    wallet: WALLET, mint: MINT_DRIFT, symbol: 'DRIFT', name: 'Drift Sample', decimals: 6,
    mark: { priceSol: 0.000_000_31, at: NOW - 20_000, via: 'dexscreener' }, historyAt: NOW - 4 * MIN, complete: true,
  });
}
