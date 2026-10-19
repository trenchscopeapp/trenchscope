---
id: set-a-filter
title: Filter the screener
kind: app-help
screen: screener
feature: filter-grammar
tags:
  - app-help
  - filter
  - screen
  - query
  - search
  - grammar
  - volume
  - liquidity
keys:
  - /
actions:
  - filter.edit
flags:
  - --filter
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

Press `/` to open the filter editor and type the grammar, e.g. `vol24 > 250K liq > 50K age < 30d org >= 60 launchpad:pump !flag:mint`. Errors show inline with the column. One-shot: `--filter "…"`. The analyst can set a filter for you (it shows "analyst did X").

Keys: `/` (screener).
