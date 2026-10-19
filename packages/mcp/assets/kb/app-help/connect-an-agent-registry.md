---
id: connect-an-agent-registry
title: Manage connected agents (trenchscope agent)
kind: app-help
screen: all
feature: mcp
tags:
  - app-help
  - agent
  - agents
  - registry
  - tier
  - pause
  - resume
  - kick
  - audit
  - bus
  - serve
commands:
  - agent
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

`trenchscope agent add|list|rotate|remove|tier|pause|resume|kick|audit|packs` manages your bring-your-own-agent registry and the loopback bus; `trenchscope agent serve` runs a standalone bus on fixtures and `connect` attaches one. Every agent is untrusted and read-only: it can never sign, arm, raise a cap, touch keys or change network settings.

CLI: `trenchscope agent`.
