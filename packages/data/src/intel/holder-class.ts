// Holder CLASSIFICATION (task-1367): what kind of owner holds a top token account — a pool, a bonding curve, a
// launch/escrow vault, a lock, an exchange, the burn address, the creator, a wallet linked to other top holders —
// or UNLABELLED when the chain facts we already have do not say. Pure: the inputs are the token account's owner
// (getMultipleAccounts over the token accounts) and the OWNER account's program (getMultipleAccounts over the
// owners), both fetched by the wallet-intel scan already, plus the launch-window labels the rules derived. No new
// request, no paid API, no scraping.
//
// Never a guess. A class is only given when the owner is (a) a program authority we can re-derive (the constant
// pool-authority PDAs below are checked in the tests with findProgramAddress), (b) an account owned by a program
// in PROGRAM_CLASS, (c) the incinerator / system address, (d) a seed-list exchange wallet (always "unverified"),
// or (e) an on-chain launch rule (D1 creator, P1 pool, linked cluster). Anything else — a plain wallet, an account
// of a program we do not list, a PDA with no account — is UNLABELLED with what we do know, and is COUNTED in the
// ex-pool concentration: an unknown program could be the dev's own contract, so it is never hidden.

import { SYSTEM_PROGRAM } from '../trade/tx-decode.ts';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../sources/solana-rpc.ts';
import { PUMP_PROGRAM_ID, pumpBondingCurve, base58Decode, isOnCurve } from '../sources/pda.ts';
import type { OwnerMeta } from './rules.ts';

export type HolderTag = 'POOL' | 'CURVE' | 'VAULT' | 'LOCK' | 'CEX' | 'BURN' | 'DEV' | 'LINKED' | 'UNLABELLED';

/** Classes whose balance is not a person's position: dropped from the ex-pool top-10. */
export const EX_POOL_TAGS: ReadonlySet<HolderTag> = new Set<HolderTag>(['POOL', 'CURVE', 'VAULT', 'LOCK', 'BURN']);

/** An unlabelled (or creator / linked) owner above this share is called out as the main risk. */
export const BIG_HOLDER_PCT = 30;

export interface HolderClass {
  tag: HolderTag;
  /** Why, in one line (the rule and the address / program it rests on). Shown on selection. */
  reason: string;
  /** Program name when the class came from the owner's program or a derived authority. */
  program: string | null;
  /** LOCK / VAULT only: what can be resolved about the escrow (never an invented schedule). */
  lock: { escrow: string; program: string; unlock: string | null; authority: string | null; note: string } | null;
}

interface ProgramEntry { tag: HolderTag; name: string; what: string }

/**
 * Programs whose ACCOUNTS own token accounts that are not a person's position. Keyed by program id: when the
 * token account's owner is an account owned by one of these programs, the owner is that program's pool / curve
 * / vault / escrow state.
 */
export const PROGRAM_CLASS: Readonly<Record<string, ProgramEntry>> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': { tag: 'POOL', name: 'Raydium AMM v4', what: 'AMM pool vault' },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: { tag: 'POOL', name: 'Raydium CPMM', what: 'AMM pool vault' },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { tag: 'POOL', name: 'Raydium CLMM', what: 'concentrated-liquidity pool vault' },
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: { tag: 'CURVE', name: 'Raydium LaunchLab', what: 'bonding-curve vault' },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: { tag: 'POOL', name: 'Orca Whirlpool', what: 'concentrated-liquidity pool vault' },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { tag: 'POOL', name: 'Meteora DLMM', what: 'DLMM pool reserve' },
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: { tag: 'POOL', name: 'Meteora DAMM v1', what: 'dynamic AMM pool' },
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: { tag: 'POOL', name: 'Meteora DAMM v2', what: 'dynamic AMM pool' },
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: { tag: 'CURVE', name: 'Meteora DBC', what: 'dynamic bonding-curve vault (Jupiter Studio / Meteora launches)' },
  '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi': { tag: 'VAULT', name: 'Meteora dynamic vault', what: 'vault backing Meteora pool liquidity' },
  vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2: { tag: 'VAULT', name: 'Meteora Alpha Vault', what: 'launch vault: tokens owed to its depositors' },
  [PUMP_PROGRAM_ID]: { tag: 'CURVE', name: 'pump.fun', what: 'bonding curve' },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { tag: 'POOL', name: 'PumpSwap', what: 'AMM pool vault' },
  strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m: { tag: 'LOCK', name: 'Streamflow', what: 'vesting / lock escrow' },
  LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn: { tag: 'LOCK', name: 'Jupiter Lock', what: 'vesting / lock escrow' },
};

/**
 * Constant program-derived authorities that own the vaults of EVERY pool of their program. They are PDAs with no
 * account of their own, so the owner-program lookup cannot see them; the tests re-derive each with
 * findProgramAddress(seed, program) so a typo can never ship.
 */
export const AUTHORITY_CLASS: Readonly<Record<string, ProgramEntry & { program: string; seed: string }>> = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': { tag: 'POOL', name: 'Raydium AMM v4', what: 'pool authority', program: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', seed: 'amm authority' },
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: { tag: 'POOL', name: 'Raydium CPMM', what: 'vault authority', program: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', seed: 'vault_and_lp_mint_auth_seed' },
  WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh: { tag: 'CURVE', name: 'Raydium LaunchLab', what: 'curve vault authority', program: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', seed: 'vault_auth_seed' },
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: { tag: 'CURVE', name: 'Meteora DBC', what: 'pool authority (holds every DBC curve vault: Jupiter Studio / Meteora launches)', program: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', seed: 'pool_authority' },
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: { tag: 'POOL', name: 'Meteora DAMM v2', what: 'pool authority', program: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', seed: 'pool_authority' },
};

export const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

export interface ClassifyInput {
  mint: string;
  owner: string;
  /** Token accounts this owner holds the mint in (the self-owned check reads them). */
  tokenAccounts: string[];
  /** The owner account's meta; undefined when the lookup did not run or failed. */
  meta: OwnerMeta | undefined;
  /** Seed-list exchange name ("Binance"), when the owner is on it. */
  cex: string | null;
  /** On-chain launch rules (from analyze()): D1 creator, P1 pool counterparty, linked cluster. */
  dev: string | null;
  poolRule: string | null;
  linked: string | null;
}

const short = (a: string | null | undefined): string => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—');

/** Whether `a` is a valid ed25519 point (a keypair can sign) — false for a PDA. Null for a malformed address. */
export function onCurve(a: string): boolean | null {
  try { const b = base58Decode(a); return b.length === 32 ? isOnCurve(b) : null; } catch { return null; }
}

const curveCache = new Map<string, string | null>();
function pumpCurveOf(mint: string): string | null {
  if (!curveCache.has(mint)) { let c: string | null = null; try { c = pumpBondingCurve(mint); } catch { c = null; } curveCache.set(mint, c); if (curveCache.size > 512) curveCache.delete(curveCache.keys().next().value!); }
  return curveCache.get(mint) ?? null;
}

function escrowOf(owner: string, e: ProgramEntry): HolderClass['lock'] {
  if (e.tag !== 'LOCK' && e.tag !== 'VAULT') return null;
  return { escrow: owner, program: e.name, unlock: null, authority: null, note: `unlock schedule not decoded: open escrow ${short(owner)} on ${e.name} to read it` };
}

/** Classify one top holder. Order: burn → derived authority → owner program → creator → linked → exchange → P1 → unlabelled. */
export function classifyHolder(x: ClassifyInput): HolderClass {
  const { owner, meta } = x;
  if (owner === INCINERATOR) return { tag: 'BURN', reason: 'owner is the incinerator address (1nc1nerator…): tokens sent there can never move', program: null, lock: null };
  if (owner === SYSTEM_PROGRAM) return { tag: 'BURN', reason: 'owner is the System Program address (1111…1111): no key can sign for it', program: null, lock: null };
  const auth = AUTHORITY_CLASS[owner];
  if (auth) return { tag: auth.tag, reason: `${auth.name} ${auth.what} (${short(owner)}, a PDA of the ${auth.name} program)`, program: auth.name, lock: null };
  if (owner === pumpCurveOf(x.mint)) return { tag: 'CURVE', reason: `pump.fun bonding curve of this mint (${short(owner)} = PDA "bonding-curve" + mint)`, program: 'pump.fun', lock: null };
  const prog = meta?.exists ? meta.programOwner : null;
  const pe = prog ? PROGRAM_CLASS[prog] : undefined;
  if (pe) return { tag: pe.tag, reason: `owner ${short(owner)} is an account of the ${pe.name} program: ${pe.what}`, program: pe.name, lock: escrowOf(owner, pe) };
  if (x.dev) return { tag: 'DEV', reason: x.dev, program: null, lock: null };
  if (x.linked) return { tag: 'LINKED', reason: x.linked, program: null, lock: null };
  if (x.cex) return { tag: 'CEX', reason: `exchange hot wallet: ${x.cex} (seed list, unverified by a second source)`, program: null, lock: null };
  if (x.poolRule) return { tag: 'POOL', reason: x.poolRule, program: null, lock: null };
  // ---- unlabelled: say what we know, never what it "probably" is
  if (!meta) return { tag: 'UNLABELLED', reason: 'owner kind not resolved (account lookup did not answer): treat as a person', program: null, lock: null };
  if (prog === TOKEN_PROGRAM || prog === TOKEN_2022_PROGRAM) {
    const self = x.tokenAccounts.includes(owner);
    return { tag: 'UNLABELLED', reason: `owner ${short(owner)} is ${self ? 'its own token account' : 'an SPL Token account'}: a program escrow, but the program that controls it is not identified, so it is counted`, program: null, lock: null };
  }
  if (meta.exists && prog !== SYSTEM_PROGRAM) return { tag: 'UNLABELLED', reason: `owner is an account of program ${short(prog)}, which is not in dexterm's program list: not a keypair wallet, but not a known pool or lock either, so it is counted`, program: null, lock: null };
  const curve = onCurve(owner);
  if (curve === false) return { tag: 'UNLABELLED', reason: `owner ${short(owner)} is a PDA (off-curve${meta.exists ? ', System-owned' : ', no account'}) of an unidentified program: counted`, program: null, lock: null };
  return { tag: 'UNLABELLED', reason: `plain wallet (${meta.exists ? 'System-owned' : 'no SOL account'}${curve ? ', a keypair address' : ''}): no pool, lock, exchange or launch rule matched`, program: null, lock: null };
}
