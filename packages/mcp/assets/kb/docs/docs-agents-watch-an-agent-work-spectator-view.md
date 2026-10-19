---
id: docs-agents-watch-an-agent-work-spectator-view
title: Bring your own agent › Watch an agent work (spectator view)
kind: docs
page: agents
page_title: Bring your own agent
heading: Watch an agent work (spectator view)
anchor: watch-an-agent-work-spectator-view
url: https://dexterm.xyz/docs/agents#watch-an-agent-work-spectator-view
tags:
  - docs
  - agents
  - watch
  - agent
  - work
  - spectator
  - view
  - bring
  - own
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/agents.md
date: 2026-10-16
---

`dexterm agent serve --spectator-popup` opens the **AGENT ACTIVITY** window ("watch the agent cook"): every call a bus agent makes, with its result, timing and data age, plus per-agent **pause**, **take over** and **kill** buttons. `--spectate` adds a read-only, token-gated loopback stream, and `--record FILE` saves a redacted session that `dexterm spectate --replay FILE` plays back. Addresses and key material are redacted on every copy that leaves the process, and none of it can arm, sign or send anything. The full page, with what is redacted, the security model, how to capture it for a stream and its limits, is spectator view (https://dexterm.xyz/docs/spectator).

```sh
$ dexterm agent serve --fixtures --spectator-popup --record session.jsonl
$ dexterm spectate --replay session.jsonl
```
