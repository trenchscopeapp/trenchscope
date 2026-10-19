// task-1360 Tier 1 — the FOLLOW LIST: wallets the user chose to watch, kept in a local JSON file
// (~/.dexterm/follows.json, mode 600). The label policy (research/wallet-intel design §4.3/§5) binds: a name is
// user-typed only (`by: 'user'`), never inferred from X/Telegram, never shared or exported, deletable in one
// command (`trenchscope follow purge`). Names pass the prompt firewall on the way in: an instruction-like label is
// refused, every other label is control-stripped and clipped, so a wallet name can never carry a prompt to the
// analyst or an escape sequence to the terminal.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Clock } from '../../clock.ts';
import { systemClock } from '../../clock.ts';
import { firewallText } from '../../social/firewall.ts';
import type { FollowRecord } from './types.ts';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const FOLLOW_NAME_MAX = 24;
export const FOLLOWS_MAX = 50;

export function defaultFollowsPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DEXTERM_HOME && env.DEXTERM_HOME.length ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
  return join(home, 'follows.json');
}

export function isWalletAddress(s: unknown): s is string { return typeof s === 'string' && ADDR_RE.test(s); }

export type FollowResult = { ok: true; follow: FollowRecord } | { ok: false; reason: string };

/** Firewall + clip a user-typed wallet label. Returns null for an instruction-like or empty label. */
export function cleanFollowName(raw: unknown): { name: string | null; refused: string | null } {
  if (raw === null || raw === undefined) return { name: null, refused: null };
  const r = firewallText(String(raw), { max: FOLLOW_NAME_MAX, keepUrls: false });
  if (r.injection) return { name: null, refused: 'label reads like an instruction; not stored' };
  const name = r.text.trim().slice(0, FOLLOW_NAME_MAX);
  return { name: name.length ? name : null, refused: null };
}

export class FollowStore {
  readonly path: string | null;
  private readonly clock: Clock;
  private rows: FollowRecord[] = [];

  constructor(opts: { path?: string | null; clock?: Clock } = {}) {
    this.path = opts.path ?? null;
    this.clock = opts.clock ?? systemClock;
    if (this.path && existsSync(this.path)) this.load();
  }

  private load(): void {
    try {
      const j = JSON.parse(readFileSync(this.path!, 'utf8')) as { v?: number; follows?: unknown[] };
      this.rows = (Array.isArray(j.follows) ? j.follows : []).flatMap((x) => {
        const r = x as Partial<FollowRecord>;
        if (!isWalletAddress(r.addr)) return [];
        return [{ addr: r.addr, name: cleanFollowName(r.name).name, since: typeof r.since === 'number' ? r.since : 0, tier: 'poll' as const }];
      });
    } catch { this.rows = []; }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify({ v: 1, follows: this.rows }, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
  }

  list(): FollowRecord[] { return this.rows.map((r) => ({ ...r })); }
  get(addr: string): FollowRecord | null { const r = this.rows.find((x) => x.addr === addr); return r ? { ...r } : null; }
  has(addr: string): boolean { return this.rows.some((x) => x.addr === addr); }

  add(addr: unknown, name?: unknown): FollowResult {
    if (!isWalletAddress(addr)) return { ok: false, reason: 'not a base58 wallet address' };
    if (this.rows.some((x) => x.addr === addr)) return { ok: false, reason: 'already followed' };
    if (this.rows.length >= FOLLOWS_MAX) return { ok: false, reason: `at most ${FOLLOWS_MAX} followed wallets (the poll budget)` };
    const n = cleanFollowName(name);
    if (n.refused) return { ok: false, reason: n.refused };
    const follow: FollowRecord = { addr, name: n.name, since: this.clock.now(), tier: 'poll' };
    this.rows.push(follow); this.save();
    return { ok: true, follow: { ...follow } };
  }

  rename(addr: string, name: unknown): FollowResult {
    const r = this.rows.find((x) => x.addr === addr);
    if (!r) return { ok: false, reason: 'not followed' };
    const n = cleanFollowName(name);
    if (n.refused) return { ok: false, reason: n.refused };
    r.name = n.name; this.save();
    return { ok: true, follow: { ...r } };
  }

  remove(addr: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((x) => x.addr !== addr);
    if (this.rows.length !== before) this.save();
    return this.rows.length !== before;
  }

  /** Delete every follow and label (the local-only, deletable label store the design requires). */
  purge(): number { const n = this.rows.length; this.rows = []; this.save(); return n; }
}

export function shortAddr(a: string): string { return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a; }
