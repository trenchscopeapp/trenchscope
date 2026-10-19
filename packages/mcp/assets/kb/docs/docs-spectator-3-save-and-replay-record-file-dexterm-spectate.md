---
id: docs-spectator-3-save-and-replay-record-file-dexterm-spectate
title: Spectator view (watch the agent cook) › The three surfaces › 3. Save and replay (--record FILE, dexterm spectate)
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: 3. Save and replay (--record FILE, dexterm spectate)
anchor: 3-save-and-replay-record-file-dexterm-spectate
url: https://dexterm.xyz/docs/spectator#3-save-and-replay-record-file-dexterm-spectate
tags:
  - docs
  - spectator
  - save
  - replay
  - record
  - file
  - dexterm
  - spectate
  - three
  - surfaces
  - view
  - watch
  - agent
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/spectator.md
date: 2026-10-16
---

`dexterm agent serve --record FILE` appends every event to `FILE` as one JSON line, **redacted**, with the file created mode 0600. The redaction makes the file fit to share in a bug report or a demo.

```sh
$ dexterm spectate --replay session.jsonl          # SCREEN, AGENTS and ACTIVITY as text
$ dexterm spectate --replay session.jsonl --json   # {"meta":…,"view":…} for scripts
```

Replay is offline and deterministic. It folds the saved events back into the same screen picture and activity list the window uses, then prints them in the terminal. It does not reopen the window. Don't confuse this with `dexterm --record FILE` on the main app, which saves raw data responses for `--replay` (see the CLI reference (https://dexterm.xyz/docs/cli)). The two flags share a name and do different things.
