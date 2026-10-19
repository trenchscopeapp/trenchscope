---
id: docs-spectator-quick-start
title: Spectator view (watch the agent cook) › Quick start
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: Quick start
anchor: quick-start
url: https://dexterm.xyz/docs/spectator#quick-start
tags:
  - docs
  - spectator
  - quick
  - start
  - view
  - watch
  - agent
  - cook
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/spectator.md
date: 2026-10-16
---

```sh
$ dexterm agent add scanbot --tier observe          # once: register the agent, prints a one-time token
$ export DEXTERM_AGENT_TOKEN=dxa_…                  # in the agent's environment, never on a command line
$ dexterm agent serve --spectator-popup --record session.jsonl
$ # now start your agent; it connects to the bus with its name and token
$ dexterm spectate --replay session.jsonl           # later: replay what it did
```

`dexterm agent serve` runs on **fixtures** (canned data, no network) unless you pass `--live` for keyless live reads. Fixtures are the right choice for a first try and for any recording you plan to show.
