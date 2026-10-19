---
id: follow-a-wallet
title: Copy / follow a wallet (trenchscope follow)
kind: app-help
screen: all
feature: copy-trading
tags:
  - app-help
  - follow
  - copy
  - mirror
  - wallet
  - trader
  - track
  - unfollow
  - list
commands:
  - follow
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

`trenchscope follow list|add|remove` is the copy-trading follow list: local, self-directed and read-only. When a followed wallet trades, trenchscope can surface a one-key MIRROR TICKET you confirm yourself — it never auto-trades, never signs, and the analyst can never add a follow or confirm a mirror.

CLI: `trenchscope follow`.
