// wallet-dossier pack, ASSEMBLE stage (AI-SUITE-DESIGN §2). "Who is this wallet?" grounded in what the
// merged, keyless code can actually prove: the wallet's role inside a scanned token's holder intelligence
// (@dexterm/data WalletIntel / IntelAnalysis) — its labels (each a rule id + confidence), cluster
// membership and kind, funder / self-funded, sniper / fresh-at-buy / created-before-launch, and holding
// share.
//
// HONEST SCOPE (design §2 + §14.4): cross-token PnL, win rate and the smart-money gate need the wallet
// tracker (task-1286 W6), which is NOT built. So the `SMART` verdict can never fire on keyless data; the
// assembled dossier records that in `availability.knownUnavailable` and the deterministic verdict is
// NEUTRAL / SUSPECT / INSUFFICIENT_DATA from the available signals. No number here comes from model
// memory; every fact is a field of the IntelAnalysis the tools returned.

import { createHash } from 'node:crypto';
import type { IntelAnalysis, IntelHolder, IntelCluster, LabelHit } from '@dexterm/data';
import { HIDDEN_LABELS } from '@dexterm/data';
import { stableStringify } from './token-dossier.ts';

export const WALLET_DOSSIER_PACK = 'wallet-dossier';
export const WALLET_DOSSIER_VERSION = '0.1.0';

export type WalletVerdict = 'SMART' | 'NEUTRAL' | 'SUSPECT' | 'INSUFFICIENT_DATA';

export interface WalletFeatures {
  in_token: boolean;
  holding_pct: number | null;
  owner_kind: string | null;
  cluster: string | null;
  cluster_kind: string | null;
  cluster_pct: number | null;
  self_funded: boolean | null;
  funder: string | null;
  funder_label: string | null;
  sniper: boolean;
  fresh_at_buy: boolean | null;
  created_before_launch: boolean | null;
  label_count: number;
}

export interface RestatedLabel { label: string; rule: string; confidence: string }

export interface AssembledWalletDossier {
  pack: typeof WALLET_DOSSIER_PACK;
  pack_version: string;
  status: 'OK' | 'NOT_IN_SCAN';
  wallet: string;
  token: string;
  assembled_at: string;
  input_hash: string;
  availability: { canVerdict: boolean; present: string[]; missing: string[]; knownUnavailable: string[] };
  features: WalletFeatures;
  flags: string[];
  labels_restated: RestatedLabel[];
  deterministic_verdict: WalletVerdict;
  injection_suspected: boolean;
  sections: { analysis_mint: string; holder: unknown; cluster: unknown };
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** The cross-token facts that need the wallet tracker (task-1286 W6), not available keyless. */
const KNOWN_UNAVAILABLE = [
  'PnL and realised/unrealised profit across tokens: needs the wallet tracker (task-1286 W6, not built)',
  'win rate and trade count (n>=10 gate): needs the wallet tracker',
  'smart-money gate (not exchange/MM, not self-funded, positive PnL over n>=10): not computable keyless, so SMART never fires',
];

/**
 * Assemble a wallet-dossier for `wallet` from one token's `IntelAnalysis` (WalletIntel.scan output).
 * The verdict is grounded only in that scan: a wallet not in the scanned token's holder sample is
 * NOT_IN_SCAN with INSUFFICIENT_DATA.
 */
export function assembleWalletDossier(wallet: string, analysis: IntelAnalysis, opts: { now?: number } = {}): AssembledWalletDossier {
  const now = opts.now ?? Date.now();
  const holder: IntelHolder | undefined = analysis.holders.find((h) => h.owner === wallet);
  const cluster: IntelCluster | undefined = analysis.clusters.find((c) => c.members.includes(wallet));
  const present: string[] = [];
  const missing: string[] = [];

  if (!holder) {
    return {
      pack: WALLET_DOSSIER_PACK, pack_version: WALLET_DOSSIER_VERSION, status: 'NOT_IN_SCAN',
      wallet, token: analysis.mint, assembled_at: new Date(now).toISOString(),
      input_hash: createHash('sha256').update(`${wallet}:${analysis.mint}:not-in-scan`).digest('hex').slice(0, 16),
      availability: { canVerdict: false, present: [], missing: ['wallet not in this token\'s top-holder sample'], knownUnavailable: KNOWN_UNAVAILABLE },
      features: emptyWalletFeatures(), flags: [], labels_restated: [], deterministic_verdict: 'INSUFFICIENT_DATA',
      injection_suspected: false, sections: { analysis_mint: analysis.mint, holder: null, cluster: null },
    };
  }

  present.push('holder-sample', 'labels');
  if (holder.funder) present.push('funder');
  if (cluster) present.push('cluster');
  if (holder.freshAtBuy === null) missing.push('fresh-at-buy: launch window needs a Helius key (keyless tier)');
  if (holder.funder === null) missing.push('funder: funding lookup needs a Helius key');

  // Self-funded = the funder is the wallet itself, or no distinct funder was found (design: self-funded
  // wallets are never SMART).
  const selfFunded = holder.funder ? holder.funder.address === wallet : null;
  const labels: LabelHit[] = holder.labels ?? [];
  const visibleLabels = labels.filter((l) => !HIDDEN_LABELS.has(l.label));
  const labelSet = new Set(visibleLabels.map((l) => l.label));

  const f: WalletFeatures = {
    in_token: true,
    holding_pct: num(holder.pct),
    owner_kind: holder.ownerKind ?? null,
    cluster: cluster?.name ?? null,
    cluster_kind: cluster?.kind ?? null,
    cluster_pct: cluster ? num(cluster.pct) : null,
    self_funded: selfFunded,
    funder: holder.funder?.address ?? null,
    funder_label: holder.funder?.label ?? null,
    sniper: labelSet.has('sniper'),
    fresh_at_buy: holder.freshAtBuy,
    created_before_launch: holder.createdBeforeLaunch,
    label_count: visibleLabels.length,
  };

  const flags: string[] = [];
  if (f.sniper) flags.push('sniper_window_buy');
  if (f.cluster_kind === 'bundle') flags.push('in_bundle_cluster');
  if (f.cluster_kind === 'dev-linked') flags.push('dev_linked_cluster');
  if (f.fresh_at_buy === true) flags.push('fresh_wallet_at_buy');
  if (f.owner_kind === 'program-owned') flags.push('program_owned_account');

  // SMART is unreachable keyless (no PnL). SUSPECT when a sniper / bundle / dev-linked / fresh signal
  // fired; NEUTRAL otherwise; an LP / CEX / contract address is INSUFFICIENT_DATA as a "trader".
  const infra = labelSet.has('LP') || labelSet.has('cex') || labelSet.has('contract') || labelSet.has('pool');
  const deterministic_verdict: WalletVerdict = infra ? 'INSUFFICIENT_DATA' : flags.length ? 'SUSPECT' : 'NEUTRAL';

  const labels_restated: RestatedLabel[] = visibleLabels.map((l) => ({ label: l.label, rule: l.rule, confidence: l.confidence }));
  const sections = { analysis_mint: analysis.mint, holder, cluster: cluster ?? null };
  return {
    pack: WALLET_DOSSIER_PACK, pack_version: WALLET_DOSSIER_VERSION, status: 'OK',
    wallet, token: analysis.mint, assembled_at: new Date(now).toISOString(),
    input_hash: createHash('sha256').update(stableStringify(sections)).digest('hex').slice(0, 16),
    availability: { canVerdict: true, present, missing, knownUnavailable: KNOWN_UNAVAILABLE },
    features: f, flags, labels_restated, deterministic_verdict, injection_suspected: false, sections,
  };
}

function emptyWalletFeatures(): WalletFeatures {
  return {
    in_token: false, holding_pct: null, owner_kind: null, cluster: null, cluster_kind: null, cluster_pct: null,
    self_funded: null, funder: null, funder_label: null, sniper: false, fresh_at_buy: null, created_before_launch: null, label_count: 0,
  };
}
