// @dexterm/data public surface. Lane B (D-02) owns this package; the shared model
// types were agreed on day 1 (D-01) and live in ./model.ts.
export * from './model.ts';
export * from './clock.ts';
export * from './limiter.ts';
export * from './health.ts';
export * from './cache.ts';
export * from './http.ts';
export * from './fixtures.ts';
export * from './store.ts';
export * from './sources/dexscreener.ts';
export * from './sources/jupiter.ts';
export * from './sources/jupiter-swap.ts';
export * from './sources/geckoterminal.ts';
export * from './sources/solana-rpc.ts';
export * from './sources/rugcheck.ts';
export * from './sources/goplus.ts';
export * from './sources/solanatracker.ts';
export * from './tracker-config.ts';
export * from './shrine-config.ts';
export * from './sources/shrine-socket.ts';
export * from './sources/shrine.ts';
export * from './sources/pumpportal.ts';
export * from './sources/solana-ws.ts';
export * from './sources/pump-curve.ts';
export * from './sources/pda.ts';
export * from './fast-lane.ts';
export * from './candles.ts';
export * from './detail.ts';
export * from './rpc-config.ts';
export * from './rpc-pool.ts';
export * from './credits.ts';
export * from './budget.ts';
export * from './watchlist.ts';
export * from './paper.ts';
export * from './trade/caps.ts';
export * from './trade/bridge.ts';
export * from './trade/swap-build.ts';
export * from './trade/rpc-exec.ts';
export * from './trade/executor.ts';
export * from './trade/link-store.ts';
export * from './trade/tx-decode.ts';
export * from './trade/sol-usd.ts';
export * from './trade/kill-switch.ts';
export * from './trade/token-delta.ts';
// task-1443: the paper agent desk + its rendezvous (agents paper-trade inside an armed mandate; never sign/send).
export * from './trade/agent/paper-desk.ts';
export * from './trade/agent/rendezvous.ts';
export * from './trade/signer/protocol.ts';
export * from './trade/signer/service.ts';
export * from './trade/signer/host.ts';
export * from './trade/signer/client.ts';
export * from './trade/signer/probe-builder.ts';
export * from './trade/signer/fast-wallet.ts';
export * from './trade/signer/sol-usd-feed.ts';
export { parseSignerArgs, buildSignerService, type SignerArgs } from './trade/signer/main.ts';
export * from './larp/links.ts';
export * from './larp/safe-fetch.ts';
export * from './larp/evidence.ts';
export * from './larp/link-baseline.ts';
// task-1401: parse a CA / coin link from any input (go-to, analyst chat, filter line, --mint, MCP refs).
export * from './coin-target.ts';
export * from './analyst-actions.ts';
export * from './intel/rules.ts';
export * from './intel/holder-class.ts';
export * from './intel/helius-history.ts';
export * from './intel/scan.ts';
export * from './intel/live-signals.ts';
export * from './images/index.ts';
// task-1330 (I-03): social / news / trending layer. `Provenance` and `Credibility`-style names are
// namespaced under `Social*` where they would collide with the core model.
export {
  type Platform, type AuthorTier, type PostFlag, type SocialAuthor, type PostMetrics, type RawPost, type SocialPost, type KolList, type KolListSource,
  type Credibility, type VenueSignal, type TrendRow, type Narrative, type NewsTag, type NewsItem, POST_DISPLAY_MAX, POST_STORED_MAX, BIO_MAX,
} from './social/model.ts';
export * from './social/firewall.ts';
export * from './social/dedupe.ts';
export * from './social/rank.ts';
export * from './social/kol.ts';
export * from './social/venues.ts';
export * from './social/rss.ts';
export * from './social/chain.ts';
export * from './social/summary.ts';
export * from './social/feed.ts';
// task-1357 (I-02): Login with X (OAuth2 PKCE on a loopback callback) + the user-authorized X read adapter.
export * from './x/index.ts';

// task-paper-bot: the data layer factory lives in layer.ts (trade-free; see core.ts).
export * from './layer.ts';
export { fetchPage, robotsAllows } from './larp/robots.ts';
