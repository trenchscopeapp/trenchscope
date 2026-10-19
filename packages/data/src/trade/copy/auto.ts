// task-1360 Tier 3 — CAPPED AUTO-MIRROR (research/wallet-intel design §6 Stage 2), the riskiest piece, built last.
//
// A COPY POLICY per followed wallet (per-trade cap, daily cap, max open mirrors, cooldown, size factor, auto-disarm
// streak, time-to-live) is DEFAULT OFF. Enabling it is a physical gesture (keypress / Phantom) that also arms a
// standing COPY MANDATE in the plan engine — the signer trust domain — drafted with exactly those caps (clamped to
// the engine's hard ceilings), buy-only, `maxTier: 'hands-free'`. It is further gated on the engine's own "this is
// less safe" popup (`Settings.handsFreeAllowed`, keypress-accepted, 24 h expiry): without it nothing auto-arms.
// Each leader BUY then goes through the Tier 2 mirror checks, becomes a PROPOSED plan (by 'copy'), and is armed
// with a `copy-auto` proof — the WEAKEST confirmation tier, so the engine sizes it at ¼ of the per-trade cap and
// re-checks every cap, the allow-list and the panic state at arming and again on every fill. This service holds
// no key, cannot raise a cap (its hard ceilings are below the engine's), and comes back OFF after a restart.
//
// Honest limits: mirror-SELL is not built (a mirror buy is closed by the user); auto-disarm therefore counts
// consecutive refused / failed mirrors, not realised losses, until exits exist.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../../clock.ts';
import { systemClock } from '../../clock.ts';
import { Journal } from '../plans/journal.ts';
import { HARD, TIERS, mandateAlive } from '../plans/mandate.ts';
import type { PlanEngine } from '../plans/engine.ts';
import { PolicyRefusal, TERMINAL } from '../plans/engine.ts';
import { PlanError } from '../plans/plan.ts';
import { MandateError } from '../plans/mandate.ts';
import { ConfirmError } from '../plans/confirm.ts';
import type { PlanService } from '../plans/service.ts';
import { buildMirror, leaderSoldSince } from './mirror.ts';
import type { MirrorMarket, MirrorResult } from './mirror.ts';
import type { CopyAlert, WalletTrade } from './types.ts';

/** Ceilings for an auto policy: stricter than the engine's (HARD), which clamp again underneath. */
export const AUTO_HARD = Object.freeze({
  perTradeUsd: Math.min(100, HARD.perTradeUsd),
  dailyUsd: Math.min(500, HARD.totalUsd),
  maxOpen: 10,
  minCooldownMs: 10_000,
  maxK: 2,
  maxDisarmStreak: 10,
  ttlMs: Math.min(24 * 3600_000, HARD.ttlMs),
});
export const AUTO_DEFAULTS = Object.freeze({ perTradeUsd: 20, dailyUsd: 100, maxOpen: 3, cooldownMs: 60_000, k: 1, autoDisarmStreak: 3, ttlMs: 8 * 3600_000 });
/** The tier an auto-mirror arms at (the weakest), and so the fraction of the per-trade cap it may use. */
export const AUTO_TIER = 'hands-free' as const;
export const AUTO_SIZE_FRACTION = TIERS[AUTO_TIER].perTradeMultiplier;
export const AUTO_GESTURE = 'copy-auto';

/** The most one auto-mirror may be: ¼ (the hands-free tier) of the mandate's per-trade cap, which the engine clamps to its total (= the daily cap). */
export function autoSizeCap(p: { perTradeUsd: number; dailyUsd: number }): number { return Math.round(Math.min(p.perTradeUsd, p.dailyUsd) * AUTO_SIZE_FRACTION * 100) / 100; }

export interface CopyPolicy {
  wallet: string;
  perTradeUsd: number;
  dailyUsd: number;
  maxOpen: number;
  cooldownMs: number;
  k: number;
  autoDisarmStreak: number;
  ttlMs: number;
  enabled: boolean;
  mandateId: string | null;
  enabledAt: number | null;
  /** why it is off (null = never enabled / turned off by the user) */
  offReason: string | null;
}

export interface CopyPolicyInput {
  perTradeUsd?: unknown; dailyUsd?: unknown; maxOpen?: unknown; cooldownMs?: unknown; k?: unknown; autoDisarmStreak?: unknown; ttlMs?: unknown;
  [k: string]: unknown;
}

export class CopyAutoError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) { super(message); this.name = 'CopyAutoError'; this.reason = reason; }
}

export interface CopyAutoDeps {
  plans: PlanService;
  clock?: Clock;
  /** the auto journal (default ~/.dexterm/copy.journal); null = memory only */
  journalPath?: string | null;
  /** what the mirror checks need for a mint (the live binding resolves it; null = unknown market) */
  market: (mint: string) => Promise<MirrorMarket | null>;
  leaderIntel?: (mint: string, wallet: string) => { inDevCluster: boolean; holdsPct: number | null } | null;
  /** the tracker's trades for a wallet (for the leader-sold check) */
  trades?: (wallet: string) => readonly WalletTrade[];
  /** only followed wallets can have an active policy */
  isFollowed?: (wallet: string) => boolean;
}

export type AutoOutcome =
  | { kind: 'ignored'; why: string }
  | { kind: 'refused'; reason: string; message: string; planId: string | null; checks?: MirrorResult }
  | { kind: 'armed'; planId: string; sizeUsd: number; mandateId: string };

export interface AutoStatus {
  policy: CopyPolicy | null;
  enabled: boolean;
  gateActive: boolean;
  mandateAlive: boolean;
  spent24hUsd: number;
  open: number;
  cooldownLeftMs: number;
  streak: number;
  lastOutcome: AutoOutcome | null;
  panicked: boolean;
}

interface AutoPlanRec { planId: string; wallet: string; sizeUsd: number; at: number; armed: boolean; judged: boolean }

export function defaultCopyJournalPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DEXTERM_HOME && env.DEXTERM_HOME.length ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
  return join(home, 'copy.journal');
}

function clampNum(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** Validate an untrusted policy input: every cap clamped DOWN to AUTO_HARD, never coerced upward. */
export function draftPolicy(wallet: string, input: CopyPolicyInput | null | undefined): CopyPolicy {
  const x = input ?? {};
  const perTradeUsd = clampNum(x.perTradeUsd, AUTO_DEFAULTS.perTradeUsd, 0.01, AUTO_HARD.perTradeUsd);
  // independent caps: a daily cap below the per-trade cap simply means fewer / smaller mirrors (the mandate clamps
  // its per-trade down to its total on its own; auto fires at ¼ of per-trade anyway)
  const dailyUsd = clampNum(x.dailyUsd, AUTO_DEFAULTS.dailyUsd, 0.01, AUTO_HARD.dailyUsd);
  return Object.freeze({
    wallet, perTradeUsd, dailyUsd,
    maxOpen: Math.round(clampNum(x.maxOpen, AUTO_DEFAULTS.maxOpen, 1, AUTO_HARD.maxOpen)),
    cooldownMs: clampNum(x.cooldownMs, AUTO_DEFAULTS.cooldownMs, AUTO_HARD.minCooldownMs, 24 * 3600_000),
    k: clampNum(x.k, AUTO_DEFAULTS.k, 0.01, AUTO_HARD.maxK),
    autoDisarmStreak: Math.round(clampNum(x.autoDisarmStreak, AUTO_DEFAULTS.autoDisarmStreak, 1, AUTO_HARD.maxDisarmStreak)),
    ttlMs: clampNum(x.ttlMs, AUTO_DEFAULTS.ttlMs, 60_000, AUTO_HARD.ttlMs),
    enabled: false, mandateId: null, enabledAt: null, offReason: null,
  });
}

export class CopyAuto {
  readonly journal: Journal;
  private readonly plans: PlanService;
  private readonly clock: Clock;
  private readonly market: CopyAutoDeps['market'];
  private readonly leaderIntel: NonNullable<CopyAutoDeps['leaderIntel']>;
  private readonly trades: CopyAutoDeps['trades'];
  private readonly isFollowed: NonNullable<CopyAutoDeps['isFollowed']>;
  private readonly policies = new Map<string, CopyPolicy>();
  private readonly autoPlans = new Map<string, AutoPlanRec>();
  private readonly lastAt = new Map<string, number>();
  private readonly streak = new Map<string, number>();
  private readonly last = new Map<string, AutoOutcome>();
  private panicked = false;
  private queue: Promise<unknown> = Promise.resolve();
  #runners = new Map<string, ReturnType<PlanEngine['authorizeCopy']>>();

  constructor(deps: CopyAutoDeps) {
    this.plans = deps.plans;
    this.clock = deps.clock ?? systemClock;
    this.market = deps.market;
    this.leaderIntel = deps.leaderIntel ?? (() => null);
    this.trades = deps.trades;
    this.isFollowed = deps.isFollowed ?? (() => true);
    const path = deps.journalPath === undefined ? null : deps.journalPath;
    this.journal = new Journal({ path, clock: this.clock });
    if (path && existsSync(path)) this.recover();
  }

  /** Rebuild policies (always OFF after a restart) and the auto-plan ledger from the journal. */
  private recover(): void {
    const v = this.journal.verify();
    if (!v.ok) throw new Error(`copy journal chain broken at seq ${v.atSeq}: ${v.why}`);
    const live = new Map<string, string>(); // wallet → copy mandate that was ON at the crash/quit
    for (const e of this.journal.events) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (e.type === 'copy.policy' && typeof d.wallet === 'string') this.policies.set(d.wallet, { ...draftPolicy(d.wallet, d.policy as CopyPolicyInput), offReason: 'off after restart: re-enable with a keypress' });
      else if (e.type === 'copy.auto.proposed' && typeof e.planId === 'string') this.autoPlans.set(e.planId, { planId: e.planId, wallet: String(d.wallet), sizeUsd: Number(d.sizeUsd) || 0, at: e.ts, armed: false, judged: false });
      else if (e.type === 'copy.auto.armed' && typeof e.planId === 'string') { const r = this.autoPlans.get(e.planId); if (r) r.armed = true; }
      else if (e.type === 'copy.auto.enabled' && typeof d.wallet === 'string' && typeof e.mandateId === 'string') live.set(d.wallet, e.mandateId);
      else if (e.type === 'copy.auto.disabled' && typeof d.wallet === 'string') live.delete(d.wallet);
      else if (e.type === 'copy.policy.removed' && typeof d.wallet === 'string') { this.policies.delete(d.wallet); live.delete(d.wallet); }
    }
    // Auto-mirror never survives a restart: a copy mandate the plan engine recovered as armed is revoked here, so
    // nothing can fire until a person enables it again with a keypress (and the less-safe popup is fresh).
    for (const [wallet, mandateId] of live) {
      try { this.plans.revokeMandate(mandateId, 'copy auto off after restart'); } catch { /* already gone */ }
      this.journal.append('copy.auto.disabled', { mandateId, data: { wallet, reason: 'off after restart' } });
    }
    this.journal.append('copy.recovered', { data: { policies: this.policies.size, autoPlans: this.autoPlans.size, revoked: live.size, note: 'auto-mirror is OFF after a restart' } });
  }

  // ───────────── policies ─────────────
  policy(wallet: string): CopyPolicy | null { return this.policies.get(wallet) ?? null; }
  list(): CopyPolicy[] { return [...this.policies.values()]; }

  /** Draft (or redraft) the caps for a wallet. Refused while enabled: a different cap is disable + a new gesture. */
  draft(wallet: string, input: CopyPolicyInput | null | undefined): CopyPolicy {
    const cur = this.policies.get(wallet);
    if (cur?.enabled) throw new CopyAutoError('enabled', 'auto-mirror is ON for this wallet; disable it before changing its caps');
    const p = draftPolicy(wallet, input);
    this.policies.set(wallet, p);
    this.journal.append('copy.policy', { data: { wallet, policy: { perTradeUsd: p.perTradeUsd, dailyUsd: p.dailyUsd, maxOpen: p.maxOpen, cooldownMs: p.cooldownMs, k: p.k, autoDisarmStreak: p.autoDisarmStreak, ttlMs: p.ttlMs } } });
    return p;
  }

  remove(wallet: string): boolean {
    const cur = this.policies.get(wallet);
    if (!cur) return false;
    if (cur.enabled) this.disable(wallet, 'policy removed');
    this.policies.delete(wallet);
    this.journal.append('copy.policy.removed', { data: { wallet } });
    return true;
  }

  /**
   * Turn auto-mirror ON for a wallet. Needs: a physical gesture (keypress / Phantom — the same rule as arming any
   * mandate), the engine's "less safe" popup accepted (hands-free allowed), no panic, a followed wallet, a drafted
   * policy. Drafts + arms the COPY MANDATE with the policy's caps in one gesture.
   */
  enable(wallet: string, gesture: { gesture?: string } | null | undefined): CopyPolicy {
    const cur = this.policies.get(wallet);
    if (!cur) throw new CopyAutoError('no-policy', 'draft the caps first (trenchscope follow auto <addr> --per-trade … or the A key)');
    if (cur.enabled) return cur;
    if (gesture?.gesture !== 'keypress' && gesture?.gesture !== 'phantom') throw new CopyAutoError('needs-keypress', 'enabling auto-mirror needs a physical keypress (or Phantom approval); voice, agents and pipes cannot');
    if (this.panicked) throw new CopyAutoError('panicked', 'panic engaged; auto-mirror stays off');
    if (!this.isFollowed(wallet)) throw new CopyAutoError('not-followed', 'follow the wallet first');
    if (!this.plans.riskStatus().active) throw new CopyAutoError('gate-on', 'the keypress gate is ON: accept the "this is less safe" popup first (G on the O screen); auto-mirror fires at the hands-free tier');
    const now = this.clock.now();
    const m = this.plans.draftMandate({
      totalUsd: cur.dailyUsd, perTradeUsd: cur.perTradeUsd, perCoinUsd: cur.perTradeUsd, dailyLossUsd: cur.dailyUsd,
      maxOpenPositions: cur.maxOpen, maxArmedPlans: cur.maxOpen, actions: ['buy'], maxTier: AUTO_TIER, ttlMs: cur.ttlMs,
    });
    const engine = this.plans.engine;
    this.#runners.set(wallet, engine.authorizeCopy(m.id, engine.issueMandateProof(m.id, gesture.gesture), wallet));
    const p: CopyPolicy = Object.freeze({ ...cur, enabled: true, mandateId: m.id, enabledAt: now, offReason: null });
    this.policies.set(wallet, p);
    this.streak.set(wallet, 0);
    this.journal.append('copy.auto.enabled', { mandateId: m.id, data: { wallet, by: gesture.gesture, perTradeUsd: cur.perTradeUsd, autoSizeUsd: autoSizeCap(cur), dailyUsd: cur.dailyUsd, maxOpen: cur.maxOpen, cooldownMs: cur.cooldownMs, expiresAt: m.expiresAt } });
    return p;
  }

  /** Turn it OFF (always allowed, no gesture): revokes the copy mandate, which cancels its unfilled mirrors. */
  disable(wallet: string, reason = 'user'): CopyPolicy | null {
    const cur = this.policies.get(wallet);
    if (!cur) return null;
    if (!cur.enabled) return cur;
    this.#runners.delete(wallet);
    try { if (cur.mandateId) this.plans.revokeMandate(cur.mandateId, `copy auto off: ${reason}`); } catch { /* already gone */ }
    const p: CopyPolicy = Object.freeze({ ...cur, enabled: false, mandateId: null, enabledAt: null, offReason: reason });
    this.policies.set(wallet, p);
    this.journal.append('copy.auto.disabled', { mandateId: cur.mandateId, data: { wallet, reason } });
    return p;
  }

  /** PANIC: every policy off, every copy mandate revoked, and the plan engine's own panic (revokes ALL mandates). */
  panic(reason = 'panic key'): void {
    this.panicked = true;
    for (const p of this.policies.values()) if (p.enabled) this.disable(p.wallet, `panic: ${reason}`);
    this.journal.append('copy.panic', { data: { reason } });
    try { this.plans.panic(reason); } catch { /* engine already panicked */ }
  }
  get isPanicked(): boolean { return this.panicked; }

  // ───────────── accounting ─────────────
  private recsFor(wallet: string): AutoPlanRec[] { return [...this.autoPlans.values()].filter((r) => r.wallet === wallet); }
  private planStatus(planId: string): string | null { return this.plans.engine.status(planId); }
  spent24h(wallet: string, now = this.clock.now()): number {
    return this.recsFor(wallet).filter((r) => r.armed && now - r.at < 24 * 3600_000).filter((r) => { const s = this.planStatus(r.planId); return s !== null && s !== 'cancelled' && s !== 'failed'; }).reduce((s, r) => s + r.sizeUsd, 0);
  }
  openCount(wallet: string): number {
    return this.recsFor(wallet).filter((r) => r.armed).filter((r) => { const s = this.planStatus(r.planId); return s !== null && !TERMINAL.has(s as never) && s !== 'proposed'; }).length;
  }
  status(wallet: string): AutoStatus {
    const p = this.policies.get(wallet) ?? null;
    const now = this.clock.now();
    const m = p?.mandateId ? this.plans.engine.mandates.get(p.mandateId)?.m ?? null : null;
    const last = this.lastAt.get(wallet) ?? 0;
    return {
      policy: p, enabled: !!p?.enabled, gateActive: this.plans.riskStatus().active,
      mandateAlive: m ? mandateAlive(m, now).ok : false,
      spent24hUsd: this.spent24h(wallet, now), open: this.openCount(wallet),
      cooldownLeftMs: p ? Math.max(0, p.cooldownMs - (now - last)) : 0,
      streak: this.streak.get(wallet) ?? 0, lastOutcome: this.last.get(wallet) ?? null, panicked: this.panicked,
    };
  }
  /** Plans THIS service proposed (never a voice/agent/user plan), newest first. */
  autoPlanIds(wallet?: string): string[] { return [...this.autoPlans.values()].filter((r) => !wallet || r.wallet === wallet).sort((a, b) => b.at - a.at).map((r) => r.planId); }

  // ───────────── the auto path ─────────────
  /** A tracker alert. Serialised; never throws (every outcome is journaled and kept for status()). */
  onAlert(alert: CopyAlert): Promise<AutoOutcome> {
    const run = this.queue.then(() => this.handle(alert)).catch((e): AutoOutcome => ({ kind: 'refused', reason: 'error', message: e instanceof Error ? e.message : String(e), planId: null }));
    this.queue = run;
    return run;
  }

  private settle(wallet: string, out: AutoOutcome): AutoOutcome {
    this.last.set(wallet, out);
    if (out.kind === 'refused') {
      const n = (this.streak.get(wallet) ?? 0) + 1;
      this.streak.set(wallet, n);
      const p = this.policies.get(wallet);
      this.journal.append('copy.auto.refused', { planId: out.planId, data: { wallet, reason: out.reason, message: out.message, streak: n } });
      if (p?.enabled && n >= p.autoDisarmStreak) this.disable(wallet, `auto-disarm: ${n} consecutive refused/failed mirrors (last: ${out.reason})`);
    } else if (out.kind === 'armed') this.streak.set(wallet, 0);
    return out;
  }

  private async handle(alert: CopyAlert): Promise<AutoOutcome> {
    const wallet = alert.wallet;
    const p = this.policies.get(wallet);
    if (!p || !p.enabled) return { kind: 'ignored', why: 'auto-mirror off for this wallet' };
    if (alert.trade.side !== 'buy') return { kind: 'ignored', why: `a ${alert.trade.side} is never mirrored` };
    const refuse = (reason: string, message: string, planId: string | null = null): AutoOutcome => this.settle(wallet, { kind: 'refused', reason, message, planId });
    const gate = (): AutoOutcome | null => {
      if (this.panicked) return refuse('panicked', 'panic engaged');
      if (!this.isFollowed(wallet)) { this.disable(wallet, 'wallet unfollowed'); return refuse('not-followed', 'the wallet is no longer followed'); }
      if (!this.plans.riskStatus().active) return refuse('gate-on', 'the keypress gate is on (the less-safe acceptance expired or was restored); auto-mirror paused');
      const m = p.mandateId ? this.plans.engine.mandates.get(p.mandateId)?.m ?? null : null;
      const alive = m ? mandateAlive(m, this.clock.now()) : { ok: false as const, reason: 'no-mandate' };
      if (!alive.ok) { this.disable(wallet, `copy mandate ${alive.reason}`); return refuse(alive.reason, 'the copy mandate is no longer alive; auto-mirror off'); }
      return null;
    };
    const g0 = gate(); if (g0) return g0;
    const now = this.clock.now();
    const sinceLast = now - (this.lastAt.get(wallet) ?? -Infinity);
    if (sinceLast < p.cooldownMs) return refuse('cooldown', `cooldown: ${Math.ceil((p.cooldownMs - sinceLast) / 1000)} s left`);
    const open = this.openCount(wallet);
    if (open >= p.maxOpen) return refuse('max-open', `${open} open mirrors (max ${p.maxOpen})`);
    const spent = this.spent24h(wallet, now);
    const dailyLeft = p.dailyUsd - spent;
    if (dailyLeft < 0.01) return refuse('daily-cap', `daily cap: $${spent.toFixed(2)} of $${p.dailyUsd} used in 24 h`);
    let market: MirrorMarket | null = null;
    try { market = await this.market(alert.trade.mint); } catch { market = null; }
    const g1 = gate(); if (g1) return g1; // re-check after the await
    const capUsd = Math.min(autoSizeCap(p), dailyLeft);
    const r = buildMirror(alert, {
      now: this.clock.now(), capUsd, k: p.k, market,
      leaderSoldSince: this.trades ? leaderSoldSince(alert, this.trades(wallet)) : null,
      leaderIntel: this.leaderIntel(alert.trade.mint, wallet),
    });
    if (!r.ok) return this.settle(wallet, { kind: 'refused', reason: r.reason, message: r.message, planId: null, checks: r });
    let planId: string | null = null;
    try {
      const runner = this.#runners.get(wallet);
      if (!runner) return refuse('no-authority', 'enable copy automation with a fresh physical gesture');
      const authorized = runner(r.input, r.supply, alert.trade.sig.slice(0, 16));
      const plan = authorized.plan;
      planId = plan.id;
      this.autoPlans.set(plan.id, { planId: plan.id, wallet, sizeUsd: plan.sizeUsd, at: this.clock.now(), armed: false, judged: false });
      this.journal.append('copy.auto.proposed', { planId: plan.id, data: { wallet, sizeUsd: plan.sizeUsd, mint: plan.mint, ref: plan.source.ref } });
      const g2 = gate(); if (g2) { this.plans.cancelPlan(plan.id, 'copy auto: gate closed'); return g2; }
      // Only the engine-held operation for this new proposal can arm it. No proof leaves the engine.
      authorized.arm();
      const rec = this.autoPlans.get(plan.id)!; rec.armed = true;
      this.lastAt.set(wallet, this.clock.now());
      this.journal.append('copy.auto.armed', { planId: plan.id, mandateId: p.mandateId, data: { wallet, sizeUsd: plan.sizeUsd, tier: AUTO_TIER, lagMs: r.lagMs, driftPct: r.driftPct } });
      return this.settle(wallet, { kind: 'armed', planId: plan.id, sizeUsd: plan.sizeUsd, mandateId: p.mandateId! });
    } catch (e) {
      if (planId) { try { this.plans.cancelPlan(planId, 'copy auto: arm refused'); } catch { /* ignore */ } }
      const reason = e instanceof PolicyRefusal || e instanceof PlanError || e instanceof MandateError || e instanceof ConfirmError ? e.reason : 'error';
      return refuse(reason, e instanceof Error ? e.message : String(e), planId);
    }
  }

  /** Judge settled auto plans for the disarm streak (a FAILED mirror counts; a done one resets). Call on a timer. */
  tick(): void {
    for (const r of this.autoPlans.values()) {
      if (r.judged || !r.armed) continue;
      const s = this.planStatus(r.planId);
      if (s === null || !TERMINAL.has(s as never)) continue;
      r.judged = true;
      const p = this.policies.get(r.wallet);
      if (s === 'failed') {
        const n = (this.streak.get(r.wallet) ?? 0) + 1;
        this.streak.set(r.wallet, n);
        this.journal.append('copy.auto.judged', { planId: r.planId, data: { wallet: r.wallet, status: s, streak: n } });
        if (p?.enabled && n >= p.autoDisarmStreak) this.disable(r.wallet, `auto-disarm: ${n} consecutive refused/failed mirrors (last: entry failed)`);
      } else if (s === 'done') { this.streak.set(r.wallet, 0); this.journal.append('copy.auto.judged', { planId: r.planId, data: { wallet: r.wallet, status: s, streak: 0 } }); }
    }
  }

  verifyJournal() { return this.journal.verify(); }
}
