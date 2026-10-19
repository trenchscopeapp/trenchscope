// task-1328 T2 — the SIGNER: protocol, service (on fakes), the cross-process channel (a real child),
// Lighthouse tolerance, the devnet probe, caps-only-downward, SOL/USD freshness, refund-after-broadcast.
// No network, no wallet, no funds: every transaction is hand-built and signed with a throwaway key.
import assert from 'node:assert/strict';
import { closeTestSigner } from '../../../scripts/test-support.ts';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../src/clock.ts';
import { SOL_MINT } from '../src/paper.ts';
import { defaultCaps, capsOnlyDownward, CapLedger, DEFAULT_PER_TRADE_USD, DEFAULT_DAILY_USD } from '../src/trade/caps.ts';
import { DEVNET_RPC, MAINNET_RPC, RpcRejectedError } from '../src/trade/rpc-exec.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { WalletLinkStore } from '../src/trade/link-store.ts';
import { LiveExecutor, LiveLedger, type LiveExecutorDeps } from '../src/trade/executor.ts';
import { decodeTransaction, compareApprovedMessage, checkTxPolicyWith, LIGHTHOUSE_PROGRAM } from '../src/trade/tx-decode.ts';
import { SignerService, SignerError, parsePlanParams, parseHashParam } from '../src/trade/signer/service.ts';
import { SignerClient, SignerUnavailableError } from '../src/trade/signer/client.ts';
import { encodeFrame, decodeFrame, encodeHello, parseHello, newSecret, mac, SIGNER_METHODS, type Frame } from '../src/trade/signer/protocol.ts';
import { parseSignerArgs } from '../src/trade/signer/main.ts';
import { compileProbeMessage, probeWire, PROBE_LAMPORTS, DevnetProbeBuilder } from '../src/trade/signer/probe-builder.ts';
import { SolUsdFeed, parseDexScreenerSol, parseCoinGeckoSol } from '../src/trade/signer/sol-usd-feed.ts';
import { WalletBridge, solanaWeb3Bundle, SOLANA_WEB3_VENDOR } from '../src/trade/bridge.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { keypair, buildTx, jupiterSwapIxs, lighthouseIx, tokenIx, fakeRpc, solUsdSamples, randomKey, wireWith, signMessage, type BuiltTx, type Keypair, type IxSpec } from './trade-helpers.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const show = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const T0 = Date.UTC(2026, 9, 9, 12);

const rawQuote = (over: Record<string, unknown> = {}) => ({
  inputMint: SOL_MINT, outputMint: MINT, inAmount: '500000000', outAmount: '2000000', otherAmountThreshold: '1990000',
  swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.005', platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '3', ...over,
});
const PLAN = { mint: MINT, symbol: 'USDC', side: 'buy' as const, decimals: 6, amountRaw: '500000000', slippageBps: 50 };

interface Opts {
  network?: 'devnet' | 'mainnet'; link?: boolean; clock?: FakeClock;
  /** What the fake wallet returns for an unsigned tx (default: the honest signature). */
  sign?: (t: BuiltTx, user: Keypair) => string;
  solUsd?: () => unknown;
  submit?: (tx: string) => Promise<string>;
  signatureStatus?: (sig: string) => Promise<{ confirmationStatus: string | null; err: unknown; slot: number | null } | null>;
  solOut?: bigint;
  blockhash?: Buffer;
}

function mk(o: Opts = {}) {
  const clock = o.clock ?? new FakeClock(T0);
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-signer-'));
  const user = keypair();
  const linkStore = new WalletLinkStore(join(dir, 'wallet-link.json'));
  if (o.link !== false) linkStore.set(user.address, { now: T0 });
  const net = o.network ?? 'devnet';
  const txs = new Map<string, BuiltTx>();
  const fresh = (): BuiltTx => { const t = buildTx({ feePayer: user.pub, ixs: jupiterSwapIxs(user, 500_000_000n), blockhash: o.blockhash }); txs.set(t.unsigned, t); return t; };
  const rpc = fakeRpc({ url: net === 'mainnet' ? MAINNET_RPC : DEVNET_RPC, submit: o.submit, signatureStatus: o.signatureStatus, solOut: o.solOut });
  const probeRpc = { ...rpc, latestBlockhash: async () => ({ blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', lastValidBlockHeight: 1 }) };
  const ledger = new CapLedger({ clock });
  const liveLedger = new LiveLedger({ clock });
  const killSwitch = new KillSwitch(join(dir, 'trading.panic'));
  let signs = 0;
  const deps: LiveExecutorDeps = {
    build: { quoteRaw: async () => rawQuote(), buildSwap: async () => ({ swapTransactionBase64: fresh().unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 1234, quote: rawQuote() }) } as unknown as LiveExecutorDeps['build'],
    rpc: probeRpc as unknown as LiveExecutorDeps['rpc'],
    bridge: { signTransaction: async (a: { unsignedTxBase64: string }) => {
      signs++;
      const t = txs.get(a.unsignedTxBase64);
      // a tx the harness did not build (the probe): sign its message honestly with the throwaway key
      if (!t) { const d = decodeTransaction(Buffer.from(a.unsignedTxBase64, 'base64')); return { signedTxBase64: wireWith(d.message, [signMessage(user, d.message)]), provider: 'fake', roundTripMs: 1 }; }
      return { signedTxBase64: o.sign ? o.sign(t, user) : t.sign(user), provider: 'fake', roundTripMs: 1 };
    } } as unknown as LiveExecutorDeps['bridge'],
    caps: defaultCaps({ network: net, mainnetEnabled: net === 'mainnet' }),
    ledger, liveLedger, clock,
    solUsd: o.solUsd ?? (() => solUsdSamples(6, clock.now())),
    killSwitch,
    probe: new DevnetProbeBuilder(probeRpc as never),
  };
  const executor = new LiveExecutor(deps);
  const service = new SignerService({ executor, deps, linkStore, liveLedger, clock });
  return { service, deps, user, dir, rpc, ledger, liveLedger, clock, killSwitch, linkStore, signs: () => signs, done: () => { ledger.close(); liveLedger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ------------------------------------------------------------------------------------ protocol

test('protocol: frames round-trip; bad mac, replayed/out-of-order seq, wrong version, oversize are refused', () => {
  const secret = newSecret();
  const line = encodeFrame(secret, 0, { id: 1, method: 'status', params: {} });
  const d = decodeFrame(secret, line.trim(), 0);
  assert.equal(d.ok, true);
  assert.equal(decodeFrame(secret, line.trim(), 1).ok, false, 'replay (seq 0 again) refused');
  assert.equal(decodeFrame(newSecret(), line.trim(), 0).ok, false, 'another secret refused');
  const f = JSON.parse(line) as Frame;
  const tampered = { ...f, body: JSON.stringify({ id: 1, method: 'confirm', params: { hash: 'a'.repeat(64) } }) };
  assert.equal(decodeFrame(secret, JSON.stringify(tampered), 0).ok, false, 'tampered body fails the mac');
  assert.equal(decodeFrame(secret, JSON.stringify({ ...f, v: 2, mac: mac(secret, 0, f.body) }), 0).ok, false, 'wrong version');
  assert.equal(decodeFrame(secret, 'x'.repeat(70_000), 0).ok, false, 'oversize');
  assert.equal(decodeFrame(secret, 'null', 0).ok, false);
  assert.equal(parseHello(encodeHello(secret).trim())?.secret.equals(secret), true);
  assert.equal(parseHello('{"hello":"dexterm-signer","v":1,"secret":"short"}'), null, 'a short secret is refused');
  assert.ok(!SIGNER_METHODS.has('sign') && !SIGNER_METHODS.has('submit') && !SIGNER_METHODS.has('setCaps'), 'no sign/submit/setCaps method exists');
});

test('service: plan params are validated, never coerced', () => {
  assert.throws(() => parsePlanParams(null), SignerError);
  assert.throws(() => parsePlanParams({ ...PLAN, mint: 'not-a-mint' }), /base58/);
  assert.throws(() => parsePlanParams({ ...PLAN, amountRaw: 500_000_000 }), /integer string/);
  assert.throws(() => parsePlanParams({ ...PLAN, amountRaw: '-1' }), /integer string/);
  assert.throws(() => parsePlanParams({ ...PLAN, side: 'both' }), /side/);
  assert.throws(() => parsePlanParams({ ...PLAN, slippageBps: 5000 }), /slippageBps/);
  assert.throws(() => parseHashParam({ hash: { toString: () => 'x' } }), /hash/);
  assert.equal(parsePlanParams({ ...PLAN, symbol: 'A\u0000B' }).symbol, 'A?B', 'symbol is sanitized');
});

// ------------------------------------------------------------------------------------ service

test('service: status reports the RPC-classified network (never a label), the linked wallet and the caps', async () => {
  const h = mk({ network: 'devnet' });
  try {
    const s = h.service.status();
    assert.equal(s.network, 'devnet');
    assert.equal(s.linked?.publicKey, h.user.address);
    assert.equal(s.caps.perTradeUsd, 5); assert.equal(s.caps.dailyUsd, 20);
    assert.equal(s.panic, null); assert.equal(s.probeAvailable, true);
    // a devnet-labelled caps object over a MAINNET endpoint reports mainnet
    (h.deps.rpc as { url: string }).url = MAINNET_RPC;
    assert.equal(h.service.status().network, 'mainnet', 'the network follows the endpoint');
  } finally { h.done(); }
});

test('service: no linked wallet → plan refused (no-wallet); the UI cannot name a wallet', async () => {
  const h = mk({ link: false });
  try {
    await assert.rejects(h.service.plan(PLAN), (e: SignerError) => e.reason === 'no-wallet');
    await assert.rejects(h.service.plan({ ...PLAN, userPublicKey: h.user.address } as never), (e: SignerError) => e.reason === 'no-wallet', 'an extra userPublicKey param is ignored');
  } finally { h.done(); }
});

test('service: plan → view (no bytes) → confirm fills; the plan is single-use; unknown hash refused', async () => {
  const h = mk();
  try {
    const v = await h.service.plan(PLAN);
    assert.equal(v.kind, 'swap'); assert.equal(v.network, 'devnet'); assert.equal(v.amountInRaw, '500000000'); assert.equal(v.amountOutRaw, '2000000');
    assert.equal(v.policy.ok, true); assert.equal(v.precheck.ok, true); assert.equal(v.sim.ok, true);
    assert.equal(v.feeLamports, String(5000 + 1234)); assert.ok(v.instructions.some((i) => i.program === 'Jupiter' && i.op === 'route'), show(v.instructions));
    assert.ok(!('unsignedTxBase64' in v) && !('decoded' in v), 'the view carries no transaction bytes');
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'filled', show(c));
    assert.equal(h.signs(), 1); assert.equal(h.rpc.calls.submit, 1);
    const again = await h.service.confirm({ hash: v.hash });
    assert.equal(again.kind, 'refused'); assert.equal(h.signs(), 1, 'a second keypress on the same plan signs nothing');
    const unknown = await h.service.confirm({ hash: 'f'.repeat(64) });
    assert.equal(unknown.kind, 'refused');
    assert.equal(h.liveLedger.positions().length, 1, 'the live ledger booked the position');
  } finally { h.done(); }
});

test('service: `sign`, `submit`, `setCaps` and any unknown method are refused by the dispatcher', async () => {
  const h = mk();
  try {
    for (const m of ['sign', 'submit', 'setCaps', 'signIfArmed', 'arm', '']) {
      await assert.rejects(h.service.call(m, { tx: 'AQAB', bytes: 'AQAB' }), /unknown method/, m);
    }
    assert.equal(h.signs(), 0); assert.equal(h.rpc.calls.submit, 0);
  } finally { h.done(); }
});

test('service: panic engages the kill switch + ledger lock, forgets plans, and refuses every later plan/confirm', async () => {
  const h = mk();
  try {
    const v = await h.service.plan(PLAN);
    const r = h.service.panic({ reason: 'test\u0000panic' });
    assert.equal(r.engaged, true); assert.equal(r.reason, 'test?panic');
    const s = h.service.status();
    assert.ok(s.panic && s.ledgerLocked, show(s)); assert.equal(s.plans, 0);
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused');
    await assert.rejects(h.service.plan(PLAN), /PANICKED/);
    assert.equal(h.signs(), 0);
    // the kill-switch FILE is what other processes read
    assert.ok(h.killSwitch.engaged());
  } finally { h.done(); }
});

test('service: the linked wallet is re-read at confirm — a link swapped after the plan is signer-mismatch', async () => {
  const h = mk();
  try {
    const v = await h.service.plan(PLAN);
    h.linkStore.set(keypair().address);
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal((c as { reason: string }).reason, 'signer-mismatch');
    assert.equal(h.signs(), 0);
  } finally { h.done(); }
});

// ------------------------------------------------------------------------------------ caps, SOL/USD, refunds

test('caps: without --mainnet the USD caps are configurable only DOWNWARD; --mainnet may raise them to the ceilings', () => {
  assert.equal(capsOnlyDownward(defaultCaps({ perTradeUsd: 50, dailyUsd: 500 })).perTradeUsd, DEFAULT_PER_TRADE_USD);
  assert.equal(capsOnlyDownward(defaultCaps({ perTradeUsd: 50, dailyUsd: 500 })).dailyUsd, DEFAULT_DAILY_USD);
  assert.equal(capsOnlyDownward(defaultCaps({ perTradeUsd: 2, dailyUsd: 8 })).perTradeUsd, 2, 'lower is honoured');
  const a = parseSignerArgs(['--max-usd', '50', '--daily-usd', '500']);
  assert.equal(a.caps.perTradeUsd, 5); assert.equal(a.caps.dailyUsd, 20); assert.equal(a.caps.network, 'devnet'); assert.equal(a.rpcUrl, DEVNET_RPC);
  const m = parseSignerArgs(['--mainnet', '--max-usd', '50', '--daily-usd', '500', '--rpc', MAINNET_RPC]);
  assert.equal(m.caps.perTradeUsd, 50); assert.equal(m.caps.dailyUsd, 500); assert.equal(m.caps.mainnetEnabled, true);
  assert.throws(() => parseSignerArgs(['--mainnet', '--max-usd', '1000000']), /ceiling/);
  assert.throws(() => parseSignerArgs(['--rpc', MAINNET_RPC]), /devnet endpoint/, 'a mainnet RPC without --mainnet is refused');
  assert.throws(() => parseSignerArgs(['--rpc', 'https://mainnet.helius-rpc.com/?api-key=devnet-looking']), /devnet endpoint/);
});

test('SOL/USD freshness: samples older than 60 s (or a single source) refuse a mainnet confirm, even after a good plan', async () => {
  const clock = new FakeClock(T0);
  let stale = false;
  const h = mk({ network: 'mainnet', clock, solUsd: () => solUsdSamples(6, stale ? clock.now() - 61_000 : clock.now()) });
  try {
    const v = await h.service.plan(PLAN);
    assert.equal(v.precheck.ok, true, show(v.precheck));
    stale = true;
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal((c as { reason: string }).reason, 'no-usd-value', show(c));
    assert.equal(h.ledger.spentToday(), 0, 'nothing stays reserved');
    assert.equal(h.rpc.calls.submit, 0);
  } finally { h.done(); }
  const one = mk({ network: 'mainnet', solUsd: () => [{ price: 6, fetchedAt: T0, source: 'dexscreener' }] });
  try {
    const v = await one.service.plan(PLAN);
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'no-usd-value');
  } finally { one.done(); }
});

test('SOL/USD feed: parsers, timestamps from the clock, failed fetches age out instead of refreshing', async () => {
  const clock = new FakeClock(T0);
  let fail = false;
  const feed = new SolUsdFeed({ clock, fetcher: async (url) => { if (fail) throw new Error('down'); return url.includes('dexscreener') ? [{ priceUsd: '150.5', liquidity: { usd: 1e6 } }, { priceUsd: '151', liquidity: { usd: 5e6 } }] : { solana: { usd: 150.7 } }; } });
  await feed.refresh();
  const s = feed.samples();
  assert.deepEqual(s.map((x) => [x.source, x.price, x.fetchedAt]).sort(), [['coingecko', 150.7, T0], ['dexscreener', 151, T0]], show(s));
  fail = true;
  await clock.advance(30_000);
  await feed.refresh();
  assert.equal(feed.age(), 30_000, 'old samples kept (to age out), not refreshed');
  assert.match(feed.lastError ?? '', /down/);
  assert.equal(parseDexScreenerSol('nope'), null); assert.equal(parseCoinGeckoSol({ solana: {} }), null);
});

test('refund-after-broadcast: a transport error after send keeps the charge (send-unknown); a JSON-RPC rejection refunds (send-failed); an on-chain failure never refunds', async () => {
  const unknown = mk({ network: 'mainnet', submit: async () => { throw new Error('socket hang up'); }, signatureStatus: async () => null });
  try {
    const v = await unknown.service.plan(PLAN);
    const c = await unknown.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'send-unknown', show(c));
    assert.ok(unknown.ledger.spentToday() > 0, 'the reservation STAYS charged');
    assert.equal(unknown.rpc.calls.submit, 1, 'no resend');
  } finally { unknown.done(); }
  const rejected = mk({ network: 'mainnet', submit: async () => { throw new RpcRejectedError('sendTransaction', 'Blockhash not found', -32002, null); } });
  try {
    const v = await rejected.service.plan(PLAN);
    const c = await rejected.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'send-failed', show(c));
    assert.equal(rejected.ledger.spentToday(), 0, 'definitely never broadcast → refunded');
  } finally { rejected.done(); }
});

// ------------------------------------------------------------------------------------ Lighthouse

test('Lighthouse: a signed tx = approved message + APPENDED Lighthouse assertions is accepted (tail counted); any other change is tx-mismatch', async () => {
  const bh = randomKey();
  const withTail = (t: BuiltTx, u: Keypair): string => {
    // Phantom-style: same instructions, then assertions appended; the extra keys land after the originals.
    const ixs = rebuildIxs(t, u);
    return buildTx({ feePayer: u.pub, ixs: [...ixs, lighthouseIx(3), lighthouseIx(0, [randomKey(), u.pub])], blockhash: bh }).sign(u);
  };
  const h = mk({ sign: withTail, blockhash: bh });
  try {
    const v = await h.service.plan(PLAN);
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'filled', show(c));
    assert.equal((c as { lighthouseTail: number }).lighthouseTail, 2);
  } finally { h.done(); }
  const cases: [string, (t: BuiltTx, u: Keypair) => string, RegExp][] = [
    ['an appended SPL Transfer', (t, u) => buildTx({ feePayer: u.pub, ixs: [...rebuildIxs(t, u), tokenIx(3, [randomKey(), randomKey(), u.pub], Buffer.alloc(8))], blockhash: bh }).sign(u), /not a Lighthouse/],
    ['Lighthouse inserted BEFORE the route', (t, u) => { const ixs = rebuildIxs(t, u); return buildTx({ feePayer: u.pub, ixs: [...ixs.slice(0, 4), lighthouseIx(3), ...ixs.slice(4)], blockhash: bh }).sign(u); }, /differs from the approved plan/],
    ['a dropped instruction plus a Lighthouse tail', (t, u) => buildTx({ feePayer: u.pub, ixs: [...rebuildIxs(t, u).slice(0, -1), lighthouseIx(3)], blockhash: bh }).sign(u), /differs|dropped/],
    ['an unknown Lighthouse discriminator', (t, u) => buildTx({ feePayer: u.pub, ixs: [...rebuildIxs(t, u), lighthouseIx(99)], blockhash: bh }).sign(u), /unknown discriminator/],
    ['a changed blockhash with a Lighthouse tail', (t, u) => buildTx({ feePayer: u.pub, ixs: [...rebuildIxs(t, u), lighthouseIx(3)], blockhash: randomKey() }).sign(u), /blockhash/],
  ];
  for (const [name, sign, re] of cases) {
    const x = mk({ sign, blockhash: bh });
    try {
      const v = await x.service.plan(PLAN);
      const c = await x.service.confirm({ hash: v.hash });
      assert.equal(c.kind, 'refused', `${name}: ${show(c)}`);
      assert.equal((c as { reason: string }).reason, 'tx-mismatch', name);
      assert.match((c as { message: string }).message, re, name);
      assert.equal(x.rpc.calls.submit, 0, `${name}: nothing submitted`);
    } finally { x.done(); }
  }
});

test('Lighthouse: the policy with the tail allowed still refuses Lighthouse outside the tail, and never for unsigned bytes', () => {
  const u = keypair();
  const ixs = jupiterSwapIxs(u, 500_000_000n);
  const tail = decodeTransaction(Buffer.from(buildTx({ feePayer: u.pub, ixs: [...ixs, lighthouseIx(3)] }).unsigned, 'base64'));
  assert.equal(checkTxPolicyWith(tail, u.address, undefined, { lighthouseTail: true }).ok, true);
  assert.equal(checkTxPolicyWith(tail, u.address).ok, false, 'default (unsigned) policy refuses the Lighthouse program');
  const mid = decodeTransaction(Buffer.from(buildTx({ feePayer: u.pub, ixs: [...ixs.slice(0, 2), lighthouseIx(3), ...ixs.slice(2)] }).unsigned, 'base64'));
  assert.equal(checkTxPolicyWith(mid, u.address, undefined, { lighthouseTail: true }).ok, false);
  const approved = decodeTransaction(Buffer.from(buildTx({ feePayer: u.pub, ixs }).unsigned, 'base64'));
  assert.equal(compareApprovedMessage(approved, approved).ok, true);
  assert.equal(LIGHTHOUSE_PROGRAM, 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
});

/** Re-derive the instruction specs of a built tx (so a fake wallet can rebuild it with the same blockhash). */
function rebuildIxs(t: BuiltTx, u: Keypair): IxSpec[] {
  const d = decodeTransaction(Buffer.from(t.unsigned, 'base64'));
  return d.instructions.map((ix) => ({ program: d.staticKeys[ix.programIdIndex], accounts: ix.accounts.map((i) => d.staticKeys[i]), data: ix.data }));
}
void u64;
function u64(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }

// ------------------------------------------------------------------------------------ probe

test('probe: the devnet wrap-and-unwrap plan decodes with the real decoder, passes the probe policy, confirms; refused on mainnet', async () => {
  const u = keypair();
  const msg = compileProbeMessage(u.address, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi');
  const d = decodeTransaction(Buffer.from(probeWire(msg), 'base64'));
  assert.equal(d.version, 'legacy'); assert.equal(d.staticKeys[0], u.address); assert.equal(d.instructions.length, 5);
  assert.equal(checkTxPolicyWith(d, u.address, undefined, { kind: 'probe' }).ok, true, show(checkTxPolicyWith(d, u.address, undefined, { kind: 'probe' })));
  assert.equal(checkTxPolicyWith(d, u.address).ok, false, 'as a SWAP it is not-a-swap (no route)');
  const h = mk({ solOut: 5_000n });
  try {
    const v = await h.service.probe();
    assert.equal(v.kind, 'probe'); assert.equal(v.network, 'devnet'); assert.equal(v.amountInRaw, PROBE_LAMPORTS.toString());
    assert.equal(v.precheck.ok, true, show(v.precheck));
    assert.ok(v.instructions.some((i) => i.program === 'Memo'), show(v.instructions));
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'filled', show(c));
    assert.equal(h.liveLedger.positions().length, 0, 'a probe books no position');
    assert.equal(h.liveLedger.trades(10)[0]?.kind, 'probe');
  } finally { h.done(); }
  const m = mk({ network: 'mainnet' });
  try { await assert.rejects(m.service.probe(), /devnet/); } finally { m.done(); }
});

// ------------------------------------------------------------------------------------ the real channel

const FAKE_HOST = fileURLToPath(new URL('./signer-fake-host.ts', import.meta.url));

function clientFor(dir: string, extra: string[] = []): SignerClient {
  return new SignerClient({ entry: FAKE_HOST, argv: ['--dir', dir, ...extra], readyTimeoutMs: 20_000 });
}

test('channel: a real child process serves status → plan → confirm over the authenticated pipe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-signer-chan-'));
  const c = clientFor(dir);
  try {
    await c.start();
    const s = await c.status();
    assert.notEqual(s.pid, process.pid, 'the signer is another process');
    assert.equal(c.pid, s.pid);
    assert.equal(s.network, 'devnet'); assert.ok(s.linked);
    const v = await c.plan(PLAN);
    assert.equal(v.policy.ok, true);
    const pre = await c.precheck(v.hash);
    assert.equal(pre.ok, true);
    const out = await c.confirm(v.hash);
    assert.equal(out.kind, 'filled', show(out));
    const again = await c.confirm(v.hash);
    assert.equal(again.kind, 'refused');
    await c.drop('a'.repeat(64));
  } finally { await closeTestSigner(c); rmSync(dir, { recursive: true, force: true }); }
});

test('channel: unknown methods (sign/submit) are refused; a bad-mac frame and a replayed frame are dropped and the session continues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-signer-chan-'));
  const c = clientFor(dir);
  try {
    await c.start();
    const priv = c as unknown as { child: { stdin: NodeJS.WritableStream }; secret: Buffer; outSeq: number };
    // 1. raw frames with a wrong mac / wrong secret are dropped (no response, no crash)
    priv.child.stdin.write(encodeFrame(newSecret(), priv.outSeq, { id: 999, method: 'sign', params: { tx: 'AQAB' } }));
    priv.child.stdin.write('garbage\n');
    priv.child.stdin.write(`${JSON.stringify({ v: 1, seq: priv.outSeq, body: '{"id":998,"method":"confirm","params":{"hash":"' + 'a'.repeat(64) + '"}}', mac: 'ff' })}\n`);
    // 2. the next legitimate request still works (the host did not consume the seq)
    const s = await c.status();
    assert.equal(s.network, 'devnet');
    // 3. an unknown method through a correctly authenticated frame is refused by name
    await assert.rejects(
      (c as unknown as { request: (m: string, p: unknown) => Promise<unknown> }).request('sign' as never, { tx: 'AQAB' }),
      (e: Error) => e instanceof SignerUnavailableError && /unknown method/.test(e.message),
    );
    // 4. replaying the client's last valid frame is dropped (seq already consumed) and the session continues
    const replay = encodeFrame(priv.secret, priv.outSeq - 1, { id: 5000, method: 'status', params: {} });
    priv.child.stdin.write(replay);
    assert.equal((await c.status()).network, 'devnet');
  } finally { await closeTestSigner(c); rmSync(dir, { recursive: true, force: true }); }
});

test('channel: a dead signer fails closed — every call refuses, nothing respawns; a request timeout refuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-signer-chan-'));
  const c = clientFor(dir);
  try {
    await c.start();
    const pid = c.pid!;
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.alive, false);
    await assert.rejects(c.status(), SignerUnavailableError);
    await assert.rejects(c.confirm('a'.repeat(64)), SignerUnavailableError);
    await assert.rejects(c.start(), SignerUnavailableError, 'start() after death rejects (no respawn)');
  } finally { await closeTestSigner(c); rmSync(dir, { recursive: true, force: true }); }
  const dir2 = mkdtempSync(join(tmpdir(), 'dexterm-signer-chan-'));
  const t = clientFor(dir2, ['--stall-status']);
  try {
    await t.start();
    const priv = t as unknown as { request: (m: string, p: unknown, timeoutMs: number) => Promise<unknown> };
    // The authenticated host accepts the request but never replies; keep the real deadline assertion.
    await assert.rejects(priv.request('status', {}, 100), (e: Error) => e instanceof SignerUnavailableError && /timed out/.test(e.message));
  } finally { await closeTestSigner(t); rmSync(dir2, { recursive: true, force: true }); }
});

test('channel: a bad hello ends the host; the child never serves without the secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-signer-chan-'));
  try {
    const child = spawn(process.execPath, [FAKE_HOST, '--dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stdin.write('{"hello":"nope"}\n');
    const code = await exited;
    assert.notEqual(code, 0, 'exit code says fail-closed');
    assert.equal(out, '', 'nothing was served');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('channel: without a linked wallet in the signer\'s store, plan over the channel is refused (the UI cannot supply one)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-signer-chan-'));
  const c = clientFor(dir, ['--no-link']);
  try {
    await c.start();
    await assert.rejects(c.plan({ ...PLAN, userPublicKey: keypair().address } as never), (e: Error) => /no-wallet/.test(e.message));
    writeFileSync(join(dir, 'wallet-link.json'), JSON.stringify({ publicKey: 'not a key' }));
    await assert.rejects(c.plan(PLAN), (e: Error) => /no-wallet/.test(e.message), 'a malformed link file is no link');
  } finally { await closeTestSigner(c); rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------ the sign page's web3.js

test('sign page: the vendored @solana/web3.js 1.98.4 bundle is sha256-pinned, inlined under the CSP nonce (no remote script) and exposed as window.dexSolana', async () => {
  const bundle = solanaWeb3Bundle();
  assert.ok(bundle && bundle.length > 400_000, 'the vendored bundle is present');
  assert.equal(createHash('sha256').update(readFileSync(SOLANA_WEB3_VENDOR)).digest('hex'), '09cdbea951b2ed0e11bcbe3aeb1ee9f035f9fb51ed212aca645475ae82688cc3', 'pinned sha256 (see vendor/solana-web3/NOTICE.md)');
  assert.ok(bundle!.startsWith('var solanaWeb3=function(exports){'), 'the IIFE global the page expects');
  // Serve one sign page through the real bridge and inspect it (no wallet: the opener just fetches the page).
  let html = '';
  let csp = '';
  const bridge = new WalletBridge({ timeoutMs: 1500, open: async (url) => { const r = await fetch(url); csp = r.headers.get('content-security-policy') ?? ''; html = await r.text(); } });
  await assert.rejects(bridge.signTransaction({ unsignedTxBase64: Buffer.from('x').toString('base64'), label: 'probe' }), /timed out/);
  assert.ok(html.includes(bundle!), 'the bundle is inlined');
  assert.match(html, /window\.dexSolana=solanaWeb3/);
  assert.match(html, /VersionedTransaction\.deserialize\(bytes\(TX\)\)/);
  const nonce = /<script nonce="([^"]+)">/.exec(html)![1];
  assert.equal(html.split(`<script nonce="${nonce}">`).length - 1, 2, 'both scripts carry the page nonce');
  assert.match(csp, /script-src 'nonce-/); assert.doesNotMatch(csp, /unpkg|cdn|https:/, 'no remote script source');
});
