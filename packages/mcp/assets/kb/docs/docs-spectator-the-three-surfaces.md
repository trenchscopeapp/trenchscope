---
id: docs-spectator-the-three-surfaces
title: Spectator view (watch the agent cook) › The three surfaces
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: The three surfaces
anchor: the-three-surfaces
url: https://dexterm.xyz/docs/spectator#the-three-surfaces
tags:
  - docs
  - spectator
  - three
  - surfaces
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

All three read the same events from one in-memory hub, which `agent serve` creates only when you ask for one of them. Each surface redacts its own copy (see what is redacted (https://dexterm.xyz/docs/spectator#what-is-redacted)). The hub keeps the original events, and they never leave the process.

| surface | start it with | what you get |
| --- | --- | --- |
| AGENT ACTIVITY window | `dexterm agent serve --spectator-popup` | a window titled "watch the agent cook" with live activity and the pause, take over and kill controls |
| read-only stream | `dexterm agent serve --spectate` | a loopback WebSocket that sends events out and accepts no commands |
| save and replay | `dexterm agent serve --record FILE`, then `dexterm spectate --replay FILE` | a redacted JSONL file of the session that you can replay offline |

The flags combine: `--spectator-popup --spectate --record FILE` runs all three at once, and `--roster` adds the agent roster (https://dexterm.xyz/docs/agents#untrusted-by-default) popup.
