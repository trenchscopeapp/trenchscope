---
id: holder-concentration
title: Holder concentration, top-10 share and funding-source clusters
tags:
  - holders
  - top10
  - concentration
  - bubble-map
  - clusters
  - helius
date: 2026-10-06
confidence: medium
owner: maintainers
origin: primary-doc
reviewed_by: maintainers@2026-10-15
sources:
  - dexterm SPEC.md §3.6 (Top 10 % excludes LP vault and known CEX/bridge addresses)
  - https://spl.solana.com/token (RPC methods getTokenLargestAccounts, getTokenAccountsByOwner, getTokenSupply)
  - https://www.helius.dev/docs/das-api (solana-launchpad/docs/helius/das-api.md; getTokenAccounts by mint)
  - dexterm research/data-firehose-inventory-2026-10-06.md §2 (bubble map from getTransactionsForAddress)
---
**How the numbers are made.** The public RPC's `getTokenLargestAccounts` returns the 20 largest token accounts for a mint (it 429s on the public endpoint in practice); Helius DAS `getTokenAccounts` returns all holders paginated (64 ms per 100 in the inventory probe). A token account is not a person: the LP vault, CEX deposit wallets and bridges hold large balances that are not "one holder". **dexterm's Top-10 % excludes the LP vault and a static allow-list of CEX/bridge addresses** (SPEC §3.6); the tool reports `top10PctExLp`.

**Clusters.** Several wallets funded from the same source (one wallet sending SOL to many fresh wallets shortly before they buy) behave as one holder. dexterm builds this from Helius `getTransactionsForAddress` (first SOL inflow per wallet) and shows it as a bubble map; the Forensics record's `bundledPct` is the same idea restricted to the launch window.

**Thresholds in use (maintainers, reviewed 2026-10-15; rough heuristics, not measured facts):** top-10 ex-LP under ~20 % is broad; 20–35 % is common for a young token; above ~50 % a handful of holders (one group, if they are linked) can decide the exit. Combine with `labelled.dev` and `labelled.sniper` from `get_holders`: 30 % spread over 10 unrelated whales is a different risk from 30 % in one funded cluster.

**What the count hides.** Holder count (`stats.holderCount`, Jupiter) can be inflated cheaply by airdropping dust to thousands of wallets; `holders24hDelta` plus organic score (`wash-trading-fake-volume`) separates growth from dusting.

**Rule:** concentration numbers for a live token come from `get_holders`/`get_token.audit.top10Pct` with their `fetchedAt`; the KB only explains how to read them.
