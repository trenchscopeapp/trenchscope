// Opt-in LIVE smoke for the task-1298 screens (not part of `npm test`). Hard cap 25 HTTP requests
// (paced by the data layer's limiter, Retry-After honoured), one PumpPortal WebSocket session of at most
// --ws-seconds (default 45, max 120). Prints what each live screen would show and the measured latency
// from PumpPortal message receipt to (a) the row entering the table and (b) the rendered frame.
//   DEXTERM_LIVE=1 node packages/cli/scripts/smoke-1298.ts [--mint MINT] [--ws-seconds 45] [--db PATH]
// The Helius key is read in code (resolveRpcUrl) and never printed; every line goes through redactSecrets.
import { createDataLayer, liveTransport, recordingTransport, FixtureStore, redactSecrets, resolveRpcUrl, defaultDbPath } from '@dexterm/data';
import { THEMES } from '@dexterm/tui';
import { ScreenerFeed } from '../src/feed.ts';
import { makeFeedState, renderFrame } from '../src/state.ts';
import { LiveContext } from '../src/live/index.ts';

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to run the live smoke');
  process.exit(2);
}
const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MINT = arg('--mint', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const WS_SECONDS = Math.min(120, Math.max(5, Number(arg('--ws-seconds', '45'))));
const MAX_REQUESTS = 25;
const DB = arg('--db', ':memory:');
const log = (s: string) => console.log(redactSecrets(s));

const rpc = resolveRpcUrl();
log(`rpc: ${rpc.provider} (${rpc.basis}) · db ${DB === ':memory:' ? 'in-memory' : DB} · default db would be ${defaultDbPath()}`);
let requests = 0;
const store = new FixtureStore();
const transport = recordingTransport(liveTransport(), store, {
  maxRequests: MAX_REQUESTS,
  onRequest: (seq, req, res) => { requests = seq; console.error(redactSecrets(`  req#${seq} ${String(res.status).padStart(3)} ${String(res.latencyMs).padStart(5)}ms ${req.url.slice(0, 96)}${req.body ? ' ' + (JSON.parse(req.body) as { method: string }).method : ''}`)); },
});
const dl = createDataLayer({ transport, rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl, dbPath: DB === ':memory:' ? undefined : DB });
const feed = new ScreenerFeed(dl);
const ctx = new LiveContext(dl, { mode: 'live', rpc: { provider: rpc.provider, basis: rpc.basis } });
const state = makeFeedState(feed, 'live', { theme: THEMES.midnight, timeZone: null });
state.live = ctx;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

// 1. token screen on live data
log(`\n[token] ${MINT}`);
const tok = ctx.openToken({ mint: MINT, symbol: MINT.slice(0, 4), name: '', launchpad: 'unknown' });
await tok.load();
const v = tok.view;
for (const [p, st] of Object.entries(v.panels)) log(`  ${p.padEnd(12)} ${st.state.padEnd(9)} ${st.via ?? '-'}${st.reason ? ` · ${st.reason}` : ''}`);
log(`  ${v.symbol} price ${v.price ?? '-'} mcap ${v.mcap ?? '-'} holders ${v.holders ?? '-'} top10 ${v.top10 ?? '-'} holdersTop ${v.holdersTop.length} (${v.holdersSample ?? '-'}) candles ${v.candles.length} trades ${v.trades.length} rug ${v.rug?.score ?? '-'} goplus ${v.goplus ? v.goplus.flags.join(',') || 'clean' : '-'} mint/freeze ${v.mintAuth}/${v.freezeAuth}`);
state.screen = 'token';
state.now = new Date();
const tokFrame = renderFrame(state, 176, 48).toPlain();
log(`  frame ok: ${tokFrame.split('\n').length} rows · header: ${tokFrame.split('\n')[0].trim().slice(-60)}`);
if (dl.credits) log(`  credits: ${dl.credits.label()}`);

// 2. new pairs: PumpPortal session with event→row and event→frame latency
log(`\n[new pairs] listening ${WS_SECONDS}s`);
state.screen = 'newpairs';
const frameLat: number[] = [];
let frames = 0;
ctx.onChange = (reason) => {
  if (!reason.startsWith('newpairs:create')) return;
  // what the interactive loop does: render the frame, then stamp the rows as drawn
  const tr = performance.now();
  state.now = new Date();
  renderFrame(state, 176, 48);
  frames++;
  const drawn = Date.now();
  for (const r of ctx.newpairs.list()) if (r.drawnAt === null && r.receivedAt !== null) frameLat.push(drawn - r.receivedAt);
  ctx.newpairs.markDrawn(drawn);
  void tr;
};
await ctx.startFeed();
await new Promise<void>((resolve) => setTimeout(resolve, WS_SECONDS * 1000));
await ctx.newpairs.refresh(true);
const st = ctx.newpairs.status();
const p = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((q / 100) * xs.length) - 1)] : null);
log(`  stream ${st.stream?.state} · attempts ${st.stream?.attempts} · ${st.stream?.messages} msgs · ${st.stream?.creates} creates · ${st.stream?.migrations} migrations · ${st.stream?.bytes} bytes · ${st.createsPerMin}/min`);
log(`  latency event→row    n=${st.latency.n} p50 ${st.latency.p50 ?? '-'}ms p95 ${st.latency.p95 ?? '-'}ms max ${st.latency.max ?? '-'}ms`);
log(`  latency event→frame  n=${frameLat.length} p50 ${p(frameLat, 50) ?? '-'}ms p95 ${p(frameLat, 95) ?? '-'}ms max ${frameLat.length ? Math.max(...frameLat) : '-'}ms (${frames} frames rendered at 176×48)`);
log(`  caption: ${st.caption}${st.headerStatus ? ` · header ${st.headerStatus}` : ''} · errors ${JSON.stringify(st.errors)}`);
const rows = ctx.newpairs.list();
for (const r of rows.slice(0, 5)) log(`  ${r.symbol.padEnd(10)} ${r.launchpad.padEnd(8)} bonding ${r.bonding ?? '-'}% mcap ${r.mcap === null ? '-' : Math.round(r.mcap)} liq ${r.liq ?? '-'} holders ${r.holders ?? '-'} via ${r.via.join('+')}`);
ctx.newpairs.stop();

// 3. watchlist: add the token, refresh prices, proposals only
log('\n[watchlist]');
ctx.watch.add(LiveContext.candidate(v));
await ctx.watch.refresh();
const w = ctx.watch.list()[0];
log(`  ${w?.entry.symbol} entry ${w?.entry.entryPrice ?? '-'} now ${w?.row?.price ?? '-'} pnl ${w?.pnlPct?.toFixed(2) ?? '-'}% · ${ctx.watch.proposals().length} proposals · ${ctx.watch.armed().length} armed · ${ctx.watch.status().caption}`);
state.screen = 'watchlist';
renderFrame(state, 176, 48);

log(`\n${requests} live HTTP requests (cap ${MAX_REQUESTS}) · 1 WebSocket session (${WS_SECONDS}s) · ${ms()}ms total`);
if (dl.credits) log(`credits: ${dl.credits.label()}`);
log('health: ' + dl.health.snapshot(['helius', 'solana-rpc', 'goplus', 'geckoterminal', 'rugcheck', 'pumpportal', 'dexscreener', 'jupiter-tokens', 'jupiter-price']).map((h) => `${h.source}=${h.state}`).join(' · '));
ctx.close();
dl.close();
