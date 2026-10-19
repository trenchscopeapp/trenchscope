---
id: docs-login-with-x-free-vs-paid-x-api-tiers-your-bill-your-limits
title: Login with X › Free vs paid X API tiers (your bill, your limits)
kind: docs
page: login-with-x
page_title: Login with X
heading: Free vs paid X API tiers (your bill, your limits)
anchor: free-vs-paid-x-api-tiers-your-bill-your-limits
url: https://dexterm.xyz/docs/login-with-x#free-vs-paid-x-api-tiers-your-bill-your-limits
tags:
  - docs
  - login-with-x
  - free
  - paid
  - api
  - tiers
  - bill
  - limits
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

Login with X gives dexterm **your** per-user rate windows and compliant user-authorized access. It does **not** move cost anywhere: X's pay-per-use pricing bills the developer account that owns the app, and with this design that account is yours. Facts as published by X (check the console; they change):

| tier | what it means for dexterm |
|---|---|
| **Free** | login and identity work (`/2/users/me`), but **search and list timelines are not included**: the app's tier answers `403 client-not-enrolled`, dexterm shows `x-stream ◐ app tier (no search)` and reads nothing. KOL list *import* (`owned_lists`, `members`) is also tier-gated; expect it to fail on Free. |
| **Pay-per-use / Basic and up** | search/recent (300 requests per 15 minutes per user, last 7 days) and list timelines (900 per 15 minutes) work. X bills about **$0.005 per post read** and **$0.01 per user read**, deduplicated per UTC day. |

dexterm keeps its own estimate and a hard stop: the SOURCES panel (`s` on the trending board) shows `@handle · 12/300 search · $0.12 of $10 today`. The default daily budget is **$10** (`DEXTERM_X_DAILY_USD=5` lowers it; `0` means "never read X"); when it is reached the header says `x-stream ◐ daily budget` and reads resume at the next UTC day. The estimate uses X's list prices and counts a post only the first time its id is seen in a day; the X console is the actual bill, so **set a spending limit there too**. At the design cadence a watched coin costs roughly $6 a day and KOL list polling roughly $7 a day on Basic; the 15-minute cache, `since_id` and the 24-hour dedupe table are what keep it there.
