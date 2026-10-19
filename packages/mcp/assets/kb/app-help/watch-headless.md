---
id: watch-headless
title: Run alerts in the background (trenchscope watch)
kind: app-help
screen: all
feature: push-alerts
tags:
  - app-help
  - watch
  - background
  - headless
  - push
  - alerts
  - notify
  - daemon
  - interval
commands:
  - watch
flags:
  - --interval
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

`trenchscope watch [--interval S] [--once|--ticks N] [--replay FILE]` runs the rules engine headless and PUSHES alerts to your enabled channels, so they reach you when the terminal is closed. It has no signer and can never trade. Set channels up first with `trenchscope alerts`.

CLI: `trenchscope watch`.
