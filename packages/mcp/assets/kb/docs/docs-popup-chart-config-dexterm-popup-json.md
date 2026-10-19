---
id: docs-popup-chart-config-dexterm-popup-json
title: Popup chart › Config: ~/.dexterm/popup.json
kind: docs
page: popup-chart
page_title: Popup chart
heading: Config: ~/.dexterm/popup.json
anchor: config-dexterm-popup-json
url: https://dexterm.xyz/docs/popup-chart#config-dexterm-popup-json
tags:
  - docs
  - popup-chart
  - config
  - dexterm
  - popup
  - json
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

```json
{
  "hotkey": "(generated from the app: see https://dexterm.xyz/docs/popup-chart#config-dexterm-popup-json; app-help has the exact keys and commands)",
  "hotkeyClose": "(generated from the app: see https://dexterm.xyz/docs/popup-chart#config-dexterm-popup-json; app-help has the exact keys and commands)",
  "dock": { "enabled": true, "width": (generated from the app: see https://dexterm.xyz/docs/popup-chart#config-dexterm-popup-json; app-help has the exact keys and commands), "follow": true, "followEvery": (generated from the app: see https://dexterm.xyz/docs/popup-chart#config-dexterm-popup-json; app-help has the exact keys and commands) },
  "rain": { "enabled": true, "speedScale": 1, "density": (generated from the app: see https://dexterm.xyz/docs/popup-chart#config-dexterm-popup-json; app-help has the exact keys and commands) },
  "fpsCap": (generated from the app: see https://dexterm.xyz/docs/popup-chart#config-dexterm-popup-json; app-help has the exact keys and commands)
}
```

Everything is optional; a missing or malformed file falls back to these defaults and never stops a popup from opening. An empty hotkey string disables that chord. `DEXTERM_HOME` moves the directory.
