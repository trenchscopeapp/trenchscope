// task-1399 — the WALLET TRACKER feeds the alerts lane: a followed wallet's decoded buy/sell becomes a
// firewalled AlertDelivery (source `follow`) and is pushed through the SAME task-1398 Notifier/adapters as a rule
// alert. These tests use fake adapters only; no network, no key, no trading surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, copyAlertToDelivery, type AlertDelivery, type DeliveryAdapter } from '../src/alerts/index.ts';
import type { CopyAlert, WalletTrade } from '@dexterm/data/copy';

const MINT = 'So11111111111111111111111111111111111111112';
const WALLET = 'Wa1111111111111111111111111111111111111111';

function trade(over: Partial<WalletTrade> = {}): WalletTrade {
  return { wallet: WALLET, sig: 'SIG', slot: 1, t: 1000, tKnown: true, mint: MINT, side: 'buy', tokenDelta: '10', lamportsDelta: -100_000_000, solDelta: -0.1, usd: 15, solUsdAt: 150, note: null, ...over };
}
function alert(over: Partial<CopyAlert> = {}): CopyAlert {
  return { id: 'copy_1', t: 2000, wallet: WALLET, name: 'my fren', trade: trade(), lagMs: 1000, ...over };
}
function captureAdapter(): { adapter: DeliveryAdapter; seen: AlertDelivery[] } {
  const seen: AlertDelivery[] = [];
  return { seen, adapter: { name: 'toast', available: () => true, deliver: async (d) => { seen.push(d); return { ok: true }; } } };
}

test('a BUY becomes an `up` follow delivery; a SELL a `down` one; the mint + time are carried through', () => {
  const buy = copyAlertToDelivery(alert());
  assert.equal(buy.kind, 'alert');
  assert.equal(buy.level, 'up');
  assert.equal(buy.source, 'follow');
  assert.equal(buy.mint, MINT);
  assert.equal(buy.at, 2000);
  assert.match(buy.title, /bought/);
  assert.match(buy.body, /bought/);
  assert.match(buy.body, /\$15/);
  assert.match(buy.body, /not a recommendation/);

  const sell = copyAlertToDelivery(alert({ trade: trade({ side: 'sell', solDelta: 0.2, usd: 30 }) }));
  assert.equal(sell.level, 'down');
  assert.match(sell.title, /sold/);
  assert.match(sell.body, /\$30/);
});

test('an unpriced leg is shown without a USD figure, and a missing label falls back to the short wallet', () => {
  const d = copyAlertToDelivery(alert({ name: null, trade: trade({ usd: null, solDelta: null }) }));
  assert.doesNotMatch(d.body, /\$/);
  assert.doesNotMatch(d.body, /SOL/);
  assert.match(d.title, /Wa11…1111 bought/);
});

test('untrusted label text is firewalled (control/ANSI/bidi stripped, URLs dropped) in title, body, spoken and symbol', () => {
  const nasty = 'x\u001b[31m\u0007‮tcae\thttp://evil.example/x';
  const d = copyAlertToDelivery(alert({ name: nasty }));
  for (const s of [d.title, d.body, d.spoken, d.symbol]) {
    assert.doesNotMatch(s, /[\u0000-\u001f‪-‮]/, 'no control / ANSI / bidi bytes reach a channel');
  }
  assert.doesNotMatch(d.body, /https?:\/\//, 'a URL in the label is dropped (never a clickable channel link)');
});

test('a follow delivery routes through the shared Notifier to the enabled channel (default = toast only)', async () => {
  const cap = captureAdapter();
  const notifier = createNotifier(undefined, { toast: cap.adapter });
  const res = await notifier.deliver(copyAlertToDelivery(alert()));
  assert.equal(res.length, 1);
  assert.equal(res[0].channel, 'toast');
  assert.equal(res[0].ok, true);
  assert.equal(cap.seen.length, 1);
  assert.equal(cap.seen[0].source, 'follow');
  assert.equal(cap.seen[0].level, 'up');
});
