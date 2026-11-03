---
id: app-help-command
title: Get help on how solgent works (solgent help)
kind: app-help
screen: all
feature: app-help
tags:
  - app-help
  - help
  - how
  - topic
  - topics
  - guide
  - manual
  - docs
  - commands
commands:
  - help
flags:
  - --help
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

`solgent help [topic]` answers "how do I ..." from the generated app-help knowledge base — the same entries the analyst's `app_help` tool uses, so they cannot drift from the app. `solgent help` lists the topics; `solgent help <topic|key|command>` prints the matching entry with the exact key or command. `--help` (or `-h`) on any command prints its usage. The analyst searches app-help first and never invents a key.

CLI: `solgent help`.
