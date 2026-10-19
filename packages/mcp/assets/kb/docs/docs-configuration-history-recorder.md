---
id: docs-configuration-history-recorder
title: Configuration and files on disk › History recorder
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: History recorder
anchor: history-recorder
url: https://dexterm.xyz/docs/configuration#history-recorder
tags:
  - docs
  - configuration
  - history
  - recorder
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

In live mode dexterm keeps a local history of what it saw, for the rug model and backtests on the roadmap (https://dexterm.xyz/roadmap/): a row per coin when its price, liquidity, holders or volume changed materially (plus an hourly anchor), which feeds listed it, and a code-only outcome label per anchor at 1 h, 2 h, 6 h, 24 h and 72 h (no model is involved). It lives in the same `--db` file; nothing is uploaded.

- **Requests:** recording reuses data the screens already fetched. Outcome checks re-ask DexScreener about coins whose window is due, at the lowest priority inside the app's own limiter: at most 6 calls a minute and 1,500 a day, skipped while DexScreener is rate-limiting.
- **When it runs:** the first maintenance pass (outcome check, labels, retention) runs 5 seconds after launch and then once a minute, and quitting labels whatever is due before the database closes. Until 2026-10-12 the first pass waited a full minute and nothing ran at quit, so two days of short runs on the development machine left 1,676 anchors and 0 outcomes; `dexterm recorder label` labels an older database's backlog in one go.
- **Size:** measured at about 100 MB per 8-hour live day with the current rules. Raw JSON is dropped after 7 days, rows are thinned to one per coin per minute after 24 hours, and columns expire after 90 days; outcome labels are kept. `dexterm recorder stats` shows the size, `dexterm recorder prune` runs retention now.
- **Off:** `--no-recorder` or `DEXTERM_RECORDER=0`. It never runs with `--fixtures`, `--replay` or `--db :memory:`.
- **Export:** `dexterm recorder export` writes one record per anchor with its later outcomes (see the CLI reference (https://dexterm.xyz/docs/cli#subcommands)).
