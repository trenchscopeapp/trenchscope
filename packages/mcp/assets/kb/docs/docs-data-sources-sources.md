---
id: docs-data-sources-sources
title: Data sources and rate limits › Sources
kind: docs
page: data-sources
page_title: Data sources and rate limits
heading: Sources
anchor: sources
url: https://dexterm.xyz/docs/data-sources#sources
tags:
  - docs
  - data-sources
  - sources
  - data
  - rate
  - limits
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/data-sources.md
date: 2026-10-16
---

| data need | keyless source | free-key upgrade | without it |
|---|---|---|---|
| screener pool | DexScreener + Jupiter Tokens v2 | Jupiter free key: 1 rps instead of 0.5 | fully keyless |
| token market | DexScreener + Jupiter | Jupiter free key: higher rate | fully keyless |
| candles and chart | GeckoTerminal | none | chart `unavailable` (rare) |
| trade tape and buy/sell flow | GeckoTerminal tape; DexScreener rolling windows for 5m to 24h | none | tape `unavailable` |
| mint and freeze authority | public Solana RPC `getAccountInfo` + Jupiter + GoPlus | any free RPC: faster, fewer 429s | Jupiter and GoPlus still answer |
| top holders | Jupiter aggregate: holder count + top-10 % | any free RPC key (Helius, Alchemy, QuickNode, Ankr): the ranked top-20 list with owners | count and concentration shown; the ranked list says "needs a free RPC key" |
| security checks | RugCheck + GoPlus | none | one may be `unavailable`, the other covers |
| new pairs | PumpPortal `subscribeNewToken` + `subscribeMigration`, Jupiter `recent` poll, RugCheck `new_tokens` | Helius: per-curve bonding % | rows from the poll; bonding is a create-time estimate |
| watchlist prices | DexScreener + Jupiter, persisted in SQLite | Jupiter free key: higher rate | fully keyless |
| fast-lane live price | public RPC WebSocket `accountSubscribe` on the pump.fun bonding curve, price computed on-chain | free Helius key: lower latency, higher limits (used first) | the polled price (POLL badge) |
| paper quotes | Jupiter `swap/v1/quote` (quote only; no build, no execute) | Jupiter free key: lower latency | fully keyless |
| product vetting | the token's own site, RDAP, the GitHub API | none | a claim stays unverifiable |
| trending board | Jupiter trending and organic-score lists, GeckoTerminal trending pools, DexScreener top boosts (counted against a coin), CoinGecko trending (macro) | none | a failing venue degrades only itself |
| news | publishers' official RSS: CoinDesk, Cointelegraph, The Block, Decrypt | none | the board works without it |
| social posts (X) | none keyless: dexterm does not scrape | Login with X (https://dexterm.xyz/docs/login-with-x): your own X app and login read posts about the open coin and from your KOL lists (user-context API, your limits, your bill; the Free tier allows identity only) | the live SOCIAL panel shows on-chain rows and news, and the band says `x-stream ○ logged out` |
| dev history, snipers, bundles | none keyless (wallet history is not public without an indexer) | Helius | columns dash + `needs Helius`; with a key, a paused or failed read names itself (`Helius paused · r`, `Helius cap today`, `history failed · r`) |
| holder classes (POOL / CURVE / VAULT / LOCK / CEX / BURN / DEV / LINKED / UNLABELLED) | the owner lookup over any RPC (`getMultipleAccounts`), part of the wallet-intel scan | same | DEV and LINKED need the Helius launch window; the rest work on any RPC that serves the ranked holder list |

The ranked holder list is the one real keyless gap: `getTokenLargestAccounts` is throttled or blocked on every keyless endpoint we probed, and Birdeye and Solscan need keys.
