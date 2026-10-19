---
id: docs-data-sources-the-helius-credit-meter
title: Data sources and rate limits › The Helius credit meter
kind: docs
page: data-sources
page_title: Data sources and rate limits
heading: The Helius credit meter
anchor: the-helius-credit-meter
url: https://dexterm.xyz/docs/data-sources#the-helius-credit-meter
tags:
  - docs
  - data-sources
  - helius
  - credit
  - meter
  - data
  - sources
  - rate
  - limits
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/data-sources.md
date: 2026-10-16
---

Helius Free is 1M credits a month, budgeted as (generated from the app: see https://dexterm.xyz/docs/data-sources#the-helius-credit-meter; app-help has the exact keys and commands) a day. Each request is charged (1 credit for standard RPC methods, 10 for DAS-class); the header shows `◐ helius credits N%` from 50% of the day, and at 90%, or at the per-run cap (`--max-credits`, default 5000), Helius switches off for the run and the keyless sources take over. Day totals persist in the SQLite file, so a restart keeps counting.
