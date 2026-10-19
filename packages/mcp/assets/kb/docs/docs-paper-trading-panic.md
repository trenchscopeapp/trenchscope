---
id: docs-paper-trading-panic
title: Paper trading, live trading and the safety model › Live trading (devnet first) › Panic
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Panic
anchor: panic
url: https://dexterm.xyz/docs/paper-trading#panic
tags:
  - docs
  - paper-trading
  - panic
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

`/wallet panic` in the app, or `dexterm wallet panic` from any shell, any time: it writes a kill-switch file every signer re-reads on every plan and confirm, locks the shared cap ledger so no reservation can be taken, tells the running signer to forget its plans and flips an open LIVE ticket to refused. The only way back is `dexterm wallet resume` in a real terminal: it needs a physical keypress on a TTY and refuses piped input.
