// trenchscope — live bindings for the TOKEN, NEW PAIRS and WATCHLIST screens (task-1298). One context per
// run, created over the screener feed's data layer so every screen shares the cache, limiter, health
// registry and (when the Helius key is configured) the credit meter. Screens stay pure renderers: the
// context owns the loaders and tells the UI loop when to redraw.
import {
  PumpPortalClient, PUMPPORTAL_WS, WatchlistStore, PaperWallet, PaperExecutor, FastLane, WalletLinkStore, WalletBridge, KillSwitch, CapLedger, SignerClient,
  defaultLiveLedgerPath, defaultLinkPath, defaultPanicPath, defaultCapLedgerPath, shortPubkey,
  type DataLayer, type FixtureStore, type StreamRecording, type RpcConfig, type CreditMeter, type WsFactory, type TradeExecutor, type FastLaneEndpoint, type Lane, type PricePoint, type LinkedWallet,
  type SignerPort, type BridgeOpener,
} from '@dexterm/data';
import type { WalletCommand } from '../wallet-command.ts';
import type { CandleInterval } from '@dexterm/data';
import { SocialFeed, KolStore, socialDeps, chainSignalsFromToken, chainSignalsFromIntel, chainSignalToRaw, RSS_FEEDS, JUPITER_HOSTS, type BoardToken } from '@dexterm/data';
import { XSource, XApi, XOAuth, XTokenStore, XSpendMeter, type XEndpoints, type XTransport } from '@dexterm/data';
import type { ScreenerRow } from '../screener/rows.ts';
import type { Side } from '@dexterm/data';
import { TokenLive, INTERVALS, type TokenView, type TokenSeed } from './token.ts';
import { NewPairsLive, type NewPairRow, type NewPairsLiveOptions } from './newpairs.ts';
import { WatchlistLive, type WatchCandidate } from './watchlist.ts';
import { TradeTicketLive, PositionsLive, LivePositions, CombinedPositions, POSITIONS_REFRESH_MS } from './trade.ts';
import { IntelLive } from './intel.ts';
import { LiveSignalsLive, type SignalInputs } from './signals.ts';
import { CopyLive } from './copy.ts';
import type { SettledTx } from '@dexterm/tui';
import type { LiveSignal } from '@dexterm/data';

export { TokenLive, INTERVALS, panelCaption, emptyView, type TokenView, type TokenSeed, type PanelStatus } from './token.ts';
export { NewPairsLive, latencyStats, percentile, RECENT_POLL_MS, NEW_TOKENS_POLL_MS, ENRICH_POLL_MS, type NewPairRow, type NewPairsStatus, type LatencyStats } from './newpairs.ts';
export { WatchlistLive, WATCH_REFRESH_MS, type WatchViewRow, type WatchCandidate } from './watchlist.ts';
export { TradeTicketLive, PositionsLive, LivePositions, CombinedPositions, POSITIONS_REFRESH_MS } from './trade.ts';
export { IntelLive, popupBubbleVM, unavailableText, INTEL_AUTOSCAN_DELAY_MS, type IntelEntry, type IntelScanSeed } from './intel.ts';
export { LiveSignalsLive, buildObservation, SIGNALS_LOG_MAX, type SignalInputs } from './signals.ts';
export { renderTokenLive } from './screens/token-live.ts';
export { renderNewPairsLive } from './screens/newpairs-live.ts';
export { renderWatchlistLive } from './screens/watchlist-live.ts';

export type LiveMode = 'live' | 'replay';

/** task-1404: how often the open token's credit-metered wallet-intel leg (holders/bundle/sniper/fresh) is re-scanned. */
export const INTEL_RESCAN_MS = 45_000;

/** A transient one-liner for a fired live signal (⚑ SYMBOL-less; the token screen shows the full strip). */
function signalNotice(s: LiveSignal): string {
  const age = s.dataAgeMs >= 1000 ? ` · ${Math.round(s.dataAgeMs / 1000)}s` : '';
  return `⚑ ${s.title}: ${s.text} (${s.source}${age})`;
}

export interface LiveContextOptions {
  mode: LiveMode;
  /** SQLite path for the watchlist (the cache's file); ':memory:' or undefined keeps it in memory. */
  dbPath?: string;
  /** RPC configuration for the status line (never the URL itself). */
  rpc?: Pick<RpcConfig, 'provider' | 'basis'>;
  now?: () => number;
  /** Recording store: the PumpPortal session is appended as a stream for --record. */
  record?: FixtureStore;
  /** Replay store: its first PumpPortal stream is replayed instead of connecting. */
  replay?: FixtureStore;
  polls?: NewPairsLiveOptions['polls'];
  /** Injectable WebSocket factory (tests). */
  ws?: WsFactory;
  interval?: CandleInterval;
  /**
   * Fast-lane WS endpoints (keyed first, keyless public fallback). When present and mode is 'live', the
   * open token + watchlist get real-time on-chain price via accountSubscribe (SPEC §3.9, task-1312).
   */
  fastEndpoints?: FastLaneEndpoint[];
  /** Optional diagnostic sink (--verbose): the fast-lane subscription/lane status, throttled. */
  onLog?: (line: string) => void;
  /** Pinned `allowed_signers` file for KOL pack signatures (task-1330); absent = packs are at most unsigned. */
  allowedSigners?: string;
  /**
   * Login with X (task-1357): the poller runs in live mode whenever tokens exist in ~/.dexterm/x (or the
   * injected store). Tests inject the mock server's endpoints + a store under a temp dir; `off` disables it.
   */
  x?: { store?: XTokenStore; endpoints?: XEndpoints; transport?: XTransport; env?: NodeJS.ProcessEnv; off?: boolean; tokenPollMs?: number; kolPollMs?: number };
  /**
   * LIVE trading (task-1328): the argv the signer PROCESS is started with (the user's caps flags,
   * forwarded once) and, for tests, a factory for the signer port / the bridge opener / file paths.
   * Absent `trade` = paper only.
   */
  /** task-1360 copy trading: test seams for the follow store path and a scripted history source. */
  copy?: { followsPath?: string | null; env?: NodeJS.ProcessEnv; history?: import('@dexterm/data/copy').HistorySource | null; pollMs?: number };
  trade?: {
    signerArgv?: string[];
    createSigner?: () => SignerPort;
    open?: BridgeOpener;
    paths?: { liveLedger?: string; link?: string; panic?: string; capLedger?: string };
  };
}

export class LiveContext {
  readonly dl: DataLayer;
  readonly mode: LiveMode;
  readonly rpc: Pick<RpcConfig, 'provider' | 'basis'>;
  readonly credits: CreditMeter | null;
  readonly newpairs: NewPairsLive;
  readonly watch: WatchlistLive;
  /** PAPER trading (task-1310): the simulated wallet, its executor and the two screens' bindings. */
  readonly wallet: PaperWallet;
  /** The linked (non-custodial) wallet pubkey, or null. Shown in the status bar (T1). */
  linkedWallet: LinkedWallet | null = null;
  readonly executor: TradeExecutor;
  readonly positions: PositionsLive;
  /** LIVE positions from the signer's ledger file (read-only); null when live trading is off for this run. */
  readonly livePositions: LivePositions | null;
  /** Paper + live behind the task-1323 PositionSource (token screen row, popup chart). */
  readonly positionSource: CombinedPositions;
  /** The signer process handle once started (lazily, on the first LIVE action). Never respawned. */
  signer: SignerPort | null = null;
  private signerFailed: string | null = null;
  private readonly trade: NonNullable<LiveContextOptions['trade']> | null;
  private readonly linkStore: WalletLinkStore;
  ticket: TradeTicketLive | null = null;
  /** Fast lane (on-chain price push) for the open token + watchlist; null in replay/when no endpoints. */
  readonly fastLane: FastLane | null;
  /** task-1330 keyless social layer: venues + news + posts, and the KOL lists behind the credibility tiers. */
  readonly social: SocialFeed;
  readonly kol: KolStore;
  /** task-1357 Login with X: the user-context poller (null in replay / when off). Status via social.xStatus(). */
  readonly x: XSource | null;
  /** Set by the UI loop: the screener's current rows (symbol ↔ mint for news matching + squat rules). */
  boardSource: (() => readonly BoardToken[]) | null = null;
  token: TokenLive | null = null;
  /** task-1340 wallet intel: the holder scan per mint (light on open, deep for watched coins) behind the bubble map. */
  readonly intel: IntelLive;
  /** task-1404 LIVE holder/rug signals: turns the open token's repeated holder/safety reads into signal events. */
  readonly signals: LiveSignalsLive;
  /** task-1360 copy trading Tier 1: the follow store + wallet tracker (alerts on a followed wallet's buys/sells). */
  readonly copy: CopyLive;
  /**
   * task-1340 trade moments: set by the UI loop; the ticket calls it once per SETTLED outcome (paper fill, live
   * fill, refusal, failure) and never for a quote, plan or in-flight send. Effects + sound hang off this only.
   */
  onSettled: (tx: SettledTx) => void = () => {};
  /**
   * History recorder (task-1329): attached by main.ts in live mode when enabled; closed with the context.
   * Typed structurally so this package does not import @dexterm/recorder (the CLI package owns the wiring).
   */
  recorder: { maintain(deps: { dexscreener: DataLayer['dexscreener']; limiter: DataLayer['limiter'] }): Promise<unknown>; close(): void; readonly database?: import('node:sqlite').DatabaseSync; recordCreator?(mint: string, creator: string, source: string, now?: number, createdAt?: number | null): boolean } | null = null;
  /** Transient one-liner for screens that have no notice slot of their own; cleared on the next key. */
  notice: string | null = null;
  /** Set by the UI loop: called whenever a binding changed something worth drawing. */
  onChange: (reason: string) => void = () => {};
  private readonly client: PumpPortalClient;
  private readonly stream: StreamRecording | null;
  private readonly watchStore: WatchlistStore;
  private readonly now: () => number;
  private readonly interval: CandleInterval;
  private started = false;
  private fastLaneStarted = false;
  private closed = false;
  /** task-1401: true once close() ran (an async coin-link resolution must not open a token after quit). */
  get isClosed(): boolean { return this.closed; }
  /** Latest SOL/USD, fed from the screener feed each refresh; the fast lane turns on-chain SOL into USD. */
  private solUsd: number | null = null;
  private lastSolFetch = 0;
  private readonly onLog?: (line: string) => void;
  private lastFastLogAt = 0;
  private lastFastLog = '';
  /** task-1404: last time the open token's wallet-intel leg was re-scanned (slow cadence; see refreshOpenIntel). */
  private lastIntelRescanAt = 0;

  constructor(dl: DataLayer, opts: LiveContextOptions) {
    this.dl = dl;
    this.mode = opts.mode;
    this.rpc = opts.rpc ?? { provider: 'public', basis: 'public mainnet (no key)' };
    this.credits = dl.credits;
    this.now = opts.now ?? (() => Date.now());
    this.interval = opts.interval ?? '1h';
    const emit = (reason: string) => { if (!this.closed) this.onChange(reason); };
    this.newpairs = new NewPairsLive(dl, { now: this.now, onChange: (r) => emit(`newpairs:${r}`), polls: opts.polls });
    let record: StreamRecording | undefined;
    if (opts.record) {
      record = { url: PUMPPORTAL_WS, startedAt: new Date(this.now()).toISOString(), sent: [], messages: [] };
      opts.record.streams.push(record);
    }
    this.stream = opts.replay?.streams[0] ?? null;
    this.client = new PumpPortalClient({
      health: dl.health,
      clock: dl.clock,
      record,
      ws: opts.mode === 'replay' ? () => { throw new Error('replay mode never connects'); } : opts.ws,
      onEvent: (ev) => this.newpairs.handleEvent(ev),
      onStatus: () => emit('newpairs:status'),
    });
    this.newpairs.attach(this.client, opts.mode);
    this.watchStore = new WatchlistStore({ path: opts.dbPath, clock: dl.clock });
    this.watch = new WatchlistLive(dl, this.watchStore, { now: this.now, onChange: () => emit('watch') });
    // Fast lane: live-only, needs at least one WS endpoint. Price USD comes from the SOL/USD this
    // context is fed each refresh. A price push just re-renders (coalesced; calm mode skips it, §3.9).
    this.fastLane = opts.mode === 'live' && opts.fastEndpoints && opts.fastEndpoints.length > 0
      ? new FastLane({
        rpcPool: dl.rpcPool,
        health: dl.health,
        clock: dl.clock,
        credits: dl.credits,
        endpoints: opts.fastEndpoints,
        solUsd: () => this.solUsd,
        ws: opts.ws,
        onPrice: (_p: PricePoint) => { this.observeSignals(); emit('fastprice'); },
        onStatus: () => { emit('fastlane:status'); this.logFast(); },
      })
      : null;
    this.onLog = opts.onLog;
    // task-1330: KOL lists persist in the shared cache DB; the social feed runs the keyless venues + RSS in live
    // mode, and in replay mode only when the recording actually carries those routes (else they stay off and
    // the board says so — never a fixture miss on screen).
    this.kol = new KolStore({ cache: dl.cache, clock: dl.clock, allowedSigners: opts.allowedSigners ?? null });
    const deps = socialDeps(dl);
    const has = (url: string): boolean => !!opts.replay?.find({ method: 'GET', url });
    const venues = opts.mode === 'live' || has(`${JUPITER_HOSTS[0]}/tokens/v2/toptrending/1h`) ? deps.venues : null;
    const news = opts.mode === 'live' || has(RSS_FEEDS[0].url) ? deps.news : null;
    this.social = new SocialFeed({ clock: dl.clock, now: this.now, kol: this.kol, venues, news, board: () => this.boardSource?.() ?? [], onChange: (r) => emit(r) });
    // task-1357: X reads only through the user's own login. The poller exists in live mode; it stays `logged-out`
    // (and costs nothing) until ~/.dexterm/x/tokens.json exists, and degrades visibly on 401/429/403/budget.
    if (opts.mode === 'live' && !opts.x?.off) {
      const env = opts.x?.env ?? process.env;
      const store = opts.x?.store ?? new XTokenStore({ env });
      const oauth = new XOAuth({ store, endpoints: opts.x?.endpoints, transport: opts.x?.transport, now: this.now });
      const spend = new XSpendMeter({ cache: dl.cache, now: this.now, env });
      const api = new XApi({ oauth, endpoints: opts.x?.endpoints, transport: opts.x?.transport, limiter: dl.limiter, health: dl.health, cache: dl.cache, spend, clock: dl.clock, env, onRequest: (r) => this.onLog?.(`  x-api          ${r.cached ? 'hit' : r.status === null ? 'ERR' : String(r.status).padStart(3)} ${String(r.latencyMs).padStart(5)}ms ${r.endpoint}`) });
      this.x = new XSource({ api, store, kol: this.kol, now: this.now, board: () => this.boardSource?.() ?? [], tokenPollMs: opts.x?.tokenPollMs, kolPollMs: opts.x?.kolPollMs, onChange: (r) => emit(r), onLog: (l) => this.onLog?.(`  ${l}`) });
      this.social.attachX(this.x);
    } else {
      this.x = null;
    }
    // PAPER wallet: same DB file as the cache/watchlist (one --db controls everything). Simulated only.
    this.wallet = new PaperWallet({ path: opts.dbPath, clock: dl.clock });
    // T1: the linked wallet (pubkey only) for the status bar. Re-read by /wallet link|unlink.
    this.trade = opts.trade ?? null;
    this.linkStore = new WalletLinkStore(this.trade?.paths?.link ?? defaultLinkPath());
    this.linkedWallet = this.linkStore.get();
    this.executor = new PaperExecutor(this.wallet, { clock: dl.clock });
    this.positions = new PositionsLive(dl, this.wallet, { now: this.now, onChange: () => emit('positions') });
    // task-1328: live positions read the signer's ledger file (read-only). Present whenever live trading
    // is configured for the run, so a position booked by a previous run shows even before the signer starts.
    this.livePositions = this.trade
      ? new LivePositions(this.trade.paths?.liveLedger ?? defaultLiveLedgerPath(), { now: this.now, mark: (m) => this.positions.markOf(m), solUsd: () => this.positions.solUsd() ?? this.solUsd })
      : null;
    this.positionSource = new CombinedPositions(this.positions, this.livePositions);
    this.intel = new IntelLive(dl, { now: this.now, onChange: () => { this.syncIntelRows(); this.observeSignals(); emit('intel'); }, isWatched: (mint) => this.watch.has(mint) });
    // task-1404: the live holder/rug signals engine. A fired signal sets a transient notice and redraws; the
    // token screen shows the recent signals, and the rules engine reads `signals.fields()` so each is an alert trigger.
    this.signals = new LiveSignalsLive({ now: this.now, onSignal: (s) => { this.notice = signalNotice(s); emit('signals'); } });
    // task-1360: followed wallets are polled only in a real live run (replay never spends credits); the store is always readable.
    this.copy = new CopyLive(opts.mode === 'live' ? dl : null, { onChange: (r) => emit(r), solUsd: () => this.solUsd, env: opts.copy?.env, followsPath: opts.copy?.followsPath, history: opts.copy?.history, pollMs: opts.copy?.pollMs });
  }

  /** Open a trade ticket (PAPER by default; `L` flips it LIVE when a wallet is linked). Replaces any open ticket. */
  openTicket(seed: { mint: string; symbol: string; name?: string; decimals?: number }, side: Side, mode: 'paper' | 'live' = 'paper'): TradeTicketLive {
    const live = this.trade ? {
      signer: () => this.ensureSigner(),
      linked: () => this.linkedWallet,
      onFill: () => { this.livePositions?.invalidate(); this.onChange('positions'); },
    } : undefined;
    const t = new TradeTicketLive(this.dl, this.wallet, this.executor, { mint: seed.mint, symbol: seed.symbol, decimals: seed.decimals, side, mode: 'paper' }, {
      now: this.now, onChange: () => this.onChange('ticket'), live, onSettled: (tx) => this.onSettled(tx),
      livePositionRaw: (mint) => { const p = this.livePositions?.positions().find((x) => x.mint === mint); return p?.tokensRaw ?? 0n; },
    });
    this.ticket = t;
    if (mode === 'live') t.setMode('live');
    return t;
  }

  /**
   * The signer process (task-1328), started on first use with the run's caps argv. A signer that
   * failed to start or died is never respawned: LIVE stays off until trenchscope restarts (fail closed).
   */
  ensureSigner(): SignerPort | null {
    if (!this.trade || this.signerFailed) return this.signer;
    if (!this.signer) {
      try {
        this.signer = this.trade.createSigner ? this.trade.createSigner() : new SignerClient({ argv: this.trade.signerArgv ?? [], log: this.onLog ? (l) => this.onLog?.(`  signer        ${l}\n`) : undefined });
      } catch (e) {
        this.signerFailed = e instanceof Error ? e.message : String(e);
        return null;
      }
    }
    return this.signer;
  }

  /** `/wallet …` typed in the app (task-1328). Returns the line to show. */
  async walletCommand(cmd: WalletCommand): Promise<string> {
    const paths = this.trade?.paths ?? {};
    switch (cmd) {
      case 'status': {
        const linked = this.linkedWallet ? `linked: ${shortPubkey(this.linkedWallet.publicKey)}` : 'no wallet linked (/wallet link)';
        const ks = new KillSwitch(paths.panic ?? defaultPanicPath()).engaged();
        const s = this.signer?.alive ? await this.signer.status().catch(() => null) : null;
        if (s) {
          const caps = s.caps;
          return `${linked} · signer ${s.network.toUpperCase()} (${s.rpcHost}) · $${caps.perTradeUsd}/trade $${caps.dailyUsd}/day · spent $${s.spentTodayUsd.toFixed(2)}${s.panic || s.ledgerLocked ? ' · ⛔ PANICKED' : ''}`;
        }
        return `${linked} · signer ${this.signer ? (this.signerFailed ?? 'stopped') : 'not started (starts on the first LIVE plan)'}${ks ? ' · ⛔ PANICKED' : ''}${this.trade ? '' : ' · live trading off in this run'}`;
      }
      case 'link': {
        if (!this.trade) return 'live trading is off in this run';
        const bridge = new WalletBridge(this.trade.open ? { open: this.trade.open } : {});
        try {
          const res = await bridge.link();
          const rec = this.linkStore.set(res.publicKey, { network: 'devnet' });
          this.linkedWallet = rec;
          this.onChange('wallet');
          return `linked: ${shortPubkey(rec.publicKey)} (public key only) · L on a ticket for LIVE`;
        } catch (e) {
          return `wallet link failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      case 'unlink': {
        const had = this.linkStore.clear();
        this.linkedWallet = null;
        if (this.ticket?.ticket.mode === 'live') this.ticket.setMode('paper');
        this.onChange('wallet');
        return had ? 'unlinked' : 'no wallet was linked';
      }
      case 'panic': {
        // Local first (the kill-switch FILE every signer re-reads + the shared ledger lock), then the signer.
        const ks = new KillSwitch(paths.panic ?? defaultPanicPath());
        ks.engage('panic from trenchscope UI', this.now());
        try { const l = new CapLedger({ path: paths.capLedger ?? defaultCapLedgerPath(), clock: this.dl.clock }); try { l.lock('panic from trenchscope UI', this.now()); } finally { l.close(); } } catch { /* the file alone disables trading */ }
        if (this.signer?.alive) await this.signer.panic('panic from trenchscope UI').catch(() => {});
        if (this.ticket?.ticket.mode === 'live') { this.ticket.ticket.phase = 'refused'; this.ticket.ticket.message = '⛔ PANIC — live signing disabled'; }
        this.onChange('wallet');
        return '⛔ PANIC: live signing disabled everywhere · re-enable only from a shell: trenchscope wallet resume';
      }
      case 'probe': {
        if (!this.trade) return 'live trading is off in this run';
        const t = this.openTicket({ mint: this.WSOL, symbol: 'SOL', decimals: 9 }, 'buy');
        const why = t.startProbe();
        return why ?? 'devnet probe: review the plan, then Y to sign the wrap-and-unwrap in Phantom (fees only)';
      }
    }
    return '';
  }

  /** Throttled fast-lane status line for --verbose (so measure.py can report the subscription count). */
  private logFast(): void {
    if (!this.onLog || !this.fastLane) return;
    const s = this.fastLane.status();
    const line = `  fastlane      subs=${s.subscriptions} tracked=${s.tracked} live=${s.live} state=${s.wsState} ep=${s.endpoint}${s.keyed ? ' (keyed)' : ''}`;
    const now = this.now();
    if (line === this.lastFastLog && now - this.lastFastLogAt < 15_000) return; // only on change or every 15 s
    this.lastFastLog = line;
    this.lastFastLogAt = now;
    this.onLog(`${line}\n`);
  }

  /** Feed the latest SOL/USD to the new-pairs mcap math and the fast lane's USD conversion. */
  setSolPrice(price: number | null | undefined): void {
    this.newpairs.setSolPrice(price);
    if (typeof price === 'number' && Number.isFinite(price)) { this.solUsd = price; return; }
    // The screener pool need not carry wrapped SOL (e.g. the trench preset hides it), so the fast lane
    // has no USD rate. Fetch SOL/USD ourselves, keyless and cached, at most ~1/min (SPEC §3.9, task-1312).
    if (this.fastLane) void this.ensureSolUsd();
  }

  private readonly WSOL = 'So11111111111111111111111111111111111111112';
  private async ensureSolUsd(): Promise<void> {
    const now = this.now();
    if (this.solUsd !== null && now - this.lastSolFetch < 60_000) return;
    if (now - this.lastSolFetch < 15_000) return; // debounce
    this.lastSolFetch = now;
    try {
      const p = (await this.dl.jupiter.price([this.WSOL])).get(this.WSOL)?.usdPrice;
      if (typeof p === 'number' && Number.isFinite(p) && !this.closed) { this.solUsd = p; this.onChange('fastprice'); }
    } catch { /* keep the last value */ }
  }

  /** The fast set = the open token first, then the watchlist (the fast lane caps and drops the rest). */
  syncFastSet(): void {
    if (!this.fastLane) return;
    const mints: string[] = [];
    if (this.token) mints.push(this.token.mint);
    for (const e of this.watchStore.list()) if (!mints.includes(e.mint)) mints.push(e.mint);
    this.fastLane.setTracked(mints);
  }

  /** Honest per-row/panel badge for a mint: LIVE when the fast lane is actually streaming it, else POLL. */
  badgeFor(mint: string): 'LIVE' | 'POLL' {
    return this.fastLane?.badgeFor(mint) ?? 'POLL';
  }

  laneFor(mint: string): Lane {
    return this.fastLane?.laneFor(mint) ?? 'slow';
  }

  /** Latest fast-lane USD price for a mint (used in place of the polled price while LIVE), or null. */
  livePrice(mint: string): number | null {
    return this.fastLane?.priceUsd(mint) ?? null;
  }

  /** Start the push feed (live) or replay the recorded stream (replay). Idempotent. */
  startFeed(speed = 0): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    if (this.mode === 'replay') {
      if (!this.stream) return Promise.resolve();
      return this.newpairs.replay(this.stream, speed).then(() => undefined);
    }
    this.newpairs.start();
    this.startFastLane();
    return Promise.resolve();
  }

  /**
   * Start just the on-chain fast lane (open token + watchlist real-time price). Idempotent and
   * live-only. Decoupled from the new-pairs PumpPortal stream (task-1319): the fast lane must run for
   * `--preset trending` and `--mint` launches and on the token screen, not only the live-stream
   * presets (trench/new/all). It is push-only and subscribes to nothing until a token or watchlist
   * exists, so starting it early costs one idle WS and no HTTP.
   */
  startFastLane(): void {
    if (this.mode !== 'live' || !this.fastLane || this.fastLaneStarted) return;
    this.fastLaneStarted = true;
    this.fastLane.start();
    this.syncFastSet();
  }

  get feedStarted(): boolean {
    return this.started;
  }

  /** True once the on-chain fast lane has been started (independent of the push stream). */
  get fastLaneRunning(): boolean {
    return this.fastLaneStarted;
  }

  /** Open a token: a fresh loader, first load kicked off; the view is readable immediately (row fields). */
  openToken(row: TokenSeed): TokenLive {
    const t = new TokenLive(this.dl, row, { interval: this.token?.view.interval ?? this.interval, now: this.now, onChange: () => { this.syncChainRows(t); this.observeSignals(); this.onChange('token'); } });
    this.token = t;
    this.syncFastSet(); // promote the opened token to the fast lane (slow→fast, no seam)
    this.x?.setFocus({ mint: row.mint, symbol: row.symbol }); // task-1357: the open token's X search (60 s, cached 15 min)
    void t.load();
    // task-1340: a light wallet-intel scan follows the open after a short delay (flipping through tokens spends nothing)
    if (this.mode === 'live') this.intel.autoscanLater({ mint: row.mint, symbol: row.symbol, name: row.name, holderCount: row.holders ?? null });
    return t;
  }

  /**
   * task-1330: rule-derived on-chain rows for the open token (labelled holders, tracked-wallet buys, large
   * trades) become `platform: 'chain'` posts in the social feed. Idempotent per signal id; cheap (≤ 12 rows).
   */
  private syncChainRows(t: TokenLive): void {
    if (this.closed) return;
    const v = t.view;
    if (!v.holdersTop.length && !v.trades.length) return;
    const kolWallets = new Set<string>();
    for (const l of this.kol.all()) if (l.enabled) for (const w of l.wallets) kolWallets.add(w.toLowerCase());
    const now = this.now();
    const sigs = chainSignalsFromToken({ mint: v.mint, holders: v.holdersTop.map((h) => ({ address: h.address, pct: h.pct, label: h.label })), trades: v.trades, kolWallets, now });
    if (sigs.length) this.social.ingest(sigs.map((s) => chainSignalToRaw(s, now)));
  }

  /**
   * task-1359: a settled wallet-intel scan of the open token becomes rule-written `platform: 'chain'` rows in the
   * SOCIAL panel: its linked clusters (R1 funder / R2 bundle / R3 transfer / R4 dev-linked) and the launch-window
   * snipers. One id per scan (the scan's fetch time), so a cached re-read never duplicates a row.
   */
  private syncIntelRows(): void {
    if (this.closed || !this.token) return;
    const mint = this.token.view.mint;
    const r = this.intel.entry(mint)?.result;
    if (!r || r.state !== 'ok') return;
    const I = r.analysis.insights;
    const sigs = chainSignalsFromIntel({ mint, clusters: r.analysis.clusters, snipers: I.coverage.launchTxs > 0 ? I.snipers : null, t: r.fetchedAt });
    if (sigs.length) this.social.ingest(sigs.map((s) => chainSignalToRaw(s, this.now())));
  }

  /** The current inputs for the live-signals engine: the open token's view + its settled intel scan + fast-lane curve. */
  private signalInputs(): SignalInputs | null {
    if (!this.token) return null;
    const mint = this.token.view.mint;
    const result = this.intel.entry(mint)?.result;
    const ok = result && result.state === 'ok' ? result : null;
    return {
      view: this.token.view,
      intel: ok ? { analysis: ok.analysis, fetchedAt: ok.fetchedAt, via: ok.via.history ? 'helius' : ok.via.holders } : null,
      curve: this.fastLane?.curve(mint) ?? null,
    };
  }

  /**
   * task-1404: feed one moment of the open token's holder/rug state to the live-signals engine. Called whenever the
   * token, the intel scan or a fast-lane push changed something; the engine only emits on a real threshold-crossing
   * change, so this is cheap to call on every redraw. Nothing fires until a second observation of the same field.
   */
  private observeSignals(): void {
    if (this.closed) return;
    const inputs = this.signalInputs();
    if (inputs) this.signals.observe(inputs);
  }

  /**
   * task-1404: re-run the open token's wallet-intel scan on a slow cadence so holder/concentration/bundle/sniper
   * signals stay LIVE, not computed once on open. Gated: live mode, the history leg can actually run (else a scan
   * would only spend public-RPC calls to still print a dash), not already in flight, and at most once per
   * INTEL_RESCAN_MS. The cheap on-chain reads (authorities, LP, liq, price) already refresh with token.load()
   * every 10 s and bonding streams sub-second; this covers the credit-metered Helius leg.
   */
  refreshOpenIntel(now: number): void {
    if (this.mode !== 'live' || !this.token) return;
    if (now - this.lastIntelRescanAt < INTEL_RESCAN_MS) return;
    if (!this.intel.historyAvailable().ok) return;
    const v = this.token.view;
    if (this.intel.entry(v.mint)?.state === 'loading') return;
    this.lastIntelRescanAt = now;
    void this.intel.scan({ mint: v.mint, symbol: v.symbol, name: v.name, holderCount: v.holders ?? null }, { force: true }).catch(() => {});
  }

  /** The token screen's `1`..`6` keys. */
  setTimeframe(n: number): void {
    const iv = INTERVALS[n - 1];
    if (iv && this.token) void this.token.setInterval(iv);
  }

  /** Candidate for the watchlist from whatever row the user is on. */
  static candidate(r: ScreenerRow | NewPairRow | TokenView): WatchCandidate {
    return { mint: r.mint, symbol: r.symbol, name: r.name, launchpad: r.launchpad, price: r.price ?? null, liq: 'liq' in r ? r.liq : null, mcap: r.mcap ?? null };
  }

  /**
   * AI scan mode's analyst meter (task-1324): analyst turns the scan started in the rolling hour vs its
   * cap, and for the locked coin. Set by the UI loop on every scan tick while the scan is on; null = off.
   */
  scanMeter: { hour: number; hourCap: number; coin: number; coinCap: number; locked: boolean } | null = null;

  /** `ai 2/8 per h · coin 1/4` while the scan is on, else null. */
  scanMeterLabel(): string | null {
    const m = this.scanMeter;
    if (!m) return null;
    return `ai ${m.hour}/${m.hourCap} per h${m.locked ? ` · coin ${m.coin}/${m.coinCap}` : ''}`;
  }

  /**
   * The header's meter status (task-1324): the scan indicator + its analyst meter alongside the Helius
   * credit meter. Without a running scan this is exactly creditsStatus().
   */
  meterStatus(scanIndicator?: string): string | undefined {
    const credits = this.creditsStatus();
    const ai = this.scanMeterLabel();
    if (!ai) return credits;
    return [scanIndicator, ai, credits].filter((x): x is string => !!x).join(' · ');
  }

  /** Header status fragments: credits warning first, then whatever the screen's feed says. */
  creditsStatus(): string | undefined {
    const s = this.credits?.status();
    if (!s) return undefined;
    if (s.level === 'degraded') return s.runCapHit ? '◐ helius run cap hit · keyless' : `◐ helius credits ${Math.round(s.dayPct * 100)}% · keyless`;
    if (s.level === 'warn') return `◐ helius credits ${Math.round(s.dayPct * 100)}%`;
    return undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.client.stop(); } catch { /* ignore */ }
    try { this.fastLane?.stop(); } catch { /* ignore */ }
    try { this.watchStore.close(); } catch { /* ignore */ }
    try { this.wallet.close(); } catch { /* ignore */ }
    try { this.recorder?.close(); } catch { /* ignore */ }
    try { this.social.close(); } catch { /* ignore */ }
    try { this.signer?.close(); } catch { /* ignore */ }
    try { this.intel.close(); } catch { /* ignore */ }
    try { this.copy.stop(); } catch { /* ignore */ }
  }
}
