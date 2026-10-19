// task-1328 T2 — the LIVE ticket in the UI: state machine phases, the binding over a (fake) signer
// port, the banner/header taking the network from the SIGNER (never a UI flag), the in-app /wallet
// commands, and the LOCKOUT: the analyst, scan mode and the MCP server can never open a LIVE ticket,
// confirm or sign anything — proven structurally (import closure, tool table, action validator) and
// behaviourally (an analyst open_ticket on a live-capable context yields a PAPER ticket in editing and
// the signer is never called). Offline: no network, no wallet, no real signer process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import {
  normalizeSwapQuote, SOL_MINT, LAMPORTS_PER_SOL, LiveLedger, KillSwitch, CapLedger, WalletLinkStore, validateAnalystAction, ANALYST_ACTION_TYPES, computeFill,
  type SwapQuote, type PaperOrder, type Fill, type PaperWallet, type TradeExecutor, type DataLayer, type SignerPort, type PlanView, type ConfirmView, type StatusView, type LinkedWallet, type FastView,
} from '@dexterm/data';
import { TOOLS } from '../../mcp/src/index.ts';
import { openTicket, ticketKey, type TicketContext, type TicketKey } from '../src/trade.ts';
import { TradeTicketLive, LivePositions, CombinedPositions, PositionsLive } from '../src/live/trade.ts';
import { parseWalletCommand } from '../src/wallet-command.ts';
import { makeFixtureState, makeFeedState, renderFrame, headerModel, type AppState } from '../src/state.ts';
import { applyKey, applyAnalystAction } from '../src/main.ts';
import { createReplayFeed } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';
import { emptyView } from '../src/live/token.ts';
import { chartVMFromView } from '../src/popup.ts';
import { screenerView } from '../src/screener/view.ts';
import type { ScreenKey } from '@dexterm/tui';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', 'src');
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PK = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const NOW = 1_000_000;
const ctx = (over: Partial<TicketContext> = {}): TicketContext => ({ balanceLamports: 10n * LAMPORTS_PER_SOL, positionTokensRaw: 0n, notionalSol: 0.5, typebackThresholdSol: 1, ...over });
const ch = (c: string): TicketKey => ({ name: 'char', ch: c });
const K = { enter: { name: 'enter' } as TicketKey, esc: { name: 'esc' } as TicketKey };

// ------------------------------------------------------------------------------------ fakes

function sampleQuote(): SwapQuote {
  return normalizeSwapQuote({
    inputMint: SOL_MINT, outputMint: MINT, inAmount: '500000000', outAmount: '2000000', otherAmountThreshold: '1990000', swapMode: 'ExactIn', slippageBps: 50,
    priceImpactPct: '0.005', platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '75',
  } as never, NOW);
}
const FILL = computeFill({ mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, amountRaw: 500_000_000n, slippageBps: 50 }, sampleQuote(), NOW);
const fakeWallet = (): PaperWallet => ({ balance: () => 10n * LAMPORTS_PER_SOL, position: () => undefined, positions: () => [] } as unknown as PaperWallet);
const fakeExec: TradeExecutor = { previewFill: (_o: PaperOrder, _q: SwapQuote) => FILL, execute: async () => FILL } as unknown as TradeExecutor;
const fakeDl = (): DataLayer => ({
  clock: { now: () => NOW }, limiter: { bucket: () => ({ stats: () => ({ pausedUntil: 0 }) }) },
  store: { enrich: async () => ({ rows: [{ token: { decimals: 6 } }] }) }, jupiterSwap: { quote: async () => sampleQuote() },
} as unknown as DataLayer);

function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    hash: 'a'.repeat(64), kind: 'swap', lane: 'main', ref: null, network: 'devnet', mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, amountInRaw: '500000000', amountOutRaw: '2000000', minOutRaw: '1990000',
    slippageBps: 50, route: ['Meteora'], priceImpactPct: 0.5, notionalUsd: null, solUsd: { price: 150, sources: ['dexscreener'] },
    sim: { ran: true, ok: true, error: null, unitsConsumed: null, solOutLamports: '500005000' }, feeLamports: '6234', prioritizationFeeLamports: 1234,
    instructions: [{ program: 'ComputeBudget', op: 'SetComputeUnitLimit' }, { program: 'Jupiter', op: 'route' }], policy: { ok: true }, precheck: { ok: true },
    userPublicKey: PK, builtAt: NOW, expiresAt: NOW + 90_000, ...over,
  };
}
function statusView(over: Partial<StatusView> = {}): StatusView {
  return {
    version: 1, pid: 4242, linked: { publicKey: PK, linkedAt: NOW }, fastWallet: null, network: 'devnet', rpcHost: 'api.devnet.solana.com',
    caps: { network: 'devnet', mainnetEnabled: false, perTradeUsd: 5, dailyUsd: 20, maxPriceImpactPct: 3, maxSolOut: 1, maxSlippageBps: 500 },
    panic: null, ledgerLocked: null, spentTodayUsd: 0, plans: 0, solUsd: { price: 150, sources: ['dexscreener'] }, probeAvailable: true, ...over,
  };
}

/** A scripted signer port: records every call; the UI must only ever reach plan/precheck/confirm/drop/panic/status. */
class FakeSigner implements SignerPort {
  alive = true;
  calls: string[] = [];
  status_ = statusView();
  plan_ = planView();
  confirm_: ConfirmView = { kind: 'filled', signature: 'S'.repeat(88), fill: { t: NOW, mint: MINT, symbol: 'USDC', side: 'buy', decimals: 6, solDelta: '-500005000', tokenDelta: '2000000', feeLamports: '5000', priceSol: 0.00025, realizedLamports: '0' }, roundTripMs: 12, lighthouseTail: 0, network: 'devnet' };
  planDelay: Promise<void> | null = null;
  async status(): Promise<StatusView> { this.calls.push('status'); return this.status_; }
  async plan(p: Parameters<SignerPort['plan']>[0]): Promise<PlanView> { this.calls.push(`plan:${p.side}:${p.amountRaw}`); if (this.planDelay) await this.planDelay; return this.plan_; }
  async probe(): Promise<PlanView> { this.calls.push('probe'); return planView({ kind: 'probe', mint: SOL_MINT, symbol: 'SOL', amountInRaw: '1000000', amountOutRaw: '1000000', instructions: [{ program: 'Memo', op: 'memo' }] }); }
  async precheck(): Promise<{ ok: boolean }> { this.calls.push('precheck'); return { ok: true }; }
  async confirm(hash: string): Promise<ConfirmView> { this.calls.push(`confirm:${hash.slice(0, 4)}`); return this.confirm_; }
  async drop(hash: string): Promise<void> { this.calls.push(`drop:${hash.slice(0, 4)}`); }
  async panic(): Promise<void> { this.calls.push('panic'); }
  // task-1363: the ticket never reaches the fast-wallet methods; a call here is recorded (and would fail a test that asserts the call list).
  async fast(): Promise<FastView> { this.calls.push('fast'); return { loaded: false, publicKey: null, network: 'devnet', balanceLamports: null, maxSolPerFill: 0.05, createdAt: null, reason: 'none' }; }
  async fill(): Promise<PlanView> { this.calls.push('fill'); throw new Error('fill is not a ticket path'); }
  close(): void { this.alive = false; }
}

function liveTicket(signer: FakeSigner | null, linked: LinkedWallet | null = { publicKey: PK, linkedAt: NOW }, onFill?: () => void): TradeTicketLive {
  return new TradeTicketLive(fakeDl(), fakeWallet(), fakeExec, { mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' }, {
    now: () => NOW, live: signer === null ? undefined : { signer: () => signer, linked: () => linked, onFill },
  });
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ------------------------------------------------------------------------------------ 1. state machine

test('ticket state machine: L flips the mode request; LIVE ⏎ → plan; the PLAN screen is a keypress gate (Y/⏎ confirm, esc/stray key cancel); receipts reset in the same mode', () => {
  const ts = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  assert.equal(ts.mode, 'paper');
  assert.equal(ticketKey(ts, ch('L'), ctx()), 'toggle-live', 'L asks the binding to flip (the binding decides)');
  assert.equal(ticketKey(ts, ch('l'), ctx()), 'toggle-live');
  ts.mode = 'live';
  ts.sizeInput = '0.5';
  assert.equal(ticketKey(ts, K.enter, ctx()), 'plan'); assert.equal(ts.phase, 'planning');
  assert.equal(ticketKey(ts, ch('y'), ctx()), 'none', 'while planning nothing confirms');
  ts.phase = 'plan';
  assert.equal(ticketKey(ts, ch('x'), ctx()), 'drop-plan', 'a stray key cancels the plan'); assert.equal(ts.phase, 'editing');
  ts.phase = 'plan';
  assert.equal(ticketKey(ts, K.esc, ctx()), 'drop-plan'); assert.equal(ts.phase, 'editing');
  ts.phase = 'plan';
  assert.equal(ticketKey(ts, ch('Y'), ctx()), 'confirm-live'); assert.equal(ts.phase, 'signing');
  assert.equal(ticketKey(ts, K.esc, ctx()), 'none', 'signing ignores keys');
  // typed-back size above the threshold, exactly like paper
  const big = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy', mode: 'live' });
  big.sizeInput = '2';
  assert.equal(ticketKey(big, K.enter, ctx({ notionalSol: 2 })), 'plan'); assert.equal(big.typebackRequired, true);
  big.phase = 'plan';
  assert.equal(ticketKey(big, ch('y'), ctx()), 'none', 'Y without the typed-back size does nothing'); assert.match(big.message ?? '', /type the size/);
  for (const c of ['2']) ticketKey(big, ch(c), ctx());
  assert.equal(ticketKey(big, ch('y'), ctx()), 'confirm-live');
  // refused / filled receipts: esc closes; any other key opens a fresh ticket in the SAME mode
  ts.phase = 'refused';
  assert.equal(ticketKey(ts, ch('b'), ctx()), 'changed'); assert.equal(ts.mode, 'live'); assert.equal(ts.phase, 'editing');
  ts.phase = 'filled';
  assert.equal(ticketKey(ts, K.esc, ctx()), 'close');
  // paper is untouched: ⏎ still goes to the paper confirm step
  const paper = openTicket({ mint: MINT, symbol: 'USDC', decimals: 6, side: 'buy' });
  paper.sizeInput = '0.5';
  assert.equal(ticketKey(paper, K.enter, ctx()), 'none'); assert.equal(paper.phase, 'confirm');
});

// ------------------------------------------------------------------------------------ 2. the binding over the signer port

test('binding: LIVE is refused without live deps, without a linked wallet, or with a dead signer — the ticket stays PAPER', async () => {
  const none = liveTicket(null);
  none.key(ch('L'));
  assert.equal(none.ticket.mode, 'paper'); assert.match(none.ticket.message ?? '', /not available/);
  const unlinked = liveTicket(new FakeSigner(), null);
  unlinked.key(ch('L'));
  assert.equal(unlinked.ticket.mode, 'paper'); assert.match(unlinked.ticket.message ?? '', /no wallet linked/);
  const dead = new FakeSigner(); dead.alive = false;
  const t = liveTicket(dead);
  t.key(ch('L'));
  assert.equal(t.ticket.mode, 'paper'); assert.match(t.ticket.message ?? '', /died/);
  assert.deepEqual(dead.calls, [], 'a dead signer is never called');
});

test('binding: L → LIVE reads the signer status; ⏎ → plan (view carries the signer\'s plan); Y → confirm → filled; onFill fires; the paper executor never ran', async () => {
  const signer = new FakeSigner();
  let fills = 0;
  const t = liveTicket(signer, undefined, () => { fills++; });
  t.key(ch('L'));
  assert.equal(t.ticket.mode, 'live');
  await tick();
  assert.ok(signer.calls.includes('status'));
  for (const c of ['0', '.', '5']) t.key(ch(c));
  assert.equal(t.key(K.enter), 'plan');
  assert.equal(t.ticket.phase, 'planning');
  await tick();
  assert.equal(t.ticket.phase, 'plan');
  const v = t.view();
  assert.equal(v.live?.plan?.hash, 'a'.repeat(64));
  assert.ok(signer.calls.some((c) => c === 'plan:buy:500000000'), signer.calls.join(','));
  assert.equal(t.key(ch('y')), 'confirm-live');
  assert.equal(t.ticket.phase, 'signing');
  await tick();
  assert.equal(t.ticket.phase, 'filled');
  assert.equal(t.view().live?.outcome?.kind, 'filled');
  assert.equal(fills, 1);
  assert.ok(signer.calls.includes('confirm:aaaa'));
  assert.equal(t.view().receipt, null, 'no PAPER receipt: nothing was booked in the paper wallet');
});

test('binding: a refused confirm lands in `refused` with the signer\'s reason; esc on the plan drops it; cancelling while planning drops the late plan', async () => {
  const signer = new FakeSigner();
  signer.confirm_ = { kind: 'refused', reason: 'per-trade-cap', message: 'trade $7.00 exceeds the per-trade cap $5.00' };
  const t = liveTicket(signer);
  t.key(ch('L'));
  for (const c of ['1']) t.key(ch(c));
  t.key(K.enter); await tick();
  t.key(ch('y')); await tick();
  assert.equal(t.ticket.phase, 'refused');
  assert.match(t.ticket.message ?? '', /per-trade-cap/);
  // esc on a plan → drop
  const u = liveTicket(signer);
  u.key(ch('L')); u.key(ch('1')); u.key(K.enter); await tick();
  assert.equal(u.ticket.phase, 'plan');
  u.key(K.esc); await tick();
  assert.equal(u.ticket.phase, 'editing');
  assert.ok(signer.calls.includes('drop:aaaa'), signer.calls.join(','));
  // cancel while planning: when the plan lands late it is dropped, never shown
  let release!: () => void;
  signer.planDelay = new Promise<void>((r) => { release = r; });
  const w = liveTicket(signer);
  w.key(ch('L')); w.key(ch('1')); w.key(K.enter);
  assert.equal(w.ticket.phase, 'planning');
  w.cancelPlan();
  assert.equal(w.ticket.phase, 'editing');
  const before = signer.calls.filter((c) => c.startsWith('drop')).length;
  release(); await tick(); await tick();
  assert.equal(w.view().live?.plan, null, 'the late plan is not shown');
  assert.equal(signer.calls.filter((c) => c.startsWith('drop')).length, before + 1, 'and it was dropped in the signer');
});

// ------------------------------------------------------------------------------------ 3. banner/header from the SIGNER

function stateWithTicket(t: TradeTicketLive): AppState {
  const s = makeFixtureState({ screen: 'ticket', intensity: 'off' });
  s.live = { ticket: t, linkedWallet: { publicKey: PK, linkedAt: NOW }, creditsStatus: () => undefined, meterStatus: () => undefined, scanMeterLabel: () => null } as unknown as AppState['live'];
  return s;
}
const plain = (s: AppState): string => renderFrame(s, 160, 48).toPlain();

test('screen + header: a LIVE ticket shows the network the SIGNER reports, never the UI\'s idea — mainnet turns the banner red/REAL FUNDS with the signer\'s caps; panic shows', async () => {
  const signer = new FakeSigner();
  signer.status_ = statusView({ network: 'mainnet', rpcHost: 'api.mainnet-beta.solana.com', caps: { ...statusView().caps, network: 'mainnet', mainnetEnabled: true } });
  const t = liveTicket(signer);
  t.key(ch('L')); await tick();
  const s = stateWithTicket(t);
  const text = plain(s);
  assert.match(text, /LIVE · MAINNET — REAL FUNDS · caps \$5\/trade \$20\/day/);
  assert.match(headerModel(s).status ?? '', /LIVE · MAINNET/);
  assert.doesNotMatch(text, /PAPER TRADING/);
  // devnet signer → devnet banner
  signer.status_ = statusView();
  await t.refreshSignerStatus();
  assert.match(plain(s), /LIVE · DEVNET/);
  assert.match(headerModel(s).status ?? '', /LIVE · DEVNET/);
  // the plan screen lists what will be signed + the signer's verdicts
  t.key(ch('1')); t.key(K.enter); await tick();
  const p = plain(s);
  assert.match(p, /PLAN · DEVNET/); assert.match(p, /Jupiter:route/); assert.match(p, /within caps/); assert.match(p, /Y = sign this exact plan in Phantom/);
  assert.match(p, /Price impact\s+0\.5%/, 'impact shown as a percent');
  // a refusing precheck is shown before the keypress
  signer.plan_ = planView({ precheck: { ok: false, reason: 'per-trade-cap', message: 'over' } });
  t.key(K.esc); t.key(K.enter); await tick();
  assert.match(plain(s), /WILL REFUSE this plan: per-trade-cap/);
  // panic in the signer's status → banner line
  signer.status_ = statusView({ panic: { engagedAt: NOW, reason: 'manual' } });
  await t.refreshSignerStatus();
  assert.match(plain(s), /PANIC — live signing is disabled/);
  // unreachable signer → nothing can be signed
  signer.status_ = null as unknown as StatusView;
  (signer as unknown as { status: () => Promise<StatusView> }).status = async () => { throw new Error('gone'); };
  await t.refreshSignerStatus();
  assert.match(plain(s), /signer not reachable · nothing can be signed/);
  // paper ticket: unchanged banner
  const paper = liveTicket(signer);
  assert.match(plain(stateWithTicket(paper)), /PAPER TRADING — simulated/);
});

// ------------------------------------------------------------------------------------ 4. /wallet commands

test('/wallet parser: status (default) · link · unlink · panic · probe; resume is refused here (needs a TTY in a shell); junk is an error; filters are untouched', () => {
  assert.equal(parseWalletCommand('/wallet'), 'status');
  assert.equal(parseWalletCommand('wallet status'), 'status');
  assert.equal(parseWalletCommand('/wallet link'), 'link');
  assert.equal(parseWalletCommand('/wallet UNLINK'), 'unlink');
  assert.equal(parseWalletCommand('/wallet panic'), 'panic');
  assert.equal(parseWalletCommand('/wallet probe'), 'probe');
  assert.match((parseWalletCommand('/wallet resume') as { error: string }).error, /keypress/);
  assert.match((parseWalletCommand('/wallet sign') as { error: string }).error, /unknown/);
  assert.equal(parseWalletCommand('liq > 50k'), null);
  assert.equal(parseWalletCommand('/scan on'), null);
});

async function liveState(screen: ScreenKey, trade?: ConstructorParameters<typeof LiveContext>[1]['trade']): Promise<AppState> {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen, intensity: 'off' });
  state.live = new LiveContext(feed.dl, { mode: 'replay', trade });
  return state;
}
const close = (s: AppState): void => { try { s.live?.close(); } catch { /* */ } try { s.feed?.close(); } catch { /* */ } };
const liveMint = (s: AppState): string => screenerView(s.screener)[0].mint;

test('/wallet on the screener\'s `/` line sets a pending command for the loop (never a filter); resume/junk become a toast', async () => {
  const s = await liveState('screener');
  try {
    s.screener.mode = 'filter'; s.screener.edit.text = '/wallet panic';
    applyKey(s, { name: 'enter' } as never, []);
    assert.equal(s.pendingWallet, 'panic'); assert.equal(s.screener.mode, 'table'); assert.ok(!s.screener.query, 'no filter applied');
    s.pendingWallet = null;
    s.screener.mode = 'filter'; s.screener.edit.text = '/wallet resume';
    applyKey(s, { name: 'enter' } as never, []);
    assert.equal(s.pendingWallet ?? null, null); assert.match(s.pendingToast ?? '', /keypress/);
  } finally { close(s); }
});

test('LiveContext.walletCommand: status/unlink/panic/probe with a fake signer and hermetic files; link via the real loopback bridge with a fake Phantom', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-t2-'));
  const paths = { liveLedger: join(dir, 'live.sqlite'), link: join(dir, 'link.json'), panic: join(dir, 'panic'), capLedger: join(dir, 'caps.sqlite') };
  new WalletLinkStore(paths.link).set(PK);
  const signer = new FakeSigner();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pub = Buffer.from(der.subarray(der.length - 32));
  const fakePhantom = async (url: string): Promise<void> => {
    const page = await (await fetch(url)).text();
    const challenge = (page.match(/<pre id="c">([\s\S]*?)<\/pre>/) ?? [])[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const sig = edSign(null, Buffer.from(challenge, 'utf8'), privateKey);
    await fetch(`${new URL(url).origin}/link/result`, { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(url).origin }, body: JSON.stringify({ t: new URL(url).searchParams.get('t'), publicKey: pub.toString('base64'), signature: sig.toString('base64'), challenge, provider: 'stub' }) });
  };
  const s = await liveState('screener', { createSigner: () => signer, open: (url) => { void fakePhantom(url); }, paths });
  const live = s.live!;
  try {
    assert.equal(live.linkedWallet?.publicKey, PK, 'the link store is read at start');
    assert.match(await live.walletCommand('status'), /linked: HN7c…YWrH · signer not started/);
    // probe → a LIVE ticket in probe mode, planned by the signer
    assert.match(await live.walletCommand('probe'), /devnet probe/);
    assert.equal(live.ticket?.ticket.mode, 'live');
    await tick();
    assert.equal(live.ticket?.view().live?.probe, true); assert.equal(live.ticket?.view().live?.plan?.kind, 'probe');
    assert.ok(signer.calls.includes('probe'));
    assert.match(await live.walletCommand('status'), /signer DEVNET \(api.devnet.solana.com\) · \$5\/trade \$20\/day/);
    // panic: kill-switch file + ledger lock written locally, the signer told, the live ticket refused
    assert.match(await live.walletCommand('panic'), /PANIC/);
    assert.ok(new KillSwitch(paths.panic).engaged(), 'kill-switch file engaged');
    const l = new CapLedger({ path: paths.capLedger }); try { assert.ok(l.locked()); } finally { l.close(); }
    assert.ok(signer.calls.includes('panic'));
    assert.equal(live.ticket?.ticket.phase, 'refused');
    // unlink forgets the key and drops a live ticket back to paper
    assert.equal(await live.walletCommand('unlink'), 'unlinked');
    assert.equal(live.linkedWallet, null); assert.equal(existsSync(paths.link), false);
    // link: the real loopback bridge + a fake Phantom; only the PUBLIC key is stored
    const line = await live.walletCommand('link');
    assert.match(line, /^linked: /);
    assert.ok((live.linkedWallet as LinkedWallet | null)?.publicKey, 'a wallet is linked again');
    const stored = JSON.parse(readFileSync(paths.link, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored).sort(), ['linkedAt', 'network', 'publicKey']);
    assert.ok(!JSON.stringify(stored).includes(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64').slice(0, 16)), 'no key material anywhere');
  } finally { close(s); rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------ 5. LOCKOUT

const FORBIDDEN = /signer|bridge|wallet|live\/trade|executor|swap-build|rpc-exec|kill-switch|caps\.ts|link-store/i;
const tsFiles = (dir: string): string[] => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)).filter((f) => statSync(f).isFile()) : [];
const specifiers = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);

test('LOCKOUT (static): src/scan, src/analyst and the MCP server never import the signer client/service, the bridge, the executor or the live ticket — not even as a type', () => {
  const files = [...tsFiles(join(SRC, 'scan')), ...tsFiles(join(SRC, 'analyst')), ...tsFiles(resolve(here, '..', '..', 'mcp', 'src'))];
  assert.ok(files.length >= 8, `files: ${files.length}`);
  for (const f of files) for (const spec of specifiers(f)) assert.doesNotMatch(spec, FORBIDDEN, `${f.replace(SRC, 'src')} imports ${spec}`);
  // the signer client/port/service identifiers are IMPORTED only by the trade modules + the CLI's wallet code
  const allowed = new Set(['live/index.ts', 'live/trade.ts', 'trade.ts', 'wallet-cmd.ts']);
  const all = [...tsFiles(SRC), ...tsFiles(join(SRC, 'screens')), ...tsFiles(join(SRC, 'live')), ...tsFiles(join(SRC, 'live', 'screens')), ...tsFiles(join(SRC, 'scan')), ...tsFiles(join(SRC, 'analyst')), ...tsFiles(join(SRC, 'screener'))];
  const importsSigner = (f: string): boolean => {
    const text = readFileSync(f, 'utf8');
    const importLines = [...text.matchAll(/^\s*(?:import|export)[^;]*?from\s*['"][^'"]+['"]/gms)].map((m) => m[0]);
    return importLines.some((l) => /\b(SignerClient|SignerPort|SignerService|SignerUnavailableError|serveSigner|buildSignerService|parseSignerArgs)\b|\/signer\//.test(l));
  };
  const importers = all.filter(importsSigner).map((f) => relative(SRC, f).split(sep).join('/')).sort();
  for (const f of importers) assert.ok(allowed.has(f), `${f} imports the signer`);
  assert.ok(importers.includes('live/index.ts') && importers.includes('wallet-cmd.ts'), importers.join(','));
});

test('LOCKOUT (MCP + validator): no tool can plan, confirm, sign, swap or panic; the only trade-shaped action is open_ticket, and it is PAPER-only', () => {
  const tools = TOOLS as unknown as readonly { name: string }[];
  // task-1443 changes this on purpose: the opt-in agent PAPER tools may confirm/close a SIMULATED trade inside an
  // armed mandate (guarded by no-sign-registry-1443). They are exactly these four, and even they are never named
  // like a real sign / swap / wallet / live / plan op.
  const PAPER_WRITE = ['paper_open_ticket', 'paper_size_ticket', 'paper_confirm', 'paper_close'];
  for (const tool of tools) {
    if (PAPER_WRITE.includes(tool.name)) assert.doesNotMatch(tool.name, /sign|plan|swap|wallet|panic|execute|submit|live|probe/i, tool.name);
    else assert.doesNotMatch(tool.name, /sign|confirm|plan|swap|wallet|panic|execute|submit|live|probe/i, tool.name);
  }
  assert.deepEqual(tools.filter((t) => /confirm|close|size|ticket/.test(t.name) && t.name !== 'open_ticket').map((t) => t.name).sort(), [...PAPER_WRITE].sort());
  assert.ok(tools.some((t) => t.name === 'open_ticket'));
  assert.deepEqual([...ANALYST_ACTION_TYPES].filter((t) => /confirm|sign|live|plan|panic/i.test(t)), []);
  const allow = { mints: [MINT], feeds: ['new'], sortKeys: ['vol24'] };
  for (const raw of [{ type: 'confirm_ticket', hash: 'a'.repeat(64) }, { type: 'sign', tx: 'AQ==' }, { type: 'open_live_ticket', mint: MINT, side: 'buy' }, { type: 'wallet', cmd: 'panic' }]) {
    assert.equal(validateAnalystAction(raw, allow).ok, false, JSON.stringify(raw));
  }
  const r = validateAnalystAction({ type: 'open_ticket', mint: MINT, side: 'buy', mode: 'live', live: true, confirm: true }, allow);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(Object.keys(r.action).sort(), ['mint', 'side', 'type'], 'extra fields (mode/live/confirm) are stripped');
});

test('LOCKOUT (behaviour): an analyst open_ticket on a live-capable context with a linked wallet and a running signer yields a PAPER ticket in editing; the signer is never called; it even REPLACES an open LIVE plan with a paper ticket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-t2-'));
  const paths = { liveLedger: join(dir, 'live.sqlite'), link: join(dir, 'link.json'), panic: join(dir, 'panic'), capLedger: join(dir, 'caps.sqlite') };
  new WalletLinkStore(paths.link).set(PK);
  const signer = new FakeSigner();
  const s = await liveState('screener', { createSigner: () => signer, paths });
  try {
    const mint = liveMint(s);
    const r = applyAnalystAction(s, { type: 'open_ticket', mint, side: 'buy', mode: 'live' }, []);
    assert.equal(r.ok, true);
    assert.equal(s.live!.ticket!.ticket.mode, 'paper'); assert.equal(s.live!.ticket!.ticket.phase, 'editing');
    assert.deepEqual(signer.calls, [], 'the signer was never reached');
    // the user opens a LIVE ticket and gets to the PLAN screen…
    const t = s.live!.openTicket({ mint, symbol: 'X', decimals: 6 }, 'buy', 'live');
    t.key(ch('1')); t.key({ name: 'enter' }); await tick();
    assert.equal(t.ticket.phase, 'plan');
    // …and a (compromised) analyst emits open_ticket: the ticket on screen becomes PAPER/editing, no confirm
    const r2 = applyAnalystAction(s, { type: 'open_ticket', mint, side: 'sell' }, []);
    assert.equal(r2.ok, true);
    assert.equal(s.live!.ticket!.ticket.mode, 'paper'); assert.equal(s.live!.ticket!.ticket.phase, 'editing');
    assert.ok(!(signer.calls as string[]).some((c) => c.startsWith('confirm')), signer.calls.join(','));
  } finally { close(s); rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------ 6. positions

test('positions: a confirmed LIVE fill in the signer\'s ledger reaches the token screen row and the popup chart as kind=live through the combined PositionSource; the positions screen lists it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-t2-'));
  const path = join(dir, 'live.sqlite');
  const ledger = new LiveLedger({ path });
  try {
    ledger.record({ fill: { ...FILL, mint: MINT, symbol: 'USDC' } as Fill, network: 'devnet', signature: 'SIG1', usd: null });
  } finally { ledger.close(); }
  const livePos = new LivePositions(path, { now: () => NOW, mark: () => 0.0003 });
  const held = livePos.held(MINT);
  assert.ok(held && held.kind === 'live' && held.tokens === 2, JSON.stringify(held));
  assert.equal(livePos.held('So11111111111111111111111111111111111111112'), null);
  const paper = new PositionsLive(fakeDl(), fakeWallet(), { now: () => NOW });
  const combined = new CombinedPositions(paper, livePos);
  assert.equal(combined.held(MINT)?.kind, 'live');
  const vm = chartVMFromView(emptyView({ mint: MINT, symbol: 'USDC', name: 'USD Coin', launchpad: 'unknown' } as never), { held: combined.held(MINT), positionKind: combined.held(MINT)?.kind ?? combined.kind, solUsd: 150, fills: [], now: NOW });
  assert.equal(vm.position?.kind, 'live'); assert.equal(vm.position?.symbol, 'USDC');
  assert.equal(livePos.records(10).length, 1, 'records are TradeRecords for the popup fills');
  // positions screen: the LIVE POSITIONS box renders from state.live.livePositions
  const s = makeFixtureState({ screen: 'positions', intensity: 'off' });
  s.live = { positions: { view: () => s.positions }, livePositions: livePos, linkedWallet: null, creditsStatus: () => undefined, meterStatus: () => undefined, scanMeterLabel: () => null } as unknown as AppState['live'];
  const text = renderFrame(s, 160, 48).toPlain();
  assert.match(text, /LIVE POSITIONS/); assert.match(text, /\$USDC/); assert.match(text, /· LIVE/);
  rmSync(dir, { recursive: true, force: true });
});
