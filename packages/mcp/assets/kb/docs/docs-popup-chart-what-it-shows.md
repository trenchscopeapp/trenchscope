---
id: docs-popup-chart-what-it-shows
title: Popup chart › What it shows
kind: docs
page: popup-chart
page_title: Popup chart
heading: What it shows
anchor: what-it-shows
url: https://dexterm.xyz/docs/popup-chart#what-it-shows
tags:
  - docs
  - popup-chart
  - shows
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

- candles, line or area; a volume pane; crosshair with the OHLCV, change and indicator values of the bar under it; wheel and pinch zoom, drag pan; auto, log or percent scale; local-time axis.
- the last-price line, and a dotted **LIVE** price line while the terminal's fast lane is streaming the coin; a `◌ STALE Ns` badge when no tick has arrived for 20 s.
- buy and sell markers from the trade tape, EMA 9/21, VWAP (anchored to the UTC day), a volume 20-MA, horizontal and trend lines you draw (page memory only; they go when the popup closes).
- when you hold a PAPER position in the coin: an ENTRY line labelled with size and PnL %, BUY and SELL fill markers for the current position, STOP and TARGET lines when a ledger sets them, and the same position row the terminal shows under its chart.
- the six timeframes are the popup's own. 5m and 15m are derived from the cached 1m base, 4h and 1d from the cached 1h base, so switching costs no fetch; a base the terminal has not fetched yet shows an honest "warming … no extra requests" banner until it lands. **1s is not offered:** the only trade source is a ≤60-trade tape refreshed at most every 20 s, so 1-second bars would be sparse and stale.
