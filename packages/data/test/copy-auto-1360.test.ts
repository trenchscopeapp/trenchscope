// task-1360 Tier 3 — CAPPED AUTO-MIRROR (money tier): default off; enabling needs a physical gesture AND the engine's
// "less safe" popup AND arms a buy-only copy mandate with the policy's caps (clamped); each leader buy is mirrored at
// the hands-free tier (¼ of the per-trade cap) inside per-wallet cooldown / max-open / daily caps that the plan engine
// re-checks signer-side; panic, gate restore, mandate death and a refusal streak all turn it off; it is OFF after a
// restart. Plus the compromised-model suite: nothing a voice/agent/forged path can do turns it on or widens it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyAuto, CopyAutoError, draftPolicy, autoSizeCap, AUTO_HARD, decodeTx, type CopyAlert, type MirrorMarket } from '../src/trade/copy/index.ts';
import { PlanService, HARD, PolicyRefusal } from '../src/trade/plans/index.ts';
import { SimClock, mkTx, sig, addr, LEADER, LEADER2, MINT_A } from './copy-helpers.ts';
import { FixtureExecutor } from './plans-helpers.ts';

const SOL = 1_000_000_000;
const T0 = 1_700_000_000_000;
const PRICE = 50; // $ per whole token (6 decimals); the leader always buys 1 token for $50 at $100/SOL (0.5 SOL)
const MARKET: MirrorMarket = { symbol: 'TRENCH', decimals: 6, priceUsd: PRICE, priceAt: null, liqUsd: 80_000, mcapUsd: PRICE * 1e6, ageMs: 3_600_000 };
const SUPPLY = 1e6;

function alertAt(clock: SimClock, n: number, opts: { side?: 'buy' | 'sell'; wallet?: string; mint?: string } = {}): CopyAlert {
  const wallet = opts.wallet ?? LEADER;
  const mint = opts.mint ?? MINT_A;
  const sell = opts.side === 'sell';
  const tx = mkTx({ slot: 1000 + n, blockTime: Math.floor(clock.now() / 1000) - 2, sig: sig(100 + n), wallet, tokens: [{ mint, pre: sell ? 1_000_000n : 0n, post: sell ? 0n : 1_000_000n }], lamports: sell ? [SOL, SOL + 0.5 * SOL] : [SOL, SOL - 0.5 * SOL] });
  const trade = decodeTx(tx, wallet, { solUsd: 100 })[0];
  return { id: `a${n}`, t: clock.now(), wallet, name: 'leader', trade, lagMs: 2_000 };
}

function mk(opts: { journalPath?: string | null; plansPath?: string | null; executor?: FixtureExecutor; market?: () => Promise<MirrorMarket | null>; followed?: Set<string> } = {}) {
  const clock = new SimClock(T0);
  const plans = new PlanService({ clock, journalPath: opts.plansPath ?? null, rng: () => 0.42, ...(opts.executor ? { executor: opts.executor } : {}) });
  const followed = opts.followed ?? new Set([LEADER]);
  const auto = new CopyAuto({ plans, clock, journalPath: opts.journalPath ?? null, market: opts.market ?? (async () => MARKET), isFollowed: (w) => followed.has(w) });
  return { clock, plans, auto, followed };
}
/** Two fresh ticks at the market price: the engine fires the armed mirror (paper fill). */
function fire(plans: PlanService, clock: SimClock, mint = MINT_A): void { for (let i = 0; i < 2; i++) { clock.advance(500); plans.tick({ mint, priceUsd: PRICE, supply: SUPPLY, ts: clock.now(), source: 'paper' }); } }
function accept(plans: PlanService): void { plans.acceptRisk({ gesture: 'keypress' }); }

test('policy: default OFF, every cap clamped DOWN to AUTO_HARD (never up), redraft refused while enabled', () => {
  const { auto, plans } = mk();
  const p = auto.draft(LEADER, { perTradeUsd: 1e9, dailyUsd: 1e9, maxOpen: 999, cooldownMs: 1, k: 50, autoDisarmStreak: 99, ttlMs: 1e12 });
  assert.equal(p.enabled, false); assert.equal(p.mandateId, null);
  assert.equal(p.perTradeUsd, AUTO_HARD.perTradeUsd); assert.equal(p.dailyUsd, AUTO_HARD.dailyUsd); assert.equal(p.maxOpen, AUTO_HARD.maxOpen);
  assert.equal(p.cooldownMs, AUTO_HARD.minCooldownMs); assert.equal(p.k, AUTO_HARD.maxK); assert.equal(p.autoDisarmStreak, AUTO_HARD.maxDisarmStreak); assert.equal(p.ttlMs, AUTO_HARD.ttlMs);
  assert.ok(AUTO_HARD.perTradeUsd <= HARD.perTradeUsd && AUTO_HARD.dailyUsd <= HARD.totalUsd, 'auto ceilings sit under the engine\'s');
  const d = draftPolicy(LEADER, { perTradeUsd: 'junk', dailyUsd: -5 });
  assert.equal(d.perTradeUsd, 20); assert.equal(d.dailyUsd, 100);
  assert.equal(draftPolicy(LEADER, { perTradeUsd: 50, dailyUsd: 10 }).dailyUsd, 10, 'a daily cap below the per-trade cap is allowed (fewer, smaller mirrors)');
  assert.ok(Object.isFrozen(p));
  accept(plans);
  auto.enable(LEADER, { gesture: 'keypress' });
  assert.throws(() => auto.draft(LEADER, { perTradeUsd: 1 }), (e: unknown) => e instanceof CopyAutoError && e.reason === 'enabled');
  // no cap-raising surface exists
  for (const name of ['raiseCap', 'setCaps', 'widen', 'sign', 'arm']) assert.equal(typeof (auto as unknown as Record<string, unknown>)[name], 'undefined');
});

test('enable: refused without a keypress/Phantom gesture, while the gate is ON, when not followed, without a policy; ON arms a buy-only hands-free copy mandate with the policy caps', () => {
  const { auto, plans, followed } = mk();
  assert.throws(() => auto.enable(LEADER, { gesture: 'keypress' }), (e: unknown) => e instanceof CopyAutoError && e.reason === 'no-policy');
  auto.draft(LEADER, { perTradeUsd: 20, dailyUsd: 60, maxOpen: 2, cooldownMs: 10_000 });
  for (const g of [null, undefined, {}, { gesture: 'spoken-free' }, { gesture: 'spoken-ptt' }, { gesture: 'voice' }, { gesture: 'agent' }, { gesture: 'copy-auto' }]) {
    assert.throws(() => auto.enable(LEADER, g as never), (e: unknown) => e instanceof CopyAutoError && e.reason === 'needs-keypress', `gesture ${JSON.stringify(g)}`);
  }
  assert.throws(() => auto.enable(LEADER, { gesture: 'keypress' }), (e: unknown) => e instanceof CopyAutoError && e.reason === 'gate-on', 'the less-safe popup must be accepted first');
  assert.equal(auto.policy(LEADER)!.enabled, false); assert.equal(plans.listMandates().length, 0, 'nothing drafted or armed by the refusals');
  accept(plans);
  followed.delete(LEADER);
  assert.throws(() => auto.enable(LEADER, { gesture: 'keypress' }), (e: unknown) => e instanceof CopyAutoError && e.reason === 'not-followed');
  followed.add(LEADER);
  const p = auto.enable(LEADER, { gesture: 'keypress' });
  assert.equal(p.enabled, true); assert.ok(p.mandateId);
  const m = plans.engine.mandates.get(p.mandateId!)!.m;
  assert.equal(m.status, 'armed'); assert.equal(m.maxTier, 'hands-free'); assert.deepEqual(m.allowed.actions, ['buy']); assert.equal(m.allowed.mints, null);
  assert.equal(m.budget.perTradeUsd, 20); assert.equal(m.budget.perCoinUsd, 20); assert.equal(m.budget.totalUsd, 60); assert.equal(m.budget.dailyLossUsd, 60); assert.equal(m.limits.maxOpenPositions, 2);
  assert.equal(m.armedBy!.gesture, 'keypress');
  const st = auto.status(LEADER);
  assert.equal(st.enabled, true); assert.equal(st.gateActive, true); assert.equal(st.mandateAlive, true); assert.equal(st.spent24hUsd, 0); assert.equal(st.open, 0);
  assert.deepEqual(auto.journal.types().filter((t) => t.startsWith('copy.')), ['copy.policy', 'copy.auto.enabled']);
  // Phantom approval is the other accepted gesture
  const { auto: a2, plans: p2 } = mk(); a2.draft(LEADER, {}); accept(p2);
  assert.equal(a2.enable(LEADER, { gesture: 'phantom' }).enabled, true);
  // disable is always allowed and revokes the copy mandate
  auto.disable(LEADER, 'user');
  assert.equal(auto.policy(LEADER)!.enabled, false); assert.equal(plans.engine.mandates.get(p.mandateId!)!.m.status, 'revoked');
});

test('auto path: a leader buy → mirror proposed by "copy" and armed at ¼ of the per-trade cap → paper fill; cooldown, max-open and the daily cap refuse; the engine holds the same caps signer-side', async () => {
  const { auto, plans, clock } = mk();
  auto.draft(LEADER, { perTradeUsd: 20, dailyUsd: 13, maxOpen: 9, cooldownMs: 10_000 });
  // OFF: nothing happens
  assert.deepEqual(await auto.onAlert(alertAt(clock, 1)), { kind: 'ignored', why: 'auto-mirror off for this wallet' });
  assert.equal(plans.listPlans().length, 0);
  accept(plans);
  auto.enable(LEADER, { gesture: 'keypress' });
  assert.equal(autoSizeCap(auto.policy(LEADER)!), 3.25, '¼ of min(per-trade $20, daily $13): the engine clamps a mandate\'s per-trade to its total');
  const o1 = await auto.onAlert(alertAt(clock, 2));
  assert.equal(o1.kind, 'armed', JSON.stringify(o1));
  assert.ok(o1.kind === 'armed');
  assert.equal(o1.sizeUsd, 3.25, 'the hands-free tier size');
  const row = plans.listPlans().find((r) => r.id === o1.planId)!;
  assert.equal(row.status, 'armed'); assert.equal(row.tier, 'hands-free'); assert.equal(row.mandateId, o1.mandateId);
  assert.equal(plans.engine.plan(o1.planId)!.source.by, 'copy'); assert.match(plans.engine.plan(o1.planId)!.source.ref!, /^copy-auto:/);
  fire(plans, clock);
  assert.equal(plans.summary(o1.planId).status, 'filled'); assert.ok(Math.abs(plans.ledger(o1.mandateId).spentUsd - 3.25) < 1e-6);
  assert.equal(auto.status(LEADER).open, 1); assert.equal(auto.status(LEADER).spent24hUsd, 3.25);
  // cooldown
  const o2 = await auto.onAlert(alertAt(clock, 3));
  assert.equal(o2.kind, 'refused'); assert.equal((o2 as { reason: string }).reason, 'cooldown'); assert.equal(plans.listPlans().length, 1, 'no proposal on a cooldown refusal');
  for (const n of [4, 5, 6]) { clock.advance(10_000); const o = await auto.onAlert(alertAt(clock, n)); assert.equal(o.kind, 'armed', JSON.stringify(o)); assert.equal((o as { sizeUsd: number }).sizeUsd, 3.25); fire(plans, clock); }
  assert.equal(auto.status(LEADER).spent24hUsd, 13); assert.equal(auto.status(LEADER).open, 4);
  clock.advance(10_000);
  const o5 = await auto.onAlert(alertAt(clock, 7)); assert.equal(o5.kind, 'refused'); assert.equal((o5 as { reason: string }).reason, 'daily-cap');
  // a daily remainder below the tier size clips the mirror to it
  const { auto: ac, plans: pc, clock: cc } = mk();
  ac.draft(LEADER, { perTradeUsd: 20, dailyUsd: 23, maxOpen: 9, cooldownMs: 10_000 }); accept(pc); ac.enable(LEADER, { gesture: 'keypress' });
  // (per coin ≤ the per-trade cap, so the leader's buys here are of different coins)
  for (let i = 0; i < 4; i++) { cc.advance(10_000); const o = await ac.onAlert(alertAt(cc, i, { mint: addr(300 + i) })); assert.equal(o.kind, 'armed', JSON.stringify(o)); assert.equal((o as { sizeUsd: number }).sizeUsd, 5); fire(pc, cc, addr(300 + i)); }
  cc.advance(10_000);
  const clipped = await ac.onAlert(alertAt(cc, 40, { mint: addr(340) })); assert.equal(clipped.kind, 'armed', JSON.stringify(clipped)); assert.equal((clipped as { sizeUsd: number }).sizeUsd, 3, 'the last $3 of the $23 daily cap'); fire(pc, cc, addr(340));
  cc.advance(10_000);
  assert.equal(((await ac.onAlert(alertAt(cc, 41))) as { reason: string }).reason, 'daily-cap');
  // signer-side: the copy mandate's total IS the daily cap, so even a hand-armed plan into it is refused now
  const extra = plans.propose({ mint: MINT_A, symbol: 'X', decimals: 6, side: 'buy', sizeUsd: 1, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'user' });
  assert.throws(() => plans.armPlanByKeypress(extra.id, o1.mandateId), (e: unknown) => e instanceof PolicyRefusal && (e.reason === 'total-cap' || e.reason === 'per-coin-cap'), 'the engine refuses on its own caps (total = daily; per coin ≤ per trade)');
  // max-open with a fresh day
  const { auto: a2, plans: p2, clock: c2 } = mk();
  a2.draft(LEADER, { perTradeUsd: 20, dailyUsd: 500, maxOpen: 1, cooldownMs: 10_000 }); accept(p2); a2.enable(LEADER, { gesture: 'keypress' });
  assert.equal((await a2.onAlert(alertAt(c2, 1))).kind, 'armed'); fire(p2, c2); c2.advance(10_000);
  const mo = await a2.onAlert(alertAt(c2, 2)); assert.equal(mo.kind, 'refused'); assert.equal((mo as { reason: string }).reason, 'max-open');
  // a sell alert and a mirror refusal (drift) leave no armed plan
  assert.equal((await a2.onAlert(alertAt(c2, 3, { side: 'sell' }))).kind, 'ignored');
  const { auto: a3, plans: p3, clock: c3 } = mk({ market: async () => ({ ...MARKET, priceUsd: PRICE * 1.2 }) });
  a3.draft(LEADER, {}); accept(p3); a3.enable(LEADER, { gesture: 'keypress' });
  const dr = await a3.onAlert(alertAt(c3, 1)); assert.equal(dr.kind, 'refused'); assert.equal((dr as { reason: string }).reason, 'drift'); assert.equal(p3.listPlans().length, 0);
  assert.ok(auto.verifyJournal().ok);
});

test('kill paths: gate restored → paused (resumes on re-accept); copy mandate revoked → off; panic → everything off + engine panic; refusal streak → auto-disarm; a failed fill counts via tick()', async () => {
  const { auto, plans, clock } = mk();
  auto.draft(LEADER, { perTradeUsd: 20, dailyUsd: 500, maxOpen: 9, cooldownMs: 10_000, autoDisarmStreak: 3 }); accept(plans); auto.enable(LEADER, { gesture: 'keypress' });
  plans.restoreGate();
  const g = await auto.onAlert(alertAt(clock, 1)); assert.equal(g.kind, 'refused'); assert.equal((g as { reason: string }).reason, 'gate-on');
  assert.equal(auto.policy(LEADER)!.enabled, true, 'paused, not off');
  accept(plans); clock.advance(10_000);
  assert.equal((await auto.onAlert(alertAt(clock, 2))).kind, 'armed');
  // the copy mandate dies underneath → off with the reason
  plans.revokeMandate(auto.policy(LEADER)!.mandateId!, 'test');
  clock.advance(10_000);
  const dead = await auto.onAlert(alertAt(clock, 3)); assert.equal(dead.kind, 'refused'); assert.equal((dead as { reason: string }).reason, 'mandate-revoked');
  assert.equal(auto.policy(LEADER)!.enabled, false); assert.match(auto.policy(LEADER)!.offReason!, /mandate-revoked/);
  // streak: three refusals in a row disarm
  const { auto: a2, plans: p2, clock: c2 } = mk({ market: async () => ({ ...MARKET, liqUsd: 100 }) });
  a2.draft(LEADER, { autoDisarmStreak: 3, cooldownMs: 10_000 }); accept(p2); a2.enable(LEADER, { gesture: 'keypress' });
  for (let i = 0; i < 3; i++) { c2.advance(10_000); assert.equal((await a2.onAlert(alertAt(c2, i))).kind, 'refused'); }
  assert.equal(a2.policy(LEADER)!.enabled, false); assert.match(a2.policy(LEADER)!.offReason!, /auto-disarm: 3 consecutive/);
  assert.equal(p2.listMandates()[0].status, 'revoked');
  // a failed fill (send-failed ×3 = entry failed) is judged by tick()
  const c3 = new SimClock(T0);
  const ex = new FixtureExecutor({ clock: c3 });
  ex.script(`mint:${MINT_A}`, [{ kind: 'send-failed', error: 'blockhash' }, { kind: 'send-failed', error: 'blockhash' }, { kind: 'send-failed', error: 'blockhash' }]);
  const p3 = new PlanService({ clock: c3, executor: ex, rng: () => 0.42 });
  const a3 = new CopyAuto({ plans: p3, clock: c3, market: async () => MARKET });
  a3.draft(LEADER, { autoDisarmStreak: 1 }); accept(p3); a3.enable(LEADER, { gesture: 'keypress' });
  const armed = await a3.onAlert(alertAt(c3, 1)); assert.equal(armed.kind, 'armed');
  for (let i = 0; i < 4; i++) fire(p3, c3);
  assert.equal(p3.summary((armed as { planId: string }).planId).status, 'failed');
  a3.tick();
  assert.equal(a3.policy(LEADER)!.enabled, false); assert.match(a3.policy(LEADER)!.offReason!, /entry failed/);
  // panic
  const { auto: a4, plans: p4, clock: c4 } = mk();
  a4.draft(LEADER, {}); accept(p4); a4.enable(LEADER, { gesture: 'keypress' });
  assert.equal((await a4.onAlert(alertAt(c4, 1))).kind, 'armed');
  a4.panic('test');
  assert.equal(a4.policy(LEADER)!.enabled, false); assert.equal(a4.isPanicked, true);
  assert.ok(p4.listMandates().every((m) => m.status === 'revoked')); assert.ok(p4.listPlans().every((r) => r.status === 'cancelled'));
  assert.throws(() => a4.enable(LEADER, { gesture: 'keypress' }), (e: unknown) => e instanceof CopyAutoError && e.reason === 'panicked');
  assert.equal((await a4.onAlert(alertAt(c4, 2))).kind, 'ignored');
});

test('restart: policies come back OFF, a copy mandate the engine recovered as armed is revoked, the auto-plan ledger survives, the chain verifies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-copy-auto-'));
  const journalPath = join(dir, 'copy.journal'), plansPath = join(dir, 'plans.journal');
  const first = mk({ journalPath, plansPath });
  first.auto.draft(LEADER, { perTradeUsd: 40 }); accept(first.plans); first.auto.enable(LEADER, { gesture: 'keypress' });
  const o = await first.auto.onAlert(alertAt(first.clock, 1)); assert.equal(o.kind, 'armed');
  const mandateId = first.auto.policy(LEADER)!.mandateId!;
  const second = mk({ journalPath, plansPath });
  const p = second.auto.policy(LEADER)!;
  assert.equal(p.enabled, false); assert.equal(p.perTradeUsd, 40); assert.match(p.offReason!, /off after restart/);
  assert.equal(second.plans.engine.mandates.get(mandateId)!.m.status, 'revoked', 'the recovered copy mandate is revoked on load');
  assert.deepEqual(second.auto.autoPlanIds(LEADER), [(o as { planId: string }).planId]);
  assert.equal(second.plans.riskStatus().active, false, 'the less-safe acceptance is per run too');
  assert.equal((await second.auto.onAlert(alertAt(second.clock, 2))).kind, 'ignored');
  assert.ok(second.auto.verifyJournal().ok);
  assert.ok(second.auto.journal.types().includes('copy.recovered'));
});

test('compromised model: no voice/claude/agent/forged path can enable auto-mirror, widen it, or get a plan it did not create auto-armed', async () => {
  const { auto, plans, clock } = mk();
  auto.draft(LEADER, { perTradeUsd: 20 });
  // 1) plans proposed by voice / claude / an agent for the same mint are never touched by the auto service
  const byVoice = plans.propose({ mint: MINT_A, symbol: 'T', decimals: 6, side: 'buy', sizeUsd: 5, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'voice' });
  const byClaude = plans.propose({ mint: MINT_A, symbol: 'T', decimals: 6, side: 'buy', sizeUsd: 5, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'claude' });
  accept(plans); auto.enable(LEADER, { gesture: 'keypress' });
  const o = await auto.onAlert(alertAt(clock, 1)); assert.equal(o.kind, 'armed');
  assert.equal(plans.summary(byVoice.id).status, 'proposed'); assert.equal(plans.summary(byClaude.id).status, 'proposed');
  assert.deepEqual(auto.autoPlanIds(), [(o as { planId: string }).planId]);
  // 2) a spoofed alert for a wallet without a policy, or an unfollowed wallet, does nothing
  assert.equal((await auto.onAlert(alertAt(clock, 2, { wallet: LEADER2 }))).kind, 'ignored');
  auto.draft(LEADER2, {});
  assert.equal((await auto.onAlert(alertAt(clock, 3, { wallet: LEADER2 }))).kind, 'ignored', 'drafted but never enabled');
  assert.equal(plans.listPlans().filter((r) => r.status === 'armed' || r.status === 'filled').length, 1);
  // 3) a voice/agent "gesture" cannot enable; neither can a spoken proof accept the popup underneath
  for (const g of ['spoken-free', 'spoken-ptt', 'agent', 'voice', 'copy-auto']) assert.throws(() => auto.enable(LEADER2, { gesture: g }), (e: unknown) => e instanceof CopyAutoError && e.reason === 'needs-keypress');
  assert.throws(() => plans.acceptRisk({ gesture: 'spoken-free' }));
  // 4) a redraft with huge caps is clamped, and refused outright while ON
  assert.throws(() => auto.draft(LEADER, { perTradeUsd: 1e9 }), (e: unknown) => e instanceof CopyAutoError && e.reason === 'enabled');
  assert.equal(auto.draft(LEADER2, { perTradeUsd: 1e9, dailyUsd: 1e9 }).perTradeUsd, AUTO_HARD.perTradeUsd);
  // 5) the engine still refuses a copy-auto proof for a plan outside the copy mandate's rules (sell, over-cap, wrong hash)
  const sellPlan = plans.propose({ mint: MINT_A, symbol: 'T', decimals: 6, side: 'sell', sizeUsd: 1, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'copy' });
  const mandateId = auto.policy(LEADER)!.mandateId!;
  assert.throws(() => plans.armPlan(sellPlan.id, { id: 'f1', kind: 'gesture', signerIssued: true, gesture: 'copy-auto', subject: `plan:${sellPlan.id}:${sellPlan.hash}`, consumed: false }, mandateId), { reason: 'unissued-proof' });
  const big = plans.propose({ mint: MINT_A, symbol: 'T', decimals: 6, side: 'buy', sizeUsd: 6, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'copy' });
  assert.throws(() => plans.armPlan(big.id, { id: 'f2', kind: 'gesture', signerIssued: true, gesture: 'copy-auto', subject: `plan:${big.id}:${big.hash}`, consumed: false }, mandateId), { reason: 'unissued-proof' });
  assert.throws(() => plans.armPlan(byVoice.id, { id: 'f3', kind: 'gesture', signerIssued: true, gesture: 'copy-auto', subject: `plan:${byVoice.id}:deadbeef`, consumed: false }, mandateId), { reason: 'unissued-proof' });
  // 6) a keypress-only mandate never accepts the auto tier
  const strict = plans.draftMandate({ totalUsd: 100, perTradeUsd: 20, maxTier: 'keypress' }); plans.armMandateByKeypress(strict.id);
  const p6 = plans.propose({ mint: MINT_A, symbol: 'T', decimals: 6, side: 'buy', sizeUsd: 1, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'copy' });
  assert.throws(() => plans.armPlan(p6.id, { id: 'f4', kind: 'gesture', signerIssued: true, gesture: 'copy-auto', subject: `plan:${p6.id}:${p6.hash}`, consumed: false }, strict.id), { reason: 'unissued-proof' });
  assert.ok(auto.verifyJournal().ok);
});
