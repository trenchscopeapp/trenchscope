---
id: docs-analyst-skills
title: The analyst › Skills
kind: docs
page: analyst
page_title: The analyst
heading: Skills
anchor: skills
url: https://dexterm.xyz/docs/analyst#skills
tags:
  - docs
  - analyst
  - skills
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

Four versioned skills ship with the app ((generated from the app: see https://dexterm.xyz/docs/analyst#skills; app-help has the exact keys and commands)). Each forces a JSON schema the app renders beside the summary (verdict, bias, setup quality, key levels, invalidation, size hint, `missing_data`, `sources_used`, `injection_detected`).

| skill | started by | what it does |
|---|---|---|
| `token-dossier` | `a` on the token screen; a scan lock; `get_dossier` in one round trip | market, holders and concentration, authorities, RugCheck, candle summary, tape aggregate, creator. A partial verdict with `missing_data` when a section is unavailable; it refuses only when there is no price and no liquidity. |
| `rug-check` | `a` on a list screen with a coin highlighted | the risk read: authorities, LP lock, holder concentration, tape, wallet share, dev history where the tier allows. |
| `trench-scan` | `a` on a list screen with nothing highlighted | a read of the screener as a whole: what is running, what is organic, what to look at. |
| `larp-check` | `V` on a live token | vets the advertised website, domain and GitHub; see LARP detector (https://dexterm.xyz/docs/larp). |
