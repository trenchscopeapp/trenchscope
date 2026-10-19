---
id: docs-larp-measured-accuracy
title: LARP detector › Measured accuracy
kind: docs
page: larp
page_title: LARP detector
heading: Measured accuracy
anchor: measured-accuracy
url: https://dexterm.xyz/docs/larp#measured-accuracy
tags:
  - docs
  - larp
  - measured
  - accuracy
  - detector
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/larp.md
date: 2026-10-16
---

**The part of the LARP check that can be replayed on history is weak, and the model stage cannot be replayed at all. dexterm prints only what it measured, including the weak numbers.**

**Skills backtest (0.1.2).** `dexterm backtest --subject skills` replays the replayable parts of the default analyst skills on recorded history: 1,054 coins from the project's recorder, labelled by a 72 h keyless outcome (bad = rug or dead). Tuning only ever sees the train split; the numbers below are the later, held-out test split of 328 coins, of which 18.6 % went bad.

- **LARP check, links only.** The links-based baseline is a weak signal: MCC 0.039 before tuning, 0.054 after. Its tuned `LARP` grade caught 4 of 14 bad coins, too few to rate. `EARLY_BUT_REAL` coins still went bad 10.3 % of the time, and coins with no website 29.2 %. The skill now treats the baseline as a weak prior and never calls `LARP` from links alone.
- **Rug check.** The verdict rules improved from MCC 0.043 to 0.159. Liquidity under $5k is the one strong signal (`SPECULATIVE` coins went bad 54.8 % of the time, `WATCH` 14.4 %). Dev percentage, organic score and top-10 share did not predict a worse 72 h outcome and now only lower confidence.
- **Not measured.** The model stage (fetched pages, RDAP, GitHub) cannot be replayed: a past page cannot be fetched as it was. It is measured going forward with `dexterm backtest --subject larp`, below.

The method, every number and the limits are in the repository at `packages/packs/eval/README.md`. A grade is a risk flag, not a certificate.

Measured 2026-10-12 with `dexterm backtest --subject larp` over this project's labelled history:

| history | outcome labels at 1 h (observed) | LARP verdicts recorded | matched |
|---|---|---|---|
| research recorder (task-1287 prototype DB) | 149 (137 flat · 9 fade · 2 runner · 1 dead; 29 unobserved) | 0 | 0 |
| the app's recorder on the development machine | 0 | 0 | 0 |
| the same, re-measured later that day after the recorder fix | 401 (361 flat · 18 dead · 13 runner · 5 fade · 4 rug; 1,206 unobserved) | 0 | 0 |

There were no verdicts to score because, before this release, a settled verdict was only kept in memory. From this release on, each settled verdict is written to your local recorder (`verdicts`, pack `larp-check`), so the measurement can grow on your own machine. The app recorder's 0 outcomes had a second cause, fixed the same day: its outcome sweeps and labels never ran in short sessions (see history recorder (https://dexterm.xyz/docs/configuration#history-recorder)). The outcome side now fills in on its own; the verdict side only grows when you run the LARP check on tokens, and no accuracy figure is printed until 50 verdicts match.

**Method.** Run `dexterm backtest --subject larp [--horizon SEC] [--json]` to reproduce it.

- **Join.** Each recorded verdict is joined to the outcome label of the latest recorder snapshot of the same coin, taken at most 10 % of the horizon before the verdict. A later snapshot is never used, and an `unobserved` label is not matched.
- **Bad outcome.** `rug` or `dead` on keyless data, or `rug` alone when chain-verified.
- **Scoring.** `LARP` is scored against `REAL_PRODUCT` and `EARLY_BUT_REAL`. `UNVERIFIABLE` is counted separately.
- **Gate.** Below 50 matched verdicts the command prints counts only. At 50 or more it adds P(bad | LARP), P(bad | real) and P(LARP | bad), each with a 95 % Wilson interval.

> warn: even when it can be computed, this number is **agreement with a bad price outcome**, not a measure of whether a product is real. Outcome labels are the only ground truth dexterm records. A real product can rug, and a LARP can run.
