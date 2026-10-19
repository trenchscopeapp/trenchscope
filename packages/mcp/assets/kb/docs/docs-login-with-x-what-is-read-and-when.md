---
id: docs-login-with-x-what-is-read-and-when
title: Login with X › What is read, and when
kind: docs
page: login-with-x
page_title: Login with X
heading: What is read, and when
anchor: what-is-read-and-when
url: https://dexterm.xyz/docs/login-with-x#what-is-read-and-when
tags:
  - docs
  - login-with-x
  - read
  - login
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/login-with-x.md
date: 2026-10-16
---

| what | endpoint (user context) | when | cached |
|---|---|---|---|
| posts about the open coin | `GET /2/tweets/search/recent` with `$SYMBOL OR <mint>` (`-is:retweet -is:reply`) | every 60 s while the token screen is open, only newer posts after the first page | 15 min per query |
| your own X lists as KOL feeds | `GET /2/lists/:id/tweets` | every 5 min per enabled list | 15 min |
| manual KOL lists and packs | `GET /2/tweets/search/recent` with `from:` handles, 20 per query | every 5 min | 15 min |
| importing your lists | `GET /2/users/:id/owned_lists` + `GET /2/lists/:id/members` | only when you press `X` on the KOL screen or run `dexterm kol import-x` | – |
| who you are | `GET /2/users/me` | once at login | – |

Never: a filtered stream (economically unbounded), cashtag firehoses, search for every coin on the board, x.com pages, third-party mirrors. `⏎` on a post opens its URL in your browser; dexterm itself never fetches it.

Every response goes through the rate limiter (one bucket for X, and every `x-rate-limit-*` header updates a per-endpoint window) and the health registry; a `429` pauses reads until X's reset time and the header shows `x-stream ◐ rate limited 5m`. Posts then flow through the social layer exactly like news and on-chain rows: near-duplicates collapse, account bursts are marked spam, cashtag squats are hidden, instruction-like posts are withheld from the model and flagged `INJ` for you.
