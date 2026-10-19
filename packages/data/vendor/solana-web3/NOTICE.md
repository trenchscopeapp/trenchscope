# Vendored: @solana/web3.js 1.98.4 (browser IIFE bundle)

- File: `index.iife.min.js` — `lib/index.iife.min.js` from the npm tarball `solana-web3.js-1.98.4.tgz`
  (fetched 2026-10-09 with `npm pack @solana/web3.js@1.98.4`; nothing was installed into node_modules).
- sha256: `09cdbea951b2ed0e11bcbe3aeb1ee9f035f9fb51ed212aca645475ae82688cc3` (pinned by
  `packages/data/test/signer-1328.test.ts`; a changed file fails the test).
- License: MIT (see `LICENSE`, copied verbatim from the package).
- Why it is here (task-1328): Phantom's `signTransaction()` takes a `VersionedTransaction` OBJECT, not
  bytes, so the wallet bridge's tx-sign page needs web3.js in the browser to rebuild the transaction
  the signer built. The bundle is INLINED into the page under the CSP nonce (no remote script, no CDN,
  no network fetch at sign time) and exposed as `window.dexSolana`. It runs only in the user's
  browser on the loopback sign page; dexterm's Node processes never import it.
- Upgrade: replace the file, update the sha256 in the test and here, re-run the bridge + signer tests.
