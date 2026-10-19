---
id: docs-paper-trading-before-you-press-size-vs-caps
title: Paper trading, live trading and the safety model › Live trading (devnet first) › Before you press ⏎: size vs caps
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Before you press ⏎: size vs caps
anchor: before-you-press-size-vs-caps
url: https://dexterm.xyz/docs/paper-trading#before-you-press-size-vs-caps
tags:
  - docs
  - paper-trading
  - before
  - press
  - size
  - caps
  - live
  - trading
  - devnet
  - first
  - paper
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

Since 2026-10-12 (`task-1368`) a LIVE buy ticket prices your size **at the signer's own SOL/USD** (the price its caps are enforced with) while you type, and shows it against the per-trade cap and what is left of the daily cap: `0.04 SOL ≈ $4.32 at SOL $108 · cap $5/trade · $20 left of $20 today`. When the size is over, the line turns red before you build anything: `0.05 SOL = $5.40 > $5 cap: use ≤ 0.043 SOL (f fits it; fees + token-account rent counted)`. `f` sets that size. The fit is the cap divided by the price minus 0.0025 SOL, rounded down to three decimals: the signer prices the *larger* of your planned SOL leg and the SOL the simulation actually moves out of the wallet, and a first buy of a token adds a token-account rent (0.00204 SOL) plus the fees on top of the size, so a size that is exactly the cap in USD would be refused at precheck. The daily remainder binds when it is smaller than the per-trade cap; with no SOL/USD from the signer the line says `$?` and the signer will refuse an unpriced trade on mainnet. The ticket's verdict is a preview; the signer still decides at precheck and again at confirm.
