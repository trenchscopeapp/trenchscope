# Skill backtest: method, numbers and limits (task-1401)

The LARP check and the rug check are **risk flags, not certificates**. This folder holds the recorded eval set
they were backtested and tuned on, and the measured numbers. Nothing here says a coin is safe, and nothing here
is an accuracy figure for the model's own judgement (see "What is not measured").

| file | what it is |
|---|---|
| `skills-eval.json` | the eval set: 1054 coins, one row each, built 2026-10-16 from one machine's recorder |
| `skills-backtest.json` / `.txt` | the report: per-grade precision/recall, before (v0) and after (v1) tuning, train and held-out test |

Re-run: `dexterm backtest --subject skills` (shipped rules), `--tune` (re-tune on the train split), `--json`.
Rebuild the set from your own history: `dexterm backtest --build-eval FILE [--db PATH]`.

## Method

- **Coins and labels.** Every coin the recorder labelled at 72 h. The label is the recorder's own outcome
  (keyless proxy, labeler 0.2.0): **bad = rug or dead**, ok = flat, fade or runner. It is a *price* outcome, so a
  grade "agrees" when the coin went bad. It does not know whether a product was real, and it misses honeypots and
  frozen holders that never show up as a price collapse.
- **Evidence, point in time.** The link features come from the DexScreener/Jupiter token record the app already
  cached, used only when that record was fetched within 1 h after the coin's t0 anchor. The cache keeps the newest
  fetch, and coins that kept trading were re-fetched days later (often after buying a DexScreener profile) while
  coins that died stopped being fetched near t0, so a late record would leak the outcome. 235 coins had no record in
  that window and are excluded, not back-filled. The rug-check features are that t0 snapshot's columns.
- **What is stored.** Mint, t0, the label, URL-free link features (site kind, X link kind, Telegram yes/no,
  whether the domain names the coin, cheap TLD) and the t0 numbers. No URL, name or symbol.
- **Split.** By time, fixed before tuning: the latest 30 % of coins by t0 (t0 ≥ 2026-10-12 21:28 UTC) are the
  held-out TEST split (328 coins, 61 bad); the rest is TRAIN (726 coins, 294 bad). The tuning functions throw if
  they are handed a test row.
- **Tuning.** Grid search on the train split only, objective MCC of "warning grade → bad", ties to the simpler
  setting. Links: weights 0–2 for nine signals and a threshold 1–5 (98,410 candidates). Rug rules: four tunable
  SPECULATIVE thresholds (1,728 candidates). The AVOID rules (authorities, unlocked LP with concentration) are the
  skills' hard rules and are not tuned.
- **Rates.** 95 % Wilson intervals. A grade with fewer than 20 coins prints counts only.

## Results (held-out TEST split, 328 coins, base rate 18.6 % bad)

**LARP check, links-only baseline** (what `get_links.baseline` returns; the skill starts from it):

| rubric | grade | n | went bad | precision | recall |
|---|---|---|---|---|---|
| v0 (written from the skill text) | LARP | 30 | 7 | 23.3 % [12–41] | 11.5 % [6–22] |
| | UNVERIFIABLE (no website) | 130 | 38 | claims nothing (29.2 % bad) | — |
| | EARLY_BUT_REAL | 168 | 16 | 90.5 % ok [85–94] | 56.9 % of ok [51–63] |
| v1 (tuned on train) | LARP | 14 | 4 | counts only (n < 20) | counts only |
| | UNVERIFIABLE (no website) | 130 | 38 | claims nothing (29.2 % bad) | — |
| | EARLY_BUT_REAL | 184 | 19 | 89.7 % ok [84–93] | 61.8 % of ok [56–67] |

MCC of LARP → bad: v0 0.039, v1 0.054. **Plainly: link shape alone barely separates bad coins from the rest.** The
tuned rubric drops the signals the skill text assumed (a social or launchpad page posted as the website) because
they did not go with bad outcomes, and keeps the ones that did: an X link to a single post or a community instead of
an account, no X, no Telegram. Having no links at all was the clearer warning (32 % bad on test, 64 % on train).

**Rug check, verdict rules** (the rug-check / token-dossier skill rules on t0 columns):

| rules | grade | n | went bad | precision | recall |
|---|---|---|---|---|---|
| v0 (dev > 10 %, organic < 40 → SPECULATIVE) | AVOID | 49 | 3 | 6.1 % [2–17] | 4.9 % [2–13] |
| | SPECULATIVE | 119 | 31 | 26.1 % [19–35] | 50.8 % [39–63] |
| | WATCH | 159 | 26 | 83.6 % ok [77–89] | 49.8 % of ok [44–56] |
| v1 (liquidity < $5k → SPECULATIVE) | AVOID | 49 | 3 | 6.1 % [2–17] | 4.9 % [2–13] |
| | SPECULATIVE | 42 | 23 | 54.8 % [40–69] | 37.7 % [27–50] |
| | WATCH | 236 | 34 | 85.6 % ok [81–90] | 75.7 % of ok [70–80] |

MCC: v0 0.043, v1 0.159. Low liquidity was the one strong signal. Dev above 10 %, organic below 40 and top-10 above
30 % did not go with worse 72 h outcomes here, so they now lower confidence instead of setting the verdict. AVOID
coins (authority still enabled) went bad *less* often than average: they were almost all older tokens off pump.fun,
and a price label cannot see the freeze or honeypot risk the rule exists for, so the rule stays.

## What changed in the default skills

- `larp-check` 0.2.0: reads `get_links.baseline` as a weak prior, never returns `LARP` from links alone, names the
  measured link signals, treats "no links" as the riskier `UNVERIFIABLE`, caps confidence at 0.6 when only links
  were readable.
- `rug-check` 0.3.0 and `token-dossier` 0.3.0: liquidity under $5k sets `SPECULATIVE`; dev %, organic score and
  top-10 % lower confidence instead; `rug_probability` anchors come from the train split (0.8 and 0.27).
- Not changed: the deterministic `analyze_token` pack (`token-dossier.ts` `computeFlags`, used by the screener
  chips and digests) still uses the v0 thresholds.

## What is not measured, and the limits

- **The model stage is not backtested.** The LARP check's judgement comes from fetched pages, RDAP and GitHub;
  those cannot be re-fetched as they were on the day. It is measured forward by `dexterm backtest --subject larp`
  from recorded verdicts, and only reports rates once 50 verdicts match an outcome (0 so far). The rug check's own
  `rug_probability` is measured forward the same way (`--subject pack_verdicts`).
- **One machine, a few days** (t0 from 2026-10-10 to 2026-10-13), mostly trending feeds. The bad rate fell from
  40 % (train) to 19 % (test), so rates drift with the market; the ranking is what held up.
- **Selection.** Coins enter only if their link record is point in time, which favours coins that left the feeds
  soon after t0. The base rate is higher than across all coins the app sees.
- **Labels are a proxy.** Rug/dead come from keyless price and liquidity data. No product is checked by hand, no
  human labelled a coin, and chain-verified labels are not in this set.
- **Small grades.** The tuned LARP grade has 14 test coins; its rate is not reported.
- No accuracy or profit claim follows from any of this. A clean grade is not "safe".
