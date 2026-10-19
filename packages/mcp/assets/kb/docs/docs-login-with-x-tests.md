---
id: docs-login-with-x-tests
title: Login with X › Tests
kind: docs
page: login-with-x
page_title: Login with X
heading: Tests
anchor: tests
url: https://dexterm.xyz/docs/login-with-x#tests
tags:
  - docs
  - login-with-x
  - tests
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

The whole flow runs in the test suite against a **mock X server on 127.0.0.1**: PKCE and state checks, single-use 30-second codes, refresh rotation, revoke, 401/429/403 and budget stops, list import, and the firewall on an injection tweet. No test ever contacts x.com, and the default suite blocks `fetch` entirely.
