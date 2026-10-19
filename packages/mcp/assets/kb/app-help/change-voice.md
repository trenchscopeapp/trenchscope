---
id: change-voice
title: Change which voice speaks
kind: app-help
screen: all
feature: jarvis
tags:
  - app-help
  - voice
  - choose
  - speak
  - say
  - name
commands:
  - voice
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

The default speaking voice is the neural Piper voice once it is set up (`trenchscope voice setup`), with the built-in macOS `say` as the fallback. Press `,` to cycle the `say` voice while running, or set `voice.name` in `~/.dexterm/config.json` (that chooses the `say` fallback voice; Piper has one fixed voice). Nothing is sent to a paid API. Voice is user-only: the analyst/agent cannot change it (the voice path is denied to models) — only the keyboard or your config sets it.

CLI: `trenchscope voice`.
