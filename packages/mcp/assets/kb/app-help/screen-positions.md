---
id: screen-positions
title: The paper positions screen
kind: app-help
screen: positions
feature: positions
tags:
  - app-help
  - screen
  - positions
  - the
  - paper
  - positions
  - screen
keys:
  - q
  - ctrl+c
  - 1
  - 2
  - 3
  - 4
  - tab
  - j
  - down
  - k
  - up
  - g
  - home
  - G
  - end
  - pagedown
  - ctrl+f
  - pageup
  - ctrl+b
  - enter
  - esc
  - backspace
  - a
  - v
  - m
  - ,
  - <
  - >
  - ?
  - t
  - p
  - $
  - E
  - H
  - w
  - b
  - y
  - x
  - P
  - r
  - Z
  - R
  - T
  - K
  - N
  - O
  - U
  - ctrl+w w
  - ctrl+w n
  - ctrl+w tab
  - ctrl+w N
  - ctrl+w s
  - ctrl+w m
  - ctrl+w o
  - ctrl+w d
  - ctrl+r
actions:
  - quit
  - screen.screener
  - screen.newpairs
  - screen.watchlist
  - screen.analyst
  - screen.next
  - move.down
  - move.up
  - move.top
  - move.bottom
  - move.pagedown
  - move.pageup
  - open
  - back
  - analyst.toggle
  - voice.talk
  - voice.mute
  - voice.cycle
  - voice.rate
  - help.toggle
  - theme.next
  - pause.toggle
  - display.priceMode
  - export.view
  - pnl.card
  - watch.add
  - alert.propose
  - alert.confirm
  - alert.dismiss
  - screen.positions
  - refresh
  - scan.toggle
  - scan.resume
  - screen.trending
  - social.kol
  - screen.narrative
  - screen.plans
  - screen.follows
  - workspace.list
  - workspace.next
  - workspace.prev
  - workspace.save
  - workspace.morning
  - workspace.popups
  - workspace.default
  - screen.rules
tools:
  - paper_positions
  - paper_pnl
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/screens/overlay.ts
date: 2026-10-16
---

Your simulated (PAPER) positions and their P&L. trenchscope holds no keys and signs nothing; paper trading is a simulation for learning the flow. An agent you enabled can read these over MCP with the read-only paper_positions and paper_pnl tools.

Keys on this screen:
  `q/^C` — quit
  `1` — screener
  `2` — new pairs
  `3` — watchlist
  `4` — analyst
  `tab` — screens
  `j/↓` — move
  `k/↑` — move
  `g/home` — top
  `G/end` — bottom
  `PgDn/^F` — page
  `PgUp/^B` — page
  `⏎` — open
  `esc/⌫` — back
  `a` — ask claude
  `v` — voice
  `m` — mute voice
  `,` — change voice
  `</>` — slower / faster voice
  `?` — help
  `t` — theme
  `p` — pause
  `$` — price ⇄ mcap
  `E` — export PNG + report
  `H` — PnL card (share)
  `w` — watch
  `b` — alert
  `y` — confirm alert
  `x` — dismiss alert
  `P` — positions
  `r` — refresh
  `Z` — AI scan
  `R` — resume scan
  `T` — trending
  `K` — KOL lists
  `N` — narrative board
  `O` — order plans
  `U` — followed wallets
  `^W w` — workspaces
  `^W n/^W tab` — next workspace
  `^W N` — previous workspace
  `^W s` — save workspace
  `^W m` — morning HUD
  `^W o` — open workspace popups
  `^W d` — default workspace
  `^R` — rules
  `c` — calm mode (effects off)
  `?` — this help
