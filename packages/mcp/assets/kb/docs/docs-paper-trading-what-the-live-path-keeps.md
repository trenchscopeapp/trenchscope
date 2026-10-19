---
id: docs-paper-trading-what-the-live-path-keeps
title: Paper trading, live trading and the safety model › What the live path keeps
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: What the live path keeps
anchor: what-the-live-path-keeps
url: https://dexterm.xyz/docs/paper-trading#what-the-live-path-keeps
tags:
  - docs
  - paper-trading
  - live
  - path
  - keeps
  - paper
  - trading
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

These are the invariants from the spec; hold us to them:

1. **Non-custodial.** You hold the keys. dexterm builds, simulates and hands off; your wallet signs. The Phantom bridge stores only your public key.
2. **Keypress gate on by default.** Models and voice create proposals; arming needs a physical keypress or a wallet approval. Opting out, if ever offered, needs an explicit "this is less safe" confirmation, is local, logged and reversible, and the signer caps still apply.
3. **Caps live in the signer, not the UI.** The signer re-simulates and re-checks every transaction (per-trade and daily USD caps, price-impact and slippage ceilings, the SOL-out cap, the token-balance diff, a positive description of what a Jupiter swap looks like: exactly one route instruction bound to your order, no token transfers, burns or approvals to anyone) and refuses out of policy even if the UI, the model or a popup is compromised.
4. **The AI has no interface to the signer.** No build, sign or send tool exists for the model. Its write-shaped tools are paper only: `open_ticket` opens a PAPER ticket, and (from 0.1.5, only if you start `--agent-paper` on a mandate you armed) an agent you connected can use the `paper_*` tools to book the **simulated** ledger inside that mandate. A registry test enumerates every MCP tool and fails if any could reach a signing, sending or cap-changing path, and the paper path imports nothing signer-shaped. Even on a live-capable context the model's ticket yields a paper ticket and the signer is never called. The scan mode and the MCP server import nothing signer-shaped.

> warn: paper results are not predictive, and live results are real. Paper fills take the quote at its word; a real fill pays real slippage, priority fees and failed transactions, and most memecoins go to zero. Nothing here is financial advice.
