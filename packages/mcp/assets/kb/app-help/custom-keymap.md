---
id: custom-keymap
title: Customize the keymap
kind: app-help
screen: all
feature: themes-keymaps
tags:
  - app-help
  - keymap
  - keybind
  - keybinding
  - rebind
  - shortcut
  - keys
  - remap
commands:
  - keymap
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

`config.keymap` in `~/.dexterm/config.json` re-binds actions to keys; `trenchscope keymap [screen]` shows the effective bindings including your overrides. Reserved keys (ctrl+c, esc, enter, y, !) and the confirm/dismiss/panic/quit actions cannot be rebound, and collisions refuse the whole keymap.

CLI: `trenchscope keymap`.
