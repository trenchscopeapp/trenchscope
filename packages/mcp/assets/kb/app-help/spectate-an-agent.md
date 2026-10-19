---
id: spectate-an-agent
title: Watch an agent drive trenchscope (trenchscope spectate)
kind: app-help
screen: all
feature: spectator
tags:
  - app-help
  - spectate
  - spectator
  - watch
  - agent
  - cook
  - observe
  - replay
  - stream
  - record
  - mcp
  - follow
commands:
  - spectate
flags:
  - --replay
  - --spectate-mcp
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

Watch an agent work. For an agent on the loopback bus, `trenchscope agent serve --spectator-popup` opens the AGENT ACTIVITY window, `--spectate` starts the read-only, token-gated, loopback stream, and `--record FILE` saves a redacted session. For an agent connected over MCP (`trenchscope mcp install`), run the app with `trenchscope --spectate-mcp`: the running terminal then follows the agent — a navigation call moves the screen, a status line shows `agent <name>: opened <coin>`, ctrl+p pauses, ctrl+k stops and any key you press takes control. `trenchscope spectate --replay FILE` replays a saved session step by step and `trenchscope spectate --info` shows the live stream endpoint. Every shared copy is redacted — a tool name, refusal, agent line or navigation can never leak a wallet or key — and a spectator can only watch, never act. Full docs: https://dexterm.xyz/docs/spectator/

CLI: `trenchscope spectate`.
