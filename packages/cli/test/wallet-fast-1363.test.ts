import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1363 — `trenchscope wallet fast …`: the capped DEVNET fast wallet from a shell. Create needs a PHYSICAL TTY
// keypress (a pipe/agent is refused), never overwrites, writes mode 600; status never prints the seed; airdrop
// goes to the devnet faucet stand-in; remove refuses while funded unless --force and needs a keypress; --mainnet
// is refused outright. Hermetic: a tmp fast-wallet path + a fake RPC, no network, no ~/.dexterm.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FastWalletStore, WalletLinkStore, KillSwitch } from '@dexterm/data';
import { runWallet, type WalletIo, type KeyInput, type WalletCmdOverrides } from '../src/wallet-cmd.ts';

function io(): WalletIo & { out: string; err: string } {
  const o = { out: '', err: '', env: {} as NodeJS.ProcessEnv, stdin: undefined as WalletIo['stdin'],
    stdout: { write(s: string) { (o as { out: string }).out += s; } },
    stderr: { write(s: string) { (o as { err: string }).err += s; } } };
  return o;
}
function fakeStdin(tty: boolean, keys: string[] = []): KeyInput {
  let handler: ((c: Buffer | string) => void) | null = null;
  const s: KeyInput = {
    isTTY: tty,
    setRawMode(_v: boolean) { return s; },
    once(_e: 'data', cb: (c: Buffer | string) => void) { handler = cb; return s; },
    off() { handler = null; return s; },
    resume() { const k = keys.shift(); if (k !== undefined && handler) setImmediate(() => handler?.(Buffer.from(k))); return s; },
    pause() { return s; },
  } as unknown as KeyInput;
  return s;
}
function setup(balance = 0n) {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-wallet-fast-'));
  const calls: string[] = [];
  let bal = balance;
  const over: WalletCmdOverrides = {
    store: new WalletLinkStore(join(dir, 'wallet-link.json')), killSwitch: new KillSwitch(join(dir, 'trading.panic')), ledgerPath: join(dir, 'caps.sqlite'),
    fastWalletPath: join(dir, 'fast-wallet.json'), keypressTimeoutMs: 500,
    fastRpc: {
      async balance(pk) { calls.push(`balance:${pk.slice(0, 4)}`); return bal; },
      async airdrop(pk, lamports) { calls.push(`airdrop:${pk.slice(0, 4)}:${lamports}`); bal += lamports; return 'AIRDROPSIG'; },
      async confirm(sig) { calls.push(`confirm:${sig}`); return { confirmed: true, err: null }; },
    },
  };
  return { dir, over, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('fast create: refused on a pipe/non-TTY, refused with --mainnet, created once with a keypress at mode 600; status shows the pubkey and never the seed', async (t) => {
  const s = setup();
  try {
    const none = io(); assert.equal(await runWallet(['fast'], none, s.over), 0); assert.match(none.out, /fast wallet: \(none\)/);
    const piped = io(); piped.stdin = fakeStdin(false, ['y']);
    assert.equal(await runWallet(['fast', 'create'], piped, s.over), 2); assert.match(piped.err, /not a TTY/);
    assert.equal(existsSync(s.over.fastWalletPath!), false, 'nothing written without a keypress');
    const main = io(); main.stdin = fakeStdin(true, ['y']);
    assert.equal(await runWallet(['fast', 'create', '--mainnet'], main, s.over), 2); assert.match(main.err, /devnet only/);
    const no = io(); no.stdin = fakeStdin(true, ['n']);
    assert.equal(await runWallet(['fast', 'create'], no, s.over), 1); assert.match(no.out, /aborted/);
    const tty = io(); tty.stdin = fakeStdin(true, ['y']);
    assert.equal(await runWallet(['fast', 'create'], tty, s.over), 0);
    assert.match(tty.out, /✓ fast wallet created: [1-9A-HJ-NP-Za-km-z]{32,44} \(devnet\)/);
    await posixPermissions(t, () => { assert.equal(statSync(s.over.fastWalletPath!).mode & 0o777, 0o600); });
    const rec = new FastWalletStore(s.over.fastWalletPath!).get()!;
    const seed = JSON.parse(readFileSync(s.over.fastWalletPath!, 'utf8')).seed as string;
    assert.ok(!tty.out.includes(seed), 'the seed is never printed');
    const again = io(); again.stdin = fakeStdin(true, ['y']);
    assert.equal(await runWallet(['fast', 'create'], again, s.over), 2); assert.match(again.err, /already exists/);
    const st = io(); assert.equal(await runWallet(['fast', 'status'], st, s.over), 0);
    assert.match(st.out, new RegExp(rec.publicKey)); assert.match(st.out, /0\.0000 SOL \(devnet\)/); assert.match(st.out, /per-fill ceiling 0\.05 SOL/);
    assert.ok(!st.out.includes(seed));
  } finally { s.done(); }
});

test('fast airdrop funds the wallet through the devnet faucet stand-in; remove refuses while funded unless --force and needs a keypress', async () => {
  const s = setup();
  try {
    const nothing = io(); assert.equal(await runWallet(['fast', 'airdrop'], nothing, s.over), 2); assert.match(nothing.err, /no fast wallet/);
    const c = io(); c.stdin = fakeStdin(true, ['y']); assert.equal(await runWallet(['fast', 'create'], c, s.over), 0);
    const bad = io(); assert.equal(await runWallet(['fast', 'airdrop', '--sol', '50'], bad, s.over), 2);
    const a = io(); assert.equal(await runWallet(['fast', 'airdrop', '--sol', '0.5'], a, s.over), 0);
    assert.match(a.out, /airdrop requested: 0\.5 SOL/); assert.match(a.out, /✓ confirmed/); assert.match(a.out, /0\.5000 SOL/);
    assert.ok(s.calls.some((x) => x.startsWith('airdrop:') && x.endsWith(':500000000')), s.calls.join(','));
    const funded = io(); funded.stdin = fakeStdin(true, ['y']);
    assert.equal(await runWallet(['fast', 'remove'], funded, s.over), 2); assert.match(funded.err, /still holds/);
    assert.equal(existsSync(s.over.fastWalletPath!), true);
    const piped = io(); piped.stdin = fakeStdin(false, ['y']);
    assert.equal(await runWallet(['fast', 'remove', '--force'], piped, s.over), 2); assert.match(piped.err, /not a TTY/);
    const forced = io(); forced.stdin = fakeStdin(true, ['y']);
    assert.equal(await runWallet(['fast', 'remove', '--force'], forced, s.over), 0); assert.match(forced.out, /✓ fast wallet removed/);
    assert.equal(existsSync(s.over.fastWalletPath!), false);
    const unk = io(); assert.equal(await runWallet(['fast', 'bogus'], unk, s.over), 2); assert.match(unk.err, /unknown action/);
  } finally { s.done(); }
});
