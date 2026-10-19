---
id: narrative-lifecycle
title: Narrative lifecycle (DRAFT, needs maintainer review before any skill may cite it)
tags:
  - narrative
  - meta
  - lifecycle
  - trending
  - judgement
date: 2026-10-06
confidence: low
owner: maintainers
origin: maintainer-draft
reviewed_by: none
status: draft-unreviewed
sources:
  - dexterm research/data-firehose-inventory-2026-10-06.md §1c (Jupiter toptrending/toporganicscore, DexScreener boosts/profiles, GeckoTerminal trending_pools, DefiLlama venue share)
  - dexterm ROADMAP.md north-star scenario (narrative summary, volume per narrative)
---
**Status.** This is the one entry in the KB that is trading judgement rather than protocol mechanics. It is a scaffold for the maintainers to replace; `confidence: low`, `status: draft-unreviewed`. The `narrative-scan` and `daily-digest` routines must refuse to cite it until `reviewed_by` is set.

**What can be measured (facts, from tools):** which tokens are on Jupiter's `toptrending/{5m,1h,6h,24h}` and `toporganicscore` lists; DexScreener boosts and profiles (paid promotion); GeckoTerminal `trending_pools` and `new_pools` with DEX counts; per-DEX 24 h volume from DefiLlama; the *share of new launches whose name/description matches a theme* (string match over firewalled text); SOL funding/OI from Hyperliquid/OKX as the macro backdrop.

**Scaffold of the lifecycle (to be rewritten by the maintainers):**
1. *Spark*: a real-world event or one runner; a handful of mints with the theme appear within minutes.
2. *Derivative wave*: dozens of same-theme launches; most are copycats; volume concentrates in one or two leaders.
3. *Peak*: trending lists are dominated by the theme; late derivatives launch into falling attention.
4. *Rotation*: volume per theme falls, leaders fade or hold, a new spark begins.

**What a narrative routine may output:** counts and volumes per theme with the tool and data age, the leaders by organic score, and *proposals* (watch-list adds, alerts) for the user to confirm. It may not say that a theme "will run".

**Open questions:** what counts as a theme match; the minimum number of same-theme launches before it is a narrative; whether DexScreener boosts count as a negative signal; which X lists (if any) seed the theme detector once 1289 lands.
