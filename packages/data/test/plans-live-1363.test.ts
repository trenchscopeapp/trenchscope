// task-1363 — the LIVE fire path for order plans: LivePlanExecutor over a (fake, in-process) signer port, the
// PlanService paper ⇄ live switch (keypress only, no open plans), and the engine's journal of a devnet fill.
// No network, no key, no funds: the "signer" here is a scripted SignerPort; the real signer-side pipeline is
// covered by signer-fast-1363.test.ts, and the two meet over the same `fill`/`confirm` methods.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlanService } from '../src/trade/plans/service.ts';
import { LivePlanExecutor } from '../src/trade/plans/executor-live.ts';
import { RpcOutage } from '../src/trade/plans/executor.ts';
import type { SignerPort } from '../src/trade/signer/client.ts';
import type { PlanView, ConfirmView, StatusView, FastView, FillParams } from '../src/trade/signer/protocol.ts';
import { SimClock, SUPPLY, NORTH_STAR_PLAN, DEFAULT_MANDATE, priceAtMc, TOKEN } from './plans-helpers.ts';

const FAST_PK = 'FaStWa11etPubKey111111111111111111111111111';
const T0 = 1_700_000_000_000;

/** A scripted signer port: `fill` answers with a view whose verdict the test sets; `confirm` with the scripted outcome. Every call is recorded. */
class FakeSigner implements SignerPort {
  alive = true;
  calls: string[] = [];
  network: 'devnet' | 'mainnet' = 'devnet';
  fastLoaded = true;
  /** per-ref precheck verdict override (what the signer's view carries) */
  prechecks = new Map<string, { ok: boolean; reason?: string; message?: string }>();
  policyBad: { reason: string; message: string } | null = null;
  fillError: Error | null = null;
  confirmOutcome: ((hash: string) => ConfirmView | Promise<ConfirmView>) | null = null;
  confirmError: Error | null = null;
  /** resolve/reject the NEXT fill/confirm by hand (to interleave engine ticks with async answers) */
  holdFill = false; holdConfirm = false;
  private heldFills: (() => void)[] = []; private heldConfirms: (() => void)[] = [];
  releaseFills(): void { for (const r of this.heldFills.splice(0)) r(); }
  releaseConfirms(): void { for (const r of this.heldConfirms.splice(0)) r(); }
  built = new Map<string, FillParams>();
  async status(): Promise<StatusView> { this.calls.push('status'); return { version: 1, pid: 1, linked: null, fastWallet: this.fastLoaded ? { publicKey: FAST_PK } : null, network: this.network, rpcHost: 'api.devnet.solana.com', caps: { network: this.network, mainnetEnabled: false, perTradeUsd: 5, dailyUsd: 20, maxPriceImpactPct: 3, maxSolOut: 1, maxSlippageBps: 500 }, panic: null, ledgerLocked: null, spentTodayUsd: 0, plans: 0, solUsd: { price: 150, sources: ['dexscreener'] }, probeAvailable: true }; }
  async plan(): Promise<PlanView> { this.calls.push('plan'); throw new Error('not a plan path'); }
  async probe(): Promise<PlanView> { this.calls.push('probe'); throw new Error('not a plan path'); }
  async precheck(hash: string): Promise<{ ok: boolean }> { this.calls.push(`precheck:${hash.slice(0, 6)}`); return { ok: true }; }
  async drop(hash: string): Promise<void> { this.calls.push(`drop:${hash.slice(0, 6)}`); }
  async panic(): Promise<void> { this.calls.push('panic'); }
  async fast(): Promise<FastView> { this.calls.push('fast'); return { loaded: this.fastLoaded, publicKey: this.fastLoaded ? FAST_PK : null, network: 'devnet', balanceLamports: '1000000000', maxSolPerFill: 0.05, createdAt: T0, reason: this.fastLoaded ? null : 'no fast wallet: `trenchscope wallet fast create`' }; }
  async fill(p: FillParams): Promise<PlanView> {
    this.calls.push(`fill:${p.ref}:${p.side}:${p.lamports}`);
    if (this.holdFill) await new Promise<void>((r) => this.heldFills.push(r));
    if (this.fillError) throw this.fillError;
    this.built.set(p.ref, p);
    const hash = `h_${p.ref}_${this.calls.length}`.padEnd(64, '0').slice(0, 64);
    const pre = this.prechecks.get(p.ref) ?? { ok: true };
    return {
      hash, kind: 'devnet-fill', lane: 'fast', ref: p.ref, network: 'devnet', mint: p.mint, symbol: p.symbol, side: p.side, decimals: p.decimals,
      amountInRaw: p.lamports, amountOutRaw: p.lamports, minOutRaw: p.lamports, slippageBps: 0, route: ['devnet-fill'], priceImpactPct: 0,
      notionalUsd: Number(p.lamports) / 1e9 * 150, solUsd: { price: 150, sources: ['dexscreener'] },
      sim: { ran: true, ok: true, error: null, unitsConsumed: null, solOutLamports: '5000' }, feeLamports: '5000', prioritizationFeeLamports: null,
      instructions: [{ program: 'Memo', op: 'memo' }], policy: this.policyBad ? { ok: false, ...this.policyBad } : { ok: true }, precheck: pre,
      userPublicKey: FAST_PK, builtAt: T0, expiresAt: Number.MAX_SAFE_INTEGER,
    };
  }
  async confirm(hash: string): Promise<ConfirmView> {
    this.calls.push(`confirm:${hash.slice(0, 12)}`);
    if (this.holdConfirm) await new Promise<void>((r) => this.heldConfirms.push(r));
    if (this.confirmError) throw this.confirmError;
    if (this.confirmOutcome) return this.confirmOutcome(hash);
    return { kind: 'filled', signature: `SIG_${hash.slice(2, 10)}`, fill: { t: T0, mint: TOKEN.mint, symbol: TOKEN.symbol, side: 'buy', decimals: 6, solDelta: '-5000', tokenDelta: '0', feeLamports: '5000', priceSol: 0, realizedLamports: '0' }, roundTripMs: 40, lighthouseTail: 0, network: 'devnet' };
  }
  close(): void { this.alive = false; }
}
function mk(opts: { mandate?: Record<string, unknown> } = {}) {
  const clock = new SimClock(T0);
  const signer = new FakeSigner();
  const svc = new PlanService({ clock, journalPath: null });
  const m = svc.draftMandate({ ...DEFAULT_MANDATE, ...(opts.mandate ?? {}) });
  svc.armMandateByKeypress(m.id);
  let changes = 0;
  const live = new LivePlanExecutor({ signer, clock, solUsd: () => 150, onChange: () => { changes++; } });
  return { clock, signer, svc, mandateId: m.id, live, changes: () => changes };
}
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const tick = (svc: PlanService, clock: SimClock, mc: number, mint = TOKEN.mint): void => { clock.advance(1000); svc.tick({ mint, priceUsd: priceAtMc(mc), supply: SUPPLY, ts: clock.now(), source: 'test' }); };

test('fire-path switch: useLive needs a keypress, a live executor and no open plans; usePaper is symmetric; both are journaled; recovery starts paper', async () => {
  const { svc, live, signer } = mk();
  assert.equal(svc.mode(), 'paper');
  assert.throws(() => svc.useLive(live, { gesture: 'spoken-free' }), { reason: 'live-needs-keypress' });
  assert.throws(() => svc.useLive(live, null), { reason: 'live-needs-keypress' });
  assert.throws(() => svc.useLive(svc.executor, { gesture: 'keypress' }), { reason: 'bad-request' }, 'the paper executor is not live');
  assert.equal(svc.mode(), 'paper');
  // an armed plan blocks the switch either way
  const p = svc.propose({ ...NORTH_STAR_PLAN, sizeUsd: 5 }, { supply: SUPPLY, by: 'user' });
  svc.armPlanByKeypress(p.id, svc.listMandates()[0].id);
  assert.throws(() => svc.useLive(live, { gesture: 'keypress' }), { reason: 'open-plans' });
  svc.cancelPlan(p.id, 'test');
  svc.useLive(live, { gesture: 'keypress' });
  assert.equal(svc.mode(), 'live'); assert.equal(svc.executor.kind, 'live');
  const r = await live.ready(); assert.equal(r.ok, true);
  assert.ok(signer.calls.includes('status') && signer.calls.includes('fast'));
  assert.ok(svc.journal.events.some((e) => e.type === 'settings.executor' && e.data?.kind === 'live' && e.data?.by === 'keypress'));
  svc.usePaper();
  assert.equal(svc.mode(), 'paper');
  assert.ok(svc.journal.events.some((e) => e.type === 'settings.executor' && e.data?.kind === 'paper'));
  svc.usePaper(); // idempotent
  // ready() refuses off devnet / without a fast wallet / with a dead signer
  signer.network = 'mainnet'; assert.match((await live.ready() as { why: string }).why, /devnet only/);
  signer.network = 'devnet'; signer.fastLoaded = false; assert.match((await live.ready() as { why: string }).why, /fast wallet/);
  signer.fastLoaded = true; signer.close(); assert.match((await live.ready() as { why: string }).why, /not available/);
});

test('live fill: tick → build in the signer (outage until built, no attempt consumed) → fire → confirm in flight → settled by lookup → leg.filled with kind devnet-fill + the real signature; position booked from the modelled tokens', async () => {
  const { svc, live, signer, clock, changes } = mk();
  svc.useLive(live, { gesture: 'keypress' });
  const p = svc.propose({ ...NORTH_STAR_PLAN, sizeUsd: 5, exits: [], stop: null }, { supply: SUPPLY, by: 'voice' });
  svc.armPlanByKeypress(p.id, svc.listMandates()[0].id);
  // two ticks at the trigger: the first fresh pair fires → quote starts the build → RpcOutage → journaled, no attempt
  tick(svc, clock, 320_000); tick(svc, clock, 299_000); tick(svc, clock, 295_000);
  assert.ok(signer.calls.some((c) => c.startsWith(`fill:${p.id}:entry:buy:`)), `fill was requested: ${signer.calls}`);
  const req = signer.built.get(`${p.id}:entry`); // may still be in flight
  assert.ok(svc.journal.events.some((e) => e.type === 'price.unusable' && e.data?.reason === 'rpc-outage'), 'the engine saw an outage while the signer built');
  assert.equal(svc.summary(p.id).legs.entry, 'pending', 'no attempt consumed while building (pending, not retry/failed)');
  await flush(); await flush();
  assert.ok(changes() >= 1, 'the host was told the build landed');
  assert.ok(req ?? signer.built.get(`${p.id}:entry`));
  const built = signer.built.get(`${p.id}:entry`)!;
  assert.equal(built.lamports, String(Math.round(5 / 150 * 1e9)), '$5 at $150/SOL = 0.0333 SOL');
  assert.equal(built.mint, TOKEN.mint); assert.equal(built.decimals, 6);
  // next tick: the quote is the signer's verdict → policy ok → leg.sent (intent) → submit → confirm in flight → leg.unknown
  tick(svc, clock, 295_000);
  const sent = svc.journal.events.find((e) => e.type === 'leg.sent' && e.planId === p.id);
  assert.ok(sent, 'leg.sent journaled before the send'); assert.match(String(sent!.data?.signature), /^live_\d+$/);
  assert.ok(signer.calls.some((c) => c.startsWith('confirm:')), 'confirm was asked');
  assert.equal(svc.summary(p.id).legs.entry, 'unknown', 'in flight = unknown until the signer answers');
  await flush(); await flush();
  // the engine settles it by lookup on the next tick (never resends)
  const confirms = signer.calls.filter((c) => c.startsWith('confirm:')).length;
  tick(svc, clock, 295_000);
  assert.equal(signer.calls.filter((c) => c.startsWith('confirm:')).length, confirms, 'no second confirm');
  const filled = svc.journal.events.find((e) => e.type === 'leg.filled' && e.planId === p.id);
  assert.ok(filled, 'leg.filled');
  const fill = filled!.data?.fill as Record<string, unknown>;
  assert.equal(fill.kind, 'devnet-fill'); assert.equal(fill.modelledTokens, true); assert.equal(fill.network, 'devnet');
  assert.match(String(fill.signature), /^SIG_/); assert.equal(fill.solDelta, '-5000', 'the real on-chain SOL delta (fees)');
  assert.equal(filled!.data?.recovered, true, 'settled through the lookup path');
  assert.equal(svc.summary(p.id).status, 'filled');
  assert.ok(svc.position(p.id).tokenRaw > 0n, 'position booked from the modelled token leg');
  assert.equal(svc.ledger(svc.listMandates()[0].id).spentUsd, 5);
});

test('live fill: the signer\'s cap/policy refusal reaches the journal with its own reason; three refusals fail the leg; a transport error is an outage (no attempt)', async () => {
  const { svc, live, signer, clock } = mk();
  svc.useLive(live, { gesture: 'keypress' });
  const p = svc.propose({ ...NORTH_STAR_PLAN, sizeUsd: 5, exits: [], stop: null, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'user' });
  signer.prechecks.set(`${p.id}:entry`, { ok: false, reason: 'per-trade-cap', message: 'trade $5.00 exceeds the per-trade cap $4.00' });
  svc.armPlanByKeypress(p.id, svc.listMandates()[0].id);
  for (let i = 0; i < 3; i++) { tick(svc, clock, 300_000); tick(svc, clock, 300_000); await flush(); await flush(); tick(svc, clock, 300_000); }
  const refused = svc.journal.events.filter((e) => e.type === 'policy.refused' && e.planId === p.id && e.data?.stage === 'fire');
  assert.ok(refused.length >= 3, `refusals journaled: ${refused.length}`);
  assert.equal(refused[0].data?.reason, 'per-trade-cap', 'the SIGNER\'s reason, not a generic simulation-failed');
  assert.equal(svc.summary(p.id).status, 'failed');
  assert.ok(!signer.calls.some((c) => c.startsWith('confirm:')), 'nothing was ever confirmed');
  // transport error at fill → outage, no attempt
  const q = svc.propose({ ...NORTH_STAR_PLAN, sizeUsd: 5, exits: [], stop: null, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'user' });
  signer.fillError = new Error('signer fill timed out after 30 s');
  svc.armPlanByKeypress(q.id, svc.listMandates()[0].id);
  tick(svc, clock, 300_000); tick(svc, clock, 300_000); await flush(); await flush(); tick(svc, clock, 300_000); await flush();
  assert.equal(svc.summary(q.id).status, 'armed', 'still armed');
  assert.equal(svc.summary(q.id).legs.entry, 'pending', 'no attempt consumed on a transport outage (pending, not retry/failed)');
  assert.ok(svc.journal.events.some((e) => e.type === 'price.unusable' && e.planId === q.id && e.data?.reason === 'rpc-outage'));
  // a remote refusal at fill (e.g. the signer lost its fast wallet) is a typed refusal
  signer.fillError = new Error('no-fast-wallet: no fast wallet is loaded');
  tick(svc, clock, 300_000); await flush(); await flush(); tick(svc, clock, 300_000);
  assert.ok(svc.journal.events.some((e) => e.type === 'policy.refused' && e.planId === q.id && e.data?.reason === 'no-fast-wallet'), 'no-fast-wallet reaches the journal');
});

test('live fill: a signer refusal at confirm fails the leg (retried with a fresh build, max 3); an unknown outcome is never resent and expires', async () => {
  const { svc, live, signer, clock } = mk();
  svc.useLive(live, { gesture: 'keypress' });
  const p = svc.propose({ ...NORTH_STAR_PLAN, sizeUsd: 5, exits: [], stop: null, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'user' });
  svc.armPlanByKeypress(p.id, svc.listMandates()[0].id);
  signer.confirmOutcome = () => ({ kind: 'refused', reason: 'daily-cap', message: 'over budget' });
  for (let i = 0; i < 3; i++) { tick(svc, clock, 300_000); tick(svc, clock, 300_000); await flush(); await flush(); tick(svc, clock, 300_000); await flush(); await flush(); tick(svc, clock, 300_000); }
  assert.equal(signer.calls.filter((c) => c.startsWith('confirm:')).length, 3, 'one confirm per attempt, three attempts');
  assert.equal(svc.summary(p.id).status, 'failed');
  assert.ok(svc.journal.events.filter((e) => e.type === 'leg.failed' && e.planId === p.id).length >= 3);
  // unknown: the signer answers send-unknown → the engine waits, never resends, and expires the leg after 90 s unseen
  const q = svc.propose({ ...NORTH_STAR_PLAN, sizeUsd: 5, exits: [], stop: null, entry: { kind: 'immediate' } }, { supply: SUPPLY, by: 'user' });
  svc.armPlanByKeypress(q.id, svc.listMandates()[0].id);
  signer.confirmOutcome = () => ({ kind: 'send-unknown', signature: 'SIGUNK', error: 'confirmation timed out' });
  tick(svc, clock, 300_000); tick(svc, clock, 300_000); await flush(); await flush(); tick(svc, clock, 300_000); await flush(); await flush();
  const confirmsBefore = signer.calls.filter((c) => c.startsWith('confirm:')).length;
  for (let i = 0; i < 95; i++) tick(svc, clock, 300_000);
  assert.equal(signer.calls.filter((c) => c.startsWith('confirm:')).length, confirmsBefore, 'never resent while unknown');
  const failed = svc.journal.events.find((e) => e.type === 'leg.failed' && e.planId === q.id);
  assert.ok(failed && failed.data?.reason === 'expired-unseen', `expired, not resent: ${JSON.stringify(failed?.data)}`);
});

test('live executor on its own: a missing build at submit is a send-failed (retry), lookup of an unknown intent is not-found, nextSignature is an intent id', () => {
  const { live } = mk();
  assert.match(live.nextSignature(), /^live_1$/);
  const plan = { id: 'plan_x', mint: TOKEN.mint, symbol: 'T', decimals: 6 } as never;
  const out = live.submit({ plan, legKey: 'entry', quote: { side: 'buy', priceUsd: 1, impactPct: 0, route: [], feeLamports: 0, tipLamports: 0, simOk: true, simError: null, usd: 5, tokenRaw: null, at: 0 }, signature: 'live_1', usd: 5, tokenRaw: null });
  assert.equal(out.kind, 'send-failed');
  assert.equal(live.lookup('nope'), 'not-found');
  assert.equal(live.chainFill('nope'), null);
  assert.throws(() => live.quote({ plan, legKey: 'entry', side: 'buy', usd: 5, tokenRaw: null, priceUsd: 1 }), RpcOutage, 'first quote starts a build and reports an outage');
  assert.equal(live.snapshot().builds[0]?.state, 'building');
  assert.match(live.describe('FaStWa11etPubKey111111111111111111111111111'), /LIVE · DEVNET · fast wallet FaSt…1111/);
});
