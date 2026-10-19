// task-1310 T1 — `trenchscope wallet` command + the link store. Proves link persists ONLY the pubkey,
// unlink clears it, status reflects the caps flags, and the store refuses a non-address value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletLinkStore, KillSwitch, CapLedger, type WalletBridge } from '@dexterm/data';
import { runWallet, parseCapsFlags, ttyKeypress, type WalletIo, type KeyInput } from '../src/wallet-cmd.ts';

const PK = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

function io(): WalletIo & { out: string; err: string } {
  const o = { out: '', err: '', env: {} as NodeJS.ProcessEnv, stdin: undefined as WalletIo['stdin'],
    stdout: { write(s: string) { (o as { out: string }).out += s; } },
    stderr: { write(s: string) { (o as { err: string }).err += s; } } };
  return o;
}
/** Hermetic store + panic switch + ledger under one tmp dir, so no test touches ~/.dexterm. */
function tmpStore(): { store: WalletLinkStore; dir: string; killSwitch: KillSwitch; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-wallet-'));
  return { store: new WalletLinkStore(join(dir, 'wallet-link.json')), dir, killSwitch: new KillSwitch(join(dir, 'trading.panic')), ledgerPath: join(dir, 'caps.sqlite') };
}

test('link store: set/get/clear round trip, pubkey only', () => {
  const { store, dir } = tmpStore();
  try {
    assert.equal(store.get(), null);
    const rec = store.set(PK, { network: 'devnet', now: 123 });
    assert.equal(rec.publicKey, PK);
    assert.equal(store.get()?.publicKey, PK);
    assert.equal(store.get()?.network, 'devnet');
    assert.equal(store.clear(), true);
    assert.equal(store.get(), null);
    assert.equal(store.clear(), false, 'clearing twice is a no-op');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('link store: refuses to store a non-base58 value (never a key/seed by mistake)', () => {
  const { store, dir } = tmpStore();
  try {
    assert.throws(() => store.set('not a pubkey'), /base58/);
    assert.throws(() => store.set('0'.repeat(300)), /base58/);
    assert.equal(existsSync(store.path), false, 'nothing was written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet status: none linked, devnet dry-run by default', async () => {
  const { store, dir, killSwitch, ledgerPath } = tmpStore();
  try {
    const o = io();
    const code = await runWallet(['status'], o, { store, killSwitch, ledgerPath });
    assert.equal(code, 0);
    assert.match(o.out, /linked: \(none\)/);
    assert.match(o.out, /DRY-RUN/);
    assert.match(o.out, /network: devnet/);
    assert.match(o.out, /per-trade \$5 · daily \$20/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet link: stores the bridge pubkey and reports the short form', async () => {
  const { store, dir } = tmpStore();
  try {
    const fakeBridge = { link: async () => ({ publicKey: PK, publicKeyBase64: 'x', provider: 'stub', roundTripMs: 1 }) } as unknown as WalletBridge;
    const o = io();
    const code = await runWallet(['link'], o, { store, bridge: fakeBridge });
    assert.equal(code, 0);
    assert.match(o.out, /linked: HN7c…YWrH/);
    assert.equal(store.get()?.publicKey, PK, 'the pubkey was persisted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet link: a bridge failure is a non-zero exit, nothing stored', async () => {
  const { store, dir } = tmpStore();
  try {
    const fakeBridge = { link: async () => { throw new Error('timed out'); } } as unknown as WalletBridge;
    const o = io();
    const code = await runWallet(['link'], o, { store, bridge: fakeBridge });
    assert.equal(code, 1);
    assert.match(o.err, /link failed: timed out/);
    assert.equal(store.get(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet unlink: clears a link', async () => {
  const { store, dir } = tmpStore();
  try {
    store.set(PK);
    const o = io();
    assert.equal(await runWallet(['unlink'], o, { store }), 0);
    assert.match(o.out, /unlinked/);
    assert.equal(store.get(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet status --mainnet --max-usd 3 --daily-usd 9 reflects LIVE caps', async () => {
  const { store, dir, killSwitch, ledgerPath } = tmpStore();
  try {
    const o = io();
    await runWallet(['status', '--mainnet', '--max-usd', '3', '--daily-usd', '9'], o, { store, killSwitch, ledgerPath });
    assert.match(o.out, /LIVE/);
    assert.match(o.out, /network: MAINNET/);
    assert.match(o.out, /per-trade \$3 · daily \$9/);
    assert.match(o.out, /real funds/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseCapsFlags: defaults devnet; --mainnet enables mainnet caps', () => {
  assert.equal(parseCapsFlags([]).network, 'devnet');
  assert.equal(parseCapsFlags([]).mainnetEnabled, false);
  const m = parseCapsFlags(['--mainnet', '--max-usd', '4']);
  assert.equal(m.network, 'mainnet');
  assert.equal(m.mainnetEnabled, true);
  assert.equal(m.perTradeUsd, 4);
});

test('DEFECT 6: an absurd USD cap is a usage error (exit 2), never silently armed', async () => {
  const { store, dir, killSwitch, ledgerPath } = tmpStore();
  try {
    for (const flag of [['--max-usd', '1000000'], ['--daily-usd', '1e12'], ['--mainnet', '--max-usd', '999999']]) {
      const o = io();
      const code = await runWallet(['status', ...flag], o, { store, killSwitch, ledgerPath });
      assert.equal(code, 2, `${flag.join(' ')} is rejected with exit 2`);
      assert.match(o.err, /exceeds the hard ceiling/);
      assert.equal(o.out, '', 'no caps line is printed for a rejected over-ceiling value');
    }
    // parseCapsFlags also clamps defensively: a value at/below the ceiling is honored, above throws.
    assert.throws(() => parseCapsFlags(['--max-usd', '501']), /exceeds the hard ceiling/);
    assert.throws(() => parseCapsFlags(['--daily-usd', '2001']), /exceeds the hard ceiling/);
    // task-1328: without --mainnet the USD caps can only go DOWN from the defaults (the signer's rule);
    // exactly at the ceiling is allowed only with --mainnet.
    assert.equal(parseCapsFlags(['--max-usd', '500']).perTradeUsd, 5, 'raising needs --mainnet');
    assert.equal(parseCapsFlags(['--mainnet', '--max-usd', '500']).perTradeUsd, 500, 'exactly at the ceiling is allowed with --mainnet');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet: an unknown subcommand is a usage error', async () => {
  const o = io();
  const { store, dir } = tmpStore();
  try { assert.equal(await runWallet(['frobnicate'], o, { store }), 2); } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match(o.err, /unknown subcommand/);
});

// ----------------------------------------------------------------- task-1310 round 2: panic / resume

/** A stand-in for process.stdin: `tty` true mimics a real terminal; `keys` are delivered on resume(). */
function fakeStdin(tty: boolean, keys: string[] = []): KeyInput & { raw: boolean | null } {
  let handler: ((c: Buffer | string) => void) | null = null;
  const s: KeyInput & { raw: boolean | null } = {
    isTTY: tty, raw: null,
    setRawMode(v: boolean) { s.raw = v; return s; },
    once(_e: 'data', cb: (c: Buffer | string) => void) { handler = cb; return s; },
    off() { handler = null; return s; },
    resume() { const k = keys.shift(); if (k !== undefined && handler) setImmediate(() => handler?.(Buffer.from(k))); return s; },
    pause() { return s; },
  };
  return s;
}
function panicSetup(): { dir: string; ks: KillSwitch; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-panic-'));
  return { dir, ks: new KillSwitch(join(dir, 'trading.panic')), ledgerPath: join(dir, 'caps.sqlite') };
}

test('wallet panic: engages the kill switch AND locks the cap ledger; status reports DISABLED; no TTY needed', async () => {
  const { dir, ks, ledgerPath } = panicSetup();
  const { store } = tmpStore();
  try {
    const o = io();
    assert.equal(await runWallet(['panic', '--reason', 'tests'], o, { store, killSwitch: ks, ledgerPath }), 0);
    assert.match(o.out, /PANIC: live trading disabled \(tests\)/);
    assert.ok(ks.engaged(), 'kill-switch file written');
    const l = new CapLedger({ path: ledgerPath });
    assert.ok(l.locked(), 'ledger locked');
    assert.equal(l.tryReserve(1, 20).ok, false, 'a locked ledger reserves nothing');
    l.close();
    const s = io();
    await runWallet(['status'], s, { store, killSwitch: ks, ledgerPath });
    assert.match(s.out, /LIVE TRADING DISABLED/);
    // panic twice is idempotent
    assert.equal(await runWallet(['panic'], io(), { store, killSwitch: ks, ledgerPath }), 0);
    assert.equal(ks.engaged()?.reason, 'tests', 'the first reason is kept');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet resume: refused without a real TTY (piped/scripted input cannot re-arm); still panicked', async () => {
  const { dir, ks, ledgerPath } = panicSetup();
  const { store } = tmpStore();
  try {
    ks.engage('x');
    const seeded = new CapLedger({ path: ledgerPath });
    try { seeded.lock('x'); } finally { seeded.close(); }
    for (const stdin of [undefined, fakeStdin(false, ['y']), { isTTY: undefined, once() { return this; } } as unknown as KeyInput]) {
      const o = io(); o.stdin = stdin;
      assert.equal(await runWallet(['resume'], o, { store, killSwitch: ks, ledgerPath }), 2);
      assert.match(o.err, /needs a real terminal keypress/);
      assert.ok(ks.engaged(), 'still panicked');
    }
    assert.equal(await ttyKeypress(fakeStdin(false, ['y']), 50), null, 'ttyKeypress itself refuses a non-TTY');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet resume: a TTY keypress of Y releases both locks; any other key (or no key) aborts', async () => {
  const { dir, ks, ledgerPath } = panicSetup();
  const { store } = tmpStore();
  try {
    ks.engage('x');
    const seeded = new CapLedger({ path: ledgerPath });
    try { seeded.lock('x'); } finally { seeded.close(); }
    const no = io(); no.stdin = fakeStdin(true, ['n']);
    assert.equal(await runWallet(['resume'], no, { store, killSwitch: ks, ledgerPath }), 1);
    assert.match(no.out, /aborted; still panicked/);
    assert.ok(ks.engaged());
    const none = io(); none.stdin = fakeStdin(true, []);
    assert.equal(await runWallet(['resume'], none, { store, killSwitch: ks, ledgerPath, keypressTimeoutMs: 30 }), 2);
    assert.match(none.err, /no keypress/);
    const yes = io(); const stdin = fakeStdin(true, ['y']); yes.stdin = stdin;
    assert.equal(await runWallet(['resume'], yes, { store, killSwitch: ks, ledgerPath }), 0);
    assert.match(yes.out, /re-enabled/);
    assert.equal(ks.engaged(), null, 'kill switch released');
    assert.equal(stdin.raw, false, 'raw mode was turned on for the keypress and restored');
    const l = new CapLedger({ path: ledgerPath }); assert.equal(l.locked(), null, 'ledger unlocked'); l.close();
    const again = io(); again.stdin = fakeStdin(true, ['y']);
    assert.equal(await runWallet(['resume'], again, { store, killSwitch: ks, ledgerPath }), 0);
    assert.match(again.out, /not panicked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseCapsFlags: --max-sol-out / --max-slippage-bps are capped at their hard ceilings and shown in status', async () => {
  assert.equal(parseCapsFlags(['--max-sol-out', '0.3']).maxSolOut, 0.3);
  assert.throws(() => parseCapsFlags(['--max-sol-out', '6']), /exceeds the hard ceiling/);
  assert.equal(parseCapsFlags(['--max-slippage-bps', '200']).maxSlippageBps, 200);
  assert.throws(() => parseCapsFlags(['--max-slippage-bps', '1001']), /exceeds the hard ceiling/);
  assert.equal(parseCapsFlags([]).maxSolOut, 1); assert.equal(parseCapsFlags([]).maxSlippageBps, 500);
  const { store, dir, killSwitch, ledgerPath } = tmpStore();
  try {
    const o = io();
    await runWallet(['status', '--max-sol-out', '0.3'], o, { store, killSwitch, ledgerPath });
    assert.match(o.out, /max SOL out 0.3 · max slippage 500 bps/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
