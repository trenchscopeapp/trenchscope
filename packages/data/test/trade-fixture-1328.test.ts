// task-1328 — REAL Jupiter swap transactions through the signer's decoder, policy and binding.
// fixtures/trade/jupiter-swap-*.json were recorded 2026-10-09 from the keyless `/swap/v1/quote` +
// `/swap/v1/swap` for a THROWAWAY public key (generated for the recording, never funded, never stored
// anywhere else, nothing signed or sent). The honest transactions must be accepted; every mutation an
// attacker (or a hostile API) could make to those same bytes must be refused, and the executor must
// refuse to submit the honest transaction without a valid signature by that wallet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../src/clock.ts';
import { SOL_MINT, type PaperOrder } from '../src/paper.ts';
import { base58 } from '../src/sources/solana-rpc.ts';
import { base58Decode } from '../src/sources/pda.ts';
import { defaultCaps, CapLedger } from '../src/trade/caps.ts';
import { DEVNET_RPC, MAINNET_RPC } from '../src/trade/rpc-exec.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { LiveExecutor, LiveLedger, summarize, type LiveExecutorDeps } from '../src/trade/executor.ts';
import {
  decodeTransaction, checkTxPolicy, checkTxPolicyWith, checkSwapBinding, compareApprovedMessage, parseRouteArgs, associatedTokenAddress,
  TOKEN_PROGRAM, TOKEN_2022_PROGRAM, SYSTEM_PROGRAM, JUPITER_V6_PROGRAM, LIGHTHOUSE_PROGRAM, WSOL_MINT,
  type DecodedTransaction, type SwapExpectation,
} from '../src/trade/tx-decode.ts';
import { fakeRpc, solUsdSamples, keypair, signMessage, wireWith } from './trade-helpers.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Fixture { userPublicKey: string; quote: Record<string, unknown>; swap: { swapTransaction: string; prioritizationFeeLamports: number } }
const load = (name: string): Fixture => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/trade/${name}.json`, import.meta.url)), 'utf8')) as Fixture;
const BUY = load('jupiter-swap-buy-sol-usdc');
const SELL = load('jupiter-swap-sell-usdc-sol');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const show = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

const expectOf = (f: Fixture): SwapExpectation => ({
  user: f.userPublicKey, inputMint: String(f.quote.inputMint), outputMint: String(f.quote.outputMint),
  inAmount: BigInt(String(f.quote.inAmount)), outAmount: BigInt(String(f.quote.outAmount)), slippageBps: Number(f.quote.slippageBps),
});
const txOf = (f: Fixture): DecodedTransaction => decodeTransaction(Buffer.from(f.swap.swapTransaction, 'base64'));

// ---- a v0 message serializer (tests only) so the REAL bytes can be mutated structurally
function shortvec(n: number): Buffer { const out: number[] = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); }
interface Mut { addKeys?: string[]; ixs?: (ixs: DecodedTransaction['instructions'], keyIndex: (k: string) => number) => DecodedTransaction['instructions']; feePayer?: string; blockhash?: Buffer }
/** Re-serialize a decoded v0 tx with mutations. Added keys go at the END of the static list (readonly, non-signer); lookup indexes are shifted to stay valid. */
function reserialize(d: DecodedTransaction, m: Mut = {}): string {
  const keys = [...d.staticKeys];
  if (m.feePayer) keys[0] = m.feePayer;
  const added = m.addKeys ?? [];
  const oldStatic = d.staticKeys.length;
  for (const k of added) if (!keys.includes(k)) keys.push(k);
  const shift = (i: number): number => (i >= oldStatic ? i + (keys.length - oldStatic) : i);
  const base = d.instructions.map((ix) => ({ ...ix, programIdIndex: shift(ix.programIdIndex), accounts: ix.accounts.map(shift) }));
  const keyIndex = (k: string): number => { const i = keys.indexOf(k); if (i < 0) throw new Error(`key ${k} not static`); return i; };
  const ixs = m.ixs ? m.ixs(base, keyIndex) : base;
  const parts: Buffer[] = [Buffer.from([0x80, d.numRequiredSignatures, d.numReadonlySigned, d.numReadonlyUnsigned + (keys.length - oldStatic)]), shortvec(keys.length)];
  for (const k of keys) parts.push(Buffer.from(base58Decode(k)));
  parts.push(m.blockhash ?? d.recentBlockhash, shortvec(ixs.length));
  for (const ix of ixs) parts.push(Buffer.from([ix.programIdIndex]), shortvec(ix.accounts.length), Buffer.from(ix.accounts), shortvec(ix.data.length), ix.data);
  parts.push(shortvec(d.lookups.length));
  for (const l of d.lookups) parts.push(Buffer.from(base58Decode(l.table)), shortvec(l.writable.length), Buffer.from(l.writable), shortvec(l.readonly.length), Buffer.from(l.readonly));
  const message = Buffer.concat(parts);
  return Buffer.concat([shortvec(d.numRequiredSignatures), ...Array.from({ length: d.numRequiredSignatures }, () => Buffer.alloc(64)), message]).toString('base64');
}
const u64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const ix = (programIdIndex: number, accounts: number[], data: Buffer) => ({ programIdIndex, programId: null, accounts, data });

// ------------------------------------------------------------------------------------ honest

test('REAL buy (SOL→USDC, shared_accounts_route): decodes, passes policy and binding; route args == quote; accounts are the wallet\'s ATAs', () => {
  const d = txOf(BUY);
  assert.equal(d.version, 0); assert.equal(d.staticKeys[0], BUY.userPublicKey);
  assert.equal(checkTxPolicy(d, BUY.userPublicKey).ok, true);
  const b = checkSwapBinding(d, expectOf(BUY));
  assert.equal(b.ok, true, show(b));
  if (b.ok) {
    assert.equal(b.route, 'shared_accounts_route');
    assert.equal(b.args.inAmount, 10_000_000n); assert.equal(b.args.quotedOutAmount, BigInt(String(BUY.quote.outAmount))); assert.equal(b.args.slippageBps, 50); assert.equal(b.args.platformFeeBps, 0);
  }
  const route = d.instructions.find((x) => x.programId === JUPITER_V6_PROGRAM)!;
  assert.equal(d.staticKeys[route.accounts[2]], BUY.userPublicKey, 'user_transfer_authority');
  assert.equal(d.staticKeys[route.accounts[3]], associatedTokenAddress(BUY.userPublicKey, WSOL_MINT, TOKEN_PROGRAM), 'source = wallet WSOL ATA');
  assert.equal(d.staticKeys[route.accounts[6]], associatedTokenAddress(BUY.userPublicKey, USDC, TOKEN_PROGRAM), 'destination = wallet USDC ATA');
  const s = summarize(d).map((x) => `${x.program}:${x.op}`);
  assert.deepEqual(s, ['ComputeBudget:SetComputeUnitLimit', 'AssociatedToken:CreateIdempotent', 'System:Transfer→own WSOL', 'Token:SyncNative', 'AssociatedToken:CreateIdempotent', 'Jupiter:shared_accounts_route', 'Token:CloseAccount→wallet'], show(s));
});

test('REAL sell (USDC→SOL, route): decodes, passes policy and binding; the sell leg spends exactly the order from the wallet\'s USDC ATA into its WSOL ATA', () => {
  const d = txOf(SELL);
  assert.equal(checkTxPolicy(d, SELL.userPublicKey).ok, true);
  const b = checkSwapBinding(d, expectOf(SELL));
  assert.equal(b.ok, true, show(b));
  if (b.ok) { assert.equal(b.route, 'route'); assert.equal(b.args.inAmount, 1_000_000n); }
  const route = d.instructions.find((x) => x.programId === JUPITER_V6_PROGRAM)!;
  assert.equal(d.staticKeys[route.accounts[1]], SELL.userPublicKey);
  assert.equal(d.staticKeys[route.accounts[2]], associatedTokenAddress(SELL.userPublicKey, USDC, TOKEN_PROGRAM), 'source = wallet USDC ATA');
  assert.equal(d.staticKeys[route.accounts[3]], associatedTokenAddress(SELL.userPublicKey, WSOL_MINT, TOKEN_PROGRAM), 'destination = wallet WSOL ATA');
  assert.ok(d.instructions.some((x) => x.programId === TOKEN_PROGRAM && x.data[0] === 9), 'WSOL closed back to the wallet');
  // the recorded sell is a different order than the buy: the buy's expectation refuses it
  assert.equal(checkSwapBinding(d, expectOf(BUY)).ok, false);
});

test('re-serializing the real bytes unchanged reproduces them byte for byte (the mutation harness is sound)', () => {
  for (const f of [BUY, SELL]) {
    const d = txOf(f);
    assert.equal(reserialize(d), f.swap.swapTransaction);
  }
});

// ------------------------------------------------------------------------------------ attacks on the REAL bytes

test('ATTACKS on the real buy: every mutation is refused (policy or binding); the honest control passes', () => {
  const d0 = txOf(BUY);
  const exp = expectOf(BUY);
  const attacker = keypair().address;
  const kTok = (d: DecodedTransaction) => d.staticKeys.indexOf(TOKEN_PROGRAM);
  const kSys = (d: DecodedTransaction) => d.staticKeys.indexOf(SYSTEM_PROGRAM);
  const USER_USDC_ATA = associatedTokenAddress(BUY.userPublicKey, USDC, TOKEN_PROGRAM);
  const iUsdc = d0.staticKeys.indexOf(USER_USDC_ATA);
  const verdict = (b64: string): { ok: boolean; reason?: string; message?: string } => {
    const d = decodeTransaction(Buffer.from(b64, 'base64'));
    const pol = checkTxPolicy(d, BUY.userPublicKey);
    if (!pol.ok) return pol;
    return checkSwapBinding(d, exp);
  };
  const cases: [string, string, RegExp][] = [
    ['route in_amount inflated to the wallet\'s whole balance', reserialize(d0, { ixs: (ixs) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, data: Buffer.concat([x.data.subarray(0, x.data.length - 19), u64(1_000_000_000_000n), x.data.subarray(x.data.length - 11)]) } : x) }), /quote-mismatch|in_amount/],
    ['route quoted_out lowered (worse price than shown)', reserialize(d0, { ixs: (ixs) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, data: Buffer.concat([x.data.subarray(0, x.data.length - 11), u64(1n), x.data.subarray(x.data.length - 3)]) } : x) }), /quoted_out/],
    ['route slippage raised to 100%', reserialize(d0, { ixs: (ixs) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, data: Buffer.concat([x.data.subarray(0, x.data.length - 3), Buffer.from([0x10, 0x27]), x.data.subarray(x.data.length - 1)]) } : x) }), /slippage/],
    ['route platform fee set to 255 bps', reserialize(d0, { ixs: (ixs) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, data: Buffer.concat([x.data.subarray(0, x.data.length - 1), Buffer.from([255])]) } : x) }), /platform fee/],
    ['route discriminator swapped to exact_out_route', reserialize(d0, { ixs: (ixs) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, data: Buffer.concat([Buffer.from('d033ef977b2bed5c', 'hex'), x.data.subarray(8)]) } : x) }), /not an ExactIn route/],
    ['route discriminator swapped to a non-route Jupiter ix', reserialize(d0, { ixs: (ixs) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, data: Buffer.concat([Buffer.from('0000000000000000', 'hex'), x.data.subarray(8)]) } : x) }), /not a route|not an ExactIn/],
    ['destination token account swapped to the attacker\'s', reserialize(d0, { addKeys: [attacker], ixs: (ixs, k) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, accounts: x.accounts.map((a, i) => (i === 6 ? k(attacker) : a)) } : x) }), /destination/],
    ['source token account swapped to a foreign account', reserialize(d0, { addKeys: [attacker], ixs: (ixs, k) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, accounts: x.accounts.map((a, i) => (i === 3 ? k(attacker) : a)) } : x) }), /source/],
    ['transfer authority swapped', reserialize(d0, { addKeys: [attacker], ixs: (ixs, k) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, accounts: x.accounts.map((a, i) => (i === 2 ? k(attacker) : a)) } : x) }), /authority|signer/],
    ['a platform-fee account named', reserialize(d0, { addKeys: [attacker], ixs: (ixs, k) => ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, accounts: x.accounts.map((a, i) => (i === 9 ? k(attacker) : a)) } : x) }), /platform-fee account/],
    ['appended SPL Transfer of the user\'s USDC to another account', reserialize(d0, { ixs: (ixs) => [...ixs, ix(kTok(d0), [iUsdc, 8, 0], Buffer.concat([Buffer.from([3]), u64(1_000_000n)]))] }), /Transfer/],
    ['appended SPL TransferChecked', reserialize(d0, { ixs: (ixs) => [...ixs, ix(kTok(d0), [iUsdc, 32, 8, 0], Buffer.concat([Buffer.from([12]), u64(1n), Buffer.from([6])]))] }), /TransferChecked/],
    ['appended Token-2022 Transfer', reserialize(d0, { addKeys: [TOKEN_2022_PROGRAM], ixs: (ixs, k) => [...ixs, ix(k(TOKEN_2022_PROGRAM), [iUsdc, 8, 0], Buffer.concat([Buffer.from([3]), u64(1n)]))] }), /Transfer/],
    ['appended SPL Burn', reserialize(d0, { ixs: (ixs) => [...ixs, ix(kTok(d0), [iUsdc, 32, 0], Buffer.concat([Buffer.from([8]), u64(1n)]))] }), /Burn/],
    ['appended SetAuthority', reserialize(d0, { ixs: (ixs) => [...ixs, ix(kTok(d0), [iUsdc, 0], Buffer.from([6, 2, 1, ...Buffer.alloc(32)]))] }), /SetAuthority/],
    ['appended Approve (delegation)', reserialize(d0, { ixs: (ixs) => [...ixs, ix(kTok(d0), [iUsdc, 8, 0], Buffer.concat([Buffer.from([4]), u64(1n)]))] }), /Approve/],
    ['appended bare System transfer of the order SOL to an account', reserialize(d0, { ixs: (ixs) => [...ixs, ix(kSys(d0), [0, 8], Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(10_000_000n)]))] }), /System Transfer/],
    ['a second route (duplicate leg)', reserialize(d0, { ixs: (ixs) => [...ixs, ixs.find((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM)!] }), /2 Jupiter|not-a-swap/],
    ['the route removed (only the wrap/unwrap scaffolding)', reserialize(d0, { ixs: (ixs) => ixs.filter((x) => d0.staticKeys[x.programIdIndex] !== JUPITER_V6_PROGRAM) }), /no Jupiter route|not-a-swap/],
    ['CloseAccount of the WSOL account to another destination', reserialize(d0, { ixs: (ixs) => ixs.map((x) => (d0.staticKeys[x.programIdIndex] === TOKEN_PROGRAM && x.data[0] === 9) ? { ...x, accounts: [x.accounts[0], 8, 0] } : x) }), /CloseAccount|wrapped-SOL/],
    ['fee payer swapped to another wallet', reserialize(d0, { feePayer: attacker }), /fee payer|signer/],
    ['a Lighthouse instruction inside the UNSIGNED tx (not Phantom\'s tail)', reserialize(d0, { addKeys: [LIGHTHOUSE_PROGRAM], ixs: (ixs, k) => [...ixs, ix(k(LIGHTHOUSE_PROGRAM), [0], Buffer.from([3, 0]))] }), /not allow-listed|Lighthouse/],
  ];
  assert.equal(verdict(BUY.swap.swapTransaction).ok, true, 'control');
  for (const [name, b64, re] of cases) {
    const v = verdict(b64);
    assert.equal(v.ok, false, `${name}: must be refused`);
    assert.match(`${v.reason} ${v.message}`, re, `${name}: ${show(v)}`);
  }
});

test('ATTACKS on the real sell: in_amount, source account and destination mutations are refused', () => {
  const d0 = txOf(SELL);
  const exp = expectOf(SELL);
  const attacker = keypair().address;
  const route = (x: DecodedTransaction['instructions'][number]) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM;
  const cases: [string, string, RegExp][] = [
    ['sell in_amount inflated beyond the order', reserialize(d0, { ixs: (ixs) => ixs.map((x) => route(x) ? { ...x, data: Buffer.concat([x.data.subarray(0, x.data.length - 19), u64(999_000_000n), x.data.subarray(x.data.length - 11)]) } : x) }), /in_amount/],
    ['sell source swapped to a foreign token account', reserialize(d0, { addKeys: [attacker], ixs: (ixs, k) => ixs.map((x) => route(x) ? { ...x, accounts: x.accounts.map((a, i) => (i === 2 ? k(attacker) : a)) } : x) }), /source/],
    ['sell destination (the SOL leg) swapped to the attacker', reserialize(d0, { addKeys: [attacker], ixs: (ixs, k) => ixs.map((x) => route(x) ? { ...x, accounts: x.accounts.map((a, i) => (i === 3 ? k(attacker) : a)) } : x) }), /destination/],
  ];
  for (const [name, b64, re] of cases) {
    const d = decodeTransaction(Buffer.from(b64, 'base64'));
    const pol = checkTxPolicy(d, SELL.userPublicKey);
    const v = pol.ok ? checkSwapBinding(d, exp) : pol;
    assert.equal(v.ok, false, `${name}: must be refused`);
    assert.match(`${(v as { reason: string }).reason} ${(v as { message: string }).message}`, re, `${name}: ${show(v)}`);
  }
});

test('Lighthouse on the REAL buy: the approved message plus an appended assertion tail matches; the policy accepts the tail only on signed bytes', () => {
  const d0 = txOf(BUY);
  const tailed = decodeTransaction(Buffer.from(reserialize(d0, { addKeys: [LIGHTHOUSE_PROGRAM], ixs: (ixs, k) => [...ixs, ix(k(LIGHTHOUSE_PROGRAM), [0], Buffer.from([3, 1, 2, 3]))] }), 'base64'));
  const cmp = compareApprovedMessage(d0, tailed);
  assert.equal(cmp.ok, true, show(cmp));
  if (cmp.ok) assert.equal(cmp.lighthouseTail, 1);
  assert.equal(checkTxPolicyWith(tailed, BUY.userPublicKey, undefined, { lighthouseTail: true }).ok, true);
  assert.equal(checkSwapBinding(tailed, expectOf(BUY)).ok, true, 'binding still holds with the tail (lookup indexes re-shifted)');
  assert.equal(checkTxPolicyWith(tailed, BUY.userPublicKey).ok, false, 'without the tail allowance the Lighthouse program is refused');
  // a tail that ALSO edits the route is a mismatch
  const edited = decodeTransaction(Buffer.from(reserialize(d0, { addKeys: [LIGHTHOUSE_PROGRAM], ixs: (ixs, k) => [...ixs.map((x) => d0.staticKeys[x.programIdIndex] === JUPITER_V6_PROGRAM ? { ...x, data: Buffer.concat([x.data.subarray(0, x.data.length - 1), Buffer.from([9])]) } : x), ix(k(LIGHTHOUSE_PROGRAM), [0], Buffer.from([3]))] }), 'base64'));
  assert.equal(compareApprovedMessage(d0, edited).ok, false);
});

// ------------------------------------------------------------------------------------ executor on the real bytes

function harness(f: Fixture, net: 'devnet' | 'mainnet', sign: (unsigned: string) => string) {
  const clock = new FakeClock(Date.UTC(2026, 9, 9, 12));
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-fx-'));
  const rpc = fakeRpc({ url: net === 'mainnet' ? MAINNET_RPC : DEVNET_RPC, solOut: 10_005_000n });
  const ledger = new CapLedger({ clock });
  let signs = 0;
  const deps: LiveExecutorDeps = {
    build: { quoteRaw: async () => f.quote, buildSwap: async () => ({ swapTransactionBase64: f.swap.swapTransaction, lastValidBlockHeight: 1, prioritizationFeeLamports: f.swap.prioritizationFeeLamports, quote: f.quote }) } as unknown as LiveExecutorDeps['build'],
    rpc: rpc as unknown as LiveExecutorDeps['rpc'],
    bridge: { signTransaction: async (a: { unsignedTxBase64: string }) => { signs++; return { signedTxBase64: sign(a.unsignedTxBase64), provider: 'fake', roundTripMs: 1 }; } } as unknown as LiveExecutorDeps['bridge'],
    caps: defaultCaps({ network: net, mainnetEnabled: net === 'mainnet' }),
    ledger, liveLedger: new LiveLedger({ clock }), clock, solUsd: () => solUsdSamples(150, clock.now()), killSwitch: new KillSwitch(join(dir, 'panic')),
  };
  return { ex: new LiveExecutor(deps), rpc, ledger, signs: () => signs, done: () => { ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('executor on the REAL buy: buildPlan accepts it (policy + binding + sim), and a confirm whose "wallet" returns the bytes unsigned / signed by another key is refused — nothing submitted', async () => {
  const order: PaperOrder = { mint: USDC, symbol: 'USDC', side: 'buy', decimals: 6, amountRaw: 10_000_000n, slippageBps: 50 };
  // 1. unsigned bytes handed back as "signed"
  const a = harness(BUY, 'mainnet', (u) => u);
  try {
    const b = await a.ex.buildPlan({ order, userPublicKey: BUY.userPublicKey, network: 'mainnet' });
    assert.equal(b.plan.txPolicy.ok, true, show(b.plan.txPolicy));
    assert.equal(b.plan.simulated, true); assert.equal(b.plan.simOk, true);
    assert.equal(b.feeLamports, BigInt(5000 + BUY.swap.prioritizationFeeLamports));
    assert.equal(a.ex.precheck(b).ok, true, show(a.ex.precheck(b)));
    const out = await a.ex.confirmAndSubmit(b, b.hash, BUY.userPublicKey);
    assert.equal(out.kind, 'refused'); assert.equal((out as { reason: string }).reason, 'bad-signature', show(out));
    assert.equal(a.rpc.calls.submit, 0); assert.equal(a.ledger.spentToday(), 0, 'refunded');
  } finally { a.done(); }
  // 2. the exact message signed by a DIFFERENT key (a wallet swap)
  const other = keypair();
  const b2 = harness(BUY, 'mainnet', (u) => { const d = decodeTransaction(Buffer.from(u, 'base64')); return wireWith(d.message, [signMessage(other, d.message)]); });
  try {
    const b = await b2.ex.buildPlan({ order, userPublicKey: BUY.userPublicKey, network: 'mainnet' });
    const out = await b2.ex.confirmAndSubmit(b, b.hash, BUY.userPublicKey);
    assert.equal((out as { reason: string }).reason, 'bad-signature', show(out));
    assert.equal(b2.rpc.calls.submit, 0);
  } finally { b2.done(); }
  // 3. the order says 0.02 SOL but the (replayed) tx is the 0.01 SOL swap: the quote binds to the order first
  const c = harness(BUY, 'mainnet', (u) => u);
  try {
    const b = await c.ex.buildPlan({ order: { ...order, amountRaw: 20_000_000n }, userPublicKey: BUY.userPublicKey, network: 'mainnet' });
    assert.equal(b.plan.txPolicy.ok, false); assert.equal((b.plan.txPolicy as { reason: string }).reason, 'quote-mismatch');
    assert.equal(c.rpc.calls.simulate, 0, 'never simulated');
  } finally { c.done(); }
  // 4. the real sell through buildPlan, as a sell order
  const s = harness(SELL, 'mainnet', (u) => u);
  try {
    const b = await s.ex.buildPlan({ order: { mint: USDC, symbol: 'USDC', side: 'sell', decimals: 6, amountRaw: 1_000_000n, slippageBps: 50 }, userPublicKey: SELL.userPublicKey, network: 'mainnet' });
    assert.equal(b.plan.txPolicy.ok, true, show(b.plan.txPolicy));
  } finally { s.done(); }
  assert.equal(base58(base58Decode(BUY.userPublicKey)), BUY.userPublicKey);
  assert.ok(parseRouteArgs(Buffer.alloc(10)) === null);
});
