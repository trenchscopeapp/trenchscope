---
id: link-a-wallet
title: Link a wallet for trading (trenchscope wallet)
kind: app-help
screen: all
feature: trading
tags:
  - app-help
  - wallet
  - link
  - unlink
  - phantom
  - connect
  - pubkey
  - caps
  - trade
commands:
  - wallet
flags:
  - --mainnet
  - --max-usd
  - --daily-usd
  - --max-sol-out
  - --max-slippage-bps
  - --trade-rpc
  - --no-live
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

`trenchscope wallet link|unlink|status` links a Phantom wallet through a loopback bridge — your keys NEVER enter dexterm, only the public key is stored — and shows the link and the signer-side trade caps. trenchscope is non-custodial: it builds and simulates transactions, your own wallet signs. The signer-side caps (`--max-usd`, `--daily-usd`, `--max-sol-out`, `--max-slippage-bps`) and the RPC (`--trade-rpc`) bound every trade and live on the signer; `--mainnet` opts in to mainnet and `--no-live` keeps it paper-only. The analyst can never link, unlink, sign, arm or change a cap.

CLI: `trenchscope wallet`.
