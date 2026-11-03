---
id: edit-rules
title: Set up alert rules (solgent rules)
kind: app-help
screen: all
feature: rules-engine
tags:
  - app-help
  - rules
  - rule
  - trigger
  - condition
  - alert
  - add
  - dry-run
  - fields
  - engine
commands:
  - rules
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

`solgent rules list|add|remove|enable|disable|check|dry-run|fields` configures the rules engine — the conditions that raise an alert (e.g. liquidity jump, volume spike). `dry-run` tests a rule against recent data; `fields` lists what you can match on. No network, no model, and a rule can never trade. Deliver the alerts with `solgent alerts` and `solgent watch`.

CLI: `solgent rules`.
