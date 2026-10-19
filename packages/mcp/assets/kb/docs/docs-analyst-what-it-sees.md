---
id: docs-analyst-what-it-sees
title: The analyst › What it sees
kind: docs
page: analyst
page_title: The analyst
heading: What it sees
anchor: what-it-sees
url: https://dexterm.xyz/docs/analyst#what-it-sees
tags:
  - docs
  - analyst
  - sees
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

Every turn carries a firewalled **CONTEXT** block: the screen you are on, the filter and sort, the selected or hovered coin, the visible rows (price, change, liquidity, volume), your watchlist, and any open PAPER ticket or position. So "this coin", "it" and "the highlighted one" resolve without asking. Token names, descriptions, socials, RugCheck text and fetched page text are wrapped as `<untrusted>` data before the model sees them; instruction-like text inside such a block is itself reported as a red flag (`injection_detected`) and never followed.

Facts come only from tools. The system prompt forbids token facts from model memory: every number, address, flag and level must come from a tool result in the session, each carrying its source and age. The knowledge base explains mechanics and patterns; it never holds a fact about a live token.
