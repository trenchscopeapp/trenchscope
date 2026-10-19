---
id: docs-configuration-headless-recorder-dexterm-record
title: Configuration and files on disk › History recorder › Headless recorder (dexterm record)
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Headless recorder (dexterm record)
anchor: headless-recorder-dexterm-record
url: https://dexterm.xyz/docs/configuration#headless-recorder-dexterm-record
tags:
  - docs
  - configuration
  - headless
  - recorder
  - dexterm
  - record
  - history
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

The recorder above only grows while the terminal is open. `dexterm record` is **opt-in**. It runs the same recorder jobs with no terminal UI: snapshots and feed membership, the new-pairs stream, the 1 h to 72 h outcome sweeps, labels and retention. Your local history keeps growing for backtests while dexterm is closed.

```sh
$ dexterm record run --once --verbose     # one observation pass + one maintenance pass, then exit
$ dexterm record run                      # keep going: a feed refresh every 60 s (--interval S)
$ dexterm record status                   # db size, snapshots, outcomes, today's sweep calls, LaunchAgent state
$ dexterm record install --dry-run        # print the macOS LaunchAgent it would write; writes nothing
$ dexterm record install --load           # write it to ~/Library/LaunchAgents (no sudo) and load it
$ dexterm record uninstall --unload       # stop and remove it
```

- **Nothing turns itself on.** The collector runs only when you start it. `install` writes a user-level LaunchAgent and loads it only with `--load`. A LaunchAgent does not start before you log in.
- **Same budgets as the app.** Every request goes through the data layer's rate limiter and health gate, and the outcome sweeps keep their own per-sweep and per-day caps. It never builds a signer, never trades and never prints an RPC key.
- **A disk cap.** Above `--max-db-mb` (1024 by default) it pauses new observations, while labels and retention keep running, so the database cannot grow without bound.
- **Recurring backtests.** 0.1.3 also ships the logic behind recurring skill backtests: a rolling held-out window, a frozen comparison set, and a gate that only *proposes* a tuning when it beats the noise. Nothing changes a skill on your machine. A tuning reaches you only through a normal release, with its measured numbers, including weak ones (see LARP detector (https://dexterm.xyz/docs/larp)).
