---
id: use-codex-analyst
title: Run the analyst on Codex instead of Claude
kind: app-help
screen: all
feature: analyst
tags:
  - app-help
  - codex
  - openai
  - chatgpt
  - engine
  - analyst
  - claude
  - switch
  - backend
flags:
  - --analyst-engine
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

The analyst can run on your own Codex CLI login instead of Claude (0.1.5). Pick it with `--analyst-engine codex`, `DEXTERM_ANALYST_ENGINE=codex`, `"analyst": {"engine": "codex"}` in `~/.dexterm/config.json`, or type `/engine codex` in the chat box (new conversations; `/engine` alone shows the engine and what is installed). The default `auto` uses claude when it is installed, else codex. trenchscope stores no credentials: your `codex login` does the work. The Codex run is locked read-only: only the read-only trenchscope tools (plus the UI actions the session allows, none in scan mode), no shell, no file edits, no web search, no other MCP server; a turn that tries anything else is stopped. `trenchscope doctor` shows a Codex CLI line (installed, version, logged in). Codex is also supported as an MCP client: `trenchscope mcp install codex`.
