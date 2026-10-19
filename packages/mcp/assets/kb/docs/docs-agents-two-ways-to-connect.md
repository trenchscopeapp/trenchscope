---
id: docs-agents-two-ways-to-connect
title: Bring your own agent › Two ways to connect
kind: docs
page: agents
page_title: Bring your own agent
heading: Two ways to connect
anchor: two-ways-to-connect
url: https://dexterm.xyz/docs/agents#two-ways-to-connect
tags:
  - docs
  - agents
  - two
  - ways
  - connect
  - bring
  - own
  - agent
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/agents.md
date: 2026-10-16
---

- **MCP (stdio).** `dexterm mcp install claude-code` (or `claude mcp add dexterm -- dexterm mcp`) gives any Claude Code the read-only tool surface (the (generated from the app: see https://dexterm.xyz/docs/agents#two-ways-to-connect; app-help has the exact keys and commands) tools in the analyst's tool list (https://dexterm.xyz/docs/analyst#mcp-tools)) plus the **agent packs**: the dexterm skills (`trench-scan`, `rug-check`, `token-dossier`) are offered as MCP prompts, and the knowledge base, case files and skills as MCP resources, so your agent gets the same playbooks the built-in analyst uses.
- **Loopback agent bus.** A WebSocket + JSON-RPC 2.0 server bound to `127.0.0.1` for live work: subscribe to the data firehose (new pairs, trades, alerts, screen state), call read and navigation tools, and create proposals. Register an agent, then connect with the TS or Python SDK, or `dexterm agent connect`.

```sh
$ dexterm agent add scanbot --tier observe        # prints a one-time token (shown once)
$ export DEXTERM_AGENT_TOKEN=dxa_…                 # paste it into your agent's env, never a flag
$ dexterm agent serve --fixtures --roster         # run the bus on fixtures + the roster popup
$ dexterm agent connect --name scanbot --watch 30 # subscribe and watch the stream
```
