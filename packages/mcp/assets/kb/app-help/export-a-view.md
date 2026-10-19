---
id: export-a-view
title: Export or share the current view
kind: app-help
screen: all
feature: export-share
tags:
  - app-help
  - export
  - share
  - screenshot
  - png
  - report
  - save
  - image
keys:
  - E
actions:
  - export.view
flags:
  - --export
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

Press `E` on any screen to write the current view to `~/.dexterm/exports/` as a PNG and a plain-text report (the toast names the file). The PNG is rendered calm with a data-source label (LIVE / SAMPLE / REPLAY) and the age of every panel. Nothing is uploaded or posted. One-shot: `--export [DIR]`.

Keys: `E`.
