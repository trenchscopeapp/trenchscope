// trenchscope T1 — `trenchscope wallet <link|unlink|status|panic|resume>` (SPEC §6.5). A non-TUI one-shot that
// links a Phantom wallet through the loopback bridge (keys never enter dexterm; only the public key is
// kept), unlinks it, prints the current link + the active trade caps, or PANICS live trading (round 2:
// the cheapest safe signer panic path — a kill-switch file every trenchscope process re-reads, plus a lock
// on the shared daily-cap ledger). `resume` needs a real TTY keypress; piped input cannot re-arm.
import {
  WalletBridge, WalletLinkStore, shortPubkey, defaultCaps, capsOnlyDownward, KillSwitch, CapLedger, defaultCapLedgerPath, defaultLiveLedgerPath, LiveLedger,
  HARD_MAX_PER_TRADE_USD, HARD_MAX_DAILY_USD, HARD_MAX_SOL_OUT, HARD_MAX_SLIPPAGE_BPS,
  parseSignerArgs, buildSignerService, lamportsToSol,
  FastWalletStore, defaultFastWalletPath, FAST_MAX_SOL_PER_FILL, createDataLayer, TradeRpc, DEVNET_RPC,
  type BridgeOpener, type TradeCaps, type LinkedWallet, type SignerService,
} from '@dexterm/data';

/** The slice of a TTY stdin the resume gate needs. A piped stdin has `isTTY` undefined/false. */
export interface KeyInput {
  isTTY?: boolean;
  setRawMode?: (raw: boolean) => unknown;
  once(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
  off?(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface WalletIo {
  stdout: { write(s: string): void; isTTY?: boolean };
  stderr: { write(s: string): void };
  env: NodeJS.ProcessEnv;
  stdin?: KeyInput;
}

export interface WalletCmdOverrides {
  /** Inject a bridge (tests); default is a real loopback bridge opening the system browser. */
  bridge?: WalletBridge;
  /** Inject a store (tests); default persists to ~/.dexterm/wallet-link.json. */
  store?: WalletLinkStore;
  /** Override the opener for the default bridge (tests / popup-host lane). */
  open?: BridgeOpener;
  /** Inject the panic switch (tests); default ~/.dexterm/trading.panic. */
  killSwitch?: KillSwitch;
  /** Path of the shared daily-cap ledger (tests); default ~/.dexterm/trade-caps.sqlite. */
  ledgerPath?: string;
  /** Keypress timeout for `resume` (ms). */
  keypressTimeoutMs?: number;
  /** Inject the signer service for `probe` (tests); default builds the real one (devnet RPC, system browser). */
  signerService?: SignerService;
  /** Path of the live fill ledger (status shows the count). */
  liveLedgerPath?: string;
  /** task-1363: where the fast wallet record lives (tests); default ~/.dexterm/fast-wallet.json. */
  fastWalletPath?: string;
  /** task-1363: devnet RPC stand-in for `fast status|airdrop|remove` (tests); default the public devnet endpoint. */
  fastRpc?: { balance(pubkey: string): Promise<bigint>; airdrop(pubkey: string, lamports: bigint): Promise<string>; confirm?(sig: string): Promise<{ confirmed: boolean; err: unknown }> };
}

/**
 * Parse the trade-caps flags shared by the wallet command and (later) live trading. DEFECT 6: a USD
 * flag above the hard ceiling (e.g. `--max-usd 1000000`, `--daily-usd 1e12`) is REJECTED rather than
 * silently accepted, so a fat-fingered cap can never arm a huge money path. Throws on an over-ceiling
 * value; the caller surfaces it as a usage error. (defaultCaps also clamps as a second line of defence.)
 */
export function parseCapsFlags(argv: string[]): TradeCaps {
  let mainnet = false;
  let perTradeUsd: number | undefined;
  let dailyUsd: number | undefined;
  let maxSolOut: number | undefined;
  let maxSlippageBps: number | undefined;
  const fmt = (n: number, unit: string) => (unit === '$' ? `$${n}` : `${n} ${unit}`);
  const take = (flag: string, raw: string | undefined, ceiling: number, unit = '$'): number | undefined => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined; // ignore junk; defaults apply
    if (n > ceiling) throw new Error(`${flag} ${fmt(n, unit)} exceeds the hard ceiling of ${fmt(ceiling, unit)}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--mainnet') mainnet = true;
    else if (k === '--max-usd') perTradeUsd = take('--max-usd', argv[++i], HARD_MAX_PER_TRADE_USD);
    else if (k === '--daily-usd') dailyUsd = take('--daily-usd', argv[++i], HARD_MAX_DAILY_USD);
    else if (k === '--max-sol-out') maxSolOut = take('--max-sol-out', argv[++i], HARD_MAX_SOL_OUT, 'SOL');
    else if (k === '--max-slippage-bps') maxSlippageBps = take('--max-slippage-bps', argv[++i], HARD_MAX_SLIPPAGE_BPS, 'bps');
  }
  // task-1328: without --mainnet the USD caps can only go DOWN from the defaults (what the signer applies).
  return capsOnlyDownward(defaultCaps({ network: mainnet ? 'mainnet' : 'devnet', mainnetEnabled: mainnet, perTradeUsd, dailyUsd, maxSolOut, maxSlippageBps }));
}

function capsLine(caps: TradeCaps): string {
  const net = caps.network === 'mainnet' ? 'MAINNET' : 'devnet';
  return `mode: ${caps.network === 'mainnet' ? 'LIVE' : 'DRY-RUN'} · network: ${net} · per-trade $${caps.perTradeUsd} · daily $${caps.dailyUsd} · max impact ${caps.maxPriceImpactPct}% · max SOL out ${caps.maxSolOut} · max slippage ${caps.maxSlippageBps} bps`;
}

function panicLine(ks: KillSwitch, ledger: CapLedger | null): string | null {
  const p = ks.engaged();
  const l = ledger?.locked() ?? null;
  if (!p && !l) return null;
  const parts: string[] = [];
  if (p) parts.push(`panic switch engaged${p.engagedAt ? ` at ${new Date(p.engagedAt).toISOString()}` : ''} (${p.reason})`);
  if (l) parts.push(`cap ledger locked (${l.reason})`);
  return `⛔ LIVE TRADING DISABLED — ${parts.join('; ')}. Run \`trenchscope wallet resume\` in a terminal to re-enable.`;
}

function printStatus(io: WalletIo, store: WalletLinkStore, caps: TradeCaps, ks: KillSwitch, ledger: CapLedger | null): void {
  const w: LinkedWallet | null = store.get();
  if (w) io.stdout.write(`linked: ${shortPubkey(w.publicKey)}  (${w.publicKey})\n`);
  else io.stdout.write('linked: (none) — run `trenchscope wallet link`\n');
  io.stdout.write(`${capsLine(caps)}\n`);
  const p = panicLine(ks, ledger);
  if (p) io.stdout.write(`${p}\n`);
  if (caps.network === 'mainnet') io.stdout.write('⚠ --mainnet is on: real funds, within the caps above. Devnet is the default; drop --mainnet to stay safe.\n');
}

function liveLine(path: string): string | null {
  try {
    const l = new LiveLedger({ path, readOnly: true });
    try {
      const fills = l.records(1000);
      const open = l.positions().filter((p) => p.tokensRaw > 0n);
      return `live ledger: ${fills.length} confirmed fill${fills.length === 1 ? '' : 's'} · ${open.length} open position${open.length === 1 ? '' : 's'}${open.length ? ` (${open.map((p) => `$${p.symbol}`).join(', ')})` : ''}`;
    } finally { l.close(); }
  } catch { return null; }
}

/**
 * Wait for ONE real keypress on a TTY. Resolves with the key, or null when stdin is not a TTY (piped
 * input, a subprocess, an agent) or no key arrives in time. Raw mode means a single keystroke — not a
 * buffered line — and `isTTY` is the kernel's word, not the caller's: `echo y | trenchscope wallet resume`
 * is refused because a pipe is never a TTY.
 */
export async function ttyKeypress(stdin: KeyInput | undefined, timeoutMs: number): Promise<string | null> {
  if (!stdin || stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') return null;
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { stdin.off?.('data', onData); } catch { /* ignore */ }
      try { stdin.setRawMode?.(false); } catch { /* ignore */ }
      try { stdin.pause?.(); } catch { /* ignore */ }
      resolve(v);
    };
    const onData = (chunk: Buffer | string) => finish(chunk.toString('utf8').slice(0, 1));
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { stdin.setRawMode?.(true); } catch { finish(null); return; }
    stdin.once('data', onData);
    stdin.resume?.();
  });
}

/** Run the wallet subcommand. Returns a process exit code. */
export async function runWallet(argv: string[], io: WalletIo, over: WalletCmdOverrides = {}): Promise<number> {
  const sub = argv[0] ?? 'status';
  let caps: TradeCaps;
  try {
    caps = parseCapsFlags(argv.slice(1));
  } catch (e) {
    io.stderr.write(`trenchscope wallet: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const store = over.store ?? new WalletLinkStore();
  const ks = over.killSwitch ?? new KillSwitch();
  const ledgerPath = over.ledgerPath ?? defaultCapLedgerPath();
  const openLedger = (): CapLedger | null => { try { return new CapLedger({ path: ledgerPath }); } catch { return null; } };

  if (sub === 'status') {
    const ledger = openLedger();
    try { printStatus(io, store, caps, ks, ledger); } finally { ledger?.close(); }
    const ll = liveLine(over.liveLedgerPath ?? defaultLiveLedgerPath());
    if (ll) io.stdout.write(`${ll}\n`);
    return 0;
  }

  // PROBE (task-1328): the devnet plumbing test from a shell — the signer service runs in THIS process
  // (same code the TUI's signer child runs), builds the wrap-and-unwrap plan for the linked wallet,
  // prints it, waits for a real TTY keypress, then opens Phantom, verifies, re-simulates, submits and
  // confirms. Devnet only: the service refuses a non-devnet RPC and --mainnet is not accepted here.
  if (sub === 'probe') {
    if (argv.includes('--mainnet')) { io.stderr.write('trenchscope wallet probe: devnet only (drop --mainnet)\n'); return 2; }
    if (!store.get()) { io.stderr.write('trenchscope wallet probe: no wallet linked; run `trenchscope wallet link` first\n'); return 2; }
    let service: SignerService;
    try {
      service = over.signerService ?? buildSignerService(parseSignerArgs(argv.slice(1).filter((a) => a !== '--no-browser'), io.env), (l) => io.stderr.write(`${l}\n`));
    } catch (e) { io.stderr.write(`trenchscope wallet probe: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }
    const st = service.status();
    if (st.network !== 'devnet') { io.stderr.write(`trenchscope wallet probe: the signer RPC is ${st.network}; the probe runs only on devnet\n`); return 2; }
    if (st.panic || st.ledgerLocked) { io.stderr.write(`${panicLine(ks, openLedger()) ?? 'panicked'}\n`); return 2; }
    let plan;
    try { plan = await service.probe(); } catch (e) { io.stderr.write(`trenchscope wallet probe: plan failed: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
    io.stdout.write(`DEVNET PROBE for ${shortPubkey(plan.userPublicKey)} via ${st.rpcHost}\n`);
    io.stdout.write(`  wraps ${lamportsToSol(BigInt(plan.amountInRaw)).toFixed(4)} SOL into your own WSOL account and closes it back · fee ≈ ${lamportsToSol(BigInt(plan.feeLamports)).toFixed(6)} SOL\n`);
    io.stdout.write(`  will sign: ${plan.instructions.map((i) => `${i.program}${i.op ? ':' + i.op : ''}`).join(' · ')}\n`);
    io.stdout.write(`  simulation: ${plan.sim.ran ? (plan.sim.ok ? `ok (${plan.sim.solOutLamports ?? '?'} lamports leave the wallet)` : `FAILED ${plan.sim.error ?? ''}`) : 'not run'} · policy: ${plan.policy.ok ? 'ok' : `REFUSE ${plan.policy.reason}`} · caps: ${plan.precheck.ok ? 'ok' : `REFUSE ${plan.precheck.reason}`}\n`);
    if (!plan.policy.ok || !plan.precheck.ok || !plan.sim.ok) { io.stderr.write('trenchscope wallet probe: the signer would refuse this plan; nothing to sign\n'); return 1; }
    const stdin = io.stdin;
    if (!stdin || stdin.isTTY !== true) { io.stderr.write('trenchscope wallet probe: needs a real terminal keypress (stdin is not a TTY). Refusing.\n'); return 2; }
    io.stdout.write('Press Y to sign this probe in Phantom (any other key aborts)… ');
    const key = await ttyKeypress(stdin, over.keypressTimeoutMs ?? 60_000);
    io.stdout.write('\n');
    if (key !== 'y' && key !== 'Y') { io.stdout.write('aborted; nothing signed.\n'); return 1; }
    const out = await service.confirm({ hash: plan.hash });
    if (out.kind === 'filled') { io.stdout.write(`✓ confirmed on devnet · signature ${out.signature}${out.lighthouseTail ? ` · Phantom appended ${out.lighthouseTail} Lighthouse instruction(s)` : ' · no Lighthouse tail'} · ${out.roundTripMs} ms\n`); return 0; }
    if (out.kind === 'refused') { io.stdout.write(`✗ refused by the signer: ${out.reason} — ${out.message}\n`); return 1; }
    if (out.kind === 'send-unknown') { io.stdout.write(`? send outcome unknown: ${out.error} · signature ${out.signature} · do NOT resend\n`); return 1; }
    io.stdout.write(`✗ send failed: ${out.error}${out.signature ? ` · signature ${out.signature}` : ''}\n`);
    return 1;
  }

  // FAST WALLET (task-1363): the one key trenchscope holds, devnet only, for standing-mandate fills at machine speed.
  //   create   a new devnet key at ~/.dexterm/fast-wallet.json (mode 600) after a real TTY keypress; never overwrites
  //   status   public key, devnet balance, the per-fill ceiling
  //   airdrop  devnet faucet into the fast wallet (--sol N, default 1)
  //   remove   delete the key (TTY keypress; refused while it still holds SOL unless --force)
  // There is no export, no import, no mainnet variant, and the signer process only ever READS this file.
  if (sub === 'fast') {
    if (argv.includes('--mainnet')) { io.stderr.write('trenchscope wallet fast: devnet only (there is no mainnet fast wallet; drop --mainnet)\n'); return 2; }
    const action = argv[1] ?? 'status';
    const fastStore = new FastWalletStore(over.fastWalletPath ?? defaultFastWalletPath(io.env));
    const rpc = (): NonNullable<WalletCmdOverrides['fastRpc']> => {
      if (over.fastRpc) return over.fastRpc;
      const dl = createDataLayer({ dbPath: ':memory:', rpcUrl: DEVNET_RPC, rpcFallbackUrl: null });
      const r = new TradeRpc(dl.http, { url: DEVNET_RPC });
      return { balance: (pk) => r.balance(pk), airdrop: (pk, l) => r.airdrop(pk, l), confirm: (sig) => r.confirm(sig, { timeoutMs: 45_000 }) };
    };
    const balanceLine = async (pk: string): Promise<{ lamports: bigint | null; text: string }> => {
      try { const l = await rpc().balance(pk); return { lamports: l, text: `${lamportsToSol(l).toFixed(4)} SOL (devnet)` }; }
      catch (e) { return { lamports: null, text: `balance unavailable (${e instanceof Error ? e.message : String(e)})` }; }
    };
    if (action === 'status') {
      const rec = fastStore.get();
      if (!rec) { io.stdout.write(`fast wallet: (none) — create one with \`trenchscope wallet fast create\` (devnet only)\n`); return 0; }
      const b = await balanceLine(rec.publicKey);
      io.stdout.write(`fast wallet: ${shortPubkey(rec.publicKey)}  (${rec.publicKey}) · devnet · created ${new Date(rec.createdAt).toISOString()}\n`);
      io.stdout.write(`  balance: ${b.text} · per-fill ceiling ${FAST_MAX_SOL_PER_FILL} SOL · the signer's USD per-trade/daily caps apply on every fill\n`);
      io.stdout.write(`  file: ${fastStore.path} (mode 600; never exported, never printed)\n`);
      return 0;
    }
    if (action === 'create') {
      if (fastStore.exists()) { io.stderr.write(`trenchscope wallet fast create: a fast wallet already exists at ${fastStore.path} (remove it first, after draining)\n`); return 2; }
      const stdin = io.stdin;
      if (!stdin || stdin.isTTY !== true) { io.stderr.write('trenchscope wallet fast create: needs a real terminal keypress (stdin is not a TTY). Refusing.\n'); return 2; }
      io.stdout.write(`Create a DEVNET fast wallet at ${fastStore.path}?\n  armed order plans inside a standing mandate fire from it at machine speed, within the signer's caps and a ${FAST_MAX_SOL_PER_FILL} SOL per-fill ceiling.\n  devnet only — this key can never be used on mainnet. Press Y to create (any other key aborts)… `);
      const key = await ttyKeypress(stdin, over.keypressTimeoutMs ?? 30_000);
      io.stdout.write('\n');
      if (key !== 'y' && key !== 'Y') { io.stdout.write('aborted; nothing created.\n'); return 1; }
      const rec = fastStore.create({ network: 'devnet' });
      io.stdout.write(`✓ fast wallet created: ${rec.publicKey} (devnet)\n  fund it: trenchscope wallet fast airdrop   · then restart trenchscope so the signer loads it\n`);
      return 0;
    }
    if (action === 'airdrop') {
      const rec = fastStore.get();
      if (!rec) { io.stderr.write('trenchscope wallet fast airdrop: no fast wallet; `trenchscope wallet fast create` first\n'); return 2; }
      const solIdx = argv.indexOf('--sol');
      const sol = solIdx >= 0 ? Number(argv[solIdx + 1]) : 1;
      if (!Number.isFinite(sol) || sol <= 0 || sol > 5) { io.stderr.write('trenchscope wallet fast airdrop: --sol must be in (0, 5]\n'); return 2; }
      try {
        const sig = await rpc().airdrop(rec.publicKey, BigInt(Math.round(sol * 1e9)));
        io.stdout.write(`airdrop requested: ${sol} SOL (devnet) → ${shortPubkey(rec.publicKey)} · signature ${sig}\n`);
        const c = rpc().confirm ? await rpc().confirm!(sig).catch(() => null) : null;
        if (c) io.stdout.write(c.confirmed ? '✓ confirmed\n' : `? not confirmed yet (${c.err ?? 'pending'})\n`);
        const b = await balanceLine(rec.publicKey);
        io.stdout.write(`  balance: ${b.text}\n`);
        return 0;
      } catch (e) {
        io.stderr.write(`trenchscope wallet fast airdrop failed: ${e instanceof Error ? e.message : String(e)} — the public devnet faucet is often dry; try https://faucet.solana.com with the address above\n`);
        return 1;
      }
    }
    if (action === 'remove') {
      const rec = fastStore.get();
      if (!rec) { io.stdout.write('no fast wallet to remove.\n'); return 0; }
      const b = await balanceLine(rec.publicKey);
      if (b.lamports !== null && b.lamports > 0n && !argv.includes('--force')) { io.stderr.write(`trenchscope wallet fast remove: the fast wallet still holds ${b.text}; move it out first, or pass --force to delete the key anyway (devnet SOL only)\n`); return 2; }
      const stdin = io.stdin;
      if (!stdin || stdin.isTTY !== true) { io.stderr.write('trenchscope wallet fast remove: needs a real terminal keypress (stdin is not a TTY). Refusing.\n'); return 2; }
      io.stdout.write(`Delete the fast wallet ${shortPubkey(rec.publicKey)} (${b.text})? Press Y to delete (any other key aborts)… `);
      const key = await ttyKeypress(stdin, over.keypressTimeoutMs ?? 30_000);
      io.stdout.write('\n');
      if (key !== 'y' && key !== 'Y') { io.stdout.write('aborted; the fast wallet is kept.\n'); return 1; }
      fastStore.remove();
      io.stdout.write('✓ fast wallet removed. Restart trenchscope so the signer stops loading it.\n');
      return 0;
    }
    io.stderr.write(`trenchscope wallet fast: unknown action ${JSON.stringify(action)} (expected status | create | airdrop | remove)\n`);
    return 2;
  }

  if (sub === 'unlink') {
    const had = store.clear();
    io.stdout.write(had ? 'unlinked.\n' : 'no wallet was linked.\n');
    return 0;
  }

  // PANIC: instant, no confirmation, scriptable from anywhere (a second terminal, a hotkey, an agent).
  // Engages the kill-switch file (every executor re-reads it on each plan/confirm) AND locks the shared
  // daily-cap ledger so no reservation can be taken even if the file were removed by hand.
  if (sub === 'panic') {
    const reasonIdx = argv.indexOf('--reason');
    const reason = reasonIdx >= 0 && argv[reasonIdx + 1] ? argv[reasonIdx + 1] : 'manual panic';
    const rec = ks.engage(reason);
    const ledger = openLedger();
    let lockNote = '';
    if (ledger) { try { ledger.lock(reason); lockNote = ' · cap ledger locked'; } finally { ledger.close(); } }
    else lockNote = ' · (cap ledger could not be opened; the kill-switch file still disables trading)';
    io.stdout.write(`⛔ PANIC: live trading disabled (${rec.reason})${lockNote}\n`);
    io.stdout.write(`kill switch: ${ks.path}\nRe-enable only from a real terminal: trenchscope wallet resume\n`);
    return 0;
  }

  // RESUME: the only way back. Requires a physical keypress on a TTY — not piped/scripted input — so a
  // model, a script or a compromised popup cannot silently re-arm live trading.
  if (sub === 'resume') {
    const stdin = io.stdin;
    if (!stdin || stdin.isTTY !== true) {
      io.stderr.write('trenchscope wallet resume: needs a real terminal keypress (stdin is not a TTY). Refusing.\n');
      return 2;
    }
    const p = ks.engaged();
    const ledger = openLedger();
    try {
      const l = ledger?.locked() ?? null;
      if (!p && !l) { io.stdout.write('live trading is not panicked; nothing to resume.\n'); return 0; }
      io.stdout.write(`${panicLine(ks, ledger) ?? ''}\nPress Y to re-enable live trading (any other key aborts)… `);
      const key = await ttyKeypress(stdin, over.keypressTimeoutMs ?? 30_000);
      io.stdout.write('\n');
      if (key === null) { io.stderr.write('trenchscope wallet resume: no keypress; still panicked.\n'); return 2; }
      if (key !== 'y' && key !== 'Y') { io.stdout.write('aborted; still panicked.\n'); return 1; }
      ks.release();
      ledger?.unlock();
      io.stdout.write('✓ live trading re-enabled (caps still apply).\n');
      return 0;
    } finally { ledger?.close(); }
  }

  if (sub === 'link') {
    const bridge = over.bridge ?? new WalletBridge(over.open ? { open: over.open } : {});
    io.stdout.write('Opening your browser to link a Solana wallet (sign-a-message only; no transaction)…\n');
    try {
      const res = await bridge.link();
      const rec = store.set(res.publicKey, { network: caps.network });
      io.stdout.write(`linked: ${shortPubkey(rec.publicKey)}  (${rec.publicKey})\n`);
      io.stdout.write(`${capsLine(caps)}\n`);
      return 0;
    } catch (e) {
      io.stderr.write(`trenchscope wallet link failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  io.stderr.write(`trenchscope wallet: unknown subcommand ${JSON.stringify(sub)} (expected link | unlink | status | panic | resume | probe | fast)\n`);
  return 2;
}
