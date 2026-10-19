---
id: docs-configuration-price-display-mode
title: Configuration and files on disk › Price display mode
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Price display mode
anchor: price-display-mode
url: https://dexterm.xyz/docs/configuration#price-display-mode
tags:
  - docs
  - configuration
  - price
  - display
  - mode
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

Memecoin traders think in market cap, so every token price can be shown as **market cap** instead of the USD price per token. It is a display mode only: the same data underneath, no extra requests, and nothing that trades (signer, caps, tickets, plans, the confirm gate) reads it.

- `$` flips price ⇄ market cap on every screen and both charts, and saves it to `config.json` as `"display": { "priceMode": "mcap" }` (or `"price"`, the default) through the journal, so `ctrl+z` undoes it. `dexterm display [price|mcap]` shows or sets it from the command line; `--price-mode price|mcap` overrides it for one run; a workspace may carry `"priceMode"` and switches to it while active.
- Market cap = price × supply, where the supply is what the data sources already report (the row's market cap ÷ its price at the latest tick). The screener, watchlist and new pairs lead with **MCAP** (the PRICE column moves to MCAP's old place, every sort key works as before, `mcap` still sorts by market cap); the watchlist's entry becomes **ENTRY MC**; spotlights and the token header lead with the market cap and keep the price beside it.
- Charts: the terminal chart and the popup chart (https://dexterm.xyz/docs/popup-chart#market-cap-axis) label the Y axis in K / M / B (`300K`, `1.2M`). Historical candles are scaled by the **current** supply, and the chart title says `mcap (current supply)` so nobody reads it as the exact market cap at that time (a burn or a mint since then is not reflected).
- Order plans already trigger on market cap: the `O` screen and the plans popup show each level with both numbers (`entry mc ≤ $300K ($0.0₃3)`), the price taken from the plan's own supply snapshot. Position rows read **AVG MC** / **MCAP**; profit and loss stay in USD (or SOL on the paper screen).
- A token without a known supply falls back to its price and says so: `ᵖ` after the number in a table (the panel caption counts them), `supply unknown · showing price` on the spotlight, the header and the chart title. Nothing is estimated.
- `config.json` moved to **v4** for this: an older file is migrated on load (`display.priceMode = price` added, a backup kept as `config.json.bak-v3`), nothing else changes.
