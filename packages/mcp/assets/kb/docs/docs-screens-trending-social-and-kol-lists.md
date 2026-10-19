---
id: docs-screens-trending-social-and-kol-lists
title: Screens tour › Trending, social and KOL lists
kind: docs
page: screens
page_title: Screens tour
heading: Trending, social and KOL lists
anchor: trending-social-and-kol-lists
url: https://dexterm.xyz/docs/screens#trending-social-and-kol-lists
tags:
  - docs
  - screens
  - trending
  - social
  - kol
  - lists
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

Three views over a social layer that is keyless by default and reads X only through your own login (https://dexterm.xyz/docs/login-with-x). There is no scraping, and nothing is ever posted; every post and headline passes the same prompt firewall as token text before it is stored or shown.

- **`T` TRENDING IN THE SPACE** (from every screen except the token screen, where `T` still opens Telegram). Coins ranked from public lists: Jupiter trending and organic score, GeckoTerminal trending pools, and CoinGecko trending for macro context; a DexScreener paid boost counts *against* a coin. With no posts to count, a coin's velocity falls back to its last-hour volume against its 24 h average. Sub-panels: NARRATIVES (coins linked by shared KOL threads or co-mentions) and NEWS (CoinDesk, Cointelegraph, The Block and Decrypt official RSS, every 10 min; context, not signal). `f` source filter, `x` show the rows held back as spam or cashtag squats, `n` narrative filter, `s` sources and their health, `a` one board summary from your own claude (at most every 5 min), `⏎` open the coin, `M` the feeds popup (https://dexterm.xyz/docs/popup-chart#token-and-feeds-popups).
- **`s` SOCIAL panel on the token screen** replaces ON-CHAIN/HOLDERS. In live mode it holds rule-written on-chain rows only (labelled holders, tracked wallets, trades of $5K or more, and the wallet-intel scan (https://dexterm.xyz/docs/screens#bubble-map)'s linked clusters and launch snipers, each naming the rule that linked them, such as `12.0% of supply sits in 4 wallets that bought in the same slot and share a funder (bundle, R2)`); X and Telegram posts appear only in the `--fixtures` demo, because no keyless post source is wired. Near-duplicates collapse into one row, bursts from fresh accounts are marked spam, and instruction-like posts are withheld from the model entirely.
- **`K` KOL lists**: your own handle lists and imported packs, stored in the local database. A pack is a hash-locked directory and a tampered one is refused. `space` enables or disables a list, `m` mutes a handle, `d` removes one, `i` adds one. The same is scriptable with `dexterm kol` (see the CLI reference (https://dexterm.xyz/docs/cli#subcommands)).

- **X posts** appear in both views after `dexterm x login` (Login with X (https://dexterm.xyz/docs/login-with-x)): the open coin's posts in the SOCIAL panel (searched every 60 s, newer posts only), and your KOL lists' posts on the board. The band shows the state and never pretends: `x-stream ○ logged out`, `●4s @you` while reading, `◐ rate limited 5m`, `◐ daily budget`, `◐ app tier (no search)` on a Free-tier app. On the KOL screen `X` imports the lists your X account owns (handles only) and `o` narrows the board and the panel to the selected handle (`o` again or `f` clears).
