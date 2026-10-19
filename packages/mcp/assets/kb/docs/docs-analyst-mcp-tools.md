---
id: docs-analyst-mcp-tools
title: The analyst › MCP tools
kind: docs
page: analyst
page_title: The analyst
heading: MCP tools
anchor: mcp-tools
url: https://dexterm.xyz/docs/analyst#mcp-tools
tags:
  - docs
  - analyst
  - mcp
  - tools
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

`dexterm mcp` is a plain stdio MCP server with (generated from the app: see https://dexterm.xyz/docs/analyst#mcp-tools; app-help has the exact keys and commands) tools. The analyst is launched with `--strict-mcp-config` and only `mcp__dexterm__*` tools allowed; it has no shell, no file access and no other tools. You can add the same server to any Claude Code with:

```sh
$ claude mcp add dexterm -- node packages/mcp/bin/dexterm-mcp.mjs
```

(generated from the app: see https://dexterm.xyz/docs/analyst#mcp-tools; app-help has the exact keys and commands)

The UI-action tools are the only way the analyst can change what you see, and they come in the three tiers below (https://dexterm.xyz/docs/analyst#what-it-can-change-three-tiers). Each action is re-validated by the app against the current screen's allow-list (a mint must already be on screen; a feed, sort key, screen or workspace must exist), rate-limited, and shown as "analyst did X". An injected instruction that names a coin not on screen is rejected and changes nothing. In scan mode (https://dexterm.xyz/docs/scan) the allow-list is empty and the launch disallows the UI-action tools.
