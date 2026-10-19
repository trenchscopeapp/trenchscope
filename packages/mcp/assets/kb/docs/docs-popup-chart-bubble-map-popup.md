---
id: docs-popup-chart-bubble-map-popup
title: Popup chart › Bubble map popup
kind: docs
page: popup-chart
page_title: Popup chart
heading: Bubble map popup
anchor: bubble-map-popup
url: https://dexterm.xyz/docs/popup-chart#bubble-map-popup
tags:
  - docs
  - popup-chart
  - bubble
  - map
  - popup
  - chart
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/popup-chart.md
date: 2026-10-16
---

`M` on the bubble map screen (https://dexterm.xyz/docs/screens#bubble-map) opens the same holder graph as real circles in a second HUD window (the chart can stay open). Hover a bubble for the rule behind its colour; click to select it, and the terminal selects the same holder; `m` flips to a treemap, `z` zooms the selected cluster, `esc` closes. The strip under the map carries the sample-captioned insights (top-10 raw and ex-pool, and the main-risk line when a counted owner holds more than 30 %) and a WHY THIS LABEL panel that leads with the selected holder's class (POOL, CURVE, VAULT, LOCK, CEX, BURN, DEV, LINKED or UNLABELLED) and its on-chain reason, then every rule, confidence and evidence line. The page receives a **text-only view model** over the local WebSocket (addresses, shares, rule text, numbers): no keys, no URLs, no fetches of its own; an unavailable or degraded scan shows a banner and never a fake map. Same server, ticket, CSP and event allow-list as the chart; the only event the page may send back is the validated address of a clicked holder.
