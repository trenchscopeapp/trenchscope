---
id: docs-popup-chart-token-and-feeds-popups
title: Popup chart › Token and feeds popups
kind: docs
page: popup-chart
page_title: Popup chart
heading: Token and feeds popups
anchor: token-and-feeds-popups
url: https://dexterm.xyz/docs/popup-chart#token-and-feeds-popups
tags:
  - docs
  - popup-chart
  - token
  - feeds
  - popups
  - popup
  - chart
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/popup-chart.md
date: 2026-10-16
---

`I` on the token screen opens the **token-detail** HUD: identity, price and changes, market cap, liquidity, holders, top-10 and dev share, authorities, the RugCheck score and risks, and the Snipers and Bundled cells from the wallet-intel scan (https://dexterm.xyz/docs/screens#bubble-map). A cell that has not been measured shows its reason: `needs Helius key` only without a key, otherwise for example `Helius paused · r` or `history failed · r`. The window follows the terminal on every token or scan update.

`M` on the trending screen opens the **feeds** HUD: the posts behind the board, filtered and hidden exactly as the SOCIAL panel does it, plus the official news headlines, newest first. Instruction-like posts are withheld. Each row names its source. `↑`/`↓` select, and `⏎` asks the terminal to open that coin.

Both are read-only text views on the same server, ticket, CSP and event allow-list as the chart:

- The page gets text only. Post text is the stored firewalled text, drawn with `textContent`.
- The feeds page never holds a coin address. It sends back an index into the terminal's own list, and the terminal resolves the coin.
- Neither page can trade, sign or fetch.

`I` and `M` toggle the windows, and `esc` in a window closes it.
