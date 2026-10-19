---
id: docs-data-sources-rate-limits-and-pacing
title: Data sources and rate limits › Rate limits and pacing
kind: docs
page: data-sources
page_title: Data sources and rate limits
heading: Rate limits and pacing
anchor: rate-limits-and-pacing
url: https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing
tags:
  - docs
  - data-sources
  - rate
  - limits
  - pacing
  - data
  - sources
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/data-sources.md
date: 2026-10-16
---

One token bucket per host with the documented limit as the ceiling and a safety factor of (generated from the app: see https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing; app-help has the exact keys and commands); over-budget requests queue and the column header shows `⌛` instead of blocking. Identical in-flight requests share one promise. The chart the user is waiting on takes a high-priority slot that background work (tape, prefetch, refresh) can never consume.

(generated from the app: see https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing; app-help has the exact keys and commands)

Refresh cadence, keyless: screener table (generated from the app: see https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing; app-help has the exact keys and commands) s (one DexScreener batch per 30 rows), token screen (generated from the app: see https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing; app-help has the exact keys and commands) s, watchlist (generated from the app: see https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing; app-help has the exact keys and commands) s, positions (generated from the app: see https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing; app-help has the exact keys and commands) s, new pairs push plus a 15 s Jupiter poll and a 30 s RugCheck poll, PAPER quote (generated from the app: see https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing; app-help has the exact keys and commands) s while editing. The fast lane adds zero HTTP requests: it is push, capped at (generated from the app: see https://dexterm.xyz/docs/data-sources#rate-limits-and-pacing; app-help has the exact keys and commands) simultaneous subscriptions (the open token, your watchlist, a few fresh launches); tokens past the cap stay on the polling lane, never dropped.
