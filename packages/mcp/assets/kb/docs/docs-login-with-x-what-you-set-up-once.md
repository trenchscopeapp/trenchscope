---
id: docs-login-with-x-what-you-set-up-once
title: Login with X › What you set up, once
kind: docs
page: login-with-x
page_title: Login with X
heading: What you set up, once
anchor: what-you-set-up-once
url: https://dexterm.xyz/docs/login-with-x#what-you-set-up-once
tags:
  - docs
  - login-with-x
  - set
  - once
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

1. **An X developer account** at developer.x.com (https://developer.x.com) (log in with the X account you want to read as).
2. **A Project with an App** of type **Native App** (a *public* client: PKCE only, no client secret ever exists, so nothing secret ships with dexterm).
3. In the app's **User authentication settings**: OAuth 2.0 on, type *Native App*, callback URL **exactly** `http://127.0.0.1:41287/callback` (X requires `127.0.0.1`, not `localhost`, and an exact match), any website URL, and a name/description for the consent screen.
4. Copy the app's **Client ID** and store it (prompted on your terminal; never on the command line):

```sh
$ dexterm x set-client-id       # paste the Client ID when prompted
$ dexterm x login               # opens your browser on x.com; approve; the tab says "linked"
$ dexterm x status              # @handle, scopes, token age, file modes
$ dexterm x logout              # revokes both tokens at X and deletes the local record
```

`dexterm doctor` has a **Login with X** line that tells you which of these is missing.

Scopes requested: `tweet.read users.read list.read offline.access`. Nothing with `write` or `dm` is ever requested, and the app refuses to build an authorize URL with such a scope.
