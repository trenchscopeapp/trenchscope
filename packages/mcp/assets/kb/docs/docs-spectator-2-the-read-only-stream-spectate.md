---
id: docs-spectator-2-the-read-only-stream-spectate
title: Spectator view (watch the agent cook) › The three surfaces › 2. The read-only stream (--spectate)
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: 2. The read-only stream (--spectate)
anchor: 2-the-read-only-stream-spectate
url: https://dexterm.xyz/docs/spectator#2-the-read-only-stream-spectate
tags:
  - docs
  - spectator
  - read-only
  - stream
  - spectate
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

`dexterm agent serve --spectate` starts a WebSocket server on `127.0.0.1` on a random port and prints the port. The per-session token goes to `~/.dexterm/spectator.json` (mode 0600). It is never printed and never on a command line. `dexterm spectate --info` shows the endpoint (`--json` for scripts).

A viewer connects, then sends `{"method":"hello","token":"…"}` with the token from that file within 10 seconds, or the connection is closed. After a good hello it receives:

```text
{"type":"welcome","protocol":"dexterm-spectator/1","redacted":true,"t":…}
{"type":"event","snapshot":true,"event":{…}}     # the recent backlog, oldest first
{"type":"event","snapshot":false,"event":{…}}    # then each new event as it happens
```

Each `event` has the same fields the window uses: `seq`, `t`, `phase`, `agent`, `tier`, `transport`, `tool`, `summary`, `ok`, `ms`, `dataAgeSec`, `refusal`, `nav`, and `redacted: true`. The server honours exactly two inbound messages: `hello` and `ping` (answered with `pong`). Anything else is counted as dropped and ignored. dexterm does not ship a viewer for the raw stream. It is meant for your own overlay or tooling on the same machine.
