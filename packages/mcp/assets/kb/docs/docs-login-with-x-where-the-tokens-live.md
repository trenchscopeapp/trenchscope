---
id: docs-login-with-x-where-the-tokens-live
title: Login with X › Where the tokens live
kind: docs
page: login-with-x
page_title: Login with X
heading: Where the tokens live
anchor: where-the-tokens-live
url: https://dexterm.xyz/docs/login-with-x#where-the-tokens-live
tags:
  - docs
  - login-with-x
  - where
  - tokens
  - live
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

`~/.dexterm/x/tokens.json` (mode `600`, directory `700`; `DEXTERM_HOME` moves it) next to `client-id`. The access token lasts two hours and is refreshed with the refresh token when needed; X may rotate the refresh token, so the record is rewritten. Tokens are never printed, never written to any log or recording, never put on a command line, and never part of what the analyst sees (the analyst gets firewalled post text inside `<untrusted>` blocks, nothing else). If X answers `401`, the header says `login revoked or expired at X · dexterm x login` and nothing is read until you log in again. You can also revoke at `x.com/settings/connected_apps`.
