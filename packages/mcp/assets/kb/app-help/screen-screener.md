---
id: screen-screener
title: The screener screen
kind: app-help
screen: screener
feature: screener
tags:
  - app-help
  - screen
  - screener
  - the
  - screener
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
  - f
  - /
  - \
  - s
  - ]
  - right
  - l
  - [
  - left
  - h
  - r
  - w
  - b
  - y
  - x
  - P
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
  - goto.open
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
  - view.toggle
  - filter.edit
  - filter.clear
  - sort.menu
  - preset.next
  - preset.prev
  - refresh
  - watch.add
  - alert.propose
  - alert.confirm
  - alert.dismiss
  - screen.positions
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
  - screener_query
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

The live table of Solana tokens (DexScreener + Jupiter, refreshed every ~10 s): price, 5m/1h/6h/24h change, volume, liquidity, market cap, age, holders, organic score, flags and a sparkline, with a p(rug) column. Cells whose source is down show a dash and the caption says why — never a fabricated number.

Keys on this screen:
  `q/^C` — quit
  `1` — screener
  `2` — new pairs
  `3` — watchlist
  `4` — analyst
  `tab` — screens
  `j/↓` — move
  `k/↑` — move
  `home` — top
  `G/end` — bottom
  `g` — go to coin
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
  `f` — simple ⇄ full table
  `/` — filter
  `\` — clear filter
  `s` — sort
  `]/→/l` — preset
  `[/←/h` — preset
  `r` — refresh
  `w` — watch
  `b` — alert
  `y` — confirm alert
  `x` — dismiss alert
  `P` — positions
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
