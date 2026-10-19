---
id: docs-scan-safety-four-layers
title: AI scan mode › Safety: four layers
kind: docs
page: scan
page_title: AI scan mode
heading: Safety: four layers
anchor: safety-four-layers
url: https://dexterm.xyz/docs/scan#safety-four-layers
tags:
  - docs
  - scan
  - safety
  - four
  - layers
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

1. The scan session is created with an **empty action-type list**. The shared validator that every analyst action passes through refuses all five UI actions for it.
2. The screen state the MCP server sees carries `actions.types = []`, so every action tool errors inside the server and writes nothing to the action channel.
3. The `claude` launch adds `--disallowedTools` for `open_ticket`, `open_token`, `show_in_screener`, `add_to_watchlist` and `switch_feed`.
4. The app's scan handler re-validates with the same empty list and toasts `AI scan blocked analyst action "…" · observe-only` so you see any attempt.

Statically, the scan code imports nothing from the trade, paper, executor, bridge or wallet modules; a test resolves its whole import closure and fails if a trade import is planted. A compromised-model test feeds a fake `claude` that emits `open_ticket` during a scan and asserts nothing happens, while the same fake opens the PAPER ticket in a normal session.
