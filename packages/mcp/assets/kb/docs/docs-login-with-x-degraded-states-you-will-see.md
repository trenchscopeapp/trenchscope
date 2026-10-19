---
id: docs-login-with-x-degraded-states-you-will-see
title: Login with X › Degraded states you will see
kind: docs
page: login-with-x
page_title: Login with X
heading: Degraded states you will see
anchor: degraded-states-you-will-see
url: https://dexterm.xyz/docs/login-with-x#degraded-states-you-will-see
tags:
  - docs
  - login-with-x
  - degraded
  - states
  - will
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

| header | meaning | what happens |
|---|---|---|
| `x-stream ○ logged out` | no login | keyless venues, news and on-chain rows only |
| `x-stream ●4s @you` | reading | the age is the last successful read |
| `x-stream ◐ rate limited 5m` | X answered 429 or the window is exhausted | reads resume after X's reset time |
| `x-stream ◐ daily budget 3h` | your dexterm budget is spent | reads resume at the next UTC day |
| `x-stream ◐ app tier (no search)` | the app is on the Free tier | identity only; upgrade the app in the X console |
| `x-stream ◐ error` | transport or 5xx | retried with backoff, up to 10 minutes |

Nothing is ever shown as fresh when it is not, and nothing is invented to fill a gap.
