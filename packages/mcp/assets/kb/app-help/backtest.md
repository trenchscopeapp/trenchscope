---
id: backtest
title: Backtest the rug model or skills
kind: app-help
screen: all
feature: skill-backtest
tags:
  - app-help
  - backtest
  - eval
  - accuracy
  - model
  - metrics
  - history
commands:
  - backtest
tools:
  - rug_backtest
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

`trenchscope backtest --subject heuristic|skills|larp|pack_verdicts` scores a subject against the recorder's outcome-labelled history and prints honest metrics (precision/recall, Brier vs base rate, AUC, calibration) with leakage checks. With no labelled outcomes it says so and prints no metrics rather than fabricating any.

CLI: `trenchscope backtest`.
