---
id: docs-larp-the-verdict
title: LARP detector › The verdict
kind: docs
page: larp
page_title: LARP detector
heading: The verdict
anchor: the-verdict
url: https://dexterm.xyz/docs/larp#the-verdict
tags:
  - docs
  - larp
  - verdict
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

The `larp-check` skill returns a structured assessment: `REAL_PRODUCT` · `EARLY_BUT_REAL` · `LARP` · `UNVERIFIABLE` · `AMBIGUOUS`, with a confidence, a status per claim (supported, contradicted, unverifiable), `missing_data`, the facts and flags it used, `injection_detected` and a short summary. It is separate from the dossier's risk verdict and does not replace it.

Once computed, a badge appears in the screener's FLAGS column and in the token screen's title strip for that mint only: **LARP** (red), **REAL** (green), **REAL?** (mixed), **UNKNOWN** for unverifiable or ambiguous. Nothing shows before you vet a coin. A `LARP` verdict also vetoes an AI scan (https://dexterm.xyz/docs/scan) lock on that coin.

> warn: a LARP verdict is a risk flag, not a certificate. Public HTML cannot prove a working product, a team's identity or who owns an account; domain age, a clean script scan and a GitHub with commits are evidence, not proof, and a real product can still go to zero.
