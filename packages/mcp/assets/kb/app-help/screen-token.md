---
id: screen-token
title: The token screen
kind: app-help
screen: token
feature: token-intel
tags:
  - app-help
  - screen
  - token
  - the
  - token
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
  - i
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
  - 5
  - 6
  - r
  - B
  - S
  - P
  - W
  - V
  - X
  - T
  - L
  - C
  - I
  - F
  - Z
  - R
  - K
  - N
  - s
  - f
  - M
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
  - input.focus
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
  - tf.1
  - tf.2
  - tf.3
  - tf.4
  - tf.5
  - tf.6
  - copy.ca
  - refresh
  - trade.buy
  - trade.sell
  - screen.positions
  - open.web
  - analyst.larp
  - open.x
  - open.tg
  - open.links
  - popup.chart
  - popup.token
  - tape.toggle
  - scan.toggle
  - scan.resume
  - screen.trending
  - social.kol
  - screen.narrative
  - social.toggle
  - social.filter
  - intel.bubbles
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
  - get_dossier
  - get_token
  - get_holders
  - get_trades
  - get_candles
  - get_dev_history
  - dev_history
  - rugcheck
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

One coin in depth: market stats, a candle chart, the trades tape, mint/freeze authority, top holders with their class (pool/dev/linked/…), RugCheck + GoPlus, snipers/bundled from the wallet-intel scan, and the ANALYST panel. Open it with ⏎ on any live row or `--mint <CA|link>`.

Keys on this screen:
  `q/^C` — quit
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
  `i` — ask
  `?` — help
  `t` — theme
  `p` — pause
  `$` — price ⇄ mcap
  `E` — export PNG + report
  `H` — PnL card (share)
  `w` — watch
  `b` — alert
  `x` — dismiss alert
  `1` — 1m
  `2` — 5m
  `3` — 15m
  `4` — 1h
  `5` — 4h
  `6` — 1d
  `y` — copy CA
  `r` — refresh
  `B` — paper buy
  `S` — paper sell
  `P` — positions
  `W` — open site
  `V` — vet product (Claude)
  `X` — open X
  `T` — open TG
  `L` — links
  `C` — chart popup
  `I` — token popup
  `F` — flow ⇄ tape
  `Z` — AI scan
  `R` — resume scan
  `K` — KOL lists
  `N` — narrative board
  `s` — social
  `f` — filter
  `M` — bubble map
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
