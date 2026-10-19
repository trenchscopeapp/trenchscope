---
id: price-or-marketcap
title: Show price or market cap
kind: app-help
screen: all
feature: price-display-mode
tags:
  - app-help
  - price
  - mcap
  - marketcap
  - market
  - display
  - usd
  - cap
keys:
  - $
actions:
  - display.priceMode
commands:
  - display
flags:
  - --price-mode
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

Press `$` to flip every price between USD price and MARKET CAP (screener, watchlist, new pairs, token, both charts, order-plan levels). Saved as `display.priceMode`; also `trenchscope display price|mcap` or `--price-mode`. A coin with no known supply stays on price and says so. The analyst can set this for you.

Keys: `$`. CLI: `trenchscope display`.
