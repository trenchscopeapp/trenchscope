---
id: workspaces
title: Save and switch workspaces
kind: app-help
screen: all
feature: workspaces
tags:
  - app-help
  - workspace
  - workspaces
  - layout
  - hud
  - save
  - morning
keys:
  - ctrl+w s
actions:
  - workspace.save
commands:
  - workspace
flags:
  - --workspace
  - --screen
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

A workspace saves a start screen, theme, intensity, screener preset/filter/sort, token panels and the HUD popups to open together. `ctrl+w` then `s` saves as; `w` lists; `n`/`N` cycle. `trenchscope workspace list|show|remove|init` manages them. The analyst can open a saved workspace for you.

Keys: `^W S`. CLI: `trenchscope workspace`.
