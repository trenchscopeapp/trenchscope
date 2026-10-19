---
id: docs-paper-trading-the-live-fire-path-devnet-the-fast-wallet
title: Paper trading, live trading and the safety model › Order plans and standing mandates › The live fire path (devnet, the fast wallet)
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: The live fire path (devnet, the fast wallet)
anchor: the-live-fire-path-devnet-the-fast-wallet
url: https://dexterm.xyz/docs/paper-trading#the-live-fire-path-devnet-the-fast-wallet
tags:
  - docs
  - paper-trading
  - live
  - fire
  - path
  - devnet
  - fast
  - wallet
  - order
  - plans
  - standing
  - mandates
  - paper
  - trading
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

A standing mandate is meant to fire at machine speed, which a Phantom approval per fill cannot do. So the live path uses a second, **capped fast wallet**: the one key dexterm ever holds, created only by `dexterm wallet fast create` after a real keypress on a TTY, stored at `~/.dexterm/fast-wallet.json` at mode 600, **devnet only** (the record says so, the signer process loads it only against a devnet RPC, and there is no mainnet variant, no export and no import). `dexterm wallet fast status` shows its public key and devnet balance, `dexterm wallet fast airdrop` asks the devnet faucet, `dexterm wallet fast remove` deletes it (refused while it still holds SOL unless `--force`). Your main wallet is never named by a mandate and the fast wallet never signs for it: the signer refuses either crossing before caps, reservation or signing.

`L` on the `O` screen raises the fire-path prompt; a held keypress switches plan fills from PAPER to **LIVE · DEVNET · fast wallet** (and back), journaled as `settings.executor`. The switch is refused by voice, an agent, a pipe or the popup (it takes nothing but a keypress), while any plan is armed or holding (its legs would strand on the other ledger), when the run has no signer process (replay, offline, `--no-live`), when the signer is not on devnet, or when no fast wallet is loaded. Every run starts on paper; the journal never recovers a live switch.

When an armed plan fires on the live path, the engine asks the signer to **build a devnet fill** for its leg. Jupiter has no devnet, so the transaction is the probe's wrap-and-unwrap shape sized to the plan's SOL leg (0.02 SOL for a $3 entry at $150/SOL), with an on-chain memo naming the plan leg; the signer decodes it, runs the probe-shape policy and the program allow-list, simulates it with the fast wallet's token balances, prices the SOL leg from its own SOL/USD feed and **enforces its USD per-trade and daily caps on devnet too** (a fill with no trustworthy price, or above the per-trade or remaining daily budget, is refused and the reason, `per-trade-cap`, `daily-cap`, `no-usd-value`, is what the plans journal records) plus a hard **0.05 SOL per-fill ceiling**. The confirm re-checks and reserves the USD, has the fast wallet sign, verifies the signature and the message, re-simulates the signed bytes, submits and confirms. The engine journals an intent before anything is sent, treats the send as in flight until the signer answers, settles it by lookup and never resends; an outcome the signer could not determine expires in the engine after 90 seconds as unseen (the fast wallet is capped, so exposure is bounded). The plan's **token leg is modelled** from the fire-time price, because no token changes hands on devnet, and the journal labels the fill `devnet-fill` with `modelledTokens: true`, the real signature and the real SOL delta (the fees). A mainnet fill through the fast wallet is refused by construction.

What is proven here, on fakes with the real decoder, the real Ed25519 signer and the real executor pipeline: a fill is built, signed by the fast wallet (Phantom is never asked), confirmed and booked with the USD ledger charged; the ceiling, a missing price, the per-trade cap and the daily cap each refuse before anything signs; a mainnet signer or a missing fast wallet refuses the build; a fast-lane plan confirmed with the main wallet's key, or a main-lane plan built for the fast wallet, is `signer-mismatch`; the whole path works over the real authenticated child-process channel; and the engine-side adapter turns the signer's answers into the journal rows above. What is not: a fill confirmed on devnet with real faucet SOL (the public faucet answered an internal error on the day), and any mainnet action.
