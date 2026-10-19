---
id: watch-a-coin
title: Watch (or unwatch) a coin
kind: app-help
screen: all
feature: watchlist
tags:
  - app-help
  - watch
  - watchlist
  - follow
  - track
  - token
  - tokens
  - coins
keys:
  - w
actions:
  - watch.add
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

Press `w` to watch/unwatch the highlighted coin (screener, new pairs, token screen). The watchlist is persisted and priced live. On the watchlist screen `d` removes a row.

Keys: `w` (screener).
