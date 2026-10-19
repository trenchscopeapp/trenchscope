---
id: docs-agents-capability-tiers-enforced-server-side
title: Bring your own agent › Capability tiers (enforced server-side)
kind: docs
page: agents
page_title: Bring your own agent
heading: Capability tiers (enforced server-side)
anchor: capability-tiers-enforced-server-side
url: https://dexterm.xyz/docs/agents#capability-tiers-enforced-server-side
tags:
  - docs
  - agents
  - capability
  - tiers
  - enforced
  - server-side
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

The tier comes from your registry at connection time, never from anything the agent sends; a client may only ask to run *below* its grant.

| tier | what it can do |
| --- | --- |
| `observe` | read tools (screener, token, dossier, holders, trades, candles, rugcheck, dev history, the analysis packs `analyze_token` / `narrative_board` / `rug_backtest`, KB, cases, LARP checks) and live stream subscriptions |
| `annotate` | + non-financial UI navigation and the agent's own notes/tags on coins |
| `propose` | + proposals (alerts, order-plan drafts, watchlist adds) that appear **labelled with the agent** and that **you** confirm with a keypress |

No tier can arm, sign, send, raise or change a cap, change the gate, or reach a wallet/mandate/signer: no such tool exists in the table, and a "never-list" refuses the *shape* of such a request before any lookup.
