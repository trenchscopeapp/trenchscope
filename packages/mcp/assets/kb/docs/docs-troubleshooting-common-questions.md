---
id: docs-troubleshooting-common-questions
title: Troubleshooting › Common questions
kind: docs
page: troubleshooting
page_title: Troubleshooting
heading: Common questions
anchor: common-questions
url: https://dexterm.xyz/docs/troubleshooting#common-questions
tags:
  - docs
  - troubleshooting
  - common
  - questions
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/troubleshooting.md
date: 2026-10-16
---

**The screener is empty on first launch.** It should paint cached or skeleton rows within a second. If it stays empty for more than a few seconds, run `dexterm doctor`: the Jupiter bucket allows one call every ~3 s keyless, and a 429 pauses it for 30 s.

**Candles load slowly after switching timeframe.** 5m/15m derive from 1m and 4h/1d from 1h locally, so a switch costs at most one fetch, and the chart goes ahead of background work. GeckoTerminal allows about 10 calls a minute per IP; several dexterm instances on one IP share that.

**The chart popup did not dock.** macOS Automation permission was denied, or the terminal is not Terminal.app or iTerm2; the window opens at the screen edge instead. Drag it where you want it.

**Quitting takes long.** It should take under a second. If it does not, report it with `--verbose` output; the shutdown signal cancels every pending wait.

**Something that looks like dexterm asks for a seed phrase or a wallet connection.** It is not dexterm. The app never asks for keys; see security and trust (https://dexterm.xyz/trust/).
