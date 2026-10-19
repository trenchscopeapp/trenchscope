// Opt-in live recorder for the task-1298 sources (not part of `npm test`):
//   Helius RPC mint + top-20 holders (key read in code from ~/.dexterm/helius.key, redacted in the file),
//   GoPlus token security, GeckoTerminal pool + trades, RugCheck new_tokens, DexScreener batch for the
//   PumpPortal mints, and a PumpPortal WebSocket session (free methods only, ≤ --ws-seconds, default 60).
//     DEXTERM_LIVE=1 node packages/data/scripts/record-1298.ts [--out FILE] [--mint MINT] [--ws-seconds N] [--max-requests N]
// Hard request cap (default 12), 1.5 s pacing between HTTP calls, Retry-After honoured by the limiter.
// The output never contains the key: URLs are redacted at capture and save() refuses a file that still has one.

import { fileURLToPath } from 'node:url';
import { createDataLayer } from '../src/index.ts';
import { FixtureStore, recordingTransport, type StreamRecording } from '../src/fixtures.ts';
import { liveTransport } from '../src/http.ts';
import { PumpPortalClient, PUMPPORTAL_WS } from '../src/sources/pumpportal.ts';
import { redactSecrets, resolveRpcUrl } from '../src/rpc-config.ts';

if (process.env.DEXTERM_LIVE !== '1') {
  console.error('refusing to touch the network: set DEXTERM_LIVE=1 to record');
  process.exit(2);
}

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = arg('--out', fileURLToPath(new URL('../fixtures/task-1298-sample.json', import.meta.url)));
const MINT = arg('--mint', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'); // BONK: pool + candles already in d06-sample
const WS_SECONDS = Math.min(120, Number(arg('--ws-seconds', '60')));
const MAX_REQUESTS = Number(arg('--max-requests', '12'));
const skipWs = args.includes('--no-ws');

const rpc = resolveRpcUrl();
console.error(`rpc: ${rpc.provider} via ${rpc.basis}`);
const store = new FixtureStore();
let n = 0;
const transport = recordingTransport(liveTransport(), store, {
  maxRequests: MAX_REQUESTS,
  onRequest: (seq, req, res) => { n = seq; console.error(`  req#${seq} ${String(res.status).padStart(3)} ${String(res.latencyMs).padStart(5)}ms ${redactSecrets(req.url).slice(0, 100)}${req.body ? ' ' + (JSON.parse(req.body) as { method: string }).method : ''}`); },
});
const dl = createDataLayer({ transport, rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl });

const pace = () => new Promise((r) => setTimeout(r, 1500));
async function step<T>(name: string, run: () => Promise<T>, show: (v: T) => string): Promise<T | undefined> {
  try {
    const v = await run();
    console.log(`${name.padEnd(12)} ok   ${redactSecrets(show(v))}`);
    await pace();
    return v;
  } catch (err) {
    console.log(`${name.padEnd(12)} FAIL ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    await pace();
    return undefined;
  }
}

console.log(`task-1298 live recording ${new Date().toISOString()} · mint ${MINT}`);
await step('mint', async () => (await dl.detail.mintInfo(MINT)).value, (m) => `${m.source} ${m.program} decimals ${m.decimals} mintAuth ${m.mintAuthority ?? 'revoked'} freezeAuth ${m.freezeAuthority ?? 'revoked'}`);
await step('holders', async () => (await dl.detail.holders(MINT)).value, (h) => `${h.source} ${h.holders.length} holders, top10 ${h.top10Pct}%, #1 ${h.holders[0]?.address?.slice(0, 8)} ${h.holders[0]?.pct}% ${h.holders[0]?.label ?? ''}`);
await step('goplus', async () => (await dl.detail.security(MINT)).value, (g) => `mintable ${g.mintable} freezable ${g.freezable} holders ${g.holderCount} top ${g.holders.length} lp ${g.lpHolders.length} dex ${g.dex.length} flags [${g.flags.join(',')}]`);
const pool = await step('pool', async () => (await dl.detail.topPool(MINT))!, (p) => `${p.name} ${p.dex} ${p.address}`);
if (pool) await step('trades', async () => (await dl.detail.trades(pool.address, MINT)).value, (t) => `${t.length} trades, newest ${t[0] ? new Date(t[0].t).toISOString() + ' ' + t[0].side + ' $' + t[0].usd.toFixed(0) : '-'}`);
const fresh = await step('new_tokens', () => dl.rugcheck.newTokens(), (l) => `${l.length} rows, newest ${l[0]?.mint.slice(0, 8)} creator ${l[0]?.creator?.slice(0, 8)} mintAuth ${l[0]?.mintAuthority}`);
if (credits()) console.log(`credits: ${dl.credits!.label()}`);

let mints: string[] = [];
if (!skipWs) {
  const rec: StreamRecording = { url: PUMPPORTAL_WS, startedAt: new Date().toISOString(), sent: [], messages: [] };
  const client = new PumpPortalClient({ health: dl.health, record: rec, onEvent: (ev) => { if (ev.kind === 'create') { if (mints.length < 30) mints.push(ev.create.mint); } } });
  const t0 = performance.now();
  let firstAt: number | null = null;
  const unsub = client.start;
  void unsub;
  client.start();
  const seen = () => client.getStatus();
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      const s = seen();
      if (s.messages > 0 && firstAt === null) firstAt = performance.now() - t0;
      if (performance.now() - t0 >= WS_SECONDS * 1000) { clearInterval(tick); resolve(); }
    }, 200);
  });
  client.stop();
  const s = client.getStatus();
  console.log(`pumpportal   ${s.state} attempts ${s.attempts} first msg ${firstAt === null ? '-' : Math.round(firstAt) + 'ms'} · ${s.messages} msgs (${s.creates} creates, ${s.migrations} migrations) ${s.bytes} bytes in ${WS_SECONDS}s`);
  store.streams.push(rec);
}
if (mints.length && n < MAX_REQUESTS) {
  await step('enrich', () => dl.store.enrich(mints.slice(0, 30), { price: false }), (r) => `${r.rows.length} rows, ${r.missing.length} missing`);
}
if (fresh && fresh.length && n < MAX_REQUESTS && !mints.length) {
  await step('enrich-fresh', () => dl.store.enrich(fresh.slice(0, 10).map((t) => t.mint), { price: false }), (r) => `${r.rows.length} rows, ${r.missing.length} missing`);
}

store.save(OUT, `task-1298 live sample: Helius mint+holders (key redacted), GoPlus, Gecko trades, RugCheck new_tokens, PumpPortal ${WS_SECONDS}s; ${n} HTTP requests`);
console.log(`saved ${OUT} · ${store.size} HTTP entries · ${store.streams.length} stream(s) · ${n} live requests`);
console.log('health:', dl.health.snapshot(['helius', 'solana-rpc', 'goplus', 'geckoterminal', 'rugcheck', 'pumpportal', 'dexscreener', 'jupiter-tokens']).map((h) => `${h.source}=${h.state}`).join(' · '));
dl.close();

function credits(): boolean { return !!dl.credits; }
