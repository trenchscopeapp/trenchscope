---
id: docs-screens-live-holder-and-rug-signals
title: Screens tour › Live holder and rug signals
kind: docs
page: screens
page_title: Screens tour
heading: Live holder and rug signals
anchor: live-holder-and-rug-signals
url: https://dexterm.xyz/docs/screens#live-holder-and-rug-signals
tags:
  - docs
  - screens
  - live
  - holder
  - rug
  - signals
  - tour
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/screens.md
date: 2026-10-16
---

While a token is open, its holder and rug-risk reads update as the data moves, not only when you open the screen. When a reading crosses a threshold, a **LIVE SIGNALS** strip in the ON-CHAIN panel shows a line like `⚑ top-10 concentration 31% → 38% (pools excluded)` with its **source** and the **age** of the data, and a short notice flashes. Each signal is a risk flag to check, not a verdict.

| signal | fires when |
| --- | --- |
| dev sell | the creator's share drops by 1 point or more |
| concentration | the top-10 share (pools excluded) moves by 3 points or more |
| LP unlock | the locked share of the liquidity drops by 1 point or more |
| liquidity | liquidity falls by 25 % or more |
| authority | the mint or freeze authority appears or is revoked |
| bundle / sniper | bundled supply rises by 1 point, or another sniper appears |
| fresh wallets | the share of fresh-at-buy wallets rises by 5 points |
| bonding / migrated | bonding-curve progress rises by 5 points, or the coin migrates |

- **Three cadences, each honest about its source.** Authorities, LP, liquidity and the top-10 share refresh with the token poll (every (generated from the app: see https://dexterm.xyz/docs/screens#live-holder-and-rug-signals; app-help has the exact keys and commands) s). Bonding progress streams sub-second from the same on-chain push as the LIVE price badge. Holder, bundle, sniper and fresh-wallet reads re-scan every 45 s while the token is open, and only with a free Helius key. Keyless, they show a dash and spend no requests.
- **Stale never fires.** The first reading of each field is a baseline and fires nothing. A reading older than 60 s, or one its source marks stale, never fires a signal and is shown as **stale**, never hidden or filled in. A migration is caught on the next token refresh, not sub-second.
- **Every signal is an alert trigger.** The rules engine (https://dexterm.xyz/docs/configuration#rules-engine) reads the open token's live fields `top10`, `dev`, `bundled`, `snipers`, `fresh`, `cluster`, `lplocked`, `bonding`, `mintable` and `freezable` (1 when that authority is present), with `.delta` and `.velocity`. A rule can then reach your push channels (https://dexterm.xyz/docs/configuration#push-alerts-and-dexterm-watch):

```text
when dev.delta < -2 then alert(down, "dev selling")
when mintable > 0 then alert(warn, "mint authority present")
when top10.delta > 5 then alert(warn, "concentration up")
```

The signals read the same keyless and free-tier sources as the rest of the token screen, through the same rate limiter. They raise flags; they cannot trade, arm or sign anything.
