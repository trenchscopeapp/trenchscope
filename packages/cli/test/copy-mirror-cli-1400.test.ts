// task-1400 Tier 2 (headless) — `trenchscope follow mirror <addr>`: the one-key MIRROR TICKET from a shell.
// Mirrors the TUI path (poll → latest BUY → buildMirror). A replayed followed-wallet buy becomes a preview,
// and `--propose` writes an INERT `proposed` order plan through PlanService. The command has NO arm/sign/execute
// path: the plan lands `proposed` and nothing is armed — the only way to arm it is the app's keypress/Phantom gate
// (proven here: the proposed plan is never `armed`, and the command exposes no option that could arm it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFollow, type FollowCmdOverrides } from '../src/follow-cmd.ts';
import type { Io } from '../src/main.ts';
import { PlanService } from '@dexterm/data/plans';
import type { MirrorMarket } from '@dexterm/data/copy';
import { SimClock, FakeHistory, mkTx, sig, LEADER, MINT_A } from '../../data/test/copy-helpers.ts';

const SOL = 1_000_000_000;

function io(): Io & { out: string; err: string } {
  const o = { out: '', err: '' } as Io & { out: string; err: string };
  o.stdout = { write: (s: string) => { o.out += s; return true; } } as Io['stdout'];
  o.stderr = { write: (s: string) => { o.err += s; return true; } } as Io['stderr'];
  o.env = {};
  return o;
}

/** A followed wallet that first backfills (no alert) then BUYS MINT_A — the mint the mirror market resolver prices. */
function scenario(opts: { priceUsd?: number; liqUsd?: number; ageMs?: number; solOut?: number } = {}) {
  const clock = new SimClock();
  // add + mirror run as separate runFollow() calls (separate processes in real use): the follow list must persist,
  // so use an on-disk temp follows.json rather than an in-memory store.
  const followsPath = join(mkdtempSync(join(tmpdir(), 'dexterm-follows-1400-')), 'follows.json');
  const tokens = 2_000_000n; // 2 whole tokens @ 6 decimals
  const priceUsd = opts.priceUsd ?? 0.01;
  const solOut = opts.solOut ?? (priceUsd * 2) / 100; // leader paid at the resolved price, $100/SOL
  const history = new FakeHistory(clock, {
    [LEADER]: [mkTx({ slot: 10, blockTime: Math.floor(clock.now() / 1000) - 600, sig: sig(1), wallet: LEADER, tokens: [{ mint: 'So11111111111111111111111111111111111111112', pre: 0n, post: 1n }], lamports: [10 * SOL, 10 * SOL - 5000] })],
  });
  const market: MirrorMarket = { symbol: 'AAA', decimals: 6, priceUsd, priceAt: clock.now(), liqUsd: opts.liqUsd ?? 100_000, mcapUsd: 1_000_000, ageMs: opts.ageMs ?? 600_000 };
  const over: FollowCmdOverrides = { followsPath, history, solUsd: 100, mirrorMarket: async () => market, clock };
  const emitBuy = () => { clock.advance(5_000); history.push(LEADER, mkTx({ slot: 20, blockTime: Math.floor(clock.now() / 1000) - 4, sig: sig(2), wallet: LEADER, tokens: [{ mint: MINT_A, pre: 0n, post: tokens }], lamports: [10 * SOL, 10 * SOL - Math.round(solOut * SOL)] })); };
  return { clock, history, over, emitBuy };
}

test('follow mirror previews the latest buy (checks + size); it does NOT propose or arm anything without --propose', async () => {
  const { over, emitBuy } = scenario();
  // follow + backfill via one `stats`-less poll is implicit in the command; add then buy
  let o = io();
  assert.equal(await runFollow(['add', LEADER], o, over), 0);
  emitBuy();
  o = io();
  const code = await runFollow(['mirror', LEADER], o, over);
  assert.equal(code, 0);
  assert.match(o.out, /mirror of .* latest BUY/);
  assert.match(o.out, /ok\s+lag/);
  assert.match(o.out, /size \$/);
  assert.match(o.out, /preview only/);
  assert.match(o.out, /not a recommendation/);
  // preview must not write a plan
  assert.doesNotMatch(o.out, /proposed plan-/);
});

test('follow mirror --propose writes an INERT proposed plan; nothing is armed and the command cannot arm it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-mirror-1400-'));
  const plansJournalPath = join(dir, 'plans.json');
  const { over, emitBuy } = scenario();
  const o0 = io();
  assert.equal(await runFollow(['add', LEADER], o0, over), 0);
  emitBuy();
  const o = io();
  const code = await runFollow(['mirror', LEADER, '--propose'], o, { ...over, plansJournalPath });
  assert.equal(code, 0);
  assert.match(o.out, /proposed \S+ · PROPOSED/);
  assert.match(o.out, /INERT — nothing is armed/);
  assert.match(o.out, /keypress/);
  // the plan is on disk, status proposed, by copy — NOT armed
  const plans = new PlanService({ journalPath: plansJournalPath });
  const rows = plans.listPlans();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'proposed');
  assert.equal(rows[0].side, 'buy');
  assert.equal(rows[0].mandateId, null); // not bound to any armed mandate
  assert.notEqual(rows[0].status, 'armed');
});

test('follow mirror refuses a stale buy (lag > 30 s) and proposes nothing; exit non-zero', async () => {
  const { clock, over, emitBuy } = scenario();
  const o0 = io();
  assert.equal(await runFollow(['add', LEADER], o0, over), 0);
  emitBuy();
  clock.advance(60_000); // the leader's block is now > 30 s old
  const o = io();
  const code = await runFollow(['mirror', LEADER], o, over);
  assert.equal(code, 1);
  assert.match(o.err, /refused: lag/);
  assert.doesNotMatch(o.out, /proposed/);
});

test('follow mirror refuses thin liquidity (< $25k) and proposes nothing', async () => {
  const { over, emitBuy } = scenario({ liqUsd: 1_000 });
  const o0 = io();
  assert.equal(await runFollow(['add', LEADER], o0, over), 0);
  emitBuy();
  const o = io();
  const code = await runFollow(['mirror', LEADER], o, over);
  assert.equal(code, 1);
  assert.match(o.err, /refused: liquidity/);
});

test('follow mirror --cap clips the size; --json prints the structured result', async () => {
  const { over, emitBuy } = scenario();
  const o0 = io();
  assert.equal(await runFollow(['add', LEADER], o0, over), 0);
  emitBuy();
  const o = io();
  const code = await runFollow(['mirror', LEADER, '--cap', '1', '--json'], o, over);
  assert.equal(code, 0);
  const r = JSON.parse(o.out);
  assert.equal(r.ok, true);
  assert.ok(r.sizeUsd <= 1, `size ${r.sizeUsd} should be clipped to the $1 cap`);
  assert.equal(r.input.side, 'buy');
});

test('follow mirror on an unfollowed wallet refuses; usage on a bad address', async () => {
  const { over } = scenario();
  let o = io();
  assert.equal(await runFollow(['mirror', LEADER], o, over), 1);
  assert.match(o.err, /is not followed/);
  o = io();
  assert.equal(await runFollow(['mirror', 'junk'], o, over), 2);
  assert.match(o.err, /usage: trenchscope follow mirror/);
});

test('follow mirror reports no-buy honestly when the wallet has only a backfill (history is not news)', async () => {
  const { over } = scenario(); // no emitBuy(): only the backfill SOL-in tx exists
  const o0 = io();
  assert.equal(await runFollow(['add', LEADER], o0, over), 0);
  const o = io();
  const code = await runFollow(['mirror', LEADER], o, over);
  assert.equal(code, 0);
  assert.match(o.out, /no BUY from .* in the fetched history/);
});
