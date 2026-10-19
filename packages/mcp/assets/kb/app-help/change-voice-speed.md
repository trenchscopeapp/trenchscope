---
id: change-voice-speed
title: Change the voice speed (rate)
kind: app-help
screen: all
feature: jarvis
tags:
  - app-help
  - voice
  - speed
  - rate
  - faster
  - slower
  - wpm
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

Voice speed is `voice.rate` in `~/.dexterm/config.json` (words per minute, 80–400). Edit it there and restart. Voice settings are yours alone: the analyst/agent CANNOT change them (the voice path is denied to models) — only you set them. `trenchscope voice status` shows the current voice engines.

CLI: `trenchscope voice`.
