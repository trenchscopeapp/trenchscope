---
id: docs-popup-chart-docking-macos
title: Popup chart › Docking (macOS)
kind: docs
page: popup-chart
page_title: Popup chart
heading: Docking (macOS)
anchor: docking-macos
url: https://dexterm.xyz/docs/popup-chart#docking-macos
tags:
  - docs
  - popup-chart
  - docking
  - macos
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

The window opens flush right of your terminal window with the same top and height; left of it when the right has no room; pinned at the screen edge (on top) when neither side fits; at the main screen's right edge when the terminal is not Terminal.app or iTerm2. It follows the terminal while open (one lightweight loop, about 0.3% CPU) until you drag the chart's title strip. It has no Dock icon. The terminal may ask once for Automation permission to read its own window bounds; if you deny, the chart opens at the screen edge instead of docked.
