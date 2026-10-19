---
id: what-dexterm-shows-agents
title: See what the user currently sees (app_state)
kind: app-help
screen: all
feature: mcp
tags:
  - app-help
  - state
  - current
  - screen
  - context
  - selected
  - agent
  - see
tools:
  - app_state
  - screen_state
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

An agent can call the read-only `app_state` MCP tool to fit an answer to what the user sees: the current screen, the selected coin, the theme, price mode, voice name/rate, whether scan and calm are on, and which alert channels are configured (YES/NO only — never a token, webhook or key). `screen_state` adds the visible rows and the action allow-list.
