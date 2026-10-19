---
id: turn-on-alerts
title: Turn on alerts (phone via ntfy / Telegram / Discord / desktop)
kind: app-help
screen: all
feature: push-alerts
tags:
  - app-help
  - alerts
  - alert
  - notify
  - notification
  - telegram
  - discord
  - desktop
  - channel
  - ntfy
  - phone
keys:
  - b
actions:
  - alert.propose
commands:
  - alerts
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

Use `trenchscope alerts` to see channels and enable them; `trenchscope alerts set-ntfy` (phone push: subscribe to the same topic in the ntfy app), `set-telegram` / `set-discord` store the topic / bot token / webhook in `~/.dexterm/` (mode 0600) — never in config.json, argv or a log. In-app, `b` proposes a liquidity alert on the highlighted coin and `y` arms it. The analyst can never change alert channels or see their secrets.

Keys: `b` (screener). CLI: `trenchscope alerts`.
