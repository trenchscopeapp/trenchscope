---
id: connect-an-agent
title: Connect your own agent (MCP)
kind: app-help
screen: all
feature: mcp
tags:
  - app-help
  - mcp
  - agent
  - agents
  - connect
  - claude
  - tool
  - server
  - bot
commands:
  - mcp
tools:
  - screen_state
  - get_dossier
  - kb_search
  - app_help
  - app_state
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

`trenchscope mcp` is a plain stdio MCP server exposing the same read-only tools the analyst uses. Add it to any Claude Code with `claude mcp add trenchscope -- node packages/mcp/bin/dexterm-mcp.mjs`, or set up Claude Code, Claude Desktop, Cursor or Codex in one command with `trenchscope mcp install <client>`. Agents are untrusted: every tool is read-only and an agent can never sign, arm, raise a cap or touch keys. Use `app_help` for "how do I" questions and `app_state` to see what the user sees.

CLI: `trenchscope mcp`.
