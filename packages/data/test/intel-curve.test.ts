// A thin pump.fun launch (fewer than 8 launch txs) must never count its own bonding curve as a sniper. The
// trade-count heuristic for the pool cannot fire that early, so the curve is excluded by its PDA address.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, pumpBondingCurve, type IntelRaw, type RawTx } from '../src/index.ts';
import { PUMP_PROGRAM } from '../src/sources/pump-curve.ts';
import { SYSTEM_PROGRAM } from '../src/trade/tx-decode.ts';

const MINT = '3fgTNzLyBkAXMJMqfYGjVqL5uBv6zPdnwda7Su31pump';
const CURVE = pumpBondingCurve(MINT);
const DEV = 'DevWa11et1111111111111111111111111111111111';
const BUYER = 'Buyer11111111111111111111111111111111111111';

function tx(slot: number, signer: string, tokenDeltas: Array<[string, bigint, bigint]>, sig: string): RawTx {
  const keys = [{ pubkey: signer, signer: true }, { pubkey: CURVE, signer: false }, { pubkey: PUMP_PROGRAM, signer: false }];
  const preT = tokenDeltas.map(([owner, a], i) => ({ accountIndex: 100 + i, mint: MINT, owner, uiTokenAmount: { amount: a.toString() } }));
  const postT = tokenDeltas.map(([owner, , b], i) => ({ accountIndex: 100 + i, mint: MINT, owner, uiTokenAmount: { amount: b.toString() } }));
  return { slot, blockTime: 1_700_000_000 + slot, transaction: { signatures: [sig], message: { accountKeys: keys } }, meta: { preBalances: [5e9, 1e9, 1], postBalances: [4e9, 2e9, 1], preTokenBalances: preT, postTokenBalances: postT } };
}

test('thin pump.fun launch: the bonding curve is never a sniper', () => {
  const supply = 1_000_000n;
  const raw: IntelRaw = {
    mint: MINT, supply: supply.toString(), decimals: 6,
    largest: [{ address: 'CurveAta1111111111111111111111111111111111', amount: '930000' }, { address: 'DevAta111111111111111111111111111111111111', amount: '50000' }, { address: 'BuyerAta11111111111111111111111111111111111', amount: '20000' }],
    owners: { CurveAta1111111111111111111111111111111111: CURVE, DevAta111111111111111111111111111111111111: DEV, BuyerAta11111111111111111111111111111111111: BUYER },
    ownerMeta: { [CURVE]: { programOwner: PUMP_PROGRAM, exists: true, lamports: 1e9 }, [DEV]: { programOwner: SYSTEM_PROGRAM, exists: true, lamports: 1e9 }, [BUYER]: { programOwner: SYSTEM_PROGRAM, exists: true, lamports: 1e9 } },
    funding: {},
    launch: [
      // create: the curve receives the supply and the dev buys from it in the same tx
      tx(1000, DEV, [[CURVE, 0n, 950_000n], [DEV, 0n, 50_000n]], 'sigCreate'),
      tx(1001, BUYER, [[CURVE, 950_000n, 930_000n], [BUYER, 0n, 20_000n]], 'sigBuy'),
    ],
    launchMore: false,
    crossToken: {},
  };
  const a = analyze(raw);
  const curve = a.holders.find((h) => h.owner === CURVE);
  assert.ok(!curve?.labels.some((l) => l.label === 'sniper'), 'the curve is the venue, not a sniper');
  assert.ok(a.holders.find((h) => h.owner === BUYER)?.labels.some((l) => l.label === 'sniper'), 'a real early buyer still is');
  assert.equal(a.insights.snipers.count, 1);
});
