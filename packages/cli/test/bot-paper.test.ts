// trenchscope paper bot: offline tests. A scripted market (fake keyless quotes with a known price per coin) drives
// the real engine, ledger and journal on node:sqlite. No network, no key, no signer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, defaultConfig, validateConfig } from '@dexterm/custom';
import { SOL_MINT, type QuoteRequest, type SwapQuote } from '@dexterm/data/core';
import type { ScreenerRow } from '../src/screener/rows.ts';
import { DEFAULT_BOT_CONFIG, resolveBotConfig, botConfigProblems, BOT_KNOBS, type BotConfig } from '../src/bot/config.ts';
import { evaluateEntry, evaluateExit, marketCheck, safetyCheck, pnlPct } from '../src/bot/strategy.ts';
import { BotStore, type BotPosition } from '../src/bot/store.ts';
import { BotEngine, NO_ROUTE_FAILS } from '../src/bot/engine.ts';
import type { BotEvent } from '../src/bot/alerts.ts';
import { botEventToDelivery } from '../src/bot/alerts.ts';
import { computeStats, renderStats, parseSince, MEANINGFUL_MIN, STATS_LABEL } from '../src/bot/stats.ts';
import { botCommand, type BotSource } from '../src/bot-cmd.ts';

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const MIN = 60_000;
const SOL_USD = 150;
const mintOf = (i: number): string => `Mint${String(i).padStart(3, '0')}${'x'.repeat(36)}`;

/** A row that passes every default entry rule (verdict NO RED FLAGS, p(rug) 0.02). */
function row(i: number, over: Partial<ScreenerRow> = {}): ScreenerRow {
  return {
    mint: mintOf(i), symbol: `C${i}`, name: `coin ${i}`, launchpad: 'pump.fun', price: 0.001, mcap: 500_000, mcapFlagged: false, fdv: 500_000,
    liq: 50_000, vol24: 300_000, vol6h: 80_000, vol1h: 20_000, vol5m: 2_000, ageMin: 180, holders: 1500, holders24: null, holdersChgPct: null,
    chg: { m5: 1, h1: 10, h6: 20, h24: 30 }, spark: undefined, buys: 100, sells: 90, org: 60, top10: 20, dev: 2, lpLocked: 100,
    mintAuth: false, freezeAuth: false, snipers: null, bundled: null, flags: [], verified: false, sus: false, bonding: null, dex: 'pumpswap',
    pair: `pair${i}`, sources: ['dexscreener'], stale: false, fetchedAt: T0, aiNote: null, image: null,
    ...over,
  };
}

/** Scripted keyless quotes: `px` lamports per raw token unit, a fixed price impact, optional per-mint failures. */
class FakeMarket {
  px = new Map<string, number>();
  impact = 0.4;
  fail = new Map<string, () => Error>();
  calls: QuoteRequest[] = [];
  quote = async (req: QuoteRequest): Promise<SwapQuote> => {
    this.calls.push(req);
    const buy = req.inputMint === SOL_MINT;
    const mint = buy ? req.outputMint : req.inputMint;
    const f = this.fail.get(mint);
    if (f) throw f();
    const p = this.px.get(mint) ?? 1;
    const out = buy ? BigInt(Math.floor(Number(req.amount) / p)) : BigInt(Math.floor(Number(req.amount) * p));
    return {
      inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount: out, otherAmountThreshold: out * 97n / 100n,
      mode: 'ExactIn', slippageBps: req.slippageBps, priceImpactPct: this.impact, route: ['FakeAMM'], platformFeeBps: null, platformFeeAmount: null,
      usdValue: null, contextSlot: 1, source: 'jupiter-swap', fetchedAt: T0,
    };
  };
}

function rig(cfgOver: Partial<BotConfig> = {}, path = ':memory:') {
  const cfg: BotConfig = { ...DEFAULT_BOT_CONFIG, ...cfgOver, entry: { ...DEFAULT_BOT_CONFIG.entry, ...(cfgOver.entry ?? {}) }, alerts: { ...DEFAULT_BOT_CONFIG.alerts, ...(cfgOver.alerts ?? {}) } };
  const store = new BotStore(path);
  const market = new FakeMarket();
  const clock = { t: T0 };
  const events: BotEvent[] = [];
  const larp = new Map<string, string>();
  let solUsd: number | null = SOL_USD;
  const engine = new BotEngine({
    store, cfg, quote: market.quote, solUsd: async () => solUsd, decimals: async () => 6, now: () => clock.t,
    notify: async (ev) => { events.push(ev); }, larp: (m) => larp.get(m) ?? null,
  });
  return { cfg, store, market, clock, events, larp, engine, setSolUsd: (v: number | null) => { solUsd = v; } };
}

// ------------------------------------------------------------------------------------------------ entry filter

test('entry filter: a clean, established coin passes both books', () => {
  const r = row(1);
  const s = evaluateEntry('strategy', r, DEFAULT_BOT_CONFIG);
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.safety?.verdict, 'NO RED FLAGS');
  assert.ok((s.safety?.rugP ?? 1) < 0.2);
  assert.equal(evaluateEntry('baseline', r, DEFAULT_BOT_CONFIG).ok, true);
  assert.equal(evaluateEntry('baseline', r, DEFAULT_BOT_CONFIG).safety, null, 'the baseline never looks at safety');
});

test('entry filter: each market rule fails on its own (and unknown is a fail)', () => {
  const e = DEFAULT_BOT_CONFIG.entry;
  const cases: Array<[Partial<ScreenerRow>, RegExp]> = [
    [{ mcap: 40_000 }, /mcap .* < /], [{ mcap: 6_000_000 }, /mcap .* > /], [{ mcap: null }, /mcap unknown/],
    [{ liq: 19_999 }, /liquidity .* < /], [{ liq: null }, /liquidity unknown/],
    [{ ageMin: 29 }, /age .* < /], [{ ageMin: null }, /age unknown/],
    [{ chg: { m5: 0, h1: -1, h6: 0, h24: 0 } }, /1h .* < /], [{ chg: { m5: 0, h1: 61, h6: 0, h24: 0 } }, /1h .* > /], [{ chg: { m5: 0, h1: null, h6: 0, h24: 0 } }, /1h change unknown/],
    [{ stale: true }, /stale/], [{ mcapFlagged: true }, /disagree/], [{ price: null }, /no price/],
  ];
  for (const [over, re] of cases) {
    const c = marketCheck(row(1, over), e);
    assert.equal(c.ok, false, JSON.stringify(over));
    assert.ok(c.fails.some((f) => re.test(f)), `${JSON.stringify(over)} -> ${c.fails.join('; ')}`);
    assert.equal(evaluateEntry('baseline', row(1, over), DEFAULT_BOT_CONFIG).ok, false, 'market rules bind the baseline too');
  }
  assert.equal(marketCheck(row(1, { skeleton: true }), e).ok, false);
});

test('entry filter: safety rules gate the strategy but not the baseline', () => {
  const cfg = DEFAULT_BOT_CONFIG;
  const cases: Array<[Partial<ScreenerRow>, RegExp]> = [
    [{ top10: 31 }, /top-10 31% >= 30%/], [{ top10: null }, /top-10 share unknown/],
    [{ mintAuth: null }, /mint authority unknown/], [{ freezeAuth: true }, /freeze authority live/],
    [{ top10: 40 }, /verdict CAREFUL/], // over the verdict's 35 % line: CAREFUL, and over our 30 % cap
  ];
  for (const [over, re] of cases) {
    const r = row(2, over);
    const s = evaluateEntry('strategy', r, cfg);
    assert.equal(s.ok, false, JSON.stringify(over));
    assert.ok(s.safety!.fails.some((f) => re.test(f)), `${JSON.stringify(over)} -> ${s.safety!.fails.join('; ')}`);
    assert.equal(evaluateEntry('baseline', r, cfg).ok, true, `baseline ignores safety (${JSON.stringify(over)})`);
  }
  // the p(rug) cap: a row the H2 score puts at/over the cap fails even with a clean verdict otherwise
  const strict = resolveBotConfig({ entry: { maxRugP: 0.01 } });
  assert.match(safetyCheck(row(3), strict.entry).fails.join(';'), /p\(rug\) 0\.02 >= 0\.01/);
  // the verdict gate can be loosened to CAREFUL (top10 40 is CAREFUL) when the top-10 cap allows it
  const loose = resolveBotConfig({ entry: { verdict: 'CAREFUL', maxTop10Pct: 50 } });
  assert.equal(evaluateEntry('strategy', row(4, { top10: 40 }), loose).ok, true);
  // a recorded LARP verdict makes the coin AVOID
  assert.equal(evaluateEntry('strategy', row(5), cfg, 'LARP').ok, false);
});

// ------------------------------------------------------------------------------------------------ exit rules

test('exit rules: each reason, safety first', () => {
  const cfg = DEFAULT_BOT_CONFIG;
  const pos = { openedAt: T0, costLamports: 1_000_000_000n };
  const at = T0 + 10 * MIN;
  const up = 1_400_000_000n, flat = 1_000_000_000n, down = 800_000_000n;
  assert.equal(evaluateExit(pos, flat, row(1), at, cfg), null);
  assert.equal(evaluateExit(pos, up, row(1), at, cfg)?.reason, 'take-profit');
  assert.equal(evaluateExit(pos, 1_399_000_000n, row(1), at, cfg), null, 'just under +40 % holds');
  assert.equal(evaluateExit(pos, down, row(1), at, cfg)?.reason, 'stop-loss');
  assert.equal(evaluateExit(pos, flat, row(1), T0 + 360 * MIN, cfg)?.reason, 'time-stop');
  assert.equal(evaluateExit(pos, flat, row(1, { mintAuth: true }), at, cfg)?.reason, 'mint-authority');
  assert.equal(evaluateExit(pos, flat, row(1, { freezeAuth: true }), at, cfg)?.reason, 'freeze-authority');
  assert.equal(evaluateExit(pos, flat, row(1, { flags: ['DEAD'], liq: 500 }), at, cfg)?.reason, 'dead');
  assert.equal(evaluateExit(pos, flat, row(1), at, cfg, 'LARP')?.reason, 'verdict-avoid');
  assert.equal(evaluateExit(pos, up, row(1, { mintAuth: true }), at, cfg)?.reason, 'mint-authority', 'a safety exit wins over take-profit');
  assert.equal(evaluateExit(pos, null, null, at, cfg), null, 'no quote and no row: hold');
  assert.equal(evaluateExit(pos, null, null, T0 + 400 * MIN, cfg)?.reason, 'time-stop', 'the time stop needs no quote');
  assert.equal(Math.round(pnlPct(1_000n, 1_250n)), 25);
});

// ------------------------------------------------------------------------------------------------ the engine

test('engine: entries are priced from the quote (fees included), one shared quote, journaled with the row', async () => {
  const k = rig();
  const r = await k.engine.tick([row(1)]);
  assert.equal(r.entries.length, 2, 'strategy + baseline');
  const buys = k.market.calls.filter((c) => c.inputMint === SOL_MINT);
  assert.equal(buys.length, 1, 'both books share one buy quote');
  const lamports = BigInt(Math.round((50 / SOL_USD) * 1e9));
  assert.equal(buys[0].amount, lamports);
  assert.equal(buys[0].slippageBps, DEFAULT_BOT_CONFIG.slippageBps);
  const p = k.store.openPositions('strategy')[0];
  assert.equal(p.costLamports, lamports + 5_000n + 100_000n, 'cost = SOL in + simulated base + priority fee');
  assert.equal(p.tokensRaw, lamports, 'tokens = the quote outAmount (px 1)');
  assert.equal(p.sizeUsd, 50);
  assert.equal(p.solUsdEntry, SOL_USD);
  const j = k.store.journalLines({ kinds: ['entry'] });
  assert.equal(j.length, 2);
  const e = j.find((x) => x.book === 'strategy')!;
  const snap = e.row as Record<string, unknown>;
  assert.equal(snap.mint, mintOf(1));
  assert.equal(snap.top10, 20);
  assert.equal(snap.mcap, 500_000);
  assert.match(e.reason, /market \+ safety passed \(NO RED FLAGS, p\(rug\) 0\.02\)/);
  const data = e.data as Record<string, any>;
  assert.equal(data.quote.outAmount, lamports.toString());
  assert.equal(data.fill.feeLamports, '105000');
  assert.equal(data.checks.safety.verdict, 'NO RED FLAGS');
  assert.equal(data.config.takeProfitPct, 40);
  assert.equal(data.paper, true);
  assert.match(j.find((x) => x.book === 'baseline')!.reason, /baseline ignores the safety verdict/);
});

test('engine: a risky coin enters only the baseline', async () => {
  const k = rig();
  const r = await k.engine.tick([row(1, { top10: 45 })]);
  assert.deepEqual(r.entries.map((p) => p.book), ['baseline']);
  assert.equal(r.candidates.strategy, 0);
  assert.equal(r.candidates.baseline, 1);
});

test('engine: take-profit and stop-loss exits book PnL from a real sell quote, net of fees', async () => {
  const k = rig();
  await k.engine.tick([row(1), row(2)]);
  k.market.px.set(mintOf(1), 1.5); // +50 %
  k.market.px.set(mintOf(2), 0.7); // -30 %
  k.clock.t += 5 * MIN;
  const r = await k.engine.tick([row(1), row(2)]);
  assert.equal(r.exits.length, 4);
  const tp = r.exits.find((p) => p.book === 'strategy' && p.mint === mintOf(1))!;
  const sl = r.exits.find((p) => p.book === 'strategy' && p.mint === mintOf(2))!;
  assert.equal(tp.exitReason, 'take-profit');
  assert.equal(sl.exitReason, 'stop-loss');
  const fee = 105_000n;
  const expectExit = BigInt(Math.floor(Number(tp.tokensRaw) * 1.5)) - fee;
  assert.equal(tp.exitLamports, expectExit);
  assert.equal(tp.pnlLamports, expectExit - tp.costLamports);
  assert.ok(tp.pnlPct! > 49 && tp.pnlPct! < 50, `${tp.pnlPct}`);
  assert.ok(Math.abs(tp.pnlUsd! - (Number(tp.pnlLamports) / 1e9) * SOL_USD) < 1e-9);
  assert.ok(sl.pnlPct! < -30 && sl.pnlPct! > -31);
  const ex = k.store.journalLines({ kinds: ['exit'] }).find((x) => x.positionId === tp.id)!;
  assert.match(ex.reason, /^take-profit: net quote \+49\.\d% >= \+40%/);
  assert.equal((ex.data as any).quote.inAmount, tp.tokensRaw.toString());
  assert.equal((ex.row as any).mint, mintOf(1));
});

test('engine: time stop, verdict AVOID, DEAD, mint and freeze authority exits', async () => {
  const k = rig({ maxEntriesPerHour: 10 });
  const rows = [row(1), row(2), row(3), row(4), row(5)];
  await k.engine.tick(rows);
  assert.equal(k.store.openPositions('strategy').length, 5);
  k.clock.t += 10 * MIN;
  k.larp.set(mintOf(2), 'LARP');
  const r = await k.engine.tick([row(1), row(2), row(3, { flags: ['DEAD'], liq: 400 }), row(4, { mintAuth: true }), row(5, { freezeAuth: true })]);
  const reasons = Object.fromEntries(r.exits.filter((p) => p.book === 'strategy').map((p) => [p.mint, p.exitReason]));
  assert.deepEqual(reasons, { [mintOf(2)]: 'verdict-avoid', [mintOf(3)]: 'dead', [mintOf(4)]: 'mint-authority', [mintOf(5)]: 'freeze-authority' });
  k.clock.t = T0 + 361 * MIN;
  const r2 = await k.engine.tick([]); // coin 1 fell out of the feed: still marked by quote, time stop applies
  assert.equal(r2.exits.find((p) => p.book === 'strategy')?.exitReason, 'time-stop');
});

test('engine: an unsellable coin is written off after repeated no-route quotes; rate limits never count', async () => {
  const k = rig();
  await k.engine.tick([row(1)]);
  const rl = (): Error => Object.assign(new Error('Jupiter is rate limiting this IP'), { name: 'JupiterRateLimitedError' });
  k.market.fail.set(mintOf(1), rl);
  for (let i = 0; i < NO_ROUTE_FAILS + 2; i++) { k.clock.t += MIN; await k.engine.tick([]); }
  assert.equal(k.store.openPositions().length, 2, 'transient failures never close a position');
  assert.equal(k.store.openPositions()[0].quoteFailures, 0);
  k.market.fail.set(mintOf(1), () => new Error('COULD_NOT_FIND_ANY_ROUTE'));
  for (let i = 0; i < NO_ROUTE_FAILS - 1; i++) { k.clock.t += MIN; await k.engine.tick([]); }
  assert.equal(k.store.openPositions().length, 2);
  k.clock.t += MIN;
  const r = await k.engine.tick([]);
  assert.equal(r.exits.length, 2);
  for (const p of r.exits) {
    assert.equal(p.exitReason, 'no-route');
    assert.equal(p.exitLamports, 0n);
    assert.equal(Math.round(p.pnlPct!), -100);
  }
});

test('caps: max open positions per book', async () => {
  const k = rig({ maxOpen: 5, maxEntriesPerHour: 60 });
  const rows = Array.from({ length: 8 }, (_, i) => row(i + 1));
  const r = await k.engine.tick(rows);
  assert.equal(r.candidates.strategy, 8);
  assert.equal(k.store.openPositions('strategy').length, 5);
  assert.equal(k.store.openPositions('baseline').length, 5);
  k.clock.t += MIN;
  await k.engine.tick(rows);
  assert.equal(k.store.openPositions('strategy').length, 5, 'still capped on the next tick');
});

test('caps: max entries per rolling hour, and the re-entry cooldown', async () => {
  const k = rig({ maxOpen: 20, maxEntriesPerHour: 4 });
  const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
  await k.engine.tick(rows);
  assert.equal(k.store.openPositions('strategy').length, 4);
  k.clock.t += 30 * MIN;
  await k.engine.tick(rows);
  assert.equal(k.store.openPositions('strategy').length, 4, 'same hour: no more entries');
  k.clock.t += 31 * MIN;
  await k.engine.tick(rows);
  assert.equal(k.store.openPositions('strategy').length, 8, 'a new hour: four more');
  // cooldown: take profit on coin 1, then it passes again but may not re-enter for reentryCooldownMin
  k.market.px.set(mintOf(1), 2);
  k.clock.t += MIN;
  await k.engine.tick(rows);
  assert.equal(k.store.openPositions('strategy').some((p) => p.mint === mintOf(1)), false);
  k.market.px.set(mintOf(1), 1);
  k.clock.t += 120 * MIN;
  await k.engine.tick([row(1)]);
  assert.equal(k.store.openPositions('strategy').some((p) => p.mint === mintOf(1)), false, 'inside the cooldown');
  k.clock.t += DEFAULT_BOT_CONFIG.reentryCooldownMin * MIN;
  await k.engine.tick([row(1)]);
  assert.equal(k.store.openPositions('strategy').some((p) => p.mint === mintOf(1)), true, 'after the cooldown');
});

test('idempotent restarts: a new process on the same db never duplicates a position', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'trenchscope-bot-')), 'bot.db');
  const a = rig({}, path);
  await a.engine.tick([row(1), row(2)]);
  a.store.close();
  // "restart": a fresh store + engine on the same file, same feed
  const b = rig({}, path);
  b.clock.t += MIN;
  const r = await b.engine.tick([row(1), row(2)]);
  assert.equal(r.entries.length, 0, 'already held: nothing re-entered');
  assert.equal(b.store.positions().length, 4, 'two coins x two books, no duplicates');
  // the database itself refuses a second open position for the same (book, mint)
  const dup = b.store.openPosition({ book: 'strategy', mint: mintOf(1), symbol: 'C1', decimals: 6, openedAt: T0, sizeUsd: 50, solUsdEntry: 150, costLamports: 1n, tokensRaw: 1n, entryPriceUsd: null, entryImpactPct: null, reason: 'dup', row: null, data: null });
  assert.equal(dup, null);
  assert.throws(() => b.store.db.prepare("INSERT INTO bot_positions (book, mint, symbol, decimals, status, opened_at, size_usd, sol_usd_entry, cost_lamports, tokens_raw) VALUES ('strategy', ?, 'C1', 6, 'open', 1, 50, 150, '1', '1')").run(mintOf(1)), /UNIQUE/);
  // entries-per-hour survives the restart too (counted from the ledger)
  assert.equal(b.store.entriesSince('strategy', T0 - 1), 2);
  b.store.close();
});

test('engine: impact ceiling skips (journaled); no SOL/USD pauses entries but not exits', async () => {
  const k = rig();
  k.market.impact = 5;
  const r = await k.engine.tick([row(1)]);
  assert.equal(r.entries.length, 0);
  assert.equal(r.skips.length, 2);
  const skip = k.store.journalLines({ kinds: ['skip'] })[0];
  assert.match(skip.reason, /price impact 5\.00% > 3%/);
  assert.equal((skip.row as any).mint, mintOf(1));
  k.market.impact = 0.4;
  await k.engine.tick([row(2)]);
  k.setSolUsd(null);
  k.market.px.set(mintOf(2), 2);
  k.clock.t += MIN;
  const r2 = await k.engine.tick([row(2), row(3)]);
  assert.equal(r2.entries.length, 0);
  assert.equal(r2.exits.length, 2, 'exits still run');
  assert.ok(k.store.journalLines({ kinds: ['error'] }).some((l) => /no SOL\/USD/.test(l.reason)));
});

test('alerts: exits only by default, strategy book only; entries when enabled', async () => {
  const k = rig();
  await k.engine.tick([row(1)]);
  assert.equal(k.events.length, 0, 'entries are off by default');
  k.market.px.set(mintOf(1), 1.6);
  k.clock.t += 7 * MIN;
  await k.engine.tick([row(1)]);
  assert.equal(k.events.length, 1, 'one exit alert (the baseline book never alerts)');
  const ev = k.events[0];
  assert.equal(ev.kind, 'exit');
  const d = botEventToDelivery(ev);
  assert.equal(d.level, 'up');
  assert.match(d.title, /^paper bot: sold C1 \+59\.\d%$/);
  assert.match(d.body, /PAPER sell \(take-profit\).*after 7m.*not financial advice/);
  assert.equal(d.source, 'bot');
  const k2 = rig({ alerts: { entries: true, exits: false } });
  await k2.engine.tick([row(1)]);
  assert.deepEqual(k2.events.map((e) => e.kind), ['entry']);
  assert.match(botEventToDelivery(k2.events[0]).body, /PAPER buy \$50\.00 · mcap \$500\.0K · NO RED FLAGS, p\(rug\) 0\.02/);
});

// ------------------------------------------------------------------------------------------------ stats

function closedPos(id: number, book: 'strategy' | 'baseline', pct: number, reason: BotPosition['exitReason'], holdMin: number, closedAt = T0): BotPosition {
  const cost = 1_000_000_000n;
  const exit = BigInt(Math.round(1e9 * (1 + pct / 100)));
  return {
    id, book, mint: mintOf(id), symbol: `C${id}`, decimals: 6, status: 'closed', openedAt: closedAt - holdMin * MIN, closedAt, sizeUsd: 150, solUsdEntry: 150,
    costLamports: cost, tokensRaw: 1n, entryPriceUsd: null, entryImpactPct: null, exitLamports: exit, exitReason: reason, exitImpactPct: null, solUsdExit: 150,
    pnlLamports: exit - cost, pnlUsd: (Number(exit - cost) / 1e9) * 150, pnlPct: pct, markLamports: exit, markAt: closedAt, quoteFailures: 0,
  };
}

test('stats: win rate, PnL, best/worst, hold, by reason, and the baseline comparison', () => {
  const ps: BotPosition[] = [
    closedPos(1, 'strategy', 40, 'take-profit', 60),
    closedPos(2, 'strategy', -20, 'stop-loss', 30),
    closedPos(3, 'strategy', 10, 'time-stop', 360),
    closedPos(4, 'baseline', -50, 'dead', 20),
    closedPos(5, 'baseline', 40, 'take-profit', 40),
    { ...closedPos(6, 'strategy', 0, null, 0), status: 'open', closedAt: null, exitLamports: null, exitReason: null, pnlLamports: null, pnlUsd: null, pnlPct: null, markLamports: 1_100_000_000n },
  ];
  const s = computeStats(ps, { since: null, now: T0 });
  assert.equal(s.strategy.closed, 3);
  assert.equal(s.strategy.open, 1);
  assert.equal(s.strategy.wins, 2);
  assert.ok(Math.abs(s.strategy.winRate! - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.strategy.totalPnlUsd - (60 - 30 + 15)) < 1e-6, `${s.strategy.totalPnlUsd}`);
  assert.ok(Math.abs(s.strategy.avgPnlUsd! - 15) < 1e-6);
  assert.ok(Math.abs(s.strategy.avgPnlPct! - 10) < 1e-9);
  assert.equal(s.strategy.best?.symbol, 'C1');
  assert.equal(s.strategy.worst?.symbol, 'C2');
  assert.equal(s.strategy.avgHoldMin, 150);
  assert.deepEqual(Object.keys(s.strategy.byReason).sort(), ['stop-loss', 'take-profit', 'time-stop']);
  assert.equal(s.strategy.byReason['take-profit']!.n, 1);
  assert.ok(Math.abs(s.strategy.openUnrealizedUsd! - 15) < 1e-6, 'open mark +10 % of 1 SOL at $150');
  assert.equal(s.baseline.closed, 2);
  assert.ok(Math.abs(s.baseline.avgPnlPct! - -5) < 1e-9);
  assert.match(s.comparison, /strategy minus baseline avg \+15\.0 pp/);
  assert.equal(s.meaningful, false);
  const text = renderStats(s);
  assert.ok(text.includes(STATS_LABEL));
  assert.match(text, /sample: 3 closed strategy trade\(s\), 2 closed baseline trade\(s\); fewer than 20 closed trades, so this is NOT yet meaningful/);
  assert.match(text, /win rate   67% \(2 won, 1 lost\)/);
  assert.match(text, /take-profit\s+1\s+\+\$60\.00\s+avg \+40\.0%/);
});

test('stats: --since window, the meaningful threshold, and an empty ledger', () => {
  const many = Array.from({ length: MEANINGFUL_MIN }, (_, i) => closedPos(i + 1, 'strategy', 5, 'take-profit', 10, T0 - i * 3_600_000));
  assert.equal(computeStats(many, { since: null, now: T0 }).meaningful, true);
  const since = parseSince('24h', T0) as number;
  const s = computeStats(many, { since, now: T0 });
  assert.equal(s.strategy.closed, MEANINGFUL_MIN, 'all closed inside 24 h');
  const s2 = computeStats(many, { since: parseSince('90m', T0) as number, now: T0 });
  assert.equal(s2.strategy.closed, 2);
  assert.equal(parseSince('all', T0), null);
  assert.ok(typeof parseSince('soon', T0) === 'object');
  const e = computeStats([], { since: null, now: T0 });
  assert.equal(e.strategy.winRate, null);
  assert.match(e.comparison, /not comparable yet/);
  assert.match(renderStats(e), /NOT yet meaningful/);
});

// ------------------------------------------------------------------------------------------------ config + CLI

test('config: the bot section is validated like the other sections and merged over the defaults', () => {
  const ok = { ...defaultConfig(), bot: { sizeUsd: 25, entry: { verdict: 'CAREFUL', maxRugP: 0.3 }, alerts: { entries: true } } };
  assert.deepEqual(validateConfig(ok), []);
  assert.ok(validateConfig({ ...defaultConfig(), bot: { sizeUsd: 0 } }).some((e) => e.path === '/bot/sizeUsd'));
  assert.ok(validateConfig({ ...defaultConfig(), bot: { live: true } }).some((e) => e.path === '/bot/live' && e.msg === 'unknown key'), 'no live / arm switch exists');
  assert.ok(validateConfig({ ...defaultConfig(), bot: { entry: { verdict: 'AVOID' } } }).some((e) => e.path === '/bot/entry/verdict'));
  const c = resolveBotConfig(ok.bot as never);
  assert.equal(c.sizeUsd, 25);
  assert.equal(c.entry.verdict, 'CAREFUL');
  assert.equal(c.entry.minLiqUsd, DEFAULT_BOT_CONFIG.entry.minLiqUsd);
  assert.equal(c.alerts.entries, true);
  assert.equal(c.alerts.exits, true);
  assert.deepEqual(resolveBotConfig(undefined), DEFAULT_BOT_CONFIG);
  assert.deepEqual(botConfigProblems(resolveBotConfig({ entry: { minMcapUsd: 10, maxMcapUsd: 5 } })), ['bot.entry.minMcapUsd is above maxMcapUsd']);
  // every knob is documented in one line
  const paths = BOT_KNOBS.map(([p]) => p);
  for (const k of Object.keys(DEFAULT_BOT_CONFIG).filter((x) => x !== 'entry' && x !== 'alerts')) assert.ok(paths.includes(k), k);
  for (const k of Object.keys(DEFAULT_BOT_CONFIG.entry)) assert.ok(paths.includes(`entry.${k}`), k);
});

function fakeIo(env: NodeJS.ProcessEnv) {
  let out = ''; let err = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
  const stderr = new Writable({ write(c, _e, cb) { err += c.toString(); cb(); } });
  return { io: { stdout, stderr, env }, out: () => out, err: () => err };
}

test('cli: bot run (scripted source) then bot stats / --json / config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trenchscope-bot-home-'));
  saveConfig(home, { ...defaultConfig(), bot: { sizeUsd: 30 } });
  const db = join(home, 'bot.db');
  const market = new FakeMarket();
  let closed = false;
  let tick = 0;
  const source: BotSource = {
    rows: async () => { tick++; if (tick === 2) market.px.set(mintOf(1), 1.5); return [row(1), row(2, { top10: 45 })]; },
    quote: market.quote, solUsd: async () => SOL_USD, decimals: async () => 6, close: () => { closed = true; },
  };
  const delivered: string[] = [];
  const notifier = { deliver: async (d: { title: string }) => { delivered.push(d.title); return []; }, readyChannels: () => [] };
  let t = T0;
  const { io, out, err } = fakeIo({ DEXTERM_HOME: home });
  const code = await botCommand(['run', '--ticks', '2', '--db', db], io as never, { source, notifier: notifier as never, now: () => (t += MIN), sleep: async () => {} });
  assert.equal(code, 0, err());
  assert.ok(closed, 'the source is closed');
  assert.match(err(), /PAPER only/);
  assert.match(out(), /tick 1: 2 rows · candidates 1 strategy \/ 2 baseline · entered 1\/2/);
  assert.match(out(), /tick 2: .* exited 1\/1/);
  assert.match(out(), /EXIT   \[strategy\] C1 take-profit \+49\.\d%/);
  assert.deepEqual(delivered.length, 1);
  const store = new BotStore(db);
  assert.equal(store.positions('strategy')[0].sizeUsd, 30, 'config.bot.sizeUsd is used');
  assert.deepEqual(store.journalLines({ kinds: ['start', 'stop'] }).map((l) => l.kind).sort(), ['start', 'stop']);
  store.close();

  const s = fakeIo({ DEXTERM_HOME: home });
  assert.equal(await botCommand(['stats', '--db', db], s.io as never, { now: () => t }), 0);
  assert.ok(s.out().includes(STATS_LABEL));
  assert.match(s.out(), /sample: 1 closed strategy trade\(s\), 1 closed baseline trade\(s\); fewer than 20/);
  const j = fakeIo({ DEXTERM_HOME: home });
  assert.equal(await botCommand(['stats', '--since', '24h', '--json', '--db', db], j.io as never, { now: () => t }), 0);
  const parsed = JSON.parse(j.out());
  assert.equal(parsed.paper, true);
  assert.equal(parsed.label, STATS_LABEL);
  assert.equal(parsed.strategy.closed, 1);
  assert.equal(parsed.baseline.open, 1);
  const c = fakeIo({ DEXTERM_HOME: home });
  assert.equal(await botCommand(['config'], c.io as never), 0);
  assert.match(c.out(), /bot\.sizeUsd\s+30\s+fixed paper size per entry, USD \(default 50\)/);
  const bad = fakeIo({ DEXTERM_HOME: home });
  assert.equal(await botCommand(['run', '--interval', '1'], bad.io as never), 2);
  assert.equal(await botCommand(['nope'], bad.io as never), 2);
  const h = fakeIo({ DEXTERM_HOME: home });
  assert.equal(await botCommand(['help'], h.io as never), 0);
  assert.match(h.out(), /PAPER ONLY/);
});

test('doctor: a Paper bot line from the ledger (read-only; never a warning)', async () => {
  const { runDoctor } = await import('../src/doctor.ts');
  const { readBotSummary } = await import('../src/bot/store.ts');
  const dir = mkdtempSync(join(tmpdir(), 'trenchscope-bot-doctor-'));
  const path = join(dir, 'app.db');
  assert.equal(readBotSummary(path), null, 'no db yet');
  const k = rig({}, path);
  await k.engine.tick([row(1)]);
  k.market.px.set(mintOf(1), 2);
  k.clock.t += MIN;
  await k.engine.tick([row(1), row(2)]);
  k.store.close();
  assert.deepEqual(readBotSummary(path), { open: 2, closed: 2, lastAt: T0 + MIN });
  const base = {
    env: { COLORTERM: 'truecolor', TERM: 'xterm-256color', DEXTERM_RPC_URL: 'https://mainnet.helius-rpc.com/' } as NodeJS.ProcessEnv,
    isTTY: true, nodeVersion: '22.18.0', platform: 'darwin' as const, claude: async () => 'ok' as const,
    probe: async () => ({ reachable: true, status: 200, ms: 40 }), checkWritable: () => null, offline: true,
  };
  const ran = await runDoctor({ ...base, paperBot: () => readBotSummary(path) });
  const line = ran.checks.find((c) => c.name === 'Paper bot');
  assert.equal(line?.status, 'pass');
  assert.match(line!.detail, /^2 open, 2 closed paper trade\(s\), last activity 2026-10-18 12:01 UTC/);
  const fresh = await runDoctor({ ...base, paperBot: () => null });
  assert.match(fresh.checks.find((c) => c.name === 'Paper bot')!.detail, /not run yet/);
});

test('engine: the first rate-limited quote pauses quoting for the rest of the tick (one skip line), entries resume next tick', async () => {
  const k = rig({ maxEntriesPerHour: 10 });
  k.market.fail.set(mintOf(1), () => new Error('rate-limit wait aborted'));
  const r = await k.engine.tick([row(1), row(2), row(3)]);
  assert.equal(r.entries.length, 0);
  assert.equal(k.market.calls.length, 1, 'no further quotes after the first rate limit');
  assert.equal(k.store.journalLines({ kinds: ['skip'] }).length, 1);
  assert.match(k.store.journalLines({ kinds: ['skip'] })[0].reason, /deferred \(rate limited\)/);
  k.market.fail.delete(mintOf(1));
  k.clock.t += MIN;
  const r2 = await k.engine.tick([row(1), row(2), row(3)]);
  assert.equal(r2.entries.length, 6);
});
