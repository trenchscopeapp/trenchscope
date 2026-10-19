---
id: open-a-coin
title: Open / paste a coin (contract address or link)
kind: app-help
screen: all
feature: go-to-coin
tags:
  - app-help
  - paste
  - open
  - coin
  - contract
  - address
  - ca
  - link
  - pump
  - dexscreener
  - solscan
  - go
  - goto
keys:
  - g
actions:
  - goto.open
flags:
  - --mint
tools:
  - open_token
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

Press `g` to open the go-to prompt and paste a contract address — or a dexscreener / pump.fun / solscan / birdeye link — then ⏎ to open that coin's live token screen, read-only. A CA or link also works in the analyst chat and the screener `/` line. One-shot: `--mint <CA|link>`. Nothing here trades.

Keys: `g` (screener).
