---
id: docs-screens-1-screener
title: Screens tour › 1 · Screener
kind: docs
page: screens
page_title: Screens tour
heading: 1 · Screener
anchor: 1-screener
url: https://dexterm.xyz/docs/screens#1-screener
tags:
  - docs
  - screens
  - screener
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

the screener on sample data

A live table of DexScreener + Jupiter rows refreshed every (generated from the app: see https://dexterm.xyz/docs/screens#1-screener; app-help has the exact keys and commands) s through a rate limiter. Columns: price, 5m/1h/6h/24h change, volume, liquidity, market cap, age, holders, organic score, `P(RUG)`, flags, a sparkline. Cells whose source is down show `—` and the panel caption names the column and the reason; safety checks the keyless sources cannot answer render `○ … needs key`, never a pass or a fail.

`P(RUG)` is a **model output, not a fact**: the pre-registered `H1-v0.1` heuristic (an additive points rule, not a learned model) scored from the row's own liquidity, cap, age, holders, organic score, top-10 and dev share and mint/freeze authorities. The panel caption names the model (`p(rug) = H1-v0.1 heuristic`), the spotlight card repeats the value with the model and, on the line under it, how old the scored data is (`p(rug) 0.45 · H1-v0.1 heuristic` / `model output · data 12s old`), and a row with nothing to score shows `—`. Red at or above the model's own flag line (0.50), amber from 0.35. `rug` is a sort key (safest first). Like `FLAGS`, the column is shed first when the table is narrow: with the spotlight open it needs about 184 columns; below that the caption and the spotlight still carry the value and the model id. How well H1 does is measured, not assumed: see backtests (https://dexterm.xyz/docs/analyst#mcp-tools) and the changelog (https://dexterm.xyz/changelog/) for the latest numbers and their sample size.

- `/` opens the filter line. The grammar: space-separated clauses, ANDed. `vol24 > 250K liq > 50K age < 30d org >= 60 launchpad:pump !flag:mint`. Fields and aliases are in the CLI reference (https://dexterm.xyz/docs/cli#filter-grammar). Errors show inline with the column that failed. `\` clears the filter.
- `s` opens the sort menu; `⏎` on the current key flips the direction.
- `\[` and `\`] step through the presets: (generated from the app: see https://dexterm.xyz/docs/screens#1-screener; app-help has the exact keys and commands). Gated presets say why they are unavailable (Graduating waits on the bonding feed; Smart money needs a Tier-1 key).
- `w` watches the highlighted row, `b` proposes a liquidity alert, `⏎` opens the token.
- The cursor resting on a row for a third of a second prefetches that token's candles when the chart source is idle (capped at 3 a minute), so `⏎` paints the chart instantly.
