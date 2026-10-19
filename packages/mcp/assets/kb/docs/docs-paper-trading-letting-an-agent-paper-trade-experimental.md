---
id: docs-paper-trading-letting-an-agent-paper-trade-experimental
title: Paper trading, live trading and the safety model › Letting an agent paper trade (experimental)
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Letting an agent paper trade (experimental)
anchor: letting-an-agent-paper-trade-experimental
url: https://dexterm.xyz/docs/paper-trading#letting-an-agent-paper-trade-experimental
tags:
  - docs
  - paper-trading
  - letting
  - agent
  - paper
  - trade
  - experimental
  - trading
  - live
  - safety
  - model
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

If you want to, you can let an agent connected over `dexterm mcp` run the whole PAPER loop (open, size, confirm and close) inside a **trading mandate** you armed, by starting `dexterm --spectate-mcp --agent-paper <mandate-id>`. It is paper only. The agent can never sign, send a real transaction, touch keys or raise a cap, a size over your caps is refused, and you can pause, take over or stop it at any time. See Agent paper trading (https://dexterm.xyz/docs/agents#agent-paper-trading). It is experimental and off by default, and simulated figures are not a result.
