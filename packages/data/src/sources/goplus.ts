// GoPlus Solana token-security adapter (task-1298; inventory 2026-10-06 §1d). Keyless, read-only.
//   GET https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses={mint}
//     -> { code: 1, message: "ok", result: { [mint]: {
//            mintable | freezable | closable | balance_mutable_authority | metadata_mutable |
//            transfer_fee_upgradable | transfer_hook_upgradable | default_account_state_upgradable:
//              { status: "0"|"1", authority: [{ address, malicious_address }] | ... },
//            non_transferable: "0"|"1", default_account_state: "0"|"1", transfer_hook: [...], transfer_fee: {...},
//            holder_count, total_supply, holders: [{ account, token_account, balance, percent, is_locked, tag }],
//            lp_holders: [...], dex: [{ dex_name, id, tvl, lp_amount, price, type, ... }],
//            creators: [{ address, malicious_address }], metadata: { name, symbol, uri, description }, trusted_token } } }
// Docs: https://docs.gopluslabs.io/reference/solanatokensecurityusingget (fetched for task-1285).
// A second opinion next to RugCheck: authorities, Token-2022 hooks/fees, LP holders. `code !== 1`
// is a failure. All free-text fields (names, tags, descriptions) are untrusted (CL-06).

import type { BodyCheck, HttpClient } from '../http.ts';
import type { Audit, Holder } from '../model.ts';
import { numOrNull } from '../util.ts';

export const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';
const META = { source: 'goplus', bucket: 'goplus' } as const;

interface RawAuthority {
  status?: string | number;
  authority?: { address?: string; malicious_address?: number | string }[] | string[] | null;
}

interface RawHolder {
  account?: string;
  token_account?: string;
  balance?: string | number;
  percent?: string | number;
  is_locked?: number | string;
  tag?: string;
}

interface RawDex {
  dex_name?: string;
  id?: string;
  tvl?: string | number;
  lp_amount?: string | number;
  price?: string | number;
  type?: string;
  open_time?: string | number;
}

export interface GoPlusRaw {
  mintable?: RawAuthority;
  freezable?: RawAuthority;
  closable?: RawAuthority;
  balance_mutable_authority?: RawAuthority;
  metadata_mutable?: RawAuthority & { metadata_upgrade_authority?: unknown[] };
  transfer_fee_upgradable?: RawAuthority;
  transfer_hook_upgradable?: RawAuthority;
  default_account_state_upgradable?: RawAuthority;
  non_transferable?: string | number;
  default_account_state?: string | number;
  transfer_hook?: unknown[] | null;
  transfer_fee?: Record<string, unknown> | null;
  holder_count?: string | number;
  total_supply?: string | number;
  holders?: RawHolder[] | null;
  lp_holders?: RawHolder[] | null;
  dex?: RawDex[] | null;
  creators?: { address?: string; malicious_address?: number | string }[] | null;
  metadata?: { name?: string; symbol?: string; uri?: string; description?: string } | null;
  trusted_token?: number | string;
}

export interface GoPlusResponse {
  code?: number;
  message?: string;
  result?: Record<string, GoPlusRaw | null | undefined> | null;
}

export interface GoPlusHolder extends Holder {
  tokenAccount: string | null;
  isLocked: boolean | null;
  /** GoPlus tag text (untrusted; usually empty for memecoins). */
  tag: string | null;
}

export interface GoPlusDex {
  name: string;
  pool: string | null;
  tvlUsd: number | null;
  lpAmount: number | null;
  type: string | null;
}

export interface GoPlusSecurity {
  /** Advertised on-chain metadata URI; untrusted, never fetched by this adapter. */
  metadataUri?: string | null;
  mint: string;
  /** true = enabled (bad), false = disabled, null = GoPlus did not say. */
  mintable: boolean | null;
  freezable: boolean | null;
  closable: boolean | null;
  balanceMutable: boolean | null;
  metadataMutable: boolean | null;
  transferFeeUpgradable: boolean | null;
  transferHookUpgradable: boolean | null;
  defaultAccountStateUpgradable: boolean | null;
  nonTransferable: boolean | null;
  /** true when any transfer hook program is set. */
  transferHook: boolean | null;
  transferFee: boolean | null;
  /** Raw default account state ("1" = initialized, "2" = frozen) as GoPlus reports it. */
  defaultAccountState: string | null;
  holderCount: number | null;
  totalSupply: number | null;
  /** Largest first, percent of supply (0..100). */
  holders: GoPlusHolder[];
  lpHolders: GoPlusHolder[];
  dex: GoPlusDex[];
  creators: string[];
  /** Any creator or authority GoPlus flags as malicious. */
  maliciousAddresses: string[];
  trustedToken: boolean | null;
  /** Names GoPlus flags on (enabled authorities, hooks, fees), e.g. `goplus:mintable`. */
  flags: string[];
  source: 'goplus';
  fetchedAt: number;
}

function flag(v: unknown): boolean | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return null;
}

function authorityFlag(a: RawAuthority | undefined | null): boolean | null {
  if (!a) return null;
  const st = flag(a.status);
  if (st !== null) return st;
  return Array.isArray(a.authority) ? a.authority.length > 0 : null;
}

/** GoPlus percentages are fractions on EVM ("0.0123"); accept both fraction and percent forms. */
export function toPercent(v: unknown, total: number | null = null, balance: unknown = null): number {
  const p = numOrNull(v);
  if (p !== null) return p <= 1 ? p * 100 : p;
  const b = numOrNull(balance);
  if (b !== null && total && total > 0) return (b / total) * 100;
  return 0;
}

function holder(h: RawHolder, total: number | null): GoPlusHolder {
  const locked = flag(h.is_locked);
  return {
    address: h.account ?? h.token_account ?? '',
    tokenAccount: h.token_account ?? null,
    pct: Math.round(toPercent(h.percent, total, h.balance) * 1000) / 1000,
    amount: numOrNull(h.balance) ?? 0,
    isLocked: locked,
    tag: typeof h.tag === 'string' && h.tag !== '' ? h.tag : null,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function normalizeGoPlus(mint: string, raw: GoPlusRaw, fetchedAt: number): GoPlusSecurity {
  const total = numOrNull(raw.total_supply);
  const malicious = new Set<string>();
  const addrs = (a: RawAuthority | undefined | null) => {
    for (const x of (a?.authority ?? []) as ({ address?: string; malicious_address?: unknown } | string)[]) {
      if (typeof x === 'object' && x && x.address && flag(x.malicious_address) === true) malicious.add(x.address);
    }
  };
  for (const a of [raw.mintable, raw.freezable, raw.closable, raw.balance_mutable_authority, raw.metadata_mutable, raw.transfer_fee_upgradable, raw.transfer_hook_upgradable, raw.default_account_state_upgradable]) addrs(a);
  const creators: string[] = [];
  for (const c of raw.creators ?? []) {
    if (c?.address) {
      creators.push(c.address);
      if (flag(c.malicious_address) === true) malicious.add(c.address);
    }
  }
  const sec: GoPlusSecurity = {
    mint,
    mintable: authorityFlag(raw.mintable),
    freezable: authorityFlag(raw.freezable),
    closable: authorityFlag(raw.closable),
    balanceMutable: authorityFlag(raw.balance_mutable_authority),
    metadataMutable: authorityFlag(raw.metadata_mutable),
    transferFeeUpgradable: authorityFlag(raw.transfer_fee_upgradable),
    transferHookUpgradable: authorityFlag(raw.transfer_hook_upgradable),
    defaultAccountStateUpgradable: authorityFlag(raw.default_account_state_upgradable),
    nonTransferable: flag(raw.non_transferable),
    transferHook: raw.transfer_hook === undefined ? null : Array.isArray(raw.transfer_hook) && raw.transfer_hook.length > 0,
    transferFee: raw.transfer_fee === undefined ? null : !!raw.transfer_fee && Object.keys(raw.transfer_fee).length > 0,
    defaultAccountState: raw.default_account_state === undefined || raw.default_account_state === null ? null : String(raw.default_account_state),
    holderCount: numOrNull(raw.holder_count),
    totalSupply: total,
    holders: (raw.holders ?? []).filter((h) => h && (h.account || h.token_account)).map((h) => holder(h, total)).sort((a, b) => b.pct - a.pct),
    lpHolders: (raw.lp_holders ?? []).filter((h) => h && (h.account || h.token_account)).map((h) => holder(h, total)).sort((a, b) => b.pct - a.pct),
    dex: (raw.dex ?? []).filter((d) => d && (d.dex_name || d.id)).map((d) => ({ name: str(d.dex_name) ?? 'unknown', pool: str(d.id), tvlUsd: numOrNull(d.tvl), lpAmount: numOrNull(d.lp_amount), type: str(d.type) })),
    creators,
    maliciousAddresses: [...malicious],
    trustedToken: flag(raw.trusted_token),
    flags: [],
    source: 'goplus',
    metadataUri: typeof raw.metadata?.uri === 'string' ? raw.metadata.uri : null,
    fetchedAt,
  };
  const flags: string[] = [];
  if (sec.mintable) flags.push('goplus:mintable');
  if (sec.freezable) flags.push('goplus:freezable');
  if (sec.closable) flags.push('goplus:closable');
  if (sec.balanceMutable) flags.push('goplus:balance-mutable');
  if (sec.nonTransferable) flags.push('goplus:non-transferable');
  if (sec.transferHook) flags.push('goplus:transfer-hook');
  if (sec.transferFee) flags.push('goplus:transfer-fee');
  if (sec.defaultAccountState === '2') flags.push('goplus:default-frozen');
  if (sec.maliciousAddresses.length) flags.push('goplus:malicious-address');
  sec.flags = flags;
  return sec;
}

/** The Audit fields GoPlus can speak to (authorities, top-10 by token account, risk names). */
export function auditPatchFromGoPlus(s: GoPlusSecurity): Pick<Audit, 'mintAuthority' | 'freezeAuthority' | 'top10Pct' | 'rugRisks'> {
  const top10 = s.holders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);
  return {
    mintAuthority: s.mintable,
    freezeAuthority: s.freezable,
    top10Pct: s.holders.length ? Math.round(top10 * 1000) / 1000 : null,
    rugRisks: s.flags,
  };
}

/** `code !== 1` is an API-level failure even with HTTP 200; code 4029 is GoPlus's rate limit. */
export const goplusBodyCheck: BodyCheck = (data) => {
  const r = data as GoPlusResponse | null;
  if (!r || typeof r !== 'object') return { error: 'goplus: empty body' };
  if (r.code === 1) return null;
  const msg = `goplus code ${r.code ?? '?'}: ${r.message ?? 'unknown'}`;
  return r.code === 4029 || /rate|limit|too many/i.test(r.message ?? '') ? { status: 429, error: msg } : { error: msg };
};

export class GoPlus {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  static url(mint: string): string {
    return `${GOPLUS_BASE}/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`;
  }

  async tokenSecurity(mint: string): Promise<GoPlusSecurity> {
    const r = await this.http.getJson<GoPlusResponse>(GoPlus.url(mint), META, goplusBodyCheck);
    const result = r.data.result ?? {};
    const raw = result[mint] ?? Object.values(result).find((v) => v) ?? null;
    if (!raw) throw new Error(`goplus: no result for ${mint}`);
    return normalizeGoPlus(mint, raw, r.fetchedAt);
  }
}
