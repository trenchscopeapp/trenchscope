// pump.fun bonding-curve price, computed from on-chain account state only — no aggregator (SPEC §3.9,
// task-1312; ported from the task-1283 spike's pump-curve.mjs and validated live there against
// PumpPortal's marketCapSol, 28 SOL ✓).
//
// The bonding-curve account (owned by program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P) is an Anchor
// account. Layout (little-endian), confirmed against pump.fun's published IDL:
//   [0..8)   8-byte account discriminator
//   [8..16)  virtualTokenReserves  u64   (token base units, 6 decimals)
//   [16..24) virtualSolReserves    u64   (lamports, 9 decimals)
//   [24..32) realTokenReserves     u64
//   [32..40) realSolReserves       u64
//   [40..48) tokenTotalSupply      u64
//   [48]     complete              u8  (1 once migrated to a DEX pool)
//   [49..81) creator               pubkey (present on curves created after the 2025 creator-fee upgrade)
//
// Spot price of 1 token in SOL on the constant-product curve = virtualSol / virtualToken, adjusted for
// the 9-vs-6 decimal gap. Virtual reserves are the pricing reserves (they include the initial virtual
// offset). Multiply by SOL/USD for a USD tick. Decode is < 1 ms and allocation-light.

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOL_DECIMALS = 9;
const TOKEN_DECIMALS = 6;
/** Base discriminator (8) + five u64 (40) + complete (1). */
const CURVE_MIN_LEN = 49;

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** 1 once the curve migrated to a DEX pool; price must then come from the pool, not the curve. */
  complete: boolean;
  vSol: number;
  vToken: number;
  /** SOL per 1 token, or null when the token reserve is zero. */
  priceSol: number | null;
}

/** Decode a base64 bonding-curve account into reserves + derived spot price. Returns null on junk. */
export function decodeBondingCurve(base64: string): BondingCurve | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (buf.length < CURVE_MIN_LEN) return null;
  const virtualTokenReserves = buf.readBigUInt64LE(8);
  const virtualSolReserves = buf.readBigUInt64LE(16);
  const realTokenReserves = buf.readBigUInt64LE(24);
  const realSolReserves = buf.readBigUInt64LE(32);
  const tokenTotalSupply = buf.readBigUInt64LE(40);
  const complete = buf.readUInt8(48) === 1;
  const vSol = Number(virtualSolReserves) / 10 ** SOL_DECIMALS;
  const vToken = Number(virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
  const priceSol = vToken > 0 ? vSol / vToken : null;
  return { virtualTokenReserves, virtualSolReserves, realTokenReserves, realSolReserves, tokenTotalSupply, complete, vSol, vToken, priceSol };
}

/** Full-dilution market cap in SOL from a decoded curve (totalSupply is 6-decimal base units). */
export function marketCapSol(curve: BondingCurve | null): number | null {
  if (!curve || curve.priceSol == null) return null;
  const supply = Number(curve.tokenTotalSupply) / 10 ** TOKEN_DECIMALS;
  return curve.priceSol * supply;
}

/** Price one token in USD from a decoded curve and a SOL/USD rate (null when either is missing). */
export function curvePriceUsd(curve: BondingCurve | null, solUsd: number | null): number | null {
  if (!curve || curve.priceSol == null || solUsd == null || !Number.isFinite(solUsd)) return null;
  return curve.priceSol * solUsd;
}
