---
id: edit-kb-or-skill
title: Edit the knowledge base or an analyst skill
kind: app-help
screen: all
feature: kb
tags:
  - app-help
  - kb
  - knowledge
  - skill
  - edit
  - customize
  - override
  - analyst
commands:
  - kb
  - skill
tools:
  - kb_lookup
  - kb_search
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

Your own KB entries and skills live in `~/.dexterm/kb/entries/<id>.md` and `~/.dexterm/skills/<name>.md` (same frontmatter as the bundled ones). `trenchscope kb|skill list|show|new|edit|check|reset|path`: `edit` copies the bundled file and opens your editor, `check` validates it, `reset` restores the bundled one. A skill is read-only guidance and may never name a trade/sign/arm tool.

CLI: `trenchscope kb`, `trenchscope skill`.
