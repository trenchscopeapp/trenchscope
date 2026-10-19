---
id: docs-paper-trading-pnl-cards
title: Paper trading, live trading and the safety model › PnL cards
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: PnL cards
anchor: pnl-cards
url: https://dexterm.xyz/docs/paper-trading#pnl-cards
tags:
  - docs
  - paper-trading
  - pnl
  - cards
  - paper
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

`H` on a token, on the positions screen (`P`) or on the followed-wallets screen (`U`) opens a preview of a **PnL card** for a coin you have fills for: ticker and image, average entry and exit (or the mark for an open position), the PnL %, hold time, size, the dates, and a dexterm footer. It is saved as a 1200×675 PNG (the X card size), a 1080×1080 PNG and a text file in `~/.dexterm/exports/`.

- **The stamp cannot be removed.** A card says where its numbers came from: **PAPER** (the simulated wallet, no real funds), **LIVE** (transactions your own wallet signed, confirmed on chain; a devnet fill says *DEVNET TEST FUNDS*) or **TRACKED WALLET** (a followed wallet's public history, read-only). The stamp is a solid block, the frame colour and a repeating strip, and no option hides it.
- **Numbers come only from the records.** The PnL is computed from the fills, net of fees (realized for a closed position; realized plus unrealized at the latest price mark for an open one, which waits for a mark). You cannot type a number into a card. Each card prints its time window, the fee basis, what it leaves out (a tracked wallet's token-to-token swaps, transfers or airdrops) and the age of its data.
- **Private by default.** The wallet address and LIVE transaction signatures are hidden, and the size shows as a band (`0.5-1 SOL`). `a` shows the wallet and signatures, `z` the exact size; no balance or key is ever on a card.
- **Sharing is yours.** `x` saves the card, copies the image to the clipboard where your OS allows it (macOS; Linux with `wl-copy` or `xclip`) and opens X's compose page in your browser with a short neutral text (the stamp in words, no coin and no numbers). You paste the image and post. dexterm does not post, has no X credentials for this and sends nothing. `t` copies the text version, `s` only saves; `f` flips 16:9 and 1:1, `←`/`→` move between coins, `esc` closes.

A card shows one position's own fills. It is not a track record, and trading in dexterm is still experimental; the footer says so, along with "not financial advice".
