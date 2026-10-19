---
id: docs-scorecard-source-and-rebuild
title: Public measurement scorecard › Source and rebuild
kind: docs
page: scorecard
page_title: Public measurement scorecard
heading: Source and rebuild
anchor: source-and-rebuild
url: https://dexterm.xyz/docs/scorecard#source-and-rebuild
tags:
  - docs
  - scorecard
  - source
  - rebuild
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

- Frozen data and report: `packages/packs/eval/skills-eval.json` and `packages/packs/eval/skills-backtest.json`.
- Rolling skill care: `packages/packs/eval/skill-care-latest.json`.
- Method details: LARP and skill evaluation (https://dexterm.xyz/docs/larp#measured-accuracy).

`dexterm/scripts/docs-sync.sh` regenerates this page before rebuilding the analyst docs knowledge base. `npm run docs:check` compares this file byte-for-byte with the generator output, so edited claims or favorable rounding fail the check.
