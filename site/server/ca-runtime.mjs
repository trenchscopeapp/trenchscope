// Both exports in one bundled dependency graph. The launch kit's proof stays
// canonical; CommonJS/ESM interoperability is resolved at build time.
export { createContractAddressWatch } from '@nullxnothing/solana-launch-kit/ca-watch';
export { Connection } from '@solana/web3.js';
