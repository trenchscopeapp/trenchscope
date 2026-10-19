---
id: docs-screens-token-screen
title: Screens tour › Token screen
kind: docs
page: screens
page_title: Screens tour
heading: Token screen
anchor: token-screen
url: https://dexterm.xyz/docs/screens#token-screen
tags:
  - docs
  - screens
  - token
  - screen
  - tour
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/screens.md
date: 2026-10-16
---

a token on sample data (the seeded renderer shows the raw tape where the live screen shows the BUY/SELL FLOW panel)

Everything about one coin: candles (1m to 1d, `1`–`6`), market stats, mint and freeze authority from the chain, holder count and top-10 concentration from Jupiter (the ranked top-20 list needs a free RPC key and says so), RugCheck summary, GoPlus second opinion, and in the lower right the **BUY/SELL FLOW** panel: buys versus sells for 1m, 5m, 1h, 6h and 24h with a ratio bar, USD volume and a trend arrow versus the previous window. `F` swaps it for the raw trade tape.

The price badge says **LIVE** only while a fresh on-chain push is flowing for that coin over the fast lane (one WebSocket on its pump.fun bonding curve), otherwise **POLL**. When you hold a PAPER position in the coin a `◈ POSITION · PAPER` row renders under the chart with side, size, value, average entry, price and unrealized PnL.

**Who holds it.** Once the wallet-intel scan (https://dexterm.xyz/docs/screens#bubble-map) lands (about 1.5 s after the token opens), every row of the HOLDERS panel carries a class read from the chain, never guessed: **POOL** (an AMM / CLMM / DLMM pool vault: Raydium, Orca, Meteora, PumpSwap), **CURVE** (a bonding curve: pump.fun, Meteora DBC for Jupiter Studio and Meteora launches, Raydium LaunchLab), **VAULT** (Meteora dynamic and Alpha vaults), **LOCK** (a Streamflow or Jupiter Lock escrow), **CEX** (seed-list exchange wallet, always *unverified*), **BURN** (the incinerator), **DEV** (the creator), **LINKED** (tied to another top holder by a funder, bundle or transfer rule) and **UNLABELLED** for everything else, including an account of a program dexterm does not list. The class comes from the token account's owner and the owner account's program (the same account lookup the scan already makes, no new request); the constant pool-authority addresses are re-derived in the tests. The single Top 10 holders row then becomes two: **Top 10 ex-pool** drops POOL / CURVE / VAULT / LOCK / BURN owners and is what the colour reads, **Top 10 raw** is what explorers show, so a fresh launch whose curve still holds 70 % no longer reads as a 78 % whale. Unlabelled owners are always counted. When a counted owner holds more than 30 % the panel says so on its first line (`⚠ main risk: UNLABELLED Ab12…Cd34 holds 71.6%`); when the biggest holder is a venue it says which (`· top holder 70.0% is CURVE (Meteora DBC): not counted in ex-pool`). A lock or vault names its escrow and program; dexterm does not decode the unlock schedule yet and says so.

When the Snipers and Bundled supply rows have no number they give the reason: `needs Helius key` only when no key is configured, otherwise `Helius paused · r` (rate-limited), `Helius cap today` (the daily credit budget is spent), `history failed · r` (the history call errored) or `no launch txs read`. `r` on the token screen re-runs a scan whose launch window did not land.

Keys here: `B`/`S` PAPER buy/sell, `C` chart popup, `M` bubble map (below), `V` vet the product (LARP detector), `W`/`X`/`T` open the advertised site/X/Telegram, `L` list every advertised link, `y` copy the contract address, `a` run the analyst dossier, `i` or `⏎` type a question, `s` the SOCIAL panel (below), `H` a PnL card (https://dexterm.xyz/docs/paper-trading#pnl-cards) when you have fills in the coin.
