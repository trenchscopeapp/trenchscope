// trenchscope WALLET + HOLDER INTELLIGENCE — the rules (task-1340, built from the task-1286 spike).
//
// Pure functions: raw chain facts in, labelled holders + clusters + sample-captioned insights out. No I/O, no
// clock, no randomness, so a recording replays to the same picture and the tests can assert every rule.
// Ported from research/wallet-intel/prototype/wallet-intel-proto.mjs `analyze()`; the output shape is the one
// the approved bubble-map mocks were rendered from (research/wallet-intel/mock/out).
//
// Label policy (design §5, binding): a label is a RULE ID + EVIDENCE, never a judgement. Seed-list entries
// (the typed CEX hot wallets) carry confidence 'seed' and are always printed "unverified". Cabal-class labels
// (cabal-candidate / smart / bot / follower / call-group) are not produced here at all (W7 measures their
// precision first); `HIDDEN_LABELS` is the gate the UI applies if a future store supplies them.

import { SYSTEM_PROGRAM } from '../trade/tx-decode.ts';
import { PUMP_PROGRAM } from '../sources/pump-curve.ts';
import { pumpBondingCurve } from '../sources/pda.ts';
import { classifyHolder, EX_POOL_TAGS, BIG_HOLDER_PCT, type HolderClass, type HolderTag } from './holder-class.ts';

export type LabelConfidence = 'on-chain' | 'program-authority' | 'derived' | 'seed' | 'weak' | 'user';

export type IntelLabel =
  | 'LP' | 'cex' | 'contract' | 'unfunded-authority?' | 'pool' | 'dev' | 'sniper' | 'fresh-at-buy' | 'same-slot-created' | 'multi-token-top20'
  | 'cabal-candidate' | 'smart' | 'bot' | 'follower' | 'call-group';

/** Labels hidden by default until their precision is measured (design §5 item 5, design decision 2026-10-06). */
export const HIDDEN_LABELS: ReadonlySet<IntelLabel> = new Set<IntelLabel>(['cabal-candidate', 'smart', 'bot', 'follower', 'call-group']);

export interface LabelHit { label: IntelLabel; rule: string; confidence: LabelConfidence }

export interface KnownOwner { label: 'LP' | 'cex'; name: string; confidence: 'program-authority' | 'seed' }

/**
 * Program authorities that own every pool vault of their program (SPEC §3.6, same as solana-rpc KNOWN_OWNERS)
 * plus the SEED list of CEX hot wallets. The CEX entries are UNVERIFIED (GoPlus tagged none of them on 3/3
 * tokens in the spike): they are shown grey with "(seed list, unverified)" and never used as a rule INPUT
 * except as a veto (a shared CEX funder never links two wallets).
 */
export const INTEL_KNOWN_OWNERS: Readonly<Record<string, KnownOwner>> = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': { label: 'LP', name: 'Raydium AMM v4 authority', confidence: 'program-authority' },
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: { label: 'LP', name: 'Raydium CPMM authority', confidence: 'program-authority' },
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': { label: 'cex', name: 'Binance', confidence: 'seed' },
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': { label: 'cex', name: 'Binance', confidence: 'seed' },
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: { label: 'cex', name: 'Coinbase', confidence: 'seed' },
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm': { label: 'cex', name: 'Coinbase', confidence: 'seed' },
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: { label: 'cex', name: 'Bybit', confidence: 'seed' },
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD': { label: 'cex', name: 'OKX', confidence: 'seed' },
  FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5: { label: 'cex', name: 'Kraken', confidence: 'seed' },
  u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w: { label: 'cex', name: 'Gate.io', confidence: 'seed' },
  BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6: { label: 'cex', name: 'KuCoin', confidence: 'seed' },
  ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ: { label: 'cex', name: 'MEXC', confidence: 'seed' },
};

/** How a static-list hit is worded (binding: seed entries say "unverified"). */
export function knownOwnerRule(k: KnownOwner): string {
  return k.confidence === 'seed' ? `exchange hot wallet: ${k.name} (seed list, unverified by a second source)` : `static allow-list: ${k.name}`;
}

// ---------------------------------------------------------------- raw inputs (jsonParsed Helius / RPC shapes)

/** The subset of a jsonParsed transaction the rules read. Never stored raw (3–5 MB per 300 txs): events only. */
export interface RawTx {
  slot: number;
  blockTime?: number | null;
  transactionIndex?: number | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: Array<string | { pubkey: string; signer?: boolean }> } };
  meta?: {
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
  } | null;
}

export interface RawTokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }

export interface OwnerMeta {
  /** The program that owns the account (System = a wallet); null when the account does not exist. */
  programOwner: string | null;
  exists: boolean;
  lamports: number;
}

export interface IntelRaw {
  mint: string;
  /** Raw supply (base units) as a decimal string. */
  supply: string;
  decimals: number;
  /** Top token accounts, largest first (getTokenLargestAccounts). */
  largest: Array<{ address: string; amount: string }>;
  /** token account → owner (getMultipleAccounts over the token accounts). */
  owners: Record<string, string>;
  /** owner → account meta (getMultipleAccounts over the owners). Missing = unknown kind. */
  ownerMeta: Record<string, OwnerMeta>;
  /** wallet → its oldest ≤ 3 succeeded txs (getTransactionsForAddress asc). Only the wallets looked up. */
  funding: Record<string, RawTx[]>;
  /** The mint's oldest succeeded txs (launch window), oldest first. Empty without a Helius key. */
  launch: RawTx[];
  /** True when the launch window has more pages than fetched. */
  launchMore: boolean;
  /** Owners of other analysed tokens' top-20 in the local store → those tokens' symbols (X1 input). */
  crossToken?: Record<string, string[]>;
}

// ---------------------------------------------------------------- outputs (the mock's analysis.json shape)

export type OwnerKind = 'wallet' | 'program-owned' | 'no-sol-account' | 'unknown';

export interface FunderInfo { address: string; label: string | null; blockTime: number | null; sig: string | null }

export interface IntelHolder {
  owner: string;
  tokenAccounts: string[];
  amount: string;
  pct: number;
  ownerKind: OwnerKind;
  programOwner: string | null;
  labels: LabelHit[];
  funder: FunderInfo | null;
  walletFirstSeen: number | null;
  freshAtBuy: boolean | null;
  createdBeforeLaunch: boolean | null;
  /** task-1367: POOL / CURVE / VAULT / LOCK / CEX / BURN / DEV / LINKED / UNLABELLED with the reason. */
  cls?: HolderClass;
}

export type ClusterKind = 'dev-linked' | 'bundle' | 'transfer' | 'funder' | 'single';

export interface Evidence { a: string; b: string; rule: string; linked: boolean }

export interface IntelCluster {
  /** C1 = largest share. */
  name: string;
  kind: ClusterKind;
  members: string[];
  pct: number;
  labels: IntelLabel[];
  evidence: Evidence[];
}

export interface FundingResult {
  funder: string | null;
  lamports?: number;
  slot?: number;
  blockTime?: number | null;
  sig?: string | null;
  firstSlot: number | null;
  firstBlockTime: number | null;
  reason?: string;
}

export interface IntelInsights {
  supply: string;
  decimals: number;
  top10: {
    byTokenAccount: number; byOwner: number; clusterAdjusted: number; excludedLabels: string[]; excludedCount: number; note: string;
    /** task-1367: top-10 owners after dropping POOL / CURVE / VAULT / LOCK / BURN owners (the red flag reads this). */
    exPool: number;
    /** Share of supply held by the dropped owners, and how many there were. */
    exPoolDroppedPct: number; exPoolDropped: number;
  };
  /** task-1367: the largest owner above BIG_HOLDER_PCT that is NOT a pool/curve/vault/lock/burn (the main risk), or null. */
  bigHolder: { owner: string; pct: number; tag: HolderTag; reason: string } | null;
  coverage: {
    topHoldersFetched: number; supplyCoveredPct: number; fundingLookups: number; fundingCoveredPct: number;
    launchTxs: number; launchTxsWithMintBalanceChange: number; launchSlots: number; launchSlotSpan: number; launchMorePages: boolean;
  };
  snipers: { count: number; launchWindowSharePct: number; stillInTop: number; holdNowPctOfTopSample: number; definition: string; honest: string };
  bundle: { sameSlotCohorts: number; largestCohort: number; bundleClustersFound: number; bundlePctOfTopSample: number; definition: string; honest: string };
  dev: { creator: string | null; creatorPctNow: number | null; creatorUpperBoundPct: number | null; usesPumpProgram: boolean; definition: string };
  fresh: { freshAtBuyPctOfTopSample: number; measuredWallets: number; measuredPct: number; notMeasuredPct: number; definition: string; honest: string };
  launch: { firstSlot: number | null; firstBlockTime: number | null; firstBlockTimeIso: string | null; creator: string | null; pools: string[]; buyers: number; sameSlotCohorts: Array<{ slot: number; buyers: number }>; sameSlotCreatedPairs: number };
}

export interface BuyEvent { slot: number; txIndex: number | null; sig: string | null; owner: string; delta: string }

export interface IntelAnalysis {
  mint: string;
  holders: IntelHolder[];
  clusters: IntelCluster[];
  funding: Record<string, FundingResult>;
  insights: IntelInsights;
  buyEvents: BuyEvent[];
}

// ---------------------------------------------------------------- helpers

class UnionFind {
  private p = new Map<string, string>();
  private r = new Map<string, number>();
  add(x: string): void { if (!this.p.has(x)) { this.p.set(x, x); this.r.set(x, 0); } }
  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.p.get(root) !== root) root = this.p.get(root)!;
    while (this.p.get(x) !== root) { const n = this.p.get(x)!; this.p.set(x, root); x = n; }
    return root;
  }
  union(a: string, b: string): boolean {
    a = this.find(a); b = this.find(b);
    if (a === b) return false;
    const ra = this.r.get(a)!, rb = this.r.get(b)!;
    if (ra < rb) [a, b] = [b, a];
    this.p.set(b, a);
    if (ra === rb) this.r.set(a, ra + 1);
    return true;
  }
}

export function accountKeys(tx: RawTx): Array<{ pubkey: string; signer: boolean }> {
  return (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? { pubkey: k, signer: false } : { pubkey: k.pubkey, signer: !!k.signer }));
}

/** Σ(post − pre) of the mint per owner within one transaction (raw base units). */
export function tokenDeltasByOwner(tx: RawTx, mint: string): Map<string, bigint> {
  const pre = new Map<number, { owner: string | undefined; amt: bigint }>();
  const post = new Map<number, { owner: string | undefined; amt: bigint }>();
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint === mint) pre.set(b.accountIndex, { owner: b.owner, amt: BigInt(b.uiTokenAmount.amount) });
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint === mint) post.set(b.accountIndex, { owner: b.owner, amt: BigInt(b.uiTokenAmount.amount) });
  const byOwner = new Map<string, bigint>();
  for (const i of new Set([...pre.keys(), ...post.keys()])) {
    const owner = post.get(i)?.owner ?? pre.get(i)?.owner;
    if (!owner) continue;
    const d = (post.get(i)?.amt ?? 0n) - (pre.get(i)?.amt ?? 0n);
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + d);
  }
  return byOwner;
}

/**
 * Funding source of a wallet from its earliest transactions: the first tx where the wallet's SOL rose; the
 * funder is the SIGNER whose SOL fell the most in that tx (measured 2026-10-06: immutable per wallet, cache forever).
 */
export function funderOf(wallet: string, txs: RawTx[]): FundingResult {
  for (const tx of txs) {
    const keys = accountKeys(tx);
    const i = keys.findIndex((k) => k.pubkey === wallet);
    if (i < 0) continue;
    const pre = tx.meta?.preBalances ?? [], post = tx.meta?.postBalances ?? [];
    const delta = (post[i] ?? 0) - (pre[i] ?? 0);
    if (delta <= 0) continue;
    let best: string | null = null, bestDrop = 0;
    keys.forEach((k, j) => { const d = (post[j] ?? 0) - (pre[j] ?? 0); if (k.signer && d < bestDrop && k.pubkey !== wallet) { bestDrop = d; best = k.pubkey; } });
    if (!best) continue;
    return { funder: best, lamports: delta, slot: tx.slot, blockTime: tx.blockTime ?? null, sig: tx.transaction?.signatures?.[0] ?? null, firstSlot: txs[0]?.slot ?? null, firstBlockTime: txs[0]?.blockTime ?? null };
  }
  return { funder: null, firstSlot: txs[0]?.slot ?? null, firstBlockTime: txs[0]?.blockTime ?? null, reason: txs.length ? 'no SOL inflow in first 3 txs' : 'no history returned' };
}

const short = (a: string | null | undefined): string => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—');
const round = (n: number | null | undefined, d = 2): number => (n == null || Number.isNaN(n) ? 0 : Math.round(n * 10 ** d) / 10 ** d);
const uniq = <T>(a: T[]): T[] => [...new Set(a)];

// ---------------------------------------------------------------- the analysis

/** Run every rule over the raw facts. Deterministic; ~1 ms for 20 holders + 300 txs. */
export function analyze(raw: IntelRaw): IntelAnalysis {
  const { mint } = raw;
  const supplyRaw = BigInt(raw.supply || '0');
  const supply = Number(supplyRaw);

  // ---- holders: token accounts → owners → kinds → static labels
  const ownerKind = new Map<string, { kind: OwnerKind; programOwner: string | null }>();
  for (const [o, m] of Object.entries(raw.ownerMeta)) {
    let kind: OwnerKind = 'wallet';
    if (!m.exists) kind = 'no-sol-account';
    else if (m.programOwner !== SYSTEM_PROGRAM) kind = 'program-owned';
    ownerKind.set(o, { kind, programOwner: m.programOwner });
  }
  const holdersByOwner = new Map<string, { owner: string; tokenAccounts: string[]; amount: bigint }>();
  for (const a of raw.largest) {
    const owner = raw.owners[a.address] ?? null;
    const key = owner ?? a.address;
    const h = holdersByOwner.get(key) ?? { owner: key, tokenAccounts: [], amount: 0n };
    h.tokenAccounts.push(a.address);
    h.amount += BigInt(a.amount);
    holdersByOwner.set(key, h);
  }
  const sorted = [...holdersByOwner.values()].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  const holders: IntelHolder[] = sorted.map((h) => {
    const k = ownerKind.get(h.owner) ?? { kind: 'unknown' as OwnerKind, programOwner: null };
    const labels: LabelHit[] = [];
    const known = INTEL_KNOWN_OWNERS[h.owner];
    if (known) labels.push({ label: known.label, rule: knownOwnerRule(known), confidence: known.confidence });
    else if (k.kind === 'program-owned') labels.push({ label: 'contract', rule: `token account owner is program-owned (owner program ${short(k.programOwner)}): pool vault / escrow / staking, not a person`, confidence: 'on-chain' });
    else if (k.kind === 'no-sol-account') labels.push({ label: 'unfunded-authority?', rule: 'owner has no SOL account: typically a PDA authority (pool / vault); could be a wallet that never held SOL', confidence: 'weak' });
    return {
      owner: h.owner, tokenAccounts: h.tokenAccounts, amount: h.amount.toString(),
      pct: supply > 0 ? Number(h.amount) / supply * 100 : 0,
      ownerKind: k.kind, programOwner: k.programOwner, labels, funder: null, walletFirstSeen: null, freshAtBuy: null, createdBeforeLaunch: null,
      cls: { tag: 'UNLABELLED', reason: '', program: null, lock: null } as HolderClass, // set after the launch rules
    };
  });
  const holderSet = new Set(holders.map((h) => h.owner));
  const pctOf = (owner: string): number => holders.find((h) => h.owner === owner)?.pct ?? 0;

  // ---- funding sources
  const funding: Record<string, FundingResult> = {};
  for (const [w, txs] of Object.entries(raw.funding)) funding[w] = funderOf(w, txs);

  // ---- launch window
  const launch = raw.launch;
  const firstSlot = launch.length ? launch[0].slot : null;
  const firstBlockTime = launch.length ? launch[0].blockTime ?? null : null;
  const creator = launch.length ? accountKeys(launch[0]).find((k) => k.signer)?.pubkey ?? null : null;
  const usesPump = launch.some((tx) => accountKeys(tx).some((k) => k.pubkey === PUMP_PROGRAM));
  // P1 pool: the owner that is the SELLING counterparty in ≥ 25 % of launch txs (n ≥ 8) is the venue, never a holder.
  // It must run before S1 or the pump.fun curve becomes "the biggest sniper" (happened in the spike).
  const sellerCount = new Map<string, number>();
  let txWithMintDeltas = 0;
  const deltasPerTx = launch.map((tx) => {
    const d = tokenDeltasByOwner(tx, mint);
    if (d.size) txWithMintDeltas += 1;
    for (const [o, v] of d) if (v < 0n) sellerCount.set(o, (sellerCount.get(o) ?? 0) + 1);
    return d;
  });
  const pools = new Set([...sellerCount].filter(([, n]) => txWithMintDeltas >= 8 && n >= txWithMintDeltas * 0.25).map(([o]) => o));
  // A pump.fun coin's own bonding-curve account is the venue by definition: exclude it by address, so a thin
  // coin (fewer than 8 launch txs, where the heuristic above cannot fire) never shows the curve as a sniper.
  if (usesPump) { try { pools.add(pumpBondingCurve(mint)); } catch { /* not a valid mint: nothing to exclude */ } }
  const buyEvents: Array<{ slot: number; txIndex: number | null; sig: string | null; owner: string; delta: bigint }> = [];
  launch.forEach((tx, k) => {
    for (const [owner, delta] of deltasPerTx[k]) if (delta > 0n && !pools.has(owner)) buyEvents.push({ slot: tx.slot, txIndex: tx.transactionIndex ?? null, sig: tx.transaction?.signatures?.[0] ?? null, owner, delta });
  });
  const slots = uniq(launch.map((t) => t.slot)).sort((a, b) => a - b);
  // S1 sniper window: the first 3 slots after the first POOL trade (not the first mint tx: WIF/POPCAT's first
  // txs are mint/LP setup with zero buyers). For pump.fun the create tx is the first trade, so both coincide.
  const firstPoolTrade = buyEvents.length ? Math.min(...buyEvents.map((e) => e.slot)) : null;
  const sniperSlotMax = firstPoolTrade != null ? firstPoolTrade + 2 : null;
  const sniperSet = new Map<string, bigint>();
  for (const e of buyEvents) if (sniperSlotMax != null && e.slot <= sniperSlotMax && e.owner !== creator) sniperSet.set(e.owner, (sniperSet.get(e.owner) ?? 0n) + e.delta);
  const bySlot = new Map<number, Set<string>>();
  for (const e of buyEvents) { const s = bySlot.get(e.slot) ?? new Set<string>(); s.add(e.owner); bySlot.set(e.slot, s); }
  const sameSlotCohorts = [...bySlot.entries()].filter(([, s]) => s.size >= 2).map(([slot, s]) => ({ slot, buyers: [...s] })).sort((a, b) => a.slot - b.slot);

  // ---- clustering: union-find over holders + funders + creator
  const uf = new UnionFind();
  const evidence: Evidence[] = [];
  const funderIndex = new Map<string, string[]>();
  for (const [w, f] of Object.entries(funding)) if (f.funder) { const arr = funderIndex.get(f.funder) ?? []; arr.push(w); funderIndex.set(f.funder, arr); }
  const isCex = (addr: string | null | undefined): boolean => !!addr && INTEL_KNOWN_OWNERS[addr]?.label === 'cex';
  // R1b: the funder is itself a top holder → one entity, two wallets
  for (const [funder, ws] of funderIndex) if (holderSet.has(funder) && !isCex(funder)) for (const w of ws) { uf.union(funder, w); evidence.push({ a: funder, b: w, rule: `funded by top holder ${short(funder)} (R1b funder-is-holder)`, linked: true }); }
  // R1: shared funding source; a CEX funder is a VETO (withdrawals from one exchange are independent people)
  for (const [funder, ws] of funderIndex) {
    if (ws.length < 2) continue;
    if (isCex(funder)) { evidence.push({ a: ws[0], b: ws[1], rule: `shared funder ${short(funder)} is an exchange hot wallet (seed list, unverified): NOT linked (withdrawals from one exchange are independent people)`, linked: false }); continue; }
    const rule = `shared funding source ${short(funder)} (R1 funder)`;
    for (let i = 1; i < ws.length; i++) { uf.union(ws[0], ws[i]); evidence.push({ a: ws[0], b: ws[i], rule, linked: true }); }
  }
  // R2 bundle: same-slot buys AND a shared funder (same-slot alone is a cohort, never a bundle: 55–146 cohorts per 300 txs)
  for (const c of sameSlotCohorts) {
    // every pair in the cohort (the spike only compared against the first buyer and missed bundles behind a sniper)
    for (let i = 0; i < c.buyers.length; i++) for (let j = i + 1; j < c.buyers.length; j++) {
      const a = c.buyers[i], b = c.buyers[j];
      const fa = funding[a]?.funder, fb = funding[b]?.funder;
      if (fa && fb && fa === fb && !isCex(fa)) { uf.union(a, b); evidence.push({ a, b, rule: `same-slot buy (slot ${c.slot}) AND shared funder ${short(fa)} (R2 bundle)`, linked: true }); }
    }
  }
  // R4 dev-linked: funded by the creator wallet
  if (creator) for (const [w, f] of Object.entries(funding)) if (f.funder === creator) { uf.union(creator, w); evidence.push({ a: creator, b: w, rule: `funded by the creator wallet ${short(creator)} (R4 dev-linked)`, linked: true }); }
  // R5 same-slot creation: weak, never links alone; surfaced as a label so the user can judge
  const byFirstSlot = new Map<number, string[]>();
  for (const [w, f] of Object.entries(funding)) if (f.firstSlot != null) { const a = byFirstSlot.get(f.firstSlot) ?? []; a.push(w); byFirstSlot.set(f.firstSlot, a); }
  const sameSlotCreated = new Map<string, { slot: number; with: string[] }>();
  for (const [slot, ws] of byFirstSlot) if (ws.length >= 2) { for (const w of ws) sameSlotCreated.set(w, { slot, with: ws.filter((x) => x !== w) }); evidence.push({ a: ws[0], b: ws[1], rule: `wallets first seen in the same slot ${slot} (R5 same-slot creation, weak: not linked alone)`, linked: false }); }
  // R3 transfer: a direct token move between two top holders inside the launch window (one sender, ≤ 2 receivers,
  // no swap). A pool / curve (P1) is never a party: on a fresh launch the curve is still a top holder and every
  // buy is "curve → buyer", which is a swap, not a transfer.
  for (const tx of launch) {
    const d = tokenDeltasByOwner(tx, mint);
    if ([...d.keys()].some((o) => pools.has(o))) continue;
    const senders = [...d].filter(([o, v]) => v < 0n && holderSet.has(o)).map(([o]) => o);
    const receivers = [...d].filter(([o, v]) => v > 0n && holderSet.has(o)).map(([o]) => o);
    if (senders.length === 1 && receivers.length >= 1 && receivers.length <= 2 && d.size <= 3) for (const r of receivers) { uf.union(senders[0], r); evidence.push({ a: senders[0], b: r, rule: `direct token transfer in ${short(tx.transaction?.signatures?.[0] ?? '')} (R3 transfer)`, linked: true }); }
  }

  const clusters = new Map<string, { members: string[]; pct: number; labels: Set<IntelLabel>; evidence: Evidence[] }>();
  for (const h of holders) {
    const root = uf.find(h.owner);
    const c = clusters.get(root) ?? { members: [], pct: 0, labels: new Set<IntelLabel>(), evidence: [] };
    c.members.push(h.owner); c.pct += h.pct;
    clusters.set(root, c);
  }
  for (const e of evidence) if (e.linked) { const c = clusters.get(uf.find(e.a)); if (c) c.evidence.push(e); }

  // ---- per-holder derived labels (after the launch rules so the cluster labels see them)
  for (const h of holders) {
    const f = funding[h.owner];
    const firstTxs = raw.funding[h.owner] ?? null;
    if (f?.funder) h.funder = { address: f.funder, label: INTEL_KNOWN_OWNERS[f.funder] ? `${INTEL_KNOWN_OWNERS[f.funder].name}${INTEL_KNOWN_OWNERS[f.funder].confidence === 'seed' ? ' (seed, unverified)' : ''}` : null, blockTime: f.blockTime ?? null, sig: f.sig ?? null };
    if (f?.firstBlockTime) h.walletFirstSeen = f.firstBlockTime;
    if (pools.has(h.owner)) h.labels.push({ label: 'pool', rule: `selling counterparty in ${sellerCount.get(h.owner)} of ${txWithMintDeltas} launch-window txs: bonding curve / AMM vault (P1 pool)`, confidence: 'on-chain' });
    if (sniperSet.has(h.owner)) h.labels.push({ label: 'sniper', rule: `bought in the first 3 slots after the first pool trade (slot ≤ ${sniperSlotMax}) (S1 sniper)`, confidence: 'on-chain' });
    if (creator && h.owner === creator) h.labels.push({ label: 'dev', rule: `fee payer of the first transaction referencing the mint (${short(launch[0]?.transaction?.signatures?.[0] ?? '')}) (D1 creator)`, confidence: 'on-chain' });
    if (firstTxs) {
      const includesMint = firstTxs.some((tx) => (tx.meta?.postTokenBalances ?? []).some((b) => b.mint === mint));
      h.freshAtBuy = includesMint;
      if (includesMint) h.labels.push({ label: 'fresh-at-buy', rule: `wallet's first ${firstTxs.length} transactions already include this token: created to hold it (F1 fresh)`, confidence: 'on-chain' });
      if (f?.firstBlockTime && firstBlockTime) h.createdBeforeLaunch = f.firstBlockTime < firstBlockTime;
    }
    const ssc = sameSlotCreated.get(h.owner);
    if (ssc) h.labels.push({ label: 'same-slot-created', rule: `first seen in slot ${ssc.slot}, same slot as ${ssc.with.map(short).join(', ')} (R5, weak)`, confidence: 'weak' });
    const cross = raw.crossToken?.[h.owner];
    if (cross && cross.length >= 2) h.labels.push({ label: 'multi-token-top20', rule: `inside the top-20 of ${cross.length} analysed tokens (${cross.join(', ')}): exchange / market maker / fund pattern, not launch coordination (X1)`, confidence: 'derived' });
  }
  for (const h of holders) { const c = clusters.get(uf.find(h.owner)); if (c) for (const l of h.labels) c.labels.add(l.label); }
  // task-1367: one class per holder from the owner facts + the launch rules above (never a guess)
  for (const h of holders) {
    const c = clusters.get(uf.find(h.owner));
    const link = c && c.members.length > 1 ? c.evidence.find((e) => e.linked && (e.a === h.owner || e.b === h.owner)) ?? c.evidence.find((e) => e.linked) : undefined;
    const known = INTEL_KNOWN_OWNERS[h.owner];
    h.cls = classifyHolder({
      mint, owner: h.owner, tokenAccounts: h.tokenAccounts, meta: raw.ownerMeta[h.owner],
      cex: known?.label === 'cex' ? known.name : null,
      dev: h.labels.find((l) => l.label === 'dev')?.rule ?? null,
      poolRule: h.labels.find((l) => l.label === 'pool')?.rule ?? null,
      linked: link ? `linked to ${c!.members.length - 1} other top holder${c!.members.length > 2 ? 's' : ''}: ${link.rule}` : null,
    });
  }

  const clusterList: IntelCluster[] = [...clusters.values()]
    .map((c) => ({
      members: c.members, pct: c.pct, evidence: c.evidence, labels: [...c.labels],
      kind: (c.members.length > 1
        ? (c.evidence.some((e) => /\(R4 /.test(e.rule)) ? 'dev-linked' : c.evidence.some((e) => /\(R2 /.test(e.rule)) ? 'bundle' : c.evidence.some((e) => /\(R3 /.test(e.rule)) ? 'transfer' : 'funder')
        : 'single') as ClusterKind,
    }))
    .sort((a, b) => b.pct - a.pct)
    .map((c, i) => ({ ...c, name: `C${i + 1}`, pct: round(c.pct) }));

  // ---- insights with coverage (every number is sample-bounded and says so)
  const topByAccount = raw.largest.slice(0, 10).reduce((s, a) => s + (supply > 0 ? Number(BigInt(a.amount)) / supply * 100 : 0), 0);
  const topByOwner = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const excluded = new Set<IntelLabel>(['LP', 'cex', 'contract', 'pool']);
  const adjustable = holders.filter((h) => !h.labels.some((l) => excluded.has(l.label)));
  const topClusterAdjusted = clusterList.filter((c) => !c.labels.some((l) => excluded.has(l))).slice(0, 10).reduce((s, c) => s + c.pct, 0);
  const coveredPct = holders.reduce((s, h) => s + h.pct, 0);
  const fundedCoverPct = Object.keys(funding).reduce((s, w) => s + pctOf(w), 0);
  const sniperHoldNow = holders.filter((h) => sniperSet.has(h.owner)).reduce((s, h) => s + h.pct, 0);
  const sniperLaunchShare = supply > 0 ? [...sniperSet.values()].reduce((s, v) => s + Number(v), 0) / supply * 100 : 0;
  const devNow = creator ? holders.find((h) => h.owner === creator)?.pct ?? null : null;
  const smallestTop = holders.length ? holders[holders.length - 1].pct : null;
  const freshPct = holders.filter((h) => h.freshAtBuy === true).reduce((s, h) => s + h.pct, 0);
  const freshMeasured = holders.filter((h) => h.freshAtBuy != null);
  const freshMeasuredPct = freshMeasured.reduce((s, h) => s + h.pct, 0);
  const bundleClusters = clusterList.filter((c) => c.kind === 'bundle');
  const people = holders.filter((h) => !EX_POOL_TAGS.has(h.cls!.tag));
  const exPool = people.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const dropped = holders.filter((h) => EX_POOL_TAGS.has(h.cls!.tag));
  const big = people.find((h) => h.pct > BIG_HOLDER_PCT) ?? null;

  const insights: IntelInsights = {
    supply: supplyRaw.toString(), decimals: raw.decimals,
    top10: {
      byTokenAccount: round(topByAccount), byOwner: round(topByOwner), clusterAdjusted: round(topClusterAdjusted),
      excludedLabels: [...excluded], excludedCount: holders.length - adjustable.length,
      note: 'byTokenAccount = what explorers show; byOwner merges token accounts of one owner; clusterAdjusted merges linked owners and drops LP vaults, program-owned accounts and seed-list CEX wallets; exPool = top-10 owners without POOL/CURVE/VAULT/LOCK/BURN owners',
      exPool: round(exPool), exPoolDroppedPct: round(dropped.reduce((s, h) => s + h.pct, 0)), exPoolDropped: dropped.length,
    },
    bigHolder: big ? { owner: big.owner, pct: round(big.pct), tag: big.cls!.tag, reason: big.cls!.reason } : null,
    coverage: {
      topHoldersFetched: holders.length, supplyCoveredPct: round(coveredPct), fundingLookups: Object.keys(funding).length, fundingCoveredPct: round(fundedCoverPct),
      launchTxs: launch.length, launchTxsWithMintBalanceChange: txWithMintDeltas, launchSlots: slots.length, launchSlotSpan: slots.length ? slots[slots.length - 1] - slots[0] : 0, launchMorePages: raw.launchMore,
    },
    snipers: { count: sniperSet.size, launchWindowSharePct: round(sniperLaunchShare), stillInTop: holders.filter((h) => sniperSet.has(h.owner)).length, holdNowPctOfTopSample: round(sniperHoldNow), definition: 'distinct owners whose balance rose in the first 3 slots after the first pool trade, creator and pools excluded (S1)', honest: 'holdNow is only known for snipers inside the fetched top sample' },
    bundle: { sameSlotCohorts: sameSlotCohorts.length, largestCohort: sameSlotCohorts.reduce((m, c) => Math.max(m, c.buyers.length), 0), bundleClustersFound: bundleClusters.length, bundlePctOfTopSample: round(bundleClusters.reduce((s, c) => s + c.pct, 0)), definition: 'same-slot buyers that ALSO share a funding source (R2); same-slot alone is a cohort, not a bundle', honest: 'funder lookups ran for the top wallets only; cohorts outside the sample are unresolved' },
    dev: { creator, creatorPctNow: devNow == null ? null : round(devNow), creatorUpperBoundPct: devNow == null && creator && smallestTop != null ? round(smallestTop) : null, usesPumpProgram: usesPump, definition: 'creator = fee payer of the first succeeded tx referencing the mint; dev % = creator share now' },
    fresh: { freshAtBuyPctOfTopSample: round(freshPct), measuredWallets: freshMeasured.length, measuredPct: round(freshMeasuredPct), notMeasuredPct: round(coveredPct - freshMeasuredPct), definition: "fresh-at-buy = the wallet's first transactions already move this token (created to hold it); one history call per wallet", honest: 'only measured for the funded sample' },
    launch: { firstSlot, firstBlockTime, firstBlockTimeIso: firstBlockTime ? new Date(firstBlockTime * 1000).toISOString() : null, creator, pools: [...pools], buyers: uniq(buyEvents.map((e) => e.owner)).length, sameSlotCohorts: sameSlotCohorts.slice(0, 10).map((c) => ({ slot: c.slot, buyers: c.buyers.length })), sameSlotCreatedPairs: [...byFirstSlot.values()].filter((ws) => ws.length >= 2).length },
  };

  return {
    mint,
    holders: holders.map((h) => ({ ...h, pct: round(h.pct) })),
    clusters: clusterList,
    funding: Object.fromEntries(Object.entries(funding).map(([w, f]) => [w, { ...f }])),
    insights,
    buyEvents: buyEvents.slice(0, 500).map((e) => ({ ...e, delta: e.delta.toString() })),
  };
}

/** Drop labels the policy hides by default (cabal-class) unless the user opted in. */
export function visibleLabels(labels: LabelHit[], showHidden = false): LabelHit[] {
  return showHidden ? labels : labels.filter((l) => !HIDDEN_LABELS.has(l.label));
}
