---
id: docs-scan
title: AI scan mode
kind: docs
page: scan
page_title: AI scan mode
url: https://dexterm.xyz/docs/scan
tags:
  - docs
  - scan
  - mode
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/scan.md
date: 2026-10-16
---

An observe-only watcher that scores every coin on screen, pulls up the one that lights up, and keeps analysing it.

AI scan mode watches the screener for you: it scores every coin from data the app already holds, and when one crosses the line it opens that coin's token screen and starts a short analyst read. It is **off by default**, it adds **no network requests**, and it is **observe-only**: a scan session can never open a ticket, sign, confirm or trade. Four structural layers enforce that, not a prompt.
