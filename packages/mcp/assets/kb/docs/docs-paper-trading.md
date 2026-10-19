---
id: docs-paper-trading
title: Paper trading, live trading and the safety model
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
url: https://dexterm.xyz/docs/paper-trading
tags:
  - docs
  - paper-trading
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

The PAPER ticket, the simulated wallet, the confirm gate; the LIVE path behind a separate signer process (devnet first), and the invariants it keeps.

Trading in dexterm is **PAPER by default**: a simulated wallet priced from live, keyless Jupiter quotes. Nothing is signed, no key is held, no transaction is sent, and the paper code imports no wallet or signing library of any kind. Every ticket and positions frame says so in a banner that is never hidden.

A **LIVE** path exists on main, devnet first and labelled in progress: your own Phantom signs, a separate signer process holds the caps, and a Jupiter swap (a mainnet transaction) is refused unless you start dexterm with `--mainnet`. It is described in Live trading (devnet first) (https://dexterm.xyz/docs/paper-trading#live-trading-devnet-first) below.

PAPER positions on sample data
