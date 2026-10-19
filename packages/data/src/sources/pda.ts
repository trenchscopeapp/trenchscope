// Program-derived-address helpers (task-1312). The fast lane needs the pump.fun bonding-curve account
// for a mint so it can accountSubscribe to it, but a Create event is not always on hand (an opened or
// watchlisted token the user did not see launch). The curve is a PDA of the mint, so we derive it with
// no @solana/web3.js dependency: base58 decode, the ed25519 on-curve test (TweetNaCl `unpackneg`, the
// same check @solana/web3.js uses), and findProgramAddress. Validated against live-harvested mint→curve
// pairs (task-1283 watchlist.json) in the unit tests, including bumps 255/254/253 so the off-curve path
// is exercised.

import { createHash } from 'node:crypto';
import { base58 } from './solana-rpc.ts';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i;

/** Base58 (Bitcoin alphabet) decode to bytes. Throws on an invalid character. */
export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const c of s) {
    const carryStart = B58_MAP[c];
    if (carryStart === undefined) throw new Error(`invalid base58 character ${JSON.stringify(c)}`);
    let carry = carryStart;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // A value of zero leaves the seed digit [0] behind; drop it so leading '1's map to exactly one zero
  // byte each (the System program `111…1` must decode to 32 zero bytes, not 33 — task-1310 round 2).
  if (bytes.length === 1 && bytes[0] === 0) bytes.length = 0;
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

// ---- ed25519 field math for the on-curve test ----
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function mod(a: bigint): bigint {
  a %= P;
  return a < 0n ? a + P : a;
}

function pow(a: bigint, e: bigint): bigint {
  let r = 1n;
  a = mod(a);
  while (e > 0n) {
    if (e & 1n) r = mod(r * a);
    a = mod(a * a);
    e >>= 1n;
  }
  return r;
}

const SQRT_M1 = pow(2n, (P - 1n) / 4n); // sqrt(-1) mod p

/**
 * True when the 32-byte value is a valid ed25519 point (i.e. ON the curve). A program-derived address
 * must be OFF the curve. Ported from TweetNaCl's `unpackneg`: recover x from y and check v·x² == ±u.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n; // drop the sign bit
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * pow(mod(u * v7), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) {
    x = mod(x * SQRT_M1);
    return mod(v * x * x) === u;
  }
  return false;
}

const PDA_MARKER = Buffer.from('ProgramDerivedAddress');

/**
 * Deterministic findProgramAddress: the highest bump (255→0) whose sha256(seeds‖bump‖program‖marker)
 * is off the curve. Throws if none is found (cryptographically ~impossible).
 */
export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): { address: string; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(Buffer.from(s));
    h.update(Buffer.from([bump]));
    h.update(Buffer.from(programId));
    h.update(PDA_MARKER);
    const hash = h.digest();
    if (!isOnCurve(hash)) return { address: base58(hash), bump };
  }
  throw new Error('unable to find a program address bump');
}

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_CURVE_SEED = Buffer.from('bonding-curve');

/** The pump.fun bonding-curve account for a mint (PDA of ["bonding-curve", mint] under the pump program). */
export function pumpBondingCurve(mint: string): string {
  return findProgramAddress([PUMP_CURVE_SEED, base58Decode(mint)], base58Decode(PUMP_PROGRAM_ID)).address;
}

/** pump.fun mints are minted with a `pump` suffix; a cheap keyless hint for "this is streamable on a curve". */
export function isPumpMint(mint: string): boolean {
  return /pump$/.test(mint);
}
