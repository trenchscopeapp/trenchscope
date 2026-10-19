---
id: ask-the-analyst
title: Ask the analyst a question
kind: app-help
screen: analyst
feature: analyst
tags:
  - app-help
  - analyst
  - ask
  - claude
  - ai
  - question
  - dossier
  - chat
keys:
  - a
  - enter
actions:
  - analyst.toggle
  - open
flags:
  - --no-ai
tools:
  - get_dossier
  - kb_search
  - app_help
  - case_lookup
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

The analyst is your own `claude` login (or your own `codex` login: `/engine codex`, see "Run the analyst on Codex"). ⏎ on a coin runs a full dossier; `a` runs a rug-check (or a trench-scan of the screener when nothing is selected). Type a follow-up and ⏎ to send. If `claude` is missing or logged out the panel shows the one-line fix and the rest of trenchscope keeps working. Start without AI using `--no-ai`.

Keys: `a`, `⏎` (screener).
