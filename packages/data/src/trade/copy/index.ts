// task-1360 — COPY TRADING (staged): wallet tracker + alerts (Tier 1), the one-key mirror PROPOSAL (Tier 2), the
// capped auto-mirror copy mandate (Tier 3). Personal, self-directed, non-custodial; paper/devnet only; nothing
// here signs, holds a key, or arms anything without the plan engine's own keypress gate.

export type { TradeSide, WalletTrade, FollowRecord, CopyAlert, MintLot, MintPosition, EarlyEntryInput, WalletStats } from './types.ts';
export { SOL_LEG_MIN_LAMPORTS, tokenDeltasForOwner, lamportsDeltaFor, decodeTx, decodeWalletTrades } from './trades.ts';
export type { DecodeOptions } from './trades.ts';
export { WIN_RATE_MIN_N, positionsOf, earlyEntryScore, walletStats, fmtHoldMs } from './stats.ts';
export type { StatsOptions } from './stats.ts';
export { FOLLOW_NAME_MAX, FOLLOWS_MAX, defaultFollowsPath, isWalletAddress, cleanFollowName, FollowStore, shortAddr } from './follows.ts';
export type { FollowResult } from './follows.ts';
export { WalletTracker, TRACKER_DEFAULTS } from './tracker.ts';
export { MIRROR_LIMITS, leaderFillPriceUsd, buildMirror, leaderSoldSince } from './mirror.ts';
export type { MirrorMarket, MirrorContext, MirrorCheck, MirrorRefuseReason, MirrorRefusal, MirrorOk, MirrorResult } from './mirror.ts';
export type { HistorySource, TrackerOptions, TrackerStatus } from './tracker.ts';
export { AUTO_HARD, AUTO_DEFAULTS, AUTO_TIER, AUTO_SIZE_FRACTION, AUTO_GESTURE, autoSizeCap, CopyAutoError, defaultCopyJournalPath, draftPolicy, CopyAuto } from './auto.ts';
export type { CopyPolicy, CopyPolicyInput, CopyAutoDeps, AutoOutcome, AutoStatus } from './auto.ts';
