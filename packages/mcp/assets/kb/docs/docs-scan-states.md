---
id: docs-scan-states
title: AI scan mode › States
kind: docs
page: scan
page_title: AI scan mode
heading: States
anchor: states
url: https://dexterm.xyz/docs/scan#states
tags:
  - docs
  - scan
  - states
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

`off` → `scanning` (a (generated from the app: see https://dexterm.xyz/docs/scan#states; app-help has the exact keys and commands) s warm-up builds the rolling samples; the ticker shows the top five) → `locked` (one coin: its token screen opens, the analyst starts, refreshes follow) → `paused` (`esc`: analysis cancelled, coin held) → `scanning` again only on `R`.

**No-hop rule:** while locked or paused the engine never returns a new lock, even if a higher-scoring coin appears (proven by a test feeding one for 300 ticks). A lock also waits while a PAPER ticket, an overlay, the filter or sort editor, or a half-typed question has the keys, so you are never yanked out of something.
