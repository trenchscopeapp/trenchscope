---
id: docs-copy-trading-stage-1-follow-a-wallet-see-what-it-does
title: Copy trading (staged, personal, paper by default) › Stage 1: follow a wallet, see what it does
kind: docs
page: copy-trading
page_title: Copy trading (staged, personal, paper by default)
heading: Stage 1: follow a wallet, see what it does
anchor: stage-1-follow-a-wallet-see-what-it-does
url: https://dexterm.xyz/docs/copy-trading#stage-1-follow-a-wallet-see-what-it-does
tags:
  - docs
  - copy-trading
  - stage
  - follow
  - wallet
  - does
  - copy
  - trading
  - staged
  - personal
  - paper
  - default
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/copy-trading.md
date: 2026-10-16
---

Press `U` anywhere for the **FOLLOWED WALLETS** screen, or use the shell:

```
dexterm follow add <addr> --name "my label"
dexterm follow list | stats <addr> | trades <addr> | remove <addr> | purge --yes
```

- **Your list, your labels.** A label is whatever you type, passed through the prompt firewall (an instruction-shaped label is refused, control characters are stripped, 24 characters at most). dexterm never infers who a wallet is, never scrapes X or Telegram to attribute one, and never exports the list. `purge` deletes every follow and label; the file is `~/.dexterm/follows.json` (mode 600).
- **Decoded swaps.** The tracker reads the wallet's own recent history (Helius `getTransactionsForAddress`, 10 credits a call, newest first, through the data layer's limiter and credit meter) and classifies each transaction from the wallet's own balances: tokens up and SOL down is a **buy**, tokens down and SOL up a **sell**, tokens moved without a SOL leg a **transfer** (an airdrop is flagged as cost 0), tokens and SOL moving the *same* way is **lp-like** (an LP add or removal, never a swap), and two mints in one transaction is a **token-swap** with no SOL split, so nothing unpriceable is priced. Wrapped SOL is never a mint. The POPCAT recording from the wallet-intel spike is the regression case for the lp-like rule: its busiest launch signer *receives* tokens and SOL together.
- **Numbers with their sample.** Realised PnL is FIFO by token amount over the history fetched, in SOL exactly and in USD at today's rate (the rate is printed). Fees and tips are inside the SOL leg. Win rate is wins over closed positions and stays hidden under n = 10 (the row shows `n<10 (2/4)`). The early-entry score needs the token's launch-window buyer ranks (a bubble-map scan) and shows `—` with the reason otherwise; it has no "reached 3×" filter yet and says so. Every figure carries `all N txs` or `last N txs only · older history not fetched`.
- **Alerts, not news.** The first look at a wallet backfills history silently. Only transactions that appear *after* that raise an alert, as a toast anywhere in the app and on the screen's ALERTS tape with the lag between the block and the moment dexterm saw it. Keyless, the tracker is honestly **unavailable** and says how to get the free Helius key; a failed poll shows on the row and the next poll retries.

- **Hold time.** The median time from first buy to last sell over the wallet's **closed** positions. A position counts only when both of those trades carry a real block time. Otherwise hold time shows `—` with the reason. It appears in `dexterm follow stats` and the detail view.
- **Buy and sell alerts, pushed if you want.** A new trade by a followed wallet raises the in-app alert as before. If you have enabled a push channel (https://dexterm.xyz/docs/configuration#push-alerts-and-dexterm-watch) (desktop, your own Telegram bot or Discord webhook), the alert is delivered there too, marked buy or sell and "not a recommendation". This happens only while the dexterm terminal is running: `dexterm watch` runs your rules headless but does not follow wallets. Delivery is read-only: an alert cannot open, arm or sign anything.
- **Per-wallet detail.** `⏎` on a followed wallet opens its detail view: recent decoded trades, positions, realised PnL, win rate with its n, hold time, early-entry score and open positions. Each figure is labelled with its source (Helius history) and data age. `↑`/`↓` scroll, `⏎` or `esc` close.

Nothing on this stage trades. A wallet's past fills say nothing about its next one, and the screen says so.

`H` on this screen makes a PnL card (https://dexterm.xyz/docs/paper-trading#pnl-cards) for the selected wallet's coins, stamped **TRACKED WALLET** (read-only observation), with the wallet address hidden unless you show it. To mark an open position it looks up the coin's public decimals and price (the same keyless lookup the mirror ticket uses).
