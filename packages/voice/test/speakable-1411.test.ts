// task-1411 part C: speakable() makes a spoken line read like a trader, not digit by digit. A tester heard
// Jarvis read a raw per-token price ("$0.0000029") and big raw numbers, which sounded crazy. Each rule
// below is one of the tester's reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable, humanizeNumber } from '../src/speakable.ts';

test('tiny per-token prices are never read digit by digit', () => {
  // sub-cent decimal
  assert.equal(speakable('it trades at $0.0000029 right now'), 'it trades at a tiny price right now');
  assert.equal(speakable('price 0.00004'), 'price a tiny price');
  // the app's own subscript rendering
  assert.equal(speakable('$0.0₅29 per token'), 'a tiny price per token');
  assert.equal(speakable('0.0₄1686'), 'a tiny price');
  // a normal price is left alone
  assert.equal(speakable('SOL is at $212.40'), 'SOL is at $212.40');
});

test('a known market cap is spoken in place of a tiny price; we never invent one', () => {
  assert.equal(speakable('$0.0000029', { marketCap: '340 thousand' }), 'a market cap of 340 thousand');
  // no market cap known -> the safe phrase, not a made-up number
  assert.equal(speakable('$0.0000029'), 'a tiny price');
});

test('the market cap is read out of the analyst line and replaces the tiny price', () => {
  // the brief: a tiny price is replaced WITH THE COIN'S MARKET CAP when the analyst text includes it
  assert.equal(
    speakable('Price $0.0000029, market cap $340K, up 12% today.'),
    'Price a market cap of 340 thousand, market cap 340 thousand, up 12 percent today.',
  );
  // "mcap" / raw-number cap forms are read too
  assert.equal(speakable('trades at $0.00004 with mcap 1.2M'), 'trades at a market cap of 1.2 million with mcap 1.2 million');
  assert.equal(speakable('price 0.0000011, cap 340000'), 'price a market cap of 340 thousand, cap 340 thousand');
  // an explicit opts.marketCap governs the tiny-price substitution; a literal number in the line is
  // still humanised on its own
  assert.equal(speakable('$0.0000029, cap 500000', { marketCap: '2 million' }), 'a market cap of 2 million, cap 500 thousand');
});

test('a 4-digit year is never humanised', () => {
  assert.equal(speakable('launched in 2024'), 'launched in 2024');
  assert.equal(speakable('the 1999 bull run'), 'the 1999 bull run');
  // a comma-grouped or $ amount that happens to be 4 digits IS still an amount
  assert.equal(speakable('a cap of $2,024'), 'a cap of 2 thousand');
});

test('a small amount with a unit (SOL fee) is not read as a per-token price', () => {
  assert.equal(speakable('fee 0.005 SOL'), 'fee 0.005 SOL');
  assert.equal(speakable('network cost 0.0025 SOL per swap'), 'network cost 0.0025 SOL per swap');
  assert.equal(speakable('priced 0.5 SOL'), 'priced 0.5 SOL');
  // but a bare sub-cent price with no unit is still a tiny price
  assert.equal(speakable('it is 0.0000029 right now'), 'it is a tiny price right now');
});

test('big raw numbers become human words', () => {
  assert.equal(speakable('market cap is 340000'), 'market cap is 340 thousand');
  assert.equal(speakable('volume 1200000 today'), 'volume 1.2 million today');
});

test('big raw numbers: millions, billions, comma groups, and dollar signs', () => {
  assert.equal(speakable('4500000000 supply'), '4.5 billion supply');
  assert.equal(speakable('a cap of $340,000'), 'a cap of 340 thousand');
  assert.equal(speakable('1,200,000 holders'), '1.2 million holders');
  assert.equal(speakable('liquidity $2,100,000'), 'liquidity 2.1 million');
  // already-human numbers from the analyst are left intact
  assert.equal(speakable('around 340 thousand'), 'around 340 thousand');
  assert.equal(speakable('1.2 million market cap'), '1.2 million market cap');
});

test('abbreviated magnitudes expand, but a lowercase "m" age (minutes) does not', () => {
  assert.equal(speakable('cap $340K vol $2.1M'), 'cap 340 thousand vol 2.1 million');
  assert.equal(speakable('4.5B supply'), '4.5 billion supply');
  // "15m" / "6h" are a token age, not millions — leave them
  assert.equal(speakable('launched 15m ago, 6h old'), 'launched 15m ago, 6h old');
});

test('percentages read naturally', () => {
  assert.equal(speakable('up 12% today'), 'up 12 percent today');
  assert.equal(speakable('down 61.4%'), 'down 61.4 percent');
});

test('small numbers and short addresses are untouched', () => {
  assert.equal(speakable('top 20 holders, 2 devs'), 'top 20 holders, 2 devs');
  assert.equal(speakable('the 7xKX…Dgkp wallet'), 'the 7xKX…Dgkp wallet');
});

test('humanizeNumber is exported and correct', () => {
  assert.equal(humanizeNumber(340000), '340 thousand');
  assert.equal(humanizeNumber(1200000), '1.2 million');
  assert.equal(humanizeNumber(4500000000), '4.5 billion');
  assert.equal(humanizeNumber(1000000), '1 million');
});
