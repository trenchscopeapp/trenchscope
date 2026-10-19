---
id: docs-scorecard-frozen-task-1401-evaluation
title: Public measurement scorecard › Frozen task-1401 evaluation
kind: docs
page: scorecard
page_title: Public measurement scorecard
heading: Frozen task-1401 evaluation
anchor: frozen-task-1401-evaluation
url: https://dexterm.xyz/docs/scorecard#frozen-task-1401-evaluation
tags:
  - docs
  - scorecard
  - frozen
  - task-1401
  - evaluation
  - public
  - measurement
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/scorecard.md
date: 2026-10-16
---

**Dataset:** 1054 coins observed from 2026-10-10 through 2026-10-13, with a 3-day outcome horizon. The earlier 726 rows were the train split; the later **328 rows were held out**, including 61 bad outcomes. Tuning used train rows only and the code refuses test rows. Rates use 95% Wilson intervals; fewer than 20 rows gets counts only.

Evidence was restricted to a point-in-time token record fetched no more than one hour after t0. Later records were excluded. Labels are keyless recorder proxies, not chain-adjudicated facts.

| Held-out result | Before | Shipped | Reading |
|---|---:|---:|---|
| Links-only LARP MCC | 0.039 | **0.054** | **Weak.** Link shape alone barely separated bad coins from the rest. |
| Rug-rule MCC | 0.043 | **0.159** | Better, but still modest and dataset-specific. |
