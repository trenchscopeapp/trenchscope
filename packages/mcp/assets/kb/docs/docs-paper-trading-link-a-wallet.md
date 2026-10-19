---
id: docs-paper-trading-link-a-wallet
title: Paper trading, live trading and the safety model › Live trading (devnet first) › Link a wallet
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Link a wallet
anchor: link-a-wallet
url: https://dexterm.xyz/docs/paper-trading#link-a-wallet
tags:
  - docs
  - paper-trading
  - link
  - wallet
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

`dexterm wallet link` (or `/wallet link` typed on the screener's `/` line or in the chat box) starts a one-shot server on `127.0.0.1:41291` (a fixed loopback port since `task-1368`; a random one only if it is busy, and the page then says so) with a single-use token, and opens your browser to it. The page asks Phantom to **connect** and **sign a message** (a dexterm nonce): no transaction, no approval of funds. The port is fixed because Phantom remembers which **origins** it trusts: link and every later sign page share `http://127.0.0.1:41291`, so after the first Connect prompt Phantom connects silently. dexterm verifies the Ed25519 proof and stores **only your public key** in `~/.dexterm/wallet-link.json`. `dexterm wallet status`, `unlink`, `/wallet`, `/wallet unlink` show or remove it. No private key, seed or password ever reaches dexterm; it has no code that could hold one.
