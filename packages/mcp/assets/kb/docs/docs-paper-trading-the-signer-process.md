---
id: docs-paper-trading-the-signer-process
title: Paper trading, live trading and the safety model › Live trading (devnet first) › The signer process
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: The signer process
anchor: the-signer-process
url: https://dexterm.xyz/docs/paper-trading#the-signer-process
tags:
  - docs
  - paper-trading
  - signer
  - process
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

The first LIVE action starts a **separate signer process** with exactly the caps flags you started dexterm with (`--max-usd`, `--daily-usd`, `--max-sol-out`, `--max-slippage-bps`, `--trade-rpc`, `--mainnet`). It talks to the terminal over an authenticated pipe whose only methods are `status · plan · probe · precheck · confirm · drop · panic`: there is no `sign(bytes)`, no `submit`, no `setCaps`, and no way to name a wallet other than the one in the signer's own link file. If the signer dies it is never respawned; LIVE stays off until you restart.

The signer owns: the caps and their hard ceilings; the **daily USD ledger** (SQLite, shared by every dexterm process on the machine, survives a restart); the **kill switch**; its own HTTP client for Jupiter and the RPC; its own **SOL/USD feed** (DexScreener and CoinGecko, timestamped, both required within 3% and under 60 s on mainnet); and the wallet bridge. The network it reports and caps by is classified from the RPC endpoint it actually talks to, by exact hostname, never from a flag or a label.
