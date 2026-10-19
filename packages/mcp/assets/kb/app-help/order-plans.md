---
id: order-plans
title: Set conditional order plans (trenchscope plan)
kind: app-help
screen: all
feature: order-plans
tags:
  - app-help
  - plan
  - plans
  - order
  - conditional
  - take-profit
  - stop
  - trigger
  - arm
commands:
  - plan
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

`trenchscope plan list|add|remove|arm|disarm` sets conditional order plans (e.g. take-profit / stop levels). Voice and agents can only PROPOSE a plan; ARMING one needs your physical keypress, and the caps and panic-stop stay signer-side. Nothing here lets a model sign or raise a cap.

CLI: `trenchscope plan`.
