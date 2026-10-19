---
id: docs-scan-keys-flag-command
title: AI scan mode › Keys, flag, command
kind: docs
page: scan
page_title: AI scan mode
heading: Keys, flag, command
anchor: keys-flag-command
url: https://dexterm.xyz/docs/scan#keys-flag-command
tags:
  - docs
  - scan
  - keys
  - flag
  - command
  - mode
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/scan.md
date: 2026-10-16
---

- `Z` toggles the scan from any screen. `R` resumes scanning after a lock (releases the coin).
- `esc` on the locked coin cancels the analysis but keeps the coin (state PAUSED); a second `esc` navigates as usual. `esc` on the screener table while SCANNING stops the scan.
- `--scan` starts it with the run; `--scan-*` flags set thresholds and caps (full list in the CLI reference (https://dexterm.xyz/docs/cli#flags)).
- `/scan` on the screener's `/` line or in the chat input: (generated from the app: see https://dexterm.xyz/docs/scan#keys-flag-command; app-help has the exact keys and commands)

The header shows `◉ AI SCAN SCANNING · ai 1/8 per h` while it is on. Row 1 of every list screen carries the ticker: state, coins scanned, the top scores with the triggers that fired. On the locked coin's screen the same row reads **WHY IT TRIGGERED**: the reasons with their numbers, the score, when, how many reads, and the keys.

the scan ticker on sample data (synthetic scores)
