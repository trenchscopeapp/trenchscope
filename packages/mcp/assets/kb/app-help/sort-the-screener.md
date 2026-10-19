---
id: sort-the-screener
title: Sort the screener
kind: app-help
screen: screener
feature: filter-grammar
tags:
  - app-help
  - sort
  - order
  - rank
  - column
  - menu
keys:
  - s
actions:
  - sort.menu
flags:
  - --sort
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

Press `s` for the sort menu: j/k pick a key, ⏎ on the current key flips the direction (ascending/descending). One-shot at launch: `--sort <key>`.

Keys: `s` (screener).
