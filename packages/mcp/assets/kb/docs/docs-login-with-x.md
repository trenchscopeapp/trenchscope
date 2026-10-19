---
id: docs-login-with-x
title: Login with X
kind: docs
page: login-with-x
page_title: Login with X
url: https://dexterm.xyz/docs/login-with-x
tags:
  - docs
  - login-with-x
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

Read X posts in the SOCIAL panel and on the trending board with your own X app and your own login; what to set up, what the free and paid API tiers allow, and what dexterm never does.

dexterm can read X (Twitter) posts about the open coin and from the people you follow as KOLs. It does this **only through your own X developer app and your own X login** (OAuth 2.0 with PKCE, user context). There is no shared key, no dexterm account in the loop, no scraping, and dexterm never posts, likes, follows or reads DMs. Every tweet passes the same prompt firewall (https://dexterm.xyz/docs/analyst) as every other untrusted text before it is stored, shown or summarised.

Without a login nothing breaks: the trending board runs on the keyless venues, the SOCIAL panel shows on-chain rows and news, and the header says `x-stream ○ logged out`.
