---
id: docs-scan-triggers-and-score
title: AI scan mode › Triggers and score
kind: docs
page: scan
page_title: AI scan mode
heading: Triggers and score
anchor: triggers-and-score
url: https://dexterm.xyz/docs/scan#triggers-and-score
tags:
  - docs
  - scan
  - triggers
  - score
  - mode
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/scan.md
date: 2026-10-16
---

Inputs come from memory and the local SQLite cache only: the screener rows, the DexScreener pair already cached for the flow panel, the open token's loaded view, and LARP verdicts that already exist. A unit test wraps the HTTP client and asserts zero calls over fifty scan ticks; measured live, requests per minute with the scan on and off were the same.

| trigger | fires when (defaults) | weight |
|---|---|---|
| `vol` | 5m volume ≥ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands)× the coin's own average 5-minute pace (6h, falling back to 1h/24h), at least $(generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands); full strength at (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands)× | 30 |
| `flow` | buy/sell flip: 5m buy share ≥ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) while the 1h share ≤ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands), at least (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) 5m transactions | 25 |
| `fresh` | age ≤ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) min, ≥ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) 5m transactions, 5m buy share ≥ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands), 5m volume ≥ $(generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) | 20 |
| `breakout` | last close above the prior (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) cached candles' high by ≥ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands)% (only coins whose candles are already loaded, in practice the open one) | 20 |
| `liq` | liquidity ≥ +(generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands)% vs the coin's own 10-minute minimum | 15 |
| `holders` | holders ≥ +(generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands)% and ≥ +(generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) vs the oldest 10-minute sample | 15 |

Points per fired trigger = weight × (0.5 + 0.5 × strength); the score is the sum, capped at 100. A coin is **exciting** at score ≥ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) with ≥ (generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands) triggers. Gate: liquidity ≥ $(generated from the app: see https://dexterm.xyz/docs/scan#triggers-and-score; app-help has the exact keys and commands). Vetoes set the score to zero and say why: an existing `LARP` verdict (the detector is never invoked by the scan), or a mint or freeze authority that is still enabled.
