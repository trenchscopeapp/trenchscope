---
id: docs-cli-invocations
title: CLI flags and commands › Invocations
kind: docs
page: cli
page_title: CLI flags and commands
heading: Invocations
anchor: invocations
url: https://dexterm.xyz/docs/cli#invocations
tags:
  - docs
  - cli
  - invocations
  - flags
  - commands
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/cli.md
date: 2026-10-16
---

```sh
$ dexterm                                     # interactive, live keyless data (needs a TTY)
$ dexterm doctor                              # pre-flight checks with the exact fix per line
$ dexterm --fixtures                          # interactive demo on seeded fixtures
$ dexterm --calm                              # effects off
$ dexterm --scan                              # live, with AI scan mode on from the start
$ dexterm --screen screener --width 176 --height 48          # one live frame to stdout
$ dexterm --screen token --mint <MINT> --interval 5m         # one live token frame
$ dexterm --screen screener --record /tmp/rec.json           # live frame, saved for replay
$ dexterm --screen screener --replay /tmp/rec.json           # the same frame, no network
$ dexterm mcp                                 # the read-only MCP server on stdio
$ dexterm popup --self-test                   # chart popup self-test
$ dexterm x login                             # Login with X (your own X app; read scopes only)
$ dexterm --workspace morning-hud             # start in a workspace (task-1358)
$ dexterm pack verify ./some-pack             # the install card for a shareable pack
```

Exit codes: 0 ok · 1 interactive mode without a TTY, or a doctor failure · 2 bad arguments (the message names the flag).
