---
id: simple-view
title: Switch between the simple view and the full table
kind: app-help
screen: screener
feature: look
tags:
  - app-help
  - simple
  - full
  - table
  - view
  - split
  - verdict
  - easy
  - columns
  - layout
keys:
  - f
actions:
  - view.toggle
flags:
  - --simple
  - --full
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

The app opens on the simple view: a short coin list on the left and, for the selected coin, a chart and a plain-English verdict (AVOID, CAREFUL or NO RED FLAGS) with the reasons. Press `f` for the full table with every column, presets and sort, and `f` again to come back. `--simple` / `--full` pick the view at start.

Keys: `f` (screener).
