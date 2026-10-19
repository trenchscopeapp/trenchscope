---
id: docs-screens-how-well-it-predicts-measured-held-out
title: Screens tour › Dev history › How well it predicts (measured, held out)
kind: docs
page: screens
page_title: Screens tour
heading: How well it predicts (measured, held out)
anchor: how-well-it-predicts-measured-held-out
url: https://dexterm.xyz/docs/screens#how-well-it-predicts-measured-held-out
tags:
  - docs
  - screens
  - well
  - predicts
  - measured
  - held
  - out
  - dev
  - history
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

Measured 2026-10-18 on the history recorder's own coins, with the same held-out window as the skill backtest (https://dexterm.xyz/docs/larp) (the newest 30 % of coins by first sighting, never used to tune anything; the rule is fixed in advance: `serial_rugger` = two or more labelled rugs). Each coin is judged only on what was known at its first sighting: prior launches recorded before it, and labels already settled by then. Outcomes are the recorder's 72-hour labels (keyless-proxy tier): **rug**, and **bad** = rug or dead. The labelled history covers 2026-10-10 to 2026-10-13.

- **Too few repeat deployers to measure the rug-history signal yet.** Of 9405 creator wallets behind 24724 recorded coins, 2127 launched two or more of them. In the held-out window 1 of 143 coins (skill-backtest set) and 4 of 387 (all 72-hour-labelled coins) had a creator with a prior labelled rug; across all 1289 labelled coins, 4. There is no number to publish for "a prior rug predicts a rug" until the record is longer. The panel says `unknown` in exactly this case.
- **What the held-out window does show.** Base rates: rug 5.7% (22/387, 95% CI 3.8–8.5%), bad 41.6% (161/387, 95% CI 36.8–46.6%). Coins whose creator had labelled prior launches and no rug: rug 6.4% (5/78, 95% CI 2.8–14.1%), bad 30.8% (24/78, 95% CI 21.6–41.7%); that is a small sample and the intervals overlap the base rate, so it is not evidence that a "clean" record means anything.
- **Exploratory, chosen after seeing the result above** (so treat it as a lead, not a finding): coins whose creator had three or more labelled prior launches, mostly *not* rug or dead, went bad 16.1% (5/31, 95% CI 7.1–32.6%) of the time in the held-out window, against 44.0% (155/352, 95% CI 38.9–49.3%) for coins with fewer labelled priors; only 4 coins had a creator whose priors were mostly bad, too few to say anything.
- **Why so thin:** the recorder's labelled history is about a week old, and a prior launch only counts once its own label had settled before the coin was first seen.
- **Jupiter's count of coins this dev minted** (keyless, at first sighting, held-out, 367 coins with a value; base bad rate 39.5% (145/367, 95% CI 34.6–44.6%)):

| dev minted | coins | rug | bad (rug or dead) |
| --- | --- | --- | --- |
| 1 | 128 | 3.9% (5/128, 95% CI 1.7–8.8%) | 43.8% (56/128, 95% CI 35.5–52.4%) |
| 2-5 | 59 | 0.0% (0/59, 95% CI 0.0–6.1%) | 20.3% (12/59, 95% CI 12.0–32.3%) |
| 6-20 | 28 | 3.6% (1/28, 95% CI 0.6–17.7%) | 28.6% (8/28, 95% CI 15.2–47.1%) |
| 21+ | 152 | 4.6% (7/152, 95% CI 2.2–9.2%) | 45.4% (69/152, 95% CI 37.7–53.3%) |

We will re-run this as the recorder grows and publish the result, good or bad. It is a risk flag from observed history, never a certificate.
