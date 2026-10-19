---
id: docs-spectator
title: Spectator view (watch the agent cook)
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
url: https://dexterm.xyz/docs/spectator
tags:
  - docs
  - spectator
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

Watch a connected agent work in real time. An AGENT ACTIVITY window with pause, take over and kill, a read-only loopback stream, and redacted save and replay. Covers what is redacted, the security model, how to capture it for a stream, and its limits.

The spectator view lets you watch an agent work: each time a connected agent calls a tool (opens a token, runs a LARP check, scans new pairs, reads a bubble map, makes a proposal, gets refused), the call shows up with its result, how long it took and how old its data was. It is for watching and for demos ("watch the agent cook"). It adds no new power: agents stay untrusted (https://dexterm.xyz/docs/agents#untrusted-by-default), and nothing in the spectator view can arm, sign, confirm or send anything.

It works with agents connected to the **loopback agent bus** that `dexterm agent serve` runs (see bring your own agent (https://dexterm.xyz/docs/agents#two-ways-to-connect)), and — since 0.1.4 — with agents connected over **MCP** (`dexterm mcp install`): run the app with `dexterm --spectate-mcp` and the **running terminal follows the agent** as it works (see follow an MCP agent (https://dexterm.xyz/docs/spectator#follow-over-mcp-in-the-running-terminal)). Read limits (https://dexterm.xyz/docs/spectator#limits) before you rely on it.
