---
id: docs-paper-trading-jupiter-rate-limits
title: Paper trading, live trading and the safety model › Live trading (devnet first) › Jupiter rate limits
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Jupiter rate limits
anchor: jupiter-rate-limits
url: https://dexterm.xyz/docs/paper-trading#jupiter-rate-limits
tags:
  - docs
  - paper-trading
  - jupiter
  - rate
  - limits
  - live
  - trading
  - devnet
  - first
  - paper
  - safety
  - model
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

Jupiter's keyless API allows about five requests per ten seconds per IP, answers `429` with no `Retry-After` but with a reset time, and its alternate host (`lite-api.jup.ag`) can answer `503` (both recorded on 2026-10-12 and kept as fixtures). A limit used to kill the plan (`build-failed: HTTP 429`) and park the preview on "fetching…" for half a minute. Now every keyless Jupiter call on the trade path is retried on the **other host** after the server's own reset (or `Retry-After`, with a jittered backoff), at most three attempts inside ten seconds; a `5xx` or a dropped connection alternates the same way; the LIVE preview, the signer's re-quote and the build go through the signer's **one** rate limiter and a quote fetched for the preview is reused by the build a moment later (two calls, not three). When the budget is spent, or the data layer's health gate is cooling the source down after two 429s in a minute, the ticket **keeps the plan**: it shows `Jupiter is rate limiting this IP (429 from api.jup.ag), retrying in Ns`, retries by itself when the wait ends, `r` retries now and `esc` cancels. Nothing is built or signed while it waits.
