// Opt-in LIVE smoke for task-1404 (LIVE holder/rug signals). Not part of `npm test`. It opens a token, starts the
// on-chain fast lane (accountSubscribe on the bonding curve) and the wallet-intel scan, feeds every refresh to the
// live-signals engine, and measures the CHAIN-EVENT → ROW latency: the time from an on-chain account push arriving
// to the token frame being rendered with it (the same definition task-1298 uses for new pairs). Prints a p95.
//
//   DEXTERM_LIVE=1 node packages/cli/scripts/smoke-1404.ts [--mint MINT] [--ws-seconds 60] [--discover 20] [--db PATH]
//
// With no --mint it discovers a fresh pre-migration pump.fun token from the PumpPortal stream so there is a live
// bonding curve to stream. The Helius key is read in code (resolveRpcUrl) and never printed; every line is redacted.
import { createDataLayer, liveTransport, recordingTransport, FixtureStore, redactSecrets, resolveRpcUrl, defaultDbPath, wsUrlFor, SOLANA_PUBLIC_RPC_WS, type FastLaneEndpoint, type RpcConfig } from '@dexterm/data';
import { THEMES } from '@dexterm/tui';
import { ScreenerFeed } from '../src/feed.ts';
import { makeFeedState, renderFrame } from '../src/state.ts';
import { LiveContext, percentile } from '../src/live/index.ts';
import type { LiveSignal } from '@dexterm/data';

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to run the live smoke');
  process.exit(2);
}
const args = process.argv.slice(2);
const arg = (k: string, d: string): string => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MINT = arg('--mint', '');
const WS_SECONDS = Math.min(180, Math.max(10, Number(arg('--ws-seconds', '60'))));
const DISCOVER = Math.min(60, Math.max(5, Number(arg('--discover', '20'))));
const DB = arg('--db', ':memory:');
const MAX_REQUESTS = 60;
const log = (s: string): void => console.log(redactSecrets(s));

/** The fast-lane endpoints (keyed ws first, keyless public ws fallback) — same order main.ts builds. */
function fastLaneEndpoints(rpc: RpcConfig): FastLaneEndpoint[] {
  const out: FastLaneEndpoint[] = [];
  const primaryWs = wsUrlFor(rpc.url);
  if (primaryWs) {
    const keyed = rpc.provider === 'helius';
    out.push({ url: primaryWs, source: keyed ? 'helius-ws' : 'solana-ws', keyed, label: keyed ? 'Helius ws (free key)' : rpc.provider === 'custom' ? 'custom RPC ws' : 'public RPC ws' });
  }
  if (!out.some((e) => e.url === SOLANA_PUBLIC_RPC_WS)) out.push({ url: SOLANA_PUBLIC_RPC_WS, source: 'solana-ws', keyed: false, label: 'public RPC ws' });
  return out;
}

const rpc = resolveRpcUrl();
log(`rpc: ${rpc.provider} (${rpc.basis}) · db ${DB === ':memory:' ? 'in-memory' : DB}${DB === ':memory:' ? ` · default would be ${defaultDbPath()}` : ''}`);
let requests = 0;
const store = new FixtureStore();
const transport = recordingTransport(liveTransport(), store, {
  maxRequests: MAX_REQUESTS,
  onRequest: (seq) => { requests = seq; },
});
const dl = createDataLayer({ transport, rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl, dbPath: DB === ':memory:' ? undefined : DB });
const feed = new ScreenerFeed(dl);
const ctx = new LiveContext(dl, { mode: 'live', rpc: { provider: rpc.provider, basis: rpc.basis }, fastEndpoints: fastLaneEndpoints(rpc) });
const state = makeFeedState(feed, 'live', { theme: THEMES.midnight, timeZone: null });
state.live = ctx;

// --- discover a live pre-migration pump.fun mint if none was given.
let mint = MINT;
if (!mint) {
  log(`\n[discover] listening to PumpPortal up to ${DISCOVER}s for a fresh pump.fun launch…`);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, DISCOVER * 1000);
    ctx.onChange = (reason) => {
      if (!reason.startsWith('newpairs')) return;
      const row = ctx.newpairs.list().find((r) => r.launchpad === 'pump.fun' && !r.migrated && r.mint.endsWith('pump'));
      if (row) { mint = row.mint; clearTimeout(timer); resolve(); }
    };
    void ctx.startFeed();
  });
  ctx.newpairs.stop();
  ctx.onChange = () => {};
  if (!mint) { log('  no live pump.fun launch seen; pass --mint to measure a specific token.'); ctx.close(); dl.close(); process.exit(1); }
}
log(`[token] ${mint}`);

// --- open the token, start the fast lane, measure chain-event → row latency per on-chain push.
const tok = ctx.openToken({ mint, symbol: mint.slice(0, 4), name: '', launchpad: 'pump.fun' });
await tok.load();
ctx.startFastLane();
state.screen = 'token';

const rowLat: number[] = [];
const seenSignals: LiveSignal[] = [];
let frames = 0;
let lastPushT = 0;
const origOnSignal = ctx.signals;
// capture every signal the engine emits (the binding already logs them; mirror for the summary)
const drainSignals = (): void => { for (const s of ctx.signals.emitted) if (!seenSignals.includes(s)) seenSignals.push(s); };

ctx.onChange = (reason) => {
  if (reason === 'fastprice') {
    const p = ctx.fastLane?.price(mint);
    if (p && p.t !== lastPushT) { // a real on-chain push (its receivedAt is p.t)
      lastPushT = p.t;
      state.now = new Date();
      renderFrame(state, 176, 48);
      frames++;
      rowLat.push(Math.max(0, Date.now() - p.t));
    }
  }
  drainSignals();
};
void origOnSignal;

log(`  streaming the bonding curve for ${WS_SECONDS}s (fast lane: ${ctx.fastLane?.status().endpoint ?? 'none'})…`);
// Mirror the interactive loop: refresh the token (market/authorities/holders/lp, 10s) and re-scan the
// credit-metered wallet-intel leg (refreshOpenIntel, ~45s) so the live fields stay fresh, not on-open-only.
const deadline = Date.now() + WS_SECONDS * 1000;
let lastLoad = Date.now();
await new Promise<void>((resolve) => {
  const iv = setInterval(() => {
    const nowMs = Date.now();
    if (nowMs >= deadline) { clearInterval(iv); resolve(); return; }
    if (nowMs - lastLoad >= 10_000) { lastLoad = nowMs; void tok.load(); }
    ctx.refreshOpenIntel(nowMs);
    drainSignals();
  }, 1000);
});
drainSignals();

const v = tok.view;
const fl = ctx.fastLane?.status();
log(`\n[fast lane] endpoint ${fl?.endpoint} keyed=${fl?.keyed} state=${fl?.wsState} subs=${fl?.subscriptions} live=${fl?.live} badge=${ctx.badgeFor(mint)}`);
log(`[latency] chain event → row  n=${rowLat.length} p50 ${percentile(rowLat, 50) ?? '-'}ms p95 ${percentile(rowLat, 95) ?? '-'}ms max ${rowLat.length ? Math.max(...rowLat) : '-'}ms (${frames} frames rendered at 176×48)`);

const snap = ctx.signals.snapshot(mint, Date.now());
log('\n[live fields] (value · source · age · stale)');
for (const [k, s] of Object.entries(snap)) {
  if (s.value === null) continue;
  log(`  ${k.padEnd(10)} ${String(s.value).padEnd(10)} ${(s.source ?? '-').padEnd(14)} ${s.ageMs === null ? '-' : `${Math.round(s.ageMs / 1000)}s`}${s.stale ? ' · STALE' : ''}`);
}
log(`\n[signals] ${seenSignals.length} fired this run`);
for (const s of seenSignals.slice(-12)) log(`  ⚑ ${s.kind.padEnd(14)} ${s.level.padEnd(5)} ${s.source.padEnd(13)} data-age ${Math.round(s.dataAgeMs / 1000)}s · ${s.text}`);

log(`\n[token] ${v.symbol} price ${v.price ?? '-'} mcap ${v.mcap ?? '-'} top10 ${v.top10 ?? '-'} dev ${v.dev ?? '-'} lp ${v.lpLocked ?? '-'} mint/freeze ${v.mintAuth}/${v.freezeAuth}`);
log(`\n${requests} live HTTP requests (cap ${MAX_REQUESTS}) · ${WS_SECONDS}s WebSocket`);
if (dl.credits) log(`credits: ${dl.credits.label()}`);
log('health: ' + dl.health.snapshot(['helius', 'helius-ws', 'solana-ws', 'solana-rpc', 'goplus', 'geckoterminal', 'rugcheck', 'dexscreener', 'jupiter-tokens']).map((h) => `${h.source}=${h.state}`).join(' · '));
ctx.close();
dl.close();
