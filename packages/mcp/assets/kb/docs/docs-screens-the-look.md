---
id: docs-screens-the-look
title: Screens tour › The look
kind: docs
page: screens
page_title: Screens tour
heading: The look
anchor: the-look
url: https://dexterm.xyz/docs/screens#the-look
tags:
  - docs
  - screens
  - look
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

the rain follows the market: gold on a pump

Matrix rain made of your own tickers, mint prefixes and transaction tails lives in the gutters and the blank parts of panels. Its colour and speed come from the data: gold on a pump, red on a dump, driven by the open token's candles or the rows on screen. Two masks on the cell buffer make it impossible for an effect to overdraw a number: data glyphs are marked hard, effects can only write to blank, unmarked cells, and a contrast gate in the test suite proves every numeric cell stays at 4.5:1 or better with effects on.

`c` toggles calm mode (no rain, glitch, blink or scanlines); `--intensity normal` is 15 fps with sparser rain; `NO_COLOR` implies calm. After (generated from the app: see https://dexterm.xyz/docs/screens#the-look; app-help has the exact keys and commands) s without a key the ambient rain drops to (generated from the app: see https://dexterm.xyz/docs/screens#the-look; app-help has the exact keys and commands) fps so an idle terminal costs about 2% CPU; the next key snaps it back.
