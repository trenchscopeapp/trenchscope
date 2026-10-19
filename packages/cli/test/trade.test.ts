// PAPER trade ticket state machine + confirm gate (task-1310 T0, SPEC §6.1). Pure, no TTY.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAMPORTS_PER_SOL, solToLamports } from '@dexterm/data';
import {
  openTicket, ticketKey, orderAmountRaw, orderValid, toOrder, slippageBps, buyNotionalSol,
  DEFAULT_SLIPPAGE_BPS, type TicketState, type TicketContext, type TicketKey,
} from '../src/trade.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ch = (c: string): TicketKey => ({ name: 'char', ch: c });
const K = {
  enter: { name: 'enter' } as TicketKey,
  esc: { name: 'esc' } as TicketKey,
  tab: { name: 'tab' } as TicketKey,
  back: { name: 'backspace' } as TicketKey,
  left: { name: 'left' } as TicketKey,
};

function ctx(over: Partial<TicketContext> = {}): TicketContext {
  return { balanceLamports: 10n * LAMPORTS_PER_SOL, positionTokensRaw: 0n, notionalSol: 0, typebackThresholdSol: 1, ...over };
}

function type(ts: TicketState, s: string, c: TicketContext): void {
  for (const x of s) ticketKey(ts, ch(x), c);
}

test('open: a buy ticket starts in editing, gate ON, SOL unit, default slippage', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  assert.equal(ts.phase, 'editing');
  assert.equal(ts.gateOn, true, 'keypress confirm gate is ON by default');
  assert.equal(ts.sizeUnit, 'sol');
  assert.equal(slippageBps(ts), DEFAULT_SLIPPAGE_BPS);
});

test('sizing: buy in SOL, buy in % of balance, sell in % of position', () => {
  const buy = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  type(buy, '0.5', ctx());
  assert.equal(orderAmountRaw(buy, ctx()), solToLamports(0.5));

  ticketKey(buy, ch('u'), ctx()); // toggle to % of balance
  assert.equal(buy.sizeUnit, 'pct');
  buy.sizeInput = '25';
  assert.equal(orderAmountRaw(buy, ctx()), (10n * LAMPORTS_PER_SOL * 2500n) / 10000n); // 25% of 10 SOL

  const sell = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'sell' });
  sell.sizeInput = '50';
  assert.equal(orderAmountRaw(sell, ctx({ positionTokensRaw: 4_000_000n })), 2_000_000n);
  assert.equal(sell.sizeUnit, 'pct', 'sell is always % of the position');
});

test('slippage: typed into its field, clamped, falls back to the default', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  ticketKey(ts, K.tab, ctx()); // focus slippage
  assert.equal(ts.field, 'slippage');
  ts.slippageInput = '';
  type(ts, '150', ctx());
  assert.equal(slippageBps(ts), 150);
  ts.slippageInput = '99999';
  assert.equal(slippageBps(ts), 5000, 'clamped to MAX');
  ts.slippageInput = '';
  assert.equal(slippageBps(ts), DEFAULT_SLIPPAGE_BPS);
});

test('order validity: empty size invalid; a sell with no position invalid', () => {
  const buy = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  assert.equal(orderValid(buy, ctx()), false);
  buy.sizeInput = '1';
  assert.equal(orderValid(buy, ctx()), true);
  const sell = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'sell' });
  sell.sizeInput = '100';
  assert.equal(orderValid(sell, ctx({ positionTokensRaw: 0n })), false);
  assert.equal(orderValid(sell, ctx({ positionTokensRaw: 10n })), true);
});

test('gate: Enter arms a small order, y confirms (no typed-back needed below threshold)', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  type(ts, '0.5', ctx());
  const c = ctx({ notionalSol: 0.5 });
  assert.equal(ticketKey(ts, K.enter, c), 'none');
  assert.equal(ts.phase, 'confirm');
  assert.equal(ts.typebackRequired, false, '0.5 SOL is below the 1 SOL threshold');
  assert.equal(ticketKey(ts, ch('y'), c), 'confirm');
  assert.equal(ts.phase, 'filling');
});

test('gate: a stray key during confirm cancels — it never confirms or navigates', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  type(ts, '0.5', ctx());
  const c = ctx({ notionalSol: 0.5 });
  ticketKey(ts, K.enter, c);
  assert.equal(ts.phase, 'confirm');
  // '1' is a screen hotkey elsewhere; here it must NOT confirm and must NOT switch screens
  const eff = ticketKey(ts, ch('1'), c);
  assert.equal(eff, 'none');
  assert.equal(ts.phase, 'editing', 'stray key dropped back to editing');
  // and a subsequent lone y does nothing (we are back in editing, y is not a digit)
  assert.equal(ticketKey(ts, ch('y'), c), 'none');
  assert.equal(ts.phase, 'editing');
});

test('gate: a large order requires the amount typed back; a wrong typeback is refused', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  type(ts, '3', ctx());
  const c = ctx({ notionalSol: 3 });
  ticketKey(ts, K.enter, c);
  assert.equal(ts.phase, 'confirm');
  assert.equal(ts.typebackRequired, true, '3 SOL is above the 1 SOL threshold');
  // y before typing the amount back is refused
  assert.equal(ticketKey(ts, ch('y'), c), 'none');
  assert.equal(ts.phase, 'confirm');
  assert.match(ts.message ?? '', /type the size/);
  // wrong typeback refused
  type(ts, '2', c);
  assert.equal(ticketKey(ts, ch('y'), c), 'none');
  assert.equal(ts.phase, 'confirm');
  // correct typeback confirms
  ticketKey(ts, K.back, c); // clear the '2'
  type(ts, '3', c);
  assert.equal(ticketKey(ts, ch('y'), c), 'confirm');
  assert.equal(ts.phase, 'filling');
});

test('gate: Esc in confirm cancels back to editing; Esc in editing closes', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  type(ts, '0.5', ctx());
  ticketKey(ts, K.enter, ctx({ notionalSol: 0.5 }));
  assert.equal(ts.phase, 'confirm');
  assert.equal(ticketKey(ts, K.esc, ctx()), 'none');
  assert.equal(ts.phase, 'editing');
  assert.equal(ticketKey(ts, K.esc, ctx()), 'close');
});

test('gate: Enter with an empty size does not arm', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  assert.equal(ticketKey(ts, K.enter, ctx()), 'none');
  assert.equal(ts.phase, 'editing');
  assert.match(ts.message ?? '', /size/);
});

test('side toggle with arrows flips buy/sell and resets the unit for sell', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  ticketKey(ts, ch('u'), ctx()); // buy → pct
  assert.equal(ts.sizeUnit, 'pct');
  assert.equal(ticketKey(ts, K.left, ctx()), 'changed');
  assert.equal(ts.side, 'sell');
  assert.equal(ts.sizeUnit, 'pct');
});

test('toOrder + buyNotionalSol feed the order and the gate', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  type(ts, '2', ctx());
  const order = toOrder(ts, ctx());
  assert.equal(order.amountRaw, solToLamports(2));
  assert.equal(order.side, 'buy');
  assert.equal(buyNotionalSol(ts, 10n * LAMPORTS_PER_SOL), 2);
});
