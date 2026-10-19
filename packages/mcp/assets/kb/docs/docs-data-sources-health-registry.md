---
id: docs-data-sources-health-registry
title: Data sources and rate limits › Health registry
kind: docs
page: data-sources
page_title: Data sources and rate limits
heading: Health registry
anchor: health-registry
url: https://dexterm.xyz/docs/data-sources#health-registry
tags:
  - docs
  - data-sources
  - health
  - registry
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

Every source goes through a health registry: three consecutive failures or two 429s in a minute mark it degraded for a backoff window (30 s, doubling to 10 min). A panel whose source is down shows `unavailable: <reason>` or `needs key`, the header turns `◐ degraded: <source>`, and the analyst's tool list is built from the healthy sources each session. A screen with no data says why instead of hanging: `connecting to the live feed…`, `offline — can't reach the data feed`, `rate-limited — backing off`. Press `r` to retry. Nothing fabricates a number.
