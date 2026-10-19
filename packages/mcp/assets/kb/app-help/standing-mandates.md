---
id: standing-mandates
title: Set a standing mandate (trenchscope mandate)
kind: app-help
screen: all
feature: order-plans
tags:
  - app-help
  - mandate
  - mandates
  - standing
  - rule
  - budget
  - auto
  - arm
  - cap
commands:
  - mandate
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

`trenchscope mandate list|add|remove|arm|disarm` sets a standing mandate — a longer-lived conditional rule bounded by a budget. As with plans, a model may only PROPOSE; arming needs your physical keypress and the signer-side caps bound it. The analyst can never arm a mandate or change its caps.

CLI: `trenchscope mandate`.
