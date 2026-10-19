---
id: docs-paper-trading-the-ticket
title: Paper trading, live trading and the safety model › The ticket
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: The ticket
anchor: the-ticket
url: https://dexterm.xyz/docs/paper-trading#the-ticket
tags:
  - docs
  - paper-trading
  - ticket
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

`B` or `S` on a token opens a buy or sell ticket. It shows the side, the size (SOL or % of balance when buying; % of the position when selling), slippage in bps, and a rolling Jupiter quote refreshed every (generated from the app: see https://dexterm.xyz/docs/paper-trading#the-ticket; app-help has the exact keys and commands) s while you edit: what you pay, what you receive, price in SOL and USD, price impact (as a percent; Jupiter reports a 0..1 fraction and the app converts it once), the simulated fee, the route and the minimum received. Keys: digits type, `tab` switches field, `←`/`→` flips the side, `u` toggles the unit, `⏎` reviews, `esc` cancels, `L` flips PAPER ⇄ LIVE (see below). Token amounts are shown as quantities, so a small buy of an expensive token reads `0.0144 AVGOx`, never `0`; until the token's decimals are known the ticket says so instead of printing a guess.

The **confirm gate** is on by default. `⏎` arms the order; `y` (or `⏎` again) confirms. For a notional above (generated from the app: see https://dexterm.xyz/docs/paper-trading#the-ticket; app-help has the exact keys and commands) SOL you must type the size back digit for digit before the confirm counts. Any other key during the confirm step cancels the arm: a stray key can never confirm, and `q` or a screen number cannot navigate out from under an armed order. The fill is computed from a **fresh quote at confirm time**, never from the quote on screen, and is booked into the paper wallet in one SQLite transaction. If Jupiter rate-limits during the confirm the ticket says so, retries for up to 8 s, then lands in an error state you can retry or cancel; it never hangs.
