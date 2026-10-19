---
id: chart-popup-selftest
title: Run the popup self-test (trenchscope popup --self-test)
kind: app-help
screen: all
feature: popup-selftest
tags:
  - app-help
  - self-test
  - selftest
  - test
  - shell
  - fps
  - diagnose
  - hotkey
commands:
  - popup
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

`trenchscope popup --self-test [--browser] [--seconds N] [--theme NAME]` opens a chart popup on fixture data and reports the shell, hotkey and fps it can measure headlessly, labelling what still needs a human at an unlocked Mac. In-app, open the popup for real with `C` on the token screen (see "Open the chart popup").

CLI: `trenchscope popup`.
