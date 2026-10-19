---
id: paper-bot
title: Paper-trade the signals in the background (trenchscope bot)
kind: app-help
screen: all
feature: paper-bot
tags:
  - app-help
  - bot
  - paper
  - auto
  - autotrade
  - simulate
  - strategy
  - forward-test
  - pnl
  - scoreboard
  - win
  - headless
  - baseline
commands:
  - bot
flags:
  - --interval
  - --db
  - --verbose
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

`trenchscope bot run [--interval S] [--once|--ticks N] [--db PATH] [--verbose]` is a headless PAPER-trading bot over the live screener feed. Each tick it marks open paper positions with a real Jupiter sell quote and exits on take-profit, stop-loss, a time stop, or when the coin turns AVOID / DEAD / gains a mint or freeze authority; then it enters coins whose safety verdict is NO RED FLAGS and that pass the market filters (mcap, liquidity, age, 1 h change, top-10 share), within the caps (one position per coin, max open, max entries per hour, fixed USD size). Fills are priced from live quotes with fees, never a mid price. A second baseline book takes every coin that passes the market filters alone, so you can see whether the safety checks add value. Every entry and exit is journaled with its reason and the row it read. `trenchscope bot stats [--since 24h|7d|all] [--json]` prints the scoreboard with its sample size (under 20 closed trades it says the result is not yet meaningful), and `trenchscope bot config` lists the strategy knobs (the `bot` section of config.json). Exit alerts go through your `trenchscope alerts` channels. Paper only: it has no key, no wallet and no signer, and nothing is ever sent. Not financial advice.

CLI: `trenchscope bot`.
