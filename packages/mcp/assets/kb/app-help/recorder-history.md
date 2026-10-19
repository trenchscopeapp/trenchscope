---
id: recorder-history
title: Work with the history recorder (trenchscope recorder)
kind: app-help
screen: all
feature: recorder
tags:
  - app-help
  - recorder
  - record
  - history
  - stats
  - label
  - prune
  - outcomes
  - database
  - session
  - capture
  - data
commands:
  - recorder
flags:
  - --record
  - --no-recorder
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

`trenchscope recorder stats|label|prune|export` works with the local history recorder's tables (the outcome-labelled data the rug model and backtests learn from). No network. Recording is on by default; `--no-recorder` disables it for a run and `--record FILE` captures a data session to a file for replay.

CLI: `trenchscope recorder`.
