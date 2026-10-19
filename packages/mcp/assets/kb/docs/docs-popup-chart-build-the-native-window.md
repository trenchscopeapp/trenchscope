---
id: docs-popup-chart-build-the-native-window
title: Popup chart › Build the native window
kind: docs
page: popup-chart
page_title: Popup chart
heading: Build the native window
anchor: build-the-native-window
url: https://dexterm.xyz/docs/popup-chart#build-the-native-window
tags:
  - docs
  - popup-chart
  - build
  - native
  - window
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

```sh
$ cd packages/popup && npm run build:shell     # cargo build --release, about a minute the first time
$ dexterm popup --self-test                     # which path is active, hotkey registration, measured fps
```

`install.sh` builds it when `cargo` is present (`DEXTERM_SKIP_SHELL=1` skips); `dexterm doctor` has a "Chart window" line that says ready or prints the command. `DEXTERM_POPUP_SHELL` points at a prebuilt binary. Without the shell every feature works in the browser; the native window is an enhancement, never a requirement.
