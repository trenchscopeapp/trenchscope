---
id: kol-lists
title: Manage KOL wallet lists (trenchscope kol)
kind: app-help
screen: kol
feature: kol-lists
tags:
  - app-help
  - kol
  - kols
  - influencer
  - leader
  - list
  - lists
  - wallet
  - mute
  - import
commands:
  - kol
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

`trenchscope kol list|create|add|remove|mute|unmute|enable|disable|import` manages key-opinion-leader wallet lists on the shared DB (official / authorized sources only). In-app the KOL screen shows the lists and their activity.

CLI: `trenchscope kol`.
