---
id: record-headless
title: Keep the recorder running with the app closed (trenchscope record)
kind: app-help
screen: all
feature: recorder
tags:
  - app-help
  - collector
  - collect
  - background
  - headless
  - launchd
  - daemon
  - keep
  - closed
  - backtest
commands:
  - record
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

`trenchscope record` runs the history recorder with no terminal UI, so the data the backtests learn from keeps growing while trenchscope is closed. `trenchscope record status` shows what it has collected; `trenchscope record install --dry-run` prints the user-level LaunchAgent it would create (macOS, no sudo) and `trenchscope record uninstall` removes it. It uses the same free-tier request limits as the app, never trades, and a disk cap pauses new observations when the database gets large.

CLI: `trenchscope record`.
