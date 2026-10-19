---
id: jito-bundles
title: Jito bundles, tips, and what "bundled" means on a launch
tags:
  - jito
  - bundle
  - bundling
  - tips
  - sniping
  - forensics
date: 2026-10-06
confidence: high
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - https://docs.jito.wtf/lowlatencytxnsend/ (retrieved 2026-10-01 into solana-launchpad/docs/jito/bundles.md)
  - dexterm SPEC.md §3.6 (Bundled % definition)
  - dexterm research/data-firehose-inventory-2026-10-06.md §1e (bundle contents not exposed by Jito)
---
**Mechanics.** A Jito bundle is "a group of up to 5 transactions that execute sequentially and atomically (all-or-nothing)", submitted to the Jito block engine (`sendBundle`) and landed by validators running Jito-Solana. A bundle pays a **tip** (minimum 1,000 lamports) to one of 8 tip accounts; "higher tips win the auction during congestion". `getBundleStatuses` returns the landed `slot`. The live tip floor is at `https://bundles.jito.wtf/api/v1/bundles/tip_floor`.

**Why launches get "bundled".** Because a bundle is atomic and ordered, a deployer can put the `create` instruction and several `buy`s from different wallets into the same bundle: the token is created and a chosen share of supply is bought in the same slot before anyone else can trade. The buyers in that bundle look like separate wallets but were funded and signed by one operator.

**What is and is not observable.** Jito does not publish bundle contents or membership, so "this was a Jito bundle" is not directly readable. What *is* on-chain: the slot and ordering of the first buys, and the funding history of each buying wallet. dexterm's definition (SPEC §3.6): **Bundled % = share of supply bought in the launch transaction or by wallets funded by the same source within 60 s of launch.** This catches bundles and also non-Jito same-slot coordination; it misses operators who pre-fund wallets days ahead.

**Trader reading.** A high bundled share means one party controls a large float and can sell it at once; many "bundled launches" dump the bundle into the first organic bid. But a bundle that *sells early and is absorbed* can leave a cleaner holder base afterwards (the fixture case F5 models this). The number to watch next is whether the bundle wallets still hold (`get_holders` labels `sniper`, `get_trades.sniperSells`).

**Sandwich note:** Jito's `jitodontfront` convention (an account whose pubkey starts with `jitodontfront` in an instruction) makes the block engine reject bundles that would front-run that transaction; it protects the sender, not the token.
