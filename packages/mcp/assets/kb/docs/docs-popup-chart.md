---
id: docs-popup-chart
title: Popup chart
kind: docs
page: popup-chart
page_title: Popup chart
url: https://dexterm.xyz/docs/popup-chart
tags:
  - docs
  - popup-chart
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

A docked native chart window for the open coin, fed only by the terminal, with the browser as the fallback.

`C` on a token opens a chart window for that coin beside the terminal. The chart is TradingView's open-source Lightweight Charts™ (Apache-2.0), vendored into the app and served by a loopback-only server inside dexterm; the window is a 1.2 MB native shell (Rust, wry) when it is built, otherwise your default browser. Either way the page loads **nothing from the network**: candles, the trade tape, the live price and your paper position all come from the terminal's own caches over one local WebSocket.

the chart popup on sample data (headless render of the real page)
