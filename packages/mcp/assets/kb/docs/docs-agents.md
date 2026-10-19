---
id: docs-agents
title: Bring your own agent
kind: docs
page: agents
page_title: Bring your own agent
url: https://dexterm.xyz/docs/agents
tags:
  - docs
  - agents
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

Connect Claude Code, Codex or a custom bot to a running dexterm over MCP or the loopback agent bus, with one-command setup, server-side capability tiers, optional per-agent mandates and an untrusted-by-default security model.

dexterm is a terminal you can let your own agent drive — Claude Code, Codex, a local agent or a custom bot — without ever handing it your keys. Every agent is **untrusted by default**: it authenticates as itself, runs at a capability tier you grant, and nothing it does can arm, sign, confirm, raise a cap, change the confirmation gate, or touch a wallet, a mandate or the signer.
