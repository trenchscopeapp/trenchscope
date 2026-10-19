---
id: docs-screens-2-new-pairs
title: Screens tour › 2 · New pairs
kind: docs
page: screens
page_title: Screens tour
heading: 2 · New pairs
anchor: 2-new-pairs
url: https://dexterm.xyz/docs/screens#2-new-pairs
tags:
  - docs
  - screens
  - new
  - pairs
  - tour
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/screens.md
date: 2026-10-16
---

new pairs on sample data

A push stream of pump.fun creates and migrations from PumpPortal on one WebSocket, plus Jupiter `recent` and RugCheck `new_tokens` polls. Bonding progress is estimated from the curve's virtual reserves at create time and says so. The SNIPE and BUNDLE columns and the spotlight's Snipers and Bundled rows come from the wallet-intel scan (https://dexterm.xyz/docs/screens#bubble-map) of the row your cursor rests on, after about 2 s. The scan only runs with a free Helius key, because only Helius history can read the launch window. An unscanned row shows a dash, a scan in flight shows `…`, and without the key the spotlight says `needs Helius key`. No number is guessed. The highlight follows the coin you picked by mint, so a new arrival never shifts your cursor onto another row.
