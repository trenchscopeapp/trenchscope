// task-1309: KEYLESS live smoke — proves every screen works with NO key configured. Run from a
// throwaway HOME so there is no ~/.dexterm/helius.key and no persisted state:
//   DEXTERM_LIVE=1 HOME=$(mktemp -d) node packages/cli/scripts/smoke-1309.ts [--ws-seconds 20]
// Hard cap MAX_REQUESTS HTTP requests, one PumpPortal WebSocket session. Prints a PASS/FAIL per feature
// and the RPC pool + per-source request budget. Every line goes through redactSecrets; the script never
// reads a key. The cap is a runaway guard, not a target: a full keyless pass legitimately fans the token
// load across the chain RPC pool + jup/goplus/gecko/rugcheck keyless fallbacks (~45 requests over the 5
// feature areas, incl. a 429→fallback RPC retry), so the old cap of 25 threw mid-run and starved the
// token candles/trades before their checks ran (task-1319). 60 keeps clear headroom over a real pass.
import { createLiveFeed } from '../src/feed.ts';
import { redactSecrets, resolveRpcUrl, extraRpcUrls, type DataLayer } from '@dexterm/data';
import { THEMES } from '@dexterm/tui';
import { makeFeedState, renderFrame } from '../src/state.ts';
import { LiveContext } from '../src/live/index.ts';

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to run the keyless smoke');
  process.exit(2);
}
const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const WS_SECONDS = Math.min(60, Math.max(5, Number(arg('--ws-seconds', '20'))));
const MAX_REQUESTS = 60; // runaway guard with headroom over a full keyless pass (~45); override with --max-req
const maxReq = Math.max(25, Number(arg('--max-req', String(MAX_REQUESTS))) || MAX_REQUESTS);
const MINT = arg('--mint', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'); // BONK
const log = (s: string) => console.log(redactSecrets(s));
const results: { feature: string; ok: boolean; detail: string }[] = [];
const check = (feature: string, ok: boolean, detail: string) => { results.push({ feature, ok, detail }); log(`  ${ok ? 'PASS' : 'FAIL'} ${feature}: ${detail}`); };

const rpc = resolveRpcUrl();
log(`rpc: ${rpc.provider} (${rpc.basis}) · extra endpoints: ${extraRpcUrls().length}`);
if (rpc.provider !== 'public') log(`  NOTE: a key/custom RPC is configured (${rpc.provider}); this run is NOT purely keyless.`);

const feed = createLiveFeed({ maxRequests: maxReq, rpcPublicPool: true, rpcExtraUrls: extraRpcUrls() });
const dl = feed.dl as DataLayer;
const ctx = new LiveContext(dl, { mode: 'live', rpc: { provider: rpc.provider, basis: rpc.basis } });
const state = makeFeedState(feed, 'live', { theme: THEMES.midnight, timeZone: null });
state.live = ctx;

// 1. screener
log('\n[screener]');
const rows = await feed.refresh();
check('screener', rows.length > 0, `${rows.length} rows from ${[...new Set(rows.map((r) => r.pair?.source).filter(Boolean))].join('+') || 'dexscreener+jupiter'}`);
state.screen = 'screener';
state.now = new Date();
check('screener render', renderFrame(state, 176, 48).toPlain().split('\n').length > 10, 'frame rendered 176×48');

// 2. token (authorities keyless via chain pool + jup/goplus; holders keyless aggregate fallback)
log('\n[token]');
const tok = ctx.openToken({ mint: MINT, symbol: MINT.slice(0, 4), name: '', launchpad: 'unknown' });
await tok.load();
const v = tok.view;
for (const [p, s] of Object.entries(v.panels)) log(`  ${p.padEnd(12)} ${s.state.padEnd(9)} ${s.via ?? '-'}${s.reason ? ` · ${s.reason}` : ''}`);
check('token authorities', v.mintAuth !== undefined, `mint/freeze ${v.mintAuth}/${v.freezeAuth} via ${v.panels.authorities.via ?? '-'}`);
const hp = v.panels.holders;
const holdersWorks = hp.state === 'ok' || v.top10 !== null || v.holders !== null;
check('token holders (keyless)', holdersWorks, `${v.holdersSample ?? '-'} · list ${v.holdersTop.length} · top10 ${v.top10 ?? '-'} · count ${v.holders ?? '-'} · via ${hp.via ?? '-'}`);
state.screen = 'token';
check('token render', renderFrame(state, 176, 48).toPlain().split('\n').length > 10, 'frame rendered 176×48');

// 3. new pairs (PumpPortal stream, keyless)
log(`\n[new pairs] listening ${WS_SECONDS}s`);
state.screen = 'newpairs';
await ctx.startFeed();
await new Promise<void>((r) => setTimeout(r, WS_SECONDS * 1000));
const st = ctx.newpairs.status();
check('new pairs', (st.stream?.creates ?? 0) > 0 || ctx.newpairs.list().length > 0, `${st.stream?.creates ?? 0} creates · ${ctx.newpairs.list().length} rows · stream ${st.stream?.state}`);
ctx.newpairs.stop();

// 4. watchlist (SQLite persistence, keyless prices)
log('\n[watchlist]');
ctx.watch.add(LiveContext.candidate(v));
await ctx.watch.refresh();
const w = ctx.watch.list()[0];
check('watchlist', !!w, `${w?.entry.symbol} now ${w?.row?.price ?? '-'} · ${ctx.watch.status().caption}`);

// pool + budget visibility
log('\n[rpc pool]');
for (const e of dl.rpcPool.status()) log(`  ${e.label.padEnd(44)} ok ${e.okCount} err ${e.errorCount} ${e.available ? 'available' : 'paused'}${e.lastError ? ` · ${e.lastError.slice(0, 40)}` : ''}`);
log('\n[request budget]');
for (const b of dl.budget.snapshot()) log(`  ${b.source.padEnd(16)} session ${b.session} · day ${b.day}${b.dayCap ? `/${b.dayCap}` : ''}`);
log(`\n[health] ${dl.health.snapshot(['solana-rpc', 'helius', 'goplus', 'geckoterminal', 'rugcheck', 'pumpportal', 'dexscreener', 'jupiter-tokens', 'jupiter-price']).map((h) => `${h.source}=${h.state}`).join(' · ')}`);
log(`\n${feed.requests} live HTTP requests (cap ${maxReq}) · 1 WebSocket session (${WS_SECONDS}s)`);

ctx.close();
dl.close();

const failed = results.filter((r) => !r.ok);
log(`\n${failed.length === 0 ? 'ALL KEYLESS FEATURES PASS' : `${failed.length} FAILED: ${failed.map((r) => r.feature).join(', ')}`} (${results.length} checks)`);
process.exit(failed.length === 0 ? 0 : 1);
