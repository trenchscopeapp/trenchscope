---
id: switch-theme
title: Switch the theme
kind: app-help
screen: all
feature: themes-keymaps
tags:
  - app-help
  - theme
  - themes
  - colour
  - colours
  - color
  - colors
  - look
  - cyberspace
  - midnight
  - ember
  - paper
keys:
  - t
actions:
  - theme.next
commands:
  - theme
flags:
  - --theme
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

Press `t` to cycle themes (slate → cyberspace → midnight → ember → paper; slate is the default). `trenchscope theme list|show|init|check` manages your own themes in `~/.dexterm/themes/`; a shared theme cannot hide a warning or swap buy/sell colours (a contrast + hue guard). The analyst can propose a theme change you confirm with a keypress.

Keys: `t`. CLI: `trenchscope theme`.
