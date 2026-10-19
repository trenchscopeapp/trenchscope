---
id: docs-larp-timestamped-follow-up-drafts
title: LARP detector › Timestamped follow-up drafts
kind: docs
page: larp
page_title: LARP detector
heading: Timestamped follow-up drafts
anchor: timestamped-follow-up-drafts
url: https://dexterm.xyz/docs/larp#timestamped-follow-up-drafts
tags:
  - docs
  - larp
  - timestamped
  - follow-up
  - drafts
  - detector
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/larp.md
date: 2026-10-16
---

`dexterm larp-detected --out DIR` is a local, offline review pipeline over your recorder history. The cron-ready equivalent is `node scripts/larp-detected.mjs --out DIR`; dexterm does not install a schedule. It does not connect to X, open a composer, upload, schedule or post.

For each coin, the command scores only the point-in-time recorder row with the named `H1-v0.1` heuristic, then joins it only to a later recorder outcome at the chosen horizon (72 hours by default). It keeps one flag per short-mint identifier. Every PNG and text report carries the original UTC timestamp, model label, source, evidence age, outcome tier and follow-up horizon. The batch line states both sides of the same dataset: how many flagged coins met the follow-up condition and how many did not. Below 50 unique flags, the sample is thin and the command writes no drafts.

By default it writes at most three Markdown drafts and three cards. Coin names, tickers and full addresses are omitted; the identifier is first four plus last four mint characters. The copy says “recorder label” rather than asserting what a project or person did. `node scripts/scan-larp-detected.mjs DIR` scans every draft and report for full addresses, handles, cashtags, identity/path leaks, trading language, accusations and market claims.

`dexterm larp-detected --live MINT --out DIR` performs one read-only, keyless market lookup and writes a **graded now** card. It explicitly says there is no later outcome yet. This path does not touch a wallet, trading, the signer, arming, voice or agents.

> warn: H1 is a heuristic model output and a risk flag, not a certificate. The files are drafts for human review. Nothing is posted automatically.
