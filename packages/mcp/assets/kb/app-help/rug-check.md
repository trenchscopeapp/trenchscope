---
id: rug-check
title: Check if a coin is a rug
kind: app-help
screen: token
feature: analyst
tags:
  - app-help
  - rug
  - safe
  - honeypot
  - scam
  - risk
  - check
  - authority
  - mint
keys:
  - a
actions:
  - analyst.toggle
tools:
  - analyze_token
  - get_dossier
  - rugcheck
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

Press `a` to run a rug-check on the selected coin: authorities, token program, LP, holder concentration, creator history and tape, with a p(rug) from the H1 heuristic (a ranking, not a calibrated probability). The verdict is WATCH / SPECULATIVE / AVOID. Facts come only from tools; it is not financial advice.

Keys: `a`.
