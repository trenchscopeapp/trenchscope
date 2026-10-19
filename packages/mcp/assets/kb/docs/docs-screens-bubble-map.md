---
id: docs-screens-bubble-map
title: Screens tour › Bubble map
kind: docs
page: screens
page_title: Screens tour
heading: Bubble map
anchor: bubble-map
url: https://dexterm.xyz/docs/screens#bubble-map
tags:
  - docs
  - screens
  - bubble
  - map
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

`M` on a token opens the holder graph. Each of the top token accounts (merged by owner) is a disc whose **area is its share of supply**, drawn on a half-row pixel grid so it is round in the terminal without any image protocol. **Colour is the rule that labelled the wallet, never a judgement:** yellow dev / dev-linked, magenta bundle, green linked by a shared funder (orange for a direct transfer), red sniper, cyan pool / LP / program-owned vault, grey exchange or multi-token whale, dim unlinked. Linked wallets sit inside a dotted ring with a tag like `B·C1 6w 12.0%`; `j`/`k` select a holder (phosphor, with dotted edges to its cluster mates), `m` flips to a treemap (share, not linkage), `z` zooms the selected cluster, `D` forces a deep scan, `r` rescans, `M` opens the popup window (https://dexterm.xyz/docs/popup-chart#bubble-map-popup).

The rules (from the task-1286 spike, replay-tested against its recordings): **P1 pool** (the selling counterparty in ≥ 25 % of launch transactions), **D1 creator** (fee payer of the first transaction referencing the mint), **R1 funder** (two holders share a funding source; a shared exchange funder is a veto, not a link), **R1b** (a holder funded another holder), **R2 bundle** (same-slot buys **and** a shared funder; same-slot alone is a cohort), **R3 transfer** (a direct token move between two holders, pools excluded), **R4 dev-linked** (funded by the creator), **R5 same-slot-created** (weak, shown, never links), **S1 sniper** (bought in the first 3 slots after the first pool trade), **F1 fresh-at-buy** (the wallet's first transactions already move this token), **X1 multi-token-top20**, and **L0** static lists. The **WHY THIS LABEL** panel leads with the holder's class (POOL, CURVE, VAULT, LOCK, CEX, BURN, DEV, LINKED or UNLABELLED) and the on-chain reason, then prints each rule with its confidence (`on-chain`, `program-authority`, `derived`, `seed`, `weak`) and up to three evidence lines; exchange labels come from a typed seed list and always read **unverified**. Cabal-class labels (cabal-candidate, smart, bot, follower, call-group) are hidden until their precision is measured.

**HOLDER INSIGHTS** print their sample every time (`sample top 20 accts of 142.5K holders · 55% supply · funders 7/20 · launch 300 txs`): top-10 raw (by token account, the explorer number), **ex-pool** (POOL / CURVE / VAULT / LOCK / BURN owners dropped; the cluster-adjusted figure, with linked owners merged and exchanges dropped too, rides underneath), a red **main risk** line when a counted owner holds more than 30 %, snipers, bundled supply, dev share (an upper bound when the creator is outside the sample) and fresh wallets. The token screen's Snipers and Bundled supply rows, the new-pairs SNIPE / BUNDLE columns and the `I` token popup read the same scan.

Two scan tiers, both through the limiter, the health registry and the Helius credit meter: **light** when a token opens (top-20 accounts, owner kinds, funders for the 7 largest wallets, the first 100 launch transactions; about 80 credits, less once funders are cached, since a wallet's first inflow never changes) and **deep** for watchlist coins or on `D` (every top wallet, 300 launch transactions). Funders and the launch window are Helius-only (`getTransactionsForAddress`): **keyless, the map still draws** from the public RPC holder list with static labels and says plainly that a free Helius key adds funders and the launch window; when no endpoint serves the ranked holder list at all, the screen says `unavailable` with the reason and the fix, never a fake map.
