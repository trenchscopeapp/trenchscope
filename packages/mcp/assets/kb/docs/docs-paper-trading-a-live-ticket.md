---
id: docs-paper-trading-a-live-ticket
title: Paper trading, live trading and the safety model › Live trading (devnet first) › A LIVE ticket
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: A LIVE ticket
anchor: a-live-ticket
url: https://dexterm.xyz/docs/paper-trading#a-live-ticket
tags:
  - docs
  - paper-trading
  - live
  - ticket
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

`L` on a ticket flips it LIVE when a wallet is linked and the signer is alive (otherwise the ticket says why and stays PAPER). The header shows `◉ LIVE · DEVNET`, or `⚠ LIVE · MAINNET — REAL FUNDS` in red with the caps. `⏎` asks the signer for a **PLAN**:

1. **Quote** from Jupiter, bound to your order: the input and output mints, the mode and the exact input amount must match or the plan is refused (`quote-mismatch`).
2. **Build** the unsigned transaction; **decode** it with dexterm's own wire decoder (legacy and v0, lookup tables included).
3. **Policy**: every top-level instruction must fit the shape of a Jupiter swap: exactly one route-family instruction (by Anchor discriminator), token operations limited to SyncNative, InitializeAccount for your wallet and CloseAccount back to your wallet, a System transfer only into your own wrapped-SOL account that is synced and closed in the same transaction, associated-token creation only for your wallet. Transfers, burns, approvals, authority changes, direct DEX calls and unknown programs are refused by name.
4. **Binding**: the route's `in_amount`, `quoted_out_amount` and `slippage_bps` must equal the quote; the platform fee must be zero with the "none" sentinel account (dexterm takes no fee); the transfer authority must be your wallet; the source and destination must be your own associated token accounts for the two mints.
5. **Simulation** against the RPC, with your wallet **and your token accounts** in the requested post-state: the SOL leaving your wallet must not exceed the plan plus a fee allowance nor the SOL cap; a buy may not decrease any of your token balances; a sell may spend only the order mint's account and only up to the order amount (an address a lookup table loads counts as part of the transaction). If the balances cannot be read, the plan is refused rather than guessed.
6. **Price**: the SOL leg times the signer's own SOL/USD, never Jupiter's `swapUsdValue`; on mainnet an unknown or $0 price refuses.

The PLAN screen lists what will be signed instruction by instruction, what you pay and receive, the minimum received, the impact as a percent, the fee including any priority fee, the route, the simulation result, the SOL/USD price and its sources, the policy verdict and the caps verdict ("will be refused: …" when it would be).

`Y` (or `⏎`) is the keypress gate. The signer re-checks the caps, **reserves** the USD against the daily ledger (atomically, so two trades cannot both pass), opens the sign page, and hands the bytes to Phantom. What comes back must be the **same message** with a valid Ed25519 signature by the linked wallet; the only tolerated difference is a Lighthouse assertion tail appended by Phantom. The signed bytes are decoded, policy-checked and bound again, **re-simulated** with fresh token balances, and only then submitted. A transport error after the send keeps the charge and shows the signature with "do not resend"; a definite rejection before broadcast refunds. Plans are single-use and expire after 90 s.
