---
id: sniping-and-snipers
title: Sniping: how first-block buyers get in and how dexterm counts them
tags:
  - sniping
  - snipers
  - launch
  - forensics
  - pumpportal
date: 2026-10-06
confidence: medium
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - dexterm SPEC.md §3.6 (Snipers definition)
  - dexterm research/data-firehose-inventory-2026-10-06.md (PumpPortal create stream median 65 ms before Helius logs; Helius logsSubscribe metering)
  - https://docs.meteora.ag/core-products/dbc/fees/rate-limiter.md (deprecated buy-size fee)
  - https://docs.raydium.io/products/launchlab/bonding-curve.md (linear curve makes early buys cheap)
---
**Definition used by dexterm (SPEC §3.6):** snipers = distinct wallets that bought in the token's **first 3 blocks** (or first 2 s on a bonding curve). Needs parsed transaction history (Helius `getTransactionsForAddress`, Tier 1).

**How snipers get there.** Bots subscribe to create events: PumpPortal's `subscribeNewToken` (free; in the 2026-10-06 probe its create messages arrived a median 65 ms *before* Helius `logsSubscribe` on a loaded socket), or `logsSubscribe` on the launchpad program, then submit a buy, often through a Jito bundle for ordering (see `jito-bundles`). On a constant-product curve with virtual reserves the first buys are the cheapest tokens the curve will ever sell; on a linear LaunchLab curve "early buyers pay close to zero".

**Protocol-level deterrents.** Meteora DBC had a *rate limiter* fee that rose with buy size for up to 12 h; it is deprecated for new configs, replaced by time-decaying fee schedulers (high starting fee that decays), so a launch's anti-snipe protection is now "fee is high for the first minutes", if the partner configured it at all. pump.fun's documented curve fee is a flat 1 % (plus any creator fee), with no size- or time-based part.

**Difference from bundling.** A sniper is an *outside* bot racing the public; a bundle is the *deployer's own* wallets inserted atomically. The chain shows both as early buys; funding-source clustering separates them (a sniper bot's wallets are funded by the bot operator, not by the creator).

**Judgement (maintainers, reviewed 2026-10-15; rough heuristics, not yet measured):** a few snipers (2–5) on a popular launch are common and often sell within minutes; a dozen plus a high bundled share means the early float is in professional hands and the first candle is theirs to sell into. The useful number is sniper share *still held* at the time of analysis, not the count at launch.
