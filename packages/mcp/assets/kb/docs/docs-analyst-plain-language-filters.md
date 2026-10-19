---
id: docs-analyst-plain-language-filters
title: The analyst › Plain-language filters
kind: docs
page: analyst
page_title: The analyst
heading: Plain-language filters
anchor: plain-language-filters
url: https://dexterm.xyz/docs/analyst#plain-language-filters
tags:
  - docs
  - analyst
  - plain-language
  - filters
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

"show me coins under 5M mcap with over 100k liquidity, up on the day, not rugs" becomes a filter in the grammar (https://dexterm.xyz/docs/cli#filter-grammar) applied through `show_in_screener`, and the analyst states the numbers it chose (`low cap → mcap < 5M, safe → lplocked >= 100 !flag:mint !flag:freeze org > 50`). Follow-ups ("tighter", "only ones with locked LP", "drop the age limit") modify the current filter. The app re-parses the string with the real grammar and rejects anything malformed; an invented field never reaches the screener.
