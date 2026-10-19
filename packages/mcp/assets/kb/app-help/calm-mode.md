---
id: calm-mode
title: Turn on calm mode (effects off)
kind: app-help
screen: all
feature: look
tags:
  - app-help
  - calm
  - effects
  - rain
  - glitch
  - quiet
  - still
  - intensity
flags:
  - --calm
  - --intensity
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

trenchscope starts calm (no effects). Press `c` to toggle: rain, glitch, blink and scanlines on, then off again. Start calm with `--calm` (or `DEXTERM_CALM=1`); `--intensity normal|fever|off` picks a tier. The analyst can toggle calm for you.
