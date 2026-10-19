// task-1355 — ORDER PLAN schema, validation, canonical hash, read-back (SPEC §6.13.1).
//
// A plan is a PROPOSAL until a confirmation proof arms it. Voice, Claude, popups and batch builders can
// only produce the input shape below; nothing here carries an `armed`/`status`/`caps` field from the
// proposer — those are stripped, never trusted. Amounts are USD (entry) and fractions of the ORIGINAL
// filled position (exits). Market-cap triggers are stored WITH the supply snapshot they were proposed
// against, so the read-back can say "300k = $0.0003 at 1.00B supply" and a later supply change is visible.
//
// No signing, no wallet, no network. `node:crypto` is used only for the SHA-256 plan hash.
// Ported from the task-1292 reference simulation (research/task-1292/sim/plan.mjs), typed and frozen.

import { createHash } from 'node:crypto';
import type { Clock } from '../../clock.ts';
import type { Exit, OrderPlan, PlanInput, ProposeCtx, Side, Trigger } from './types.ts';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const PLAN_SCHEMA_VERSION = 1 as const;

/** Which fields are "material": a change to any of them changes the hash and voids every confirmation. */
export const MATERIAL_FIELDS = [
  'v', 'mint', 'decimals', 'side', 'sizeUsd', 'entry', 'exits', 'moonBagFraction', 'stop',
  'slippageBps', 'maxPriceImpactPct', 'supplyAtProposal', 'expiresAt', 'chunkUsd',
] as const;

export class PlanError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PlanError';
    this.reason = reason;
  }
}

interface NumOpts { min?: number; max?: number; integer?: boolean }

function num(x: unknown, name: string, { min = 0, max = Infinity, integer = false }: NumOpts = {}): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new PlanError('bad-request', `${name} must be a finite number`);
  if (x < min || x > max) throw new PlanError('bad-request', `${name} must be in [${min}, ${max}]`);
  if (integer && !Number.isInteger(x)) throw new PlanError('bad-request', `${name} must be an integer`);
  return x;
}

function trigger(t: unknown, name: string): Trigger {
  if (t === null || typeof t !== 'object') throw new PlanError('bad-request', `${name} must be an object`);
  const kind = (t as { kind?: unknown }).kind;
  if (kind === 'immediate') return { kind: 'immediate' };
  if (kind !== 'mc-below' && kind !== 'mc-above' && kind !== 'price-below' && kind !== 'price-above') {
    throw new PlanError('bad-request', `${name}.kind unknown`);
  }
  return { kind, value: num((t as { value?: unknown }).value, `${name}.value`, { min: 1e-12 }) };
}

/** Sanitize untrusted display text (token symbol / name): printable ASCII, short. Never used in policy. */
export function displayText(s: unknown, max = 16): string {
  return typeof s === 'string' ? s.replace(/[^\x20-\x7e]/g, '?').slice(0, max) : '';
}

/**
 * Validate an untrusted proposal input and return a frozen plan (status 'proposed'). `ctx` is what the
 * TUI knows and the proposer does not control: the supply snapshot, the clock, and the provenance.
 */
export function proposePlan(input: PlanInput | null | undefined, ctx: ProposeCtx): Readonly<OrderPlan> {
  if (input === null || typeof input !== 'object') throw new PlanError('bad-request', 'plan must be an object');
  const x = input;
  if (typeof x.mint !== 'string' || !MINT_RE.test(x.mint)) throw new PlanError('bad-request', 'mint must be a base58 address');
  const side: Side | null = x.side === 'sell' ? 'sell' : x.side === 'buy' ? 'buy' : null;
  if (!side) throw new PlanError('bad-request', 'side must be buy or sell');
  const decimals = num(x.decimals, 'decimals', { min: 0, max: 18, integer: true });
  const sizeUsd = num(x.sizeUsd, 'sizeUsd', { min: 0.01, max: 1e7 });
  const entry = trigger(x.entry ?? { kind: 'immediate' }, 'entry');
  const exitsIn = Array.isArray(x.exits) ? x.exits : [];
  if (exitsIn.length > 8) throw new PlanError('bad-request', 'at most 8 exit legs');
  let sum = 0;
  const cleanExits: Exit[] = exitsIn.map((e, i) => {
    const at = trigger((e as { at?: unknown })?.at, `exits[${i}].at`);
    if (at.kind !== 'mc-above' && at.kind !== 'price-above') throw new PlanError('bad-request', `exits[${i}] must be an above-trigger (take profit)`);
    const fraction = num((e as { fraction?: unknown })?.fraction, `exits[${i}].fraction`, { min: 0.01, max: 1 });
    sum += fraction;
    return { at, fraction };
  });
  // exits must be ascending so the ladder is unambiguous ("sell half at 600k, a quarter at 1.2M")
  for (let i = 1; i < cleanExits.length; i++) {
    const cur = cleanExits[i].at;
    const prev = cleanExits[i - 1].at;
    const curVal = cur.kind === 'immediate' ? 0 : cur.value;
    const prevVal = prev.kind === 'immediate' ? 0 : prev.value;
    if (curVal <= prevVal) throw new PlanError('bad-request', 'exit legs must be ascending');
  }
  if (sum > 1 + 1e-9) throw new PlanError('bad-request', 'exit fractions sum above 100%');
  const moonBagFraction = Math.round((1 - sum) * 1e6) / 1e6;
  const stop = x.stop == null ? null : trigger(x.stop, 'stop');
  if (stop && stop.kind !== 'mc-below' && stop.kind !== 'price-below') throw new PlanError('bad-request', 'stop must be a below-trigger');
  if (stop && entry.kind === 'mc-below' && stop.kind === 'mc-below' && stop.value >= entry.value) throw new PlanError('bad-request', 'stop must be below the entry');
  const slippageBps = num(x.slippageBps ?? 300, 'slippageBps', { min: 0, max: 1000, integer: true });
  const maxPriceImpactPct = num(x.maxPriceImpactPct ?? 3, 'maxPriceImpactPct', { min: 0.01, max: 3 });
  const ttlMs = num(x.ttlMs ?? 4 * 3600_000, 'ttlMs', { min: 10_000, max: 7 * 86_400_000, integer: true });
  const chunkUsd = x.chunkUsd == null ? null : num(x.chunkUsd, 'chunkUsd', { min: 1 });
  if (typeof ctx?.supply !== 'number' || !(ctx.supply > 0)) throw new PlanError('bad-request', 'ctx.supply (token supply snapshot) is required');
  if (!ctx.clock) throw new PlanError('bad-request', 'ctx.clock is required');
  const createdAt = ctx.clock.now();
  const plan: OrderPlan = {
    v: PLAN_SCHEMA_VERSION,
    id: ctx.id ?? `plan_${createdAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    mint: x.mint, symbol: displayText(x.symbol) || x.mint.slice(0, 4), decimals, side, sizeUsd,
    entry, exits: cleanExits, moonBagFraction, stop, slippageBps, maxPriceImpactPct,
    supplyAtProposal: ctx.supply, chunkUsd,
    createdAt, expiresAt: createdAt + ttlMs,
    // provenance (NOT material; the proposer cannot influence policy through it)
    source: { by: ctx.by ?? 'user', ref: typeof ctx.ref === 'string' ? ctx.ref.slice(0, 80) : null, batchId: ctx.batchId ?? null },
    status: 'proposed',
    hash: '',
  };
  plan.hash = planHash(plan);
  return Object.freeze(plan);
}

/** Canonical JSON of the material fields only (sorted keys, fixed order). */
export function canonicalPlan(plan: OrderPlan): string {
  const pick: Record<string, unknown> = {};
  const rec = plan as unknown as Record<string, unknown>;
  for (const k of MATERIAL_FIELDS) pick[k] = rec[k] === undefined ? null : rec[k];
  return JSON.stringify(pick, (_k, v) =>
    (v && typeof v === 'object' && !Array.isArray(v))
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((kk) => [kk, (v as Record<string, unknown>)[kk]]))
      : v);
}

export function planHash(plan: OrderPlan): string {
  return createHash('sha256').update(canonicalPlan(plan)).digest('hex');
}

export interface AmendPatch {
  sizeUsd?: number;
  entry?: Trigger;
  exits?: Exit[];
  stop?: Trigger | null;
  slippageBps?: number;
  maxPriceImpactPct?: number;
  ttlMs?: number;
  chunkUsd?: number | null;
  symbol?: string;
}

/** Return a NEW plan with a material field changed (a mutated plan is a different plan: new hash, new status). */
export function amendPlan(plan: OrderPlan, patch: AmendPatch, ctx: { clock: Clock; by?: OrderPlan['source']['by']; ref?: string | null }): Readonly<OrderPlan> {
  const input: PlanInput = {
    mint: plan.mint, symbol: plan.symbol, decimals: plan.decimals, side: plan.side, sizeUsd: plan.sizeUsd,
    entry: plan.entry, exits: plan.exits, stop: plan.stop, slippageBps: plan.slippageBps,
    maxPriceImpactPct: plan.maxPriceImpactPct, ttlMs: plan.expiresAt - plan.createdAt, chunkUsd: plan.chunkUsd,
    ...patch,
  };
  return proposePlan(input, {
    supply: plan.supplyAtProposal, clock: ctx.clock,
    by: ctx.by ?? plan.source.by, ref: ctx.ref ?? plan.source.ref, batchId: plan.source.batchId,
  });
}

export function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(2)}`;
}

/** The price a market-cap trigger means at the proposal's supply snapshot. */
export function priceForMc(mcUsd: number, supply: number): number { return mcUsd / supply; }

function describeTrigger(t: Trigger, supply: number): string {
  switch (t.kind) {
    case 'immediate': return 'now';
    case 'mc-below': return `if market cap dips to ${fmtUsd(t.value)} (price $${priceForMc(t.value, supply).toPrecision(3)} at ${(supply / 1e9).toFixed(2)}B supply)`;
    case 'mc-above': return `at ${fmtUsd(t.value)} market cap`;
    case 'price-below': return `if price dips to $${t.value}`;
    case 'price-above': return `at $${t.value}`;
    default: return '?';
  }
}

/** The spoken/rendered read-back. The challenge code is appended by the confirm gate, not here. */
export function readBack(plan: OrderPlan): string {
  const s = plan.supplyAtProposal;
  const parts: string[] = [`${plan.side === 'buy' ? 'Buy' : 'Sell'} ${fmtUsd(plan.sizeUsd)} of ${plan.symbol} (mint ${plan.mint.slice(0, 4)}…${plan.mint.slice(-4)}) ${describeTrigger(plan.entry, s)}`];
  for (const e of plan.exits) parts.push(`sell ${Math.round(e.fraction * 100)}% ${describeTrigger(e.at, s)}`);
  if (plan.moonBagFraction > 0) parts.push(`keep ${Math.round(plan.moonBagFraction * 100)}% as a moon bag`);
  if (plan.stop) parts.push(`stop ${describeTrigger(plan.stop, s).replace(/^if /, '')}`);
  parts.push(`slippage ${(plan.slippageBps / 100).toFixed(1)}%`, `expires in ${Math.round((plan.expiresAt - plan.createdAt) / 60_000)} min`);
  return parts.join('; ') + '.';
}
