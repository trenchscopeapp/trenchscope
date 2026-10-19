---
id: docs-scorecard-rug-verdict-rules
title: Public measurement scorecard › Frozen task-1401 evaluation › Rug verdict rules
kind: docs
page: scorecard
page_title: Public measurement scorecard
heading: Rug verdict rules
anchor: rug-verdict-rules
url: https://dexterm.xyz/docs/scorecard#rug-verdict-rules
tags:
  - docs
  - scorecard
  - rug
  - verdict
  - rules
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

For the shipped rules, warning grades had precision **28.6% (95% CI 20.3%–38.6%)** and recall **42.6% (95% CI 31.0%–55.1%)** on the held-out split. The confusion matrix is 26 true positives, 65 false positives, 35 false negatives and 202 true negatives.

The strongest measured split was low liquidity: `SPECULATIVE` had 23/42 bad outcomes, **54.8% (95% CI 39.9%–68.8%)**. `WATCH` had 34/236, **14.4% (95% CI 10.5%–19.5%)**. Dev percentage, organic score and top-10 concentration did not predict a worse 72-hour outcome in this dataset; they now lower confidence instead of setting the verdict.
