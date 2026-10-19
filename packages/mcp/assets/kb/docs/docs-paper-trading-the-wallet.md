---
id: docs-paper-trading-the-wallet
title: Paper trading, live trading and the safety model › The wallet
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: The wallet
anchor: the-wallet
url: https://dexterm.xyz/docs/paper-trading#the-wallet
tags:
  - docs
  - paper-trading
  - wallet
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

- starts at (generated from the app: see https://dexterm.xyz/docs/paper-trading#the-wallet; app-help has the exact keys and commands) SOL (configurable), persisted in the same SQLite file as the cache and watchlist (`--db`; `:memory:` for a throwaway session);
- books every fill append-only with the simulated fee (5 000 lamports per fill, labelled as a simulation);
- marks positions from DexScreener's USD price over the live SOL price every (generated from the app: see https://dexterm.xyz/docs/paper-trading#the-wallet; app-help has the exact keys and commands) s on the positions screen;
- shows a `◈ POSITION · PAPER` row under the chart on any token you hold, and the same row plus entry line and fill markers in the chart popup (https://dexterm.xyz/docs/popup-chart). A confirmed LIVE fill shows the same way, marked live, read from the signer's own ledger.

The analyst can open a PAPER ticket for you (`open_ticket`, pre-filled, editing phase) when you ask it to buy or sell. It cannot size it past what you typed, arm it, confirm it, or flip it LIVE; it tells you to confirm yourself.
