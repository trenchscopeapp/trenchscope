---
id: docs-paper-trading-devnet-signer-mainnet-token
title: Paper trading, live trading and the safety model › Live trading (devnet first) › Devnet signer, mainnet token
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Devnet signer, mainnet token
anchor: devnet-signer-mainnet-token
url: https://dexterm.xyz/docs/paper-trading#devnet-signer-mainnet-token
tags:
  - docs
  - paper-trading
  - devnet
  - signer
  - mainnet
  - token
  - live
  - trading
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

Jupiter has no devnet. A Jupiter route is built on **mainnet state** (its accounts, address-lookup tables and blockhash), so a devnet signer can never simulate or fill a swap of a real token: the simulation fails with an RPC error such as `invalid transaction: Transaction loads an address table account that doesn't exist`, and the caps refuse it (`simulation-failed`). The ticket now says this **before** you press ⏎ on any token while the signer is on devnet (`DEVNET cannot fill mainnet tokens: paper trade (L) or restart with --mainnet (real funds, caps $5/$20)`), and when a simulation does fail the PLAN shows the **full** RPC error over several lines (it used to be cut to `invalid transaction: Tr…`) with a plain-English hint when the pattern is this mismatch; the signer also writes the full error to the app log. Your two options are exactly those: paper trade the token with `L`, or run `dexterm --mainnet` with a funded mainnet wallet inside the caps (next section). The devnet signing path itself is proven by the probe, which is built for devnet on purpose.

On **devnet** a Jupiter swap is refused at the caps step (`mainnet-not-enabled`): Jupiter has no devnet, so a real swap is a mainnet action. The signing path is proven on devnet instead by **`dexterm wallet probe`** (or `/wallet probe`): a transaction dexterm builds itself that wraps 0.001 SOL into your own wrapped-SOL account and closes it back, fees only, through exactly the same keypress → Phantom → verify → re-simulate → submit → confirm path, with its own policy (no route allowed) and never on mainnet.
