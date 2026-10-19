import { posixPermissions, closeTestSigner, closeTestSignerStores } from '../../../scripts/test-support.ts';
// task-1363 — the capped FAST WALLET and the signer's DEVNET FILL path (the live fire path for order plans).
// No network, no real wallet, no funds: the fast wallet here is a throwaway devnet key in a tmp dir, the RPC
// is the fake, and every transaction is decoded by the real decoder, Ed25519-verified against the real key,
// and run through the real LiveExecutor pipeline (policy → simulate → caps → sign → compare → re-sim → book).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../src/clock.ts';
import { defaultCaps, CapLedger } from '../src/trade/caps.ts';
import { DEVNET_RPC, MAINNET_RPC } from '../src/trade/rpc-exec.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { WalletLinkStore } from '../src/trade/link-store.ts';
import { LiveExecutor, LiveLedger, policyKind, type LiveExecutorDeps } from '../src/trade/executor.ts';
import { decodeTransaction, verifyEd25519, checkTxPolicyWith } from '../src/trade/tx-decode.ts';
import { base58Decode } from '../src/sources/pda.ts';
import { SignerService, SignerError, parseFillParams } from '../src/trade/signer/service.ts';
import { SignerClient } from '../src/trade/signer/client.ts';
import { SIGNER_METHODS } from '../src/trade/signer/protocol.ts';
import { parseSignerArgs, buildSignerService } from '../src/trade/signer/main.ts';
import { compileProbeMessage, probeWire, DevnetProbeBuilder } from '../src/trade/signer/probe-builder.ts';
import { FastWalletStore, FastWalletSigner, FAST_MAX_SOL_PER_FILL_LAMPORTS, FAST_WALLET_PROVIDER } from '../src/trade/signer/fast-wallet.ts';
import { keypair, buildTx, jupiterSwapIxs, fakeRpc, solUsdSamples, type BuiltTx } from './trade-helpers.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const show = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const T0 = Date.UTC(2026, 9, 12, 12);
const FILL = { ref: 'plan_1:entry', mint: MINT, symbol: 'TRENCH', decimals: 6, side: 'buy' as const, lamports: '20000000' }; // 0.02 SOL
const rawQuote = () => ({
  inputMint: 'So11111111111111111111111111111111111111112', outputMint: MINT, inAmount: '500000000', outAmount: '2000000', otherAmountThreshold: '1990000',
  swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.005', platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '3',
});

interface Opts { network?: 'devnet' | 'mainnet'; fast?: boolean; solUsd?: number | null; solOut?: bigint; linkFastAsMain?: boolean }

/** A signer service on fakes with (by default) a freshly created devnet fast wallet in a tmp dir. */
function mk(o: Opts = {}) {
  const clock = new FakeClock(T0);
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-fast-'));
  const user = keypair();
  const net = o.network ?? 'devnet';
  const fastStore = new FastWalletStore(join(dir, 'fast-wallet.json'));
  if (o.fast !== false) fastStore.create({ network: 'devnet', now: T0 });
  const fastSigner = o.fast !== false ? fastStore.load()! : undefined;
  const linkStore = new WalletLinkStore(join(dir, 'wallet-link.json'));
  linkStore.set(o.linkFastAsMain && fastSigner ? fastSigner.publicKey : user.address, { now: T0 });
  const txs = new Map<string, BuiltTx>();
  const fresh = (): BuiltTx => { const t = buildTx({ feePayer: user.pub, ixs: jupiterSwapIxs(user, 500_000_000n) }); txs.set(t.unsigned, t); return t; };
  const rpc0 = fakeRpc({ url: net === 'mainnet' ? MAINNET_RPC : DEVNET_RPC, solOut: o.solOut ?? 5_000n });
  const rpc = { ...rpc0, latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }) };
  const ledger = new CapLedger({ clock });
  const liveLedger = new LiveLedger({ clock });
  let phantomSigns = 0;
  let fastSigns = 0;
  const wrappedFast = fastSigner ? { publicKey: fastSigner.publicKey, signTransaction: (a: Parameters<FastWalletSigner['signTransaction']>[0]) => { fastSigns++; return fastSigner.signTransaction(a); } } : undefined;
  const deps: LiveExecutorDeps = {
    build: { quoteRaw: async () => rawQuote(), buildSwap: async () => ({ swapTransactionBase64: fresh().unsigned, lastValidBlockHeight: 1, prioritizationFeeLamports: 0, quote: rawQuote() }) } as unknown as LiveExecutorDeps['build'],
    rpc: rpc as unknown as LiveExecutorDeps['rpc'],
    bridge: { signTransaction: async (a: { unsignedTxBase64: string }) => { phantomSigns++; const t = txs.get(a.unsignedTxBase64); if (!t) throw new Error('phantom: unknown tx'); return { signedTxBase64: t.sign(user), provider: 'fake-phantom', roundTripMs: 1 }; } } as unknown as LiveExecutorDeps['bridge'],
    caps: defaultCaps({ network: net, mainnetEnabled: net === 'mainnet' }),
    ledger, liveLedger, clock,
    solUsd: () => (o.solUsd === null ? [] : solUsdSamples(o.solUsd ?? 6, clock.now())),
    killSwitch: new KillSwitch(join(dir, 'trading.panic')),
    probe: new DevnetProbeBuilder(rpc as never),
    fastSigner: wrappedFast,
  };
  const executor = new LiveExecutor(deps);
  const service = new SignerService({ executor, deps, linkStore, liveLedger, clock, fastStore });
  return {
    service, executor, deps, user, dir, rpc: rpc0, ledger, liveLedger, clock, fastStore, fastSigner, linkStore,
    phantomSigns: () => phantomSigns, fastSigns: () => fastSigns,
    done: () => { ledger.close(); liveLedger.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ------------------------------------------------------------------------------------ the store + signer

test('fast wallet: devnet only, mode 600, never overwritten, the seed never leaves the store, the signer signs for itself only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-fastwallet-'));
  try {
    const store = new FastWalletStore(join(dir, 'fast-wallet.json'));
    assert.throws(() => store.create({ network: 'mainnet' }), /devnet only/);
    assert.equal(store.exists(), false);
    const info = store.create({ network: 'devnet', now: T0 });
    assert.match(info.publicKey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.equal(info.network, 'devnet');
    await posixPermissions(t, () => { assert.equal(statSync(store.path).mode & 0o777, 0o600, 'the record is mode 600'); });
    assert.throws(() => store.create({ network: 'devnet' }), /already exists/);
    const pub = store.get()!;
    assert.deepEqual(Object.keys(pub).sort(), ['createdAt', 'network', 'publicKey'], 'get() exposes public fields only');
    assert.ok(JSON.parse(readFileSync(store.path, 'utf8')).seed, 'the seed is on disk (mode 600)…');
    assert.equal((pub as unknown as Record<string, unknown>).seed, undefined, '…and never in the public view');
    const signer = store.load()!;
    assert.equal(signer.publicKey, info.publicKey);
    assert.equal(signer.provider, FAST_WALLET_PROVIDER);
    assert.equal((signer as unknown as Record<string, unknown>).seed, undefined);

    // signs its own probe-shaped tx; the signature verifies against the stored public key with the real decoder
    const unsigned = probeWire(compileProbeMessage(signer.publicKey, BLOCKHASH, 20_000_000n, 'trenchscope devnet fill plan_1:entry'));
    const signed = await signer.signTransaction({ unsignedTxBase64: unsigned, expectPublicKey: signer.publicKey, label: 'fill' });
    const d = decodeTransaction(Buffer.from(signed.signedTxBase64, 'base64'));
    assert.equal(d.staticKeys[0], signer.publicKey);
    assert.equal(verifyEd25519(Buffer.from(base58Decode(signer.publicKey)), d.message, d.signatures[0]), true, 'Ed25519 verifies');
    assert.equal(checkTxPolicyWith(d, signer.publicKey, undefined, { kind: 'probe' }).ok, true);
    assert.equal(policyKind('devnet-fill'), 'probe');

    // refuses: another expected key, a tx whose fee payer is someone else, a multi-signer tx
    const other = keypair();
    await assert.rejects(signer.signTransaction({ unsignedTxBase64: unsigned, expectPublicKey: other.address }), /different public key/);
    await assert.rejects(signer.signTransaction({ unsignedTxBase64: probeWire(compileProbeMessage(other.address, BLOCKHASH)) }), /fee payer is not the fast wallet/);
    const two = buildTx({ feePayer: Buffer.from(base58Decode(signer.publicKey)), ixs: jupiterSwapIxs(other, 1_000n), numRequiredSignatures: 2 });
    await assert.rejects(signer.signTransaction({ unsignedTxBase64: two.unsigned }), /2 required signatures/);
    await assert.rejects(signer.signTransaction({ unsignedTxBase64: Buffer.from('junk').toString('base64') }), /malformed/);

    assert.equal(store.remove(), true);
    assert.equal(store.load(), null);
    assert.equal(store.remove(), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fast wallet: a tampered record (foreign network, mismatched seed) does not load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-fastwallet-'));
  try {
    const store = new FastWalletStore(join(dir, 'fast-wallet.json'));
    store.create({ network: 'devnet' });
    const raw = JSON.parse(readFileSync(store.path, 'utf8'));
    const bad = new FastWalletStore(join(dir, 'bad.json'));
    writeFileSync(bad.path, JSON.stringify({ ...raw, network: 'mainnet' }));
    assert.equal(bad.load(), null, 'a mainnet-labelled record never loads');
    writeFileSync(bad.path, JSON.stringify({ ...raw, publicKey: keypair().address }));
    assert.equal(bad.load(), null, 'a seed that does not match the public key never loads');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------ the fill path

test('fill: the signer builds a devnet fill for the fast wallet, the fast wallet signs it, Phantom is never asked, USD is charged on devnet, the ledger books kind devnet-fill', async () => {
  const h = mk();
  try {
    const st = h.service.status();
    assert.equal(st.fastWallet?.publicKey, h.fastSigner!.publicKey);
    const f = await h.service.fast();
    assert.equal(f.loaded, true); assert.equal(f.publicKey, h.fastSigner!.publicKey); assert.equal(f.network, 'devnet');
    assert.equal(f.balanceLamports, '10000000000', 'the fake RPC balance');
    const v = await h.service.fill(FILL);
    assert.equal(v.kind, 'devnet-fill'); assert.equal(v.lane, 'fast'); assert.equal(v.ref, 'plan_1:entry'); assert.equal(v.network, 'devnet');
    assert.equal(v.userPublicKey, h.fastSigner!.publicKey, 'built for the fast wallet, not the linked one');
    assert.equal(v.mint, MINT); assert.equal(v.amountInRaw, '20000000'); assert.deepEqual(v.route, ['devnet-fill']);
    assert.equal(v.policy.ok, true, show(v.policy)); assert.equal(v.sim.ok, true, show(v.sim)); assert.equal(v.precheck.ok, true, show(v.precheck));
    assert.ok(v.notionalUsd !== null && v.notionalUsd > 0, 'priced in USD from the signer feed (0.02 SOL × $6)');
    assert.ok(v.instructions.some((i) => i.program === 'Memo'), show(v.instructions));
    assert.equal(h.ledger.spentToday(), 0);
    const c = await h.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'filled', show(c));
    if (c.kind !== 'filled') return;
    assert.equal(c.network, 'devnet'); assert.equal(c.fill.tokenDelta, '0', 'a devnet fill moves no tokens');
    assert.equal(h.fastSigns(), 1, 'the fast wallet signed');
    assert.equal(h.phantomSigns(), 0, 'Phantom was never asked');
    assert.ok(h.ledger.spentToday() > 0, 'the USD daily ledger is charged on devnet for the fast lane');
    assert.equal(h.liveLedger.trades(5)[0]?.kind, 'devnet-fill');
    assert.equal(h.liveLedger.positions().length, 0, 'no live position from a devnet fill');
    assert.equal(h.rpc.calls.submit, 1);
    // the signed bytes that went to the node verify against the FAST wallet
    const sent = decodeTransaction(Buffer.from(h.rpc.calls.submitted[0], 'base64'));
    assert.equal(sent.staticKeys[0], h.fastSigner!.publicKey);
    assert.equal(verifyEd25519(Buffer.from(base58Decode(h.fastSigner!.publicKey)), sent.message, sent.signatures[0]), true);
    assert.ok(sent.instructions.some((ix) => ix.data.toString('utf8') === 'trenchscope devnet fill plan_1:entry'), 'the memo names the plan leg');
    // single use
    const again = await h.service.confirm({ hash: v.hash });
    assert.equal(again.kind, 'refused');
  } finally { h.done(); }
});

test('fill: refusals — over the SOL-per-fill ceiling, no SOL/USD price, per-trade USD cap, daily USD cap; each is visible at precheck and refused at confirm', async () => {
  // ceiling: 0.051 SOL > 0.05 → built with a sol-out-cap policy refusal and no bytes; never confirmable
  const a = mk();
  try {
    const v = await a.service.fill({ ...FILL, lamports: (FAST_MAX_SOL_PER_FILL_LAMPORTS + 1_000_000n).toString() });
    assert.equal(v.policy.ok, false); assert.equal(v.policy.reason, 'sol-out-cap', show(v.policy));
    assert.equal(v.precheck.ok, false);
    assert.equal(v.instructions.length, 0, 'no transaction bytes exist for an over-ceiling fill');
    const c = await a.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); assert.equal(a.fastSigns(), 0); assert.equal(a.rpc.calls.submit, 0);
  } finally { a.done(); }
  // no trustworthy SOL/USD → the fast lane refuses (USD caps are enforced on devnet for this lane)
  const b = mk({ solUsd: null });
  try {
    const v = await b.service.fill(FILL);
    assert.equal(v.notionalUsd, null);
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'no-usd-value', show(v.precheck));
    const c = await b.service.confirm({ hash: v.hash });
    assert.equal(c.kind, 'refused'); if (c.kind === 'refused') assert.equal(c.reason, 'no-usd-value');
    assert.equal(b.fastSigns(), 0);
  } finally { b.done(); }
  // per-trade: $150/SOL × 0.04 SOL = $6 > $5
  const c = mk({ solUsd: 150 });
  try {
    const v = await c.service.fill({ ...FILL, lamports: '40000000' });
    assert.equal(v.precheck.ok, false); assert.equal(v.precheck.reason, 'per-trade-cap', show(v.precheck));
    const out = await c.service.confirm({ hash: v.hash });
    assert.equal(out.kind, 'refused'); if (out.kind === 'refused') assert.equal(out.reason, 'per-trade-cap');
    assert.equal(c.fastSigns(), 0);
    // daily: $4.50 fills (0.03 SOL) — the fifth would take the day past $20
    let filled = 0;
    for (let i = 0; i < 5; i++) {
      const w = await c.service.fill({ ...FILL, ref: `plan_1:entry#${i}`, lamports: '30000000' });
      const o = await c.service.confirm({ hash: w.hash });
      if (o.kind === 'filled') filled++;
      else { assert.equal(o.kind, 'refused'); if (o.kind === 'refused') assert.equal(o.reason, 'daily-cap', show(o)); break; }
    }
    assert.equal(filled, 4, 'four $4.50 fills fit in a $20 day; the fifth is refused');
    assert.ok(c.ledger.spentToday() >= 18 && c.ledger.spentToday() <= 20, `spent ${c.ledger.spentToday()}`);
  } finally { c.done(); }
});

test('fill: refused on a mainnet signer (no fast wallet is ever loaded there), without a fast wallet, and on bad params', async () => {
  const m = mk({ network: 'mainnet', fast: false });
  try {
    await assert.rejects(m.service.fill(FILL), (e: unknown) => e instanceof SignerError && e.reason === 'network-mismatch');
    const f = await m.service.fast();
    assert.equal(f.loaded, false); assert.match(f.reason ?? '', /devnet/);
  } finally { m.done(); }
  const n = mk({ fast: false });
  try {
    await assert.rejects(n.service.fill(FILL), (e: unknown) => e instanceof SignerError && e.reason === 'no-fast-wallet');
    assert.equal(n.service.status().fastWallet, null);
    const f = await n.service.fast();
    assert.equal(f.loaded, false); assert.match(f.reason ?? '', /trenchscope wallet fast create/);
  } finally { n.done(); }
  assert.throws(() => parseFillParams(null), SignerError);
  assert.throws(() => parseFillParams({ ...FILL, ref: 'has space' }), /ref/);
  assert.throws(() => parseFillParams({ ...FILL, ref: 'x'.repeat(65) }), /ref/);
  assert.throws(() => parseFillParams({ ...FILL, lamports: '0' }), /lamports/);
  assert.throws(() => parseFillParams({ ...FILL, lamports: 20000000 }), /lamports/);
  assert.throws(() => parseFillParams({ ...FILL, mint: 'nope' }), /mint/);
  assert.throws(() => parseFillParams({ ...FILL, side: 'both' }), /side/);
  assert.equal(parseFillParams({ ...FILL, symbol: 'A\u0000B‮' }).symbol, 'A?B?', 'symbol sanitized');
});

test('lanes never cross: a Phantom plan never touches the fast wallet; a fast-lane plan confirmed for the main wallet is signer-mismatch; a main-lane plan built for the fast wallet is refused', async () => {
  const h = mk();
  try {
    // main lane: the linked wallet's swap goes to Phantom, the fast signer stays idle
    const p = await h.service.plan({ mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, amountRaw: '500000000', slippageBps: 50 });
    assert.equal(p.lane, 'main'); assert.equal(p.ref, null); assert.equal(p.userPublicKey, h.user.address);
    const c = await h.service.confirm({ hash: p.hash });
    assert.equal(c.kind, 'filled', show(c));
    assert.equal(h.phantomSigns(), 1); assert.equal(h.fastSigns(), 0);
    // fast lane confirmed with the MAIN wallet's key (a forged confirm path) → signer-mismatch before anything signs
    const v = await h.service.fill(FILL);
    const built = await h.executor.buildFill({ lamports: 20_000_000n, mint: MINT, symbol: 'TRENCH', decimals: 6, side: 'buy', ref: 'plan_2:entry' });
    const out = await h.executor.confirmAndSubmit(built, built.hash, h.user.address);
    assert.equal(out.kind, 'refused'); if (out.kind === 'refused') assert.equal(out.reason, 'signer-mismatch');
    assert.equal(h.fastSigns(), 0);
    void v;
  } finally { h.done(); }
  // the link store naming the FAST wallet as the "main" wallet: a main-lane plan for it is refused at confirm
  const x = mk({ linkFastAsMain: true });
  try {
    const p = await x.service.plan({ mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, amountRaw: '500000000', slippageBps: 50 });
    assert.equal(p.userPublicKey, x.fastSigner!.publicKey);
    // (the fake swap builder signs for the throwaway user, so the plan's static policy already dislikes it; what
    // matters is that the LANE check refuses first, before caps, reservation or any signer is asked)
    const c = await x.service.confirm({ hash: p.hash });
    assert.equal(c.kind, 'refused'); if (c.kind === 'refused') { assert.equal(c.reason, 'signer-mismatch'); assert.match(c.message, /never signs a main-lane plan/); }
    assert.equal(x.fastSigns(), 0); assert.equal(x.phantomSigns(), 0);
  } finally { x.done(); }
});

test('channel surface: fast + fill exist; there is no create/export/import/sign/setCaps method, over the pipe or in the dispatcher', async () => {
  for (const m of ['fast', 'fill', 'status', 'plan', 'probe', 'precheck', 'confirm', 'drop', 'panic']) assert.ok(SIGNER_METHODS.has(m), m);
  for (const m of ['fast-create', 'fast-export', 'fast-import', 'fast-remove', 'fast-drain', 'sign', 'submit', 'setCaps', 'raiseCap']) assert.ok(!SIGNER_METHODS.has(m), `no ${m}`);
  const h = mk();
  try {
    for (const m of ['fast-create', 'setCaps', 'sign']) await assert.rejects(h.service.call(m, {}), /unknown method/);
    const svc = h.service as unknown as Record<string, unknown>;
    for (const name of ['createFast', 'exportFast', 'setCaps', 'sign', 'raiseCap']) assert.equal(typeof svc[name], 'undefined', `service must not expose ${name}`);
  } finally { h.done(); }
});

test('channel: a real child signer with --fast serves fast → fill → confirm over the authenticated pipe; the status names the fast wallet', async () => {
  const FAKE_HOST = fileURLToPath(new URL('./signer-fake-host.ts', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-fast-chan-'));
  const c = new SignerClient({ entry: FAKE_HOST, argv: ['--dir', dir, '--fast'], readyTimeoutMs: 20_000 });
  try {
    await c.start();
    const s = await c.status();
    assert.ok(s.fastWallet?.publicKey, 'status carries the fast wallet public key');
    const f = await c.fast();
    assert.equal(f.loaded, true); assert.equal(f.publicKey, s.fastWallet!.publicKey);
    const v = await c.fill(FILL);
    assert.equal(v.lane, 'fast'); assert.equal(v.kind, 'devnet-fill'); assert.equal(v.precheck.ok, true, show(v.precheck));
    const out = await c.confirm(v.hash);
    assert.equal(out.kind, 'filled', show(out));
    const again = await c.confirm(v.hash);
    assert.equal(again.kind, 'refused');
  } finally { await closeTestSigner(c); rmSync(dir, { recursive: true, force: true }); }
});

test('signer process args: --fast-wallet PATH is honoured; the production builder loads the fast wallet on devnet and never on mainnet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-fast-args-'));
  const services: ReturnType<typeof buildSignerService>[] = [];
  try {
    const path = join(dir, 'fw.json');
    new FastWalletStore(path).create({ network: 'devnet' });
    const dev = parseSignerArgs(['--fast-wallet', path, '--ledger', join(dir, 'c.sqlite'), '--live-ledger', join(dir, 'l.sqlite'), '--link', join(dir, 'link.json'), '--panic-file', join(dir, 'p')]);
    assert.equal(dev.fastWalletPath, path);
    const devSvc = buildSignerService(dev, () => {});
    services.push(devSvc);
    assert.equal(devSvc.status().fastWallet?.publicKey, new FastWalletStore(path).get()!.publicKey, 'devnet signer loads the fast wallet');
    const main = parseSignerArgs(['--mainnet', '--rpc', MAINNET_RPC, '--fast-wallet', path, '--ledger', join(dir, 'c2.sqlite'), '--live-ledger', join(dir, 'l2.sqlite'), '--link', join(dir, 'link.json'), '--panic-file', join(dir, 'p')]);
    const mainSvc = buildSignerService(main, () => {});
    services.push(mainSvc);
    assert.equal(mainSvc.status().fastWallet, null, 'a mainnet signer never loads the fast wallet');
    assert.equal(parseSignerArgs([]).fastWalletPath.endsWith('fast-wallet.json'), true);
  } finally { for (const service of services) closeTestSignerStores(service); rmSync(dir, { recursive: true, force: true }); }
});
