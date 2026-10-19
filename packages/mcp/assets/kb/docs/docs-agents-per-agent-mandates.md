---
id: docs-agents-per-agent-mandates
title: Bring your own agent › Per-agent mandates
kind: docs
page: agents
page_title: Bring your own agent
heading: Per-agent mandates
anchor: per-agent-mandates
url: https://dexterm.xyz/docs/agents#per-agent-mandates
tags:
  - docs
  - agents
  - per-agent
  - mandates
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

On top of the tier, you can give an agent a **mandate** — a named allow-list of tools:

```sh
$ dexterm agent mandate scanbot --tools screener_query,analyze_token,get_dossier
$ dexterm agent mandate scanbot --clear   # back to the full tier surface
```

A mandated agent sees and may call **only** those tools (plus `agent_whoami` to introspect itself). A mandate can only **narrow** a tier, never widen it — the tier gate still refuses a tool above the agent's grant, and the never-list still refuses anything that arms, signs or raises a cap. Use it to hand one agent a tight, auditable job.
