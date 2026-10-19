---
id: docs-analyst
title: The analyst
kind: docs
page: analyst
page_title: The analyst
url: https://dexterm.xyz/docs/analyst
tags:
  - docs
  - analyst
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

What Claude sees, the skills, the MCP tools, the short bold answer style, and what it can never do.

The analyst is **your own Claude Code login**, spawned as a local `claude` process by dexterm. No API key ships with the app; your subscription, billing and limits apply. It talks to the app through a read-only MCP server (`dexterm mcp`) that exposes the same data adapters the screens use, a sourced knowledge base and historical case files. Default model: `(generated from the app: see https://dexterm.xyz/docs/analyst; app-help has the exact keys and commands)` (override with `DEXTERM_ANALYST_MODEL`).
