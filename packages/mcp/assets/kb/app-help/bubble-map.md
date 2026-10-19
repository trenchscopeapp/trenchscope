---
id: bubble-map
title: Open the bubble map
kind: app-help
screen: token
feature: bubble-map
tags:
  - app-help
  - bubble
  - bubbles
  - map
  - cluster
  - clusters
  - holders
  - wallets
  - cabal
keys:
  - M
actions:
  - intel.bubbles
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

Press `M` on a token to open the BUBBLE MAP: top holders as discs (area = share of supply, colour = the rule that labelled the wallet), linked-cluster rings, a CLUSTERS table and a WHY THIS LABEL panel. Keyless it uses the public holder list with static labels; a free Helius key adds funders and the launch window.

Keys: `M` (token).
