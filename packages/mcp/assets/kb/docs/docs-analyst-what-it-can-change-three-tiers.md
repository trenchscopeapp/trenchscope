---
id: docs-analyst-what-it-can-change-three-tiers
title: The analyst › What it can change: three tiers
kind: docs
page: analyst
page_title: The analyst
heading: What it can change: three tiers
anchor: what-it-can-change-three-tiers
url: https://dexterm.xyz/docs/analyst#what-it-can-change-three-tiers
tags:
  - docs
  - analyst
  - can
  - change
  - three
  - tiers
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

| tier | actions | how it applies |
| --- | --- | --- |
| **view** (immediate) | `open_token`, `show_in_screener`, `add_to_watchlist`, `switch_feed`, `open_ticket`, `switch_screen`, `switch_workspace`, `chart_popup`, `toggle_calm`, `set_scan`, `export_view` | applied at once, re-validated against the current screen, and shown as "analyst did X". Local and reversible. `open_ticket` only opens the PAPER ticket in its editing phase. |
| **config** (you confirm) | `set_theme`, `set_price_mode`, `set_intensity` | never applied by the model. It becomes a one-line proposal; `y` within 8 seconds accepts it and any other key dismisses it. An accepted change is written through the journaled config path as actor `analyst`, so `ctrl+z` undoes it. A proposal never takes a key you are typing into a prompt or the chat. |
| **never** | anything touching wallets, keys, credentials, alert-channel secrets, signing, arming, caps, mandates, trade tickets beyond the PAPER `open_ticket`, network or RPC settings, voice settings, or installing and updating software | no such action exists. A request fails as an unknown action, and the config write re-runs the model-actor policy check, so even a mis-mapped action cannot write a denied path. |

Voice speed and voice name are keyboard-only on purpose. The analyst can explain how to change them (`<` / `>`, `,`, or `config.json`), but it cannot change them, even behind a confirm.
