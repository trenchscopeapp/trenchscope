---
id: narrative-board
title: See the narrative board (trenchscope narrative)
kind: app-help
screen: trending
feature: trending-board
tags:
  - app-help
  - narrative
  - narratives
  - board
  - trending
  - movers
  - window
  - summary
commands:
  - narrative
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

`trenchscope narrative [--window 1h|24h] [--summary]` prints the narrative board — what is trending across the recorded feed — with no network and no model. In-app it is the trending screen.

CLI: `trenchscope narrative`.
