---
id: docs-getting-started-first-run
title: Getting started › First run
kind: docs
page: getting-started
page_title: Getting started
heading: First run
anchor: first-run
url: https://dexterm.xyz/docs/getting-started#first-run
tags:
  - docs
  - getting-started
  - first
  - run
  - getting
  - started
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/getting-started.md
date: 2026-10-16
---

The first launch shows the full glitch boot and then a one-screen welcome card: what dexterm is, the keys that get you around, and the safety stance (non-custodial, your keys never enter dexterm, trading is PAPER by default, not financial advice). Press any key to enter the live screener. Later launches boot in about a second.

- `?` on any screen shows every key for that screen.
- `q` quits. The terminal is always restored, even after a crash or a signal.
- `1`–`4` switch screens, `j`/`k` move, `⏎` opens a token, `esc` goes back.
- `a` asks the analyst about what you are looking at. This is the one explicit, paid run; opening a token with `⏎` never starts one.

The screener paints within a second on a cold start: a cached snapshot of the last rows (marked how old it is), or skeleton rows while the first DexScreener list lands. Jupiter fields fill in behind it.
