---
id: open-chart-popup
title: Open the chart popup
kind: app-help
screen: token
feature: popup-chart
tags:
  - app-help
  - chart
  - popup
  - candles
  - window
  - dock
  - graph
keys:
  - C
actions:
  - popup.chart
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

Press `C` on the token screen to open the docked chart popup (a native window, or your browser as fallback). It is fed only by the terminal's caches over one loopback WebSocket and never sees your keys. The analyst can open or close it for you.

Keys: `C` (token).
