// @dexterm/data/core: the READ-ONLY slice of the data package. The live data layer (createDataLayer), its
// keyless sources, the store/cache/health plumbing, the keyless swap QUOTE, the paper-ledger math and the
// text firewall, and nothing from trade/ (no signer, no live executor, no swap build, no rpc send, no bridge).
// The full barrel (index.ts) re-exports all of this too; this entry exists so a paper-only consumer (the
// headless paper bot) can be proven, by a static import-graph test, unable to reach a sign/send path.
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
export * from './candles.ts';
export * from './detail.ts';
export * from './rpc-config.ts';
export * from './rpc-pool.ts';
export * from './credits.ts';
export * from './budget.ts';
export * from './paper.ts';
export * from './social/firewall.ts';
export * from './layer.ts';
