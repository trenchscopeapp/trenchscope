---
id: docs-spectator-follow-over-mcp-in-the-running-terminal
title: Spectator view (watch the agent cook) › Follow over MCP in the running terminal
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: Follow over MCP in the running terminal
anchor: follow-over-mcp-in-the-running-terminal
url: https://dexterm.xyz/docs/spectator#follow-over-mcp-in-the-running-terminal
tags:
  - docs
  - spectator
  - follow
  - over
  - mcp
  - running
  - terminal
  - view
  - watch
  - agent
  - cook
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/spectator.md
date: 2026-10-16
---

An agent connected over MCP (Claude Code, Claude Desktop, Cursor, Codex — set up with `dexterm mcp install`) runs the `dexterm mcp` server as its own process, which the app cannot see into. Since 0.1.4, run the app with `dexterm --spectate-mcp` and the running terminal **follows** that agent:

- While the flag is on, the app writes a small local rendezvous under `~/.dexterm` (mode 0600). The `dexterm mcp` server notices it and starts emitting one record per tool call to a local channel the app tails. When you are not following, the file is absent and the server writes nothing — there is no cost when nobody is watching.
- A **navigation** call (open a token, switch screen or feed, set a filter, highlight a row, open the paper ticket) moves the real screen, with a status line like `agent <name>: opened BONK`. These are the same read-only moves the analyst makes; nothing an agent does here can size, confirm, sign, send or raise a cap. From 0.1.5, if you start with `--agent-paper <mandate-id>`, the agent's **simulated** trades show here too as `PAPER …` rows. They never move your screen, and Ctrl+P, Ctrl+K and taking over halt them (agent paper trading (https://dexterm.xyz/docs/agents#agent-paper-trading)).
- The controls are at your keyboard: **ctrl+p** pauses and resumes the mirroring, **ctrl+k** stops following (it removes the rendezvous, so the server stops emitting), and **any other key** hands control back to you — the agent can never move the screen out from under you.
- A read-only, loopback, token-gated stream opens too, so `dexterm spectate --info` shows its endpoint while you follow. Every record is authenticated by the rendezvous token before it is folded, and every shared copy is redacted (see what is redacted (https://dexterm.xyz/docs/spectator#what-is-redacted)). This is on the owner's own machine, so follow mode itself shows full detail.

The built-in analyst (the in-app `ask Claude`) already drives the terminal through its own action channel and shows `analyst did X`; this is the same idea for an agent you connected yourself over MCP.
