// task-1360 Tier 2 — the one-key MIRROR TICKET (research/wallet-intel design §6 Stage 1). A followed wallet's
// BUY alert becomes a PROPOSED order plan sized by the user's own cap, never larger than k × the leader's size
// and never more than 1 % of the pool. The three numbers the user must see are computed here and refused on:
// LAG (now − the leader's block) > 30 s, DRIFT (price now vs the leader's fill) > +5 %, liquidity < $25k, token
// age < 60 s, the leader sold since, the leader is in the token's dev cluster or holds > 5 % (they are
// distributing to you). Unknown facts are shown as unknown, never guessed. The output is a PlanInput: an inert
// proposal for the plan engine, armed only through its own keypress / Phantom gate. Nothing here trades.

import type { PlanInput } from '../plans/types.ts';
import type { CopyAlert } from './types.ts';

export const MIRROR_LIMITS = Object.freeze({
  maxLagMs: 30_000,
  maxDriftPct: 5,
  minLiqUsd: 25_000,
  minAgeMs: 60_000,
  maxLeaderHoldPct: 5,
  /** a mirror never takes more than this fraction of the pool's liquidity */
  maxLiqFraction: 0.01,
  /** a mirror proposal is time-sensitive: it expires fast (plan TTL) */
  ttlMs: 10 * 60_000,
  slippageBps: 300,
  maxPriceImpactPct: 3,
});

export interface MirrorMarket {
  symbol: string | null;
  decimals: number | null;
  priceUsd: number | null;
  /** when `priceUsd` was observed (for the "price age" caption) */
  priceAt: number | null;
  liqUsd: number | null;
  mcapUsd: number | null;
  /** ms since the pair was created; null unknown */
  ageMs: number | null;
}

export interface MirrorContext {
  now: number;
  /** the user's own cap for ONE mirror ticket (USD) */
  capUsd: number;
  /** size factor vs the leader's size (default 1) */
  k?: number;
  market: MirrorMarket | null;
  /** did the leader sell this mint after the alerted buy? null = unknown */
  leaderSoldSince: boolean | null;
  /** from a wallet-intel scan of the token, when one exists */
  leaderIntel: { inDevCluster: boolean; holdsPct: number | null } | null;
}

export interface MirrorCheck { name: string; ok: boolean | null; detail: string }

export type MirrorRefuseReason = 'not-a-buy' | 'unpriced' | 'no-market' | 'no-decimals' | 'lag' | 'drift' | 'liquidity' | 'age' | 'leader-sold' | 'leader-dev' | 'leader-holds' | 'cap';

export interface MirrorRefusal { ok: false; reason: MirrorRefuseReason; message: string; checks: MirrorCheck[] }
export interface MirrorOk {
  ok: true;
  sizeUsd: number;
  sizeWhy: string;
  lagMs: number | null;
  driftPct: number | null;
  leaderPriceUsd: number | null;
  checks: MirrorCheck[];
  /** the inert proposal input for PlanService.propose(input, { supply, by: 'copy', ref }) */
  input: PlanInput;
  supply: number;
  ref: string;
}
export type MirrorResult = MirrorOk | MirrorRefusal;

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const usd = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`);

/** The leader's fill price in USD per whole token, from the alerted trade (null without decimals / USD). */
export function leaderFillPriceUsd(alert: CopyAlert, decimals: number | null): number | null {
  const tr = alert.trade;
  if (tr.usd === null || decimals === null) return null;
  const raw = Math.abs(Number(tr.tokenDelta));
  if (!(raw > 0)) return null;
  return tr.usd / (raw / 10 ** decimals);
}

/** Build the mirror proposal (or the refusal with every check listed). Pure. */
export function buildMirror(alert: CopyAlert, ctx: MirrorContext): MirrorResult {
  const checks: MirrorCheck[] = [];
  const tr = alert.trade;
  const refuse = (reason: MirrorRefuseReason, message: string): MirrorRefusal => ({ ok: false, reason, message, checks });
  if (tr.side !== 'buy') return refuse('not-a-buy', `only a leader BUY can be mirrored (this is a ${tr.side})`);
  if (tr.usd === null) return refuse('unpriced', 'the leader\'s fill has no USD value (token-swap leg or no SOL price); nothing to size from');
  const m = ctx.market;
  if (!m || m.priceUsd === null || !(m.priceUsd > 0)) return refuse('no-market', 'no price for this token yet (open it, or wait for the board)');
  // lag
  const lagMs = tr.tKnown ? Math.max(0, ctx.now - tr.t) : null;
  checks.push({ name: 'lag', ok: lagMs === null ? null : lagMs <= MIRROR_LIMITS.maxLagMs, detail: lagMs === null ? 'block time unknown' : `${(lagMs / 1000).toFixed(0)} s since the leader\'s block (max ${MIRROR_LIMITS.maxLagMs / 1000} s)` });
  // drift
  const leaderPrice = leaderFillPriceUsd(alert, m.decimals);
  const driftPct = leaderPrice === null ? null : ((m.priceUsd - leaderPrice) / leaderPrice) * 100;
  const priceAge = m.priceAt === null ? null : Math.max(0, ctx.now - m.priceAt);
  checks.push({ name: 'drift', ok: driftPct === null ? null : driftPct <= MIRROR_LIMITS.maxDriftPct, detail: driftPct === null ? (m.decimals === null ? 'token decimals unknown' : 'leader fill price unknown') : `${pct(driftPct)} vs the leader\'s fill $${leaderPrice!.toPrecision(3)} (now $${m.priceUsd.toPrecision(3)}${priceAge !== null ? `, ${Math.round(priceAge / 1000)} s old` : ''}; max +${MIRROR_LIMITS.maxDriftPct}%)` });
  // liquidity
  checks.push({ name: 'liquidity', ok: m.liqUsd === null ? null : m.liqUsd >= MIRROR_LIMITS.minLiqUsd, detail: m.liqUsd === null ? 'liquidity unknown' : `${usd(m.liqUsd)} (min ${usd(MIRROR_LIMITS.minLiqUsd)})` });
  // age
  checks.push({ name: 'age', ok: m.ageMs === null ? null : m.ageMs >= MIRROR_LIMITS.minAgeMs, detail: m.ageMs === null ? 'pair age unknown' : `${Math.round(m.ageMs / 1000)} s old (min ${MIRROR_LIMITS.minAgeMs / 1000} s)` });
  // leader sold since
  checks.push({ name: 'leader-sold', ok: ctx.leaderSoldSince === null ? null : !ctx.leaderSoldSince, detail: ctx.leaderSoldSince === null ? 'unknown' : ctx.leaderSoldSince ? 'the leader already SOLD this mint since the buy' : 'the leader still holds (as far as fetched history shows)' });
  // leader intel
  const li = ctx.leaderIntel;
  checks.push({ name: 'leader-dev', ok: li === null ? null : !li.inDevCluster, detail: li === null ? 'token not scanned (M on the token)' : li.inDevCluster ? 'the leader is linked to the dev cluster: they may be distributing to you' : 'not in the dev cluster' });
  checks.push({ name: 'leader-holds', ok: li === null || li.holdsPct === null ? null : li.holdsPct <= MIRROR_LIMITS.maxLeaderHoldPct, detail: li === null || li.holdsPct === null ? 'leader\'s share unknown' : `${li.holdsPct.toFixed(1)}% of supply (max ${MIRROR_LIMITS.maxLeaderHoldPct}%)` });
  for (const c of checks) {
    if (c.ok === false) {
      const reason = c.name as MirrorRefuseReason;
      return refuse(reason, `refused: ${c.name} — ${c.detail}`);
    }
  }
  if (m.decimals === null) return refuse('no-decimals', 'token decimals unknown: open the token so its decimals and price are known, then mirror again');
  // size = min(own cap, k × leader size, 1 % of liquidity)
  const k = ctx.k && ctx.k > 0 ? ctx.k : 1;
  const parts: Array<[number, string]> = [[ctx.capUsd, 'your cap'], [k * tr.usd, `${k}× the leader\'s ${usd(tr.usd)}`]];
  if (m.liqUsd !== null) parts.push([m.liqUsd * MIRROR_LIMITS.maxLiqFraction, '1% of liquidity']);
  parts.sort((a, b) => a[0] - b[0]);
  const sizeUsd = Math.floor(parts[0][0] * 100) / 100;
  if (!(sizeUsd >= 0.01)) return refuse('cap', 'the mirror size rounds to nothing (raise your cap or wait for a bigger leader buy)');
  const supply = m.mcapUsd !== null && m.mcapUsd > 0 ? m.mcapUsd / m.priceUsd : 1e9;
  const input: PlanInput = {
    mint: tr.mint, symbol: m.symbol ?? tr.mint.slice(0, 4), decimals: m.decimals, side: 'buy', sizeUsd,
    entry: { kind: 'immediate' }, exits: [], stop: null,
    slippageBps: MIRROR_LIMITS.slippageBps, maxPriceImpactPct: MIRROR_LIMITS.maxPriceImpactPct, ttlMs: MIRROR_LIMITS.ttlMs,
  };
  return { ok: true, sizeUsd, sizeWhy: `min(${parts.map((p) => `${p[1]} ${usd(p[0])}`).join(', ')})`, lagMs, driftPct, leaderPriceUsd: leaderPrice, checks, input, supply, ref: `mirror:${alert.wallet}:${tr.sig.slice(0, 16)}` };
}

/** Did the leader sell `mint` after the alerted buy, as far as the tracker's trades show? */
export function leaderSoldSince(alert: CopyAlert, trades: readonly { mint: string; side: string; slot: number; sig: string }[]): boolean {
  return trades.some((t) => t.mint === alert.trade.mint && t.side === 'sell' && (t.slot > alert.trade.slot || (t.slot === alert.trade.slot && t.sig > alert.trade.sig)));
}
