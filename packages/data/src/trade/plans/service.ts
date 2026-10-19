// task-1355 — PlanService: the app-facing facade over the plan engine.
//
// Owns the engine + hash-chained journal (persisted to ~/.dexterm/plans.journal) + the paper fire path +
// the confirm gate + the gate-off settings. It adds persistence (recover on load), untrusted-string
// parsing for typed commands (`mc-below:300k`, `mc-above:600k:50%`), and list/describe views the CLI,
// TUI and popup render. It adds NO new way to arm or sign: arming still requires a signer-issued
// keypress/Phantom gesture proof routed through the engine; voice/agents can only propose.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../../clock.ts';
import { systemClock } from '../../clock.ts';
import { Journal } from './journal.ts';
import { ConfirmGate, Settings, HOLD_MS } from './confirm.ts';
import type { ConfirmEvidence } from './confirm.ts';
import { PlanEngine } from './engine.ts';
import type { PriceTick, SafetyFn } from './engine.ts';
import { PaperPlanExecutor } from './executor-paper.ts';
import type { Executor } from './executor.ts';
import { ConfirmError } from './confirm.ts';
import { PolicyRefusal } from './engine.ts';
import { readBack, fmtUsd, PlanError } from './plan.ts';
import type { GestureProof, Mandate, MandateInput, TierName } from './mandate.ts';
import type { OrderPlan, Exit, PlanInput, Trigger } from './types.ts';

export interface PlanServiceOptions {
  clock?: Clock;
  journalPath?: string | null;
  executor?: Executor;
  safety?: SafetyFn;
  solUsd?: number;
  rng?: () => number;
  /**
   * task-1363: how old a price tick may be and still fire (engine default 3 s). The terminal feeds the engine
   * from its board refresh (~10 s) so it passes a wider window; tests keep the default.
   */
  priceMaxAgeMs?: number;
  debounceTicks?: number;
}

/** Where the plan/mandate journal (audit log + recovery source) lives, shared by every trenchscope process. */
export function defaultPlansJournalPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DEXTERM_HOME && env.DEXTERM_HOME.length ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
  return join(home, 'plans.journal');
}

/** Parse a memecoin-style amount: 300k / 1.2m / 2b / 600000. */
export function parseAmount(s: string): number {
  const m = /^\s*\$?([0-9]*\.?[0-9]+)\s*([kmb])?\s*$/i.exec(s);
  if (!m) throw new PlanError('bad-request', `cannot parse amount "${s}"`);
  const mult = m[2] ? ({ k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[m[2].toLowerCase()] : 1;
  return Number(m[1]) * mult;
}

/** Parse a trigger spec: `immediate` | `mc-below:300k` | `price-above:0.0005`. */
export function parseTrigger(s: string): Trigger {
  const t = s.trim();
  if (t === 'immediate' || t === 'now') return { kind: 'immediate' };
  const m = /^(mc-below|mc-above|price-below|price-above):(.+)$/.exec(t);
  if (!m) throw new PlanError('bad-request', `cannot parse trigger "${s}" (expected kind:value, e.g. mc-below:300k)`);
  return { kind: m[1] as Exclude<Trigger['kind'], 'immediate'>, value: parseAmount(m[2]) };
}

/** Parse an exit spec: `mc-above:600k:0.5` or `mc-above:600k:50%`. */
export function parseExit(s: string): Exit {
  const parts = s.split(':');
  if (parts.length < 3) throw new PlanError('bad-request', `cannot parse exit "${s}" (expected kind:value:fraction, e.g. mc-above:600k:50%)`);
  const fracStr = parts[parts.length - 1].trim();
  const at = parseTrigger(parts.slice(0, -1).join(':'));
  const fraction = fracStr.endsWith('%') ? Number(fracStr.slice(0, -1)) / 100 : Number(fracStr);
  if (!(fraction > 0 && fraction <= 1)) throw new PlanError('bad-request', `exit fraction "${fracStr}" must be in (0, 1] or a percent`);
  return { at, fraction };
}

export interface PlanRow {
  id: string;
  mint: string;
  symbol: string;
  side: OrderPlan['side'];
  sizeUsd: number;
  status: string;
  mandateId: string | null;
  tier: TierName | null;
  readBack: string;
  paused: boolean;
}

export interface MandateRow {
  id: string;
  status: string;
  wallet: string;
  totalUsd: number;
  perTradeUsd: number;
  perCoinUsd: number;
  maxTier: TierName;
  reservedUsd: number;
  spentUsd: number;
  realizedUsd: number;
  lossUsd: number;
  expiresAt: number;
}

export class PlanService {
  readonly clock: Clock;
  readonly journal: Journal;
  readonly settings: Settings;
  readonly gate: ConfirmGate;
  readonly engine: PlanEngine;
  private readonly paper: Executor;

  constructor(opts: PlanServiceOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    const path = opts.journalPath ?? null;
    this.journal = new Journal({ path, clock: this.clock });
    this.settings = new Settings(this.clock, this.journal);
    this.gate = new ConfirmGate({ clock: this.clock, journal: this.journal, settings: this.settings, rng: opts.rng });
    this.paper = opts.executor ?? new PaperPlanExecutor({ clock: this.clock, solUsd: opts.solUsd });
    const deps = { clock: this.clock, journal: this.journal, executor: this.paper, gate: this.gate, safety: opts.safety, priceMaxAgeMs: opts.priceMaxAgeMs, debounceTicks: opts.debounceTicks };
    // Recover from an existing journal (replay + settle in-flight) or start fresh. The fire path always starts
    // PAPER (task-1363): live is a per-run keypress opt-in, never recovered from the journal.
    this.engine = path && existsSync(path) ? PlanEngine.recover(deps) : new PlanEngine(deps);
  }

  /** The executor the engine fires through right now (paper by default; the live adapter after useLive). */
  get executor(): Executor { return this.engine.executor; }
  /** 'paper' unless a live executor is installed. Surfaces that cannot prove 'paper' must render LIVE. */
  mode(): 'paper' | 'live' { return this.engine.executor.kind === 'live' ? 'live' : 'paper'; }

  // ── the fire path (task-1363). Switching to LIVE is a physical keypress on the plans screen (never voice,
  // an agent, a pipe or the popup): the gesture is required here AND the signer only fills from a fast wallet
  // that was itself created by a TTY keypress. A switch while plans are armed/filled would strand their legs on
  // the other executor's ledger, so both directions refuse until those plans are cancelled or finished. ──
  useLive(executor: Executor, gesture: { gesture?: string } | null | undefined): void {
    if (gesture?.gesture !== 'keypress') throw new ConfirmError('live-needs-keypress', 'switching plan fills to LIVE needs a physical keypress');
    if (executor.kind !== 'live') throw new PlanError('bad-request', 'useLive needs a live executor');
    const open = this.engine.openPlans();
    if (open.length) throw new PolicyRefusal('open-plans', `cancel or finish ${open.length} open plan(s) before switching the fire path`);
    this.engine.replaceExecutor(executor);
    this.journal.append('settings.executor', { data: { kind: 'live', network: 'devnet', by: 'keypress', label: (executor as { describe?: () => string }).describe?.() ?? 'live' } });
  }
  usePaper(): void {
    if (this.engine.executor === this.paper) return;
    const open = this.engine.openPlans();
    if (open.length) throw new PolicyRefusal('open-plans', `cancel or finish ${open.length} open plan(s) before switching the fire path`);
    this.engine.replaceExecutor(this.paper);
    this.journal.append('settings.executor', { data: { kind: 'paper' } });
  }

  // ── proposals (voice/claude/user/batch all land here; a proposal is inert until armed) ──
  propose(input: PlanInput, ctx: { supply: number; by?: OrderPlan['source']['by']; ref?: string | null }): OrderPlan {
    return this.engine.propose(input, { supply: ctx.supply, by: ctx.by ?? 'user', ref: ctx.ref ?? null });
  }
  readBack(planId: string): string { const p = this.engine.plan(planId); if (!p) throw new PlanError('unknown-plan', 'no such plan'); return readBack(p); }

  // ── arming (keypress/Phantom only; the CLI/TUI must supply a real gesture) ──
  challenge(planId: string, tier: TierName = 'keypress') { return this.engine.challenge(planId, tier); }
  confirm(challengeId: string, evidence: ConfirmEvidence): GestureProof { return this.engine.confirm(challengeId, evidence); }
  armPlan(planId: string, proof: GestureProof, mandateId: string) { return this.engine.armPlan(planId, proof, mandateId); }
  cancelPlan(planId: string, reason = 'user') { return this.engine.cancelPlan(planId, reason); }

  /** Arm a plan from a physical keypress gesture the host already captured (hold >= HOLD_MS). */
  armPlanByKeypress(planId: string, mandateId: string, holdMs = HOLD_MS + 50): ReturnType<PlanEngine['armPlan']> {
    const ch = this.challenge(planId, 'keypress');
    const proof = this.confirm(ch.id, { kind: 'keypress', holdMs });
    return this.armPlan(planId, proof, mandateId);
  }

  // ── mandates (drafted by anyone; armed by keypress/Phantom only) ──
  draftMandate(input: MandateInput): Mandate { return this.engine.draftMandate(input); }
  armMandateByKeypress(mandateId: string, gesture: 'keypress' | 'phantom' = 'keypress'): Mandate {
    return this.engine.armMandate(mandateId, this.engine.issueMandateProof(mandateId, gesture));
  }
  revokeMandate(mandateId: string, reason = 'user') { this.engine.revokeMandate(mandateId, reason); }

  // ── kill switch ──
  panic(reason = 'panic key'): void { this.engine.panic(reason); }

  // ── the "less safe" hands-free opt-in (Tier 4). The keypress gate is ON by default: voice/agents can only
  // ever leave an inert proposal, and arming is a physical gesture. Turning the gate OFF enables hands-free
  // (spoken) confirmation; it is accepted ONLY by a real keypress on the risk popup, journaled, auto-expires
  // in 24h (RISK_ACCEPT_TTL_MS), and is reversible at any time. These thin methods keep every surface off the
  // Settings object so the keypress-only rule lives in exactly one place. ──
  riskStatus(): { gateOff: boolean; acceptedAt: number | null; expiresAt: number | null; active: boolean } {
    const r = this.settings.risk;
    return { gateOff: this.settings.gateOff, acceptedAt: r?.acceptedAt ?? null, expiresAt: r?.expiresAt ?? null, active: this.settings.handsFreeAllowed(this.clock.now()) };
  }
  acceptRisk(gesture: { gesture?: string } | null | undefined): void { this.settings.acceptRiskPopup(gesture); }
  restoreGate(): void { this.settings.restoreGate(); }

  // ── ticks (untrusted price hints; the engine re-confirms via its own quote) ──
  tick(t: PriceTick): void { this.engine.tick(t); }

  // ── views ──
  listPlans(): PlanRow[] {
    return [...this.engine.recs.values()].map((r) => ({
      id: r.plan.id, mint: r.plan.mint, symbol: r.plan.symbol, side: r.plan.side, sizeUsd: r.plan.sizeUsd,
      status: r.status, mandateId: r.mandateId, tier: r.tier, readBack: readBack(r.plan), paused: r.paused !== null,
    }));
  }
  listMandates(): MandateRow[] {
    return [...this.engine.mandates.values()].map((x) => {
      const L = this.engine.ledger(x.m.id);
      return {
        id: x.m.id, status: x.m.status, wallet: x.m.wallet, totalUsd: x.m.budget.totalUsd, perTradeUsd: x.m.budget.perTradeUsd,
        perCoinUsd: x.m.budget.perCoinUsd, maxTier: x.m.maxTier, reservedUsd: L.reservedUsd, spentUsd: L.spentUsd,
        realizedUsd: L.realizedUsd, lossUsd: L.lossUsd, expiresAt: x.m.expiresAt,
      };
    });
  }

  // ── audit log ──
  verifyJournal() { return this.journal.verify(); }
  exportJournal(): string { return this.journal.events.map((e) => JSON.stringify(e)).join('\n'); }

  summary(planId: string) { return this.engine.summary(planId); }
  position(planId: string) { return this.engine.position(planId); }
  ledger(mandateId: string) { return this.engine.ledger(mandateId); }
}

/** One-line label for a plan status (CLI/TUI). */
export function planStatusLabel(row: PlanRow): string {
  const tier = row.tier ? ` · ${row.tier}` : '';
  const paused = row.paused ? ' · PAUSED' : '';
  return `${row.symbol} ${fmtUsd(row.sizeUsd)} ${row.side} — ${row.status}${tier}${paused}`;
}
