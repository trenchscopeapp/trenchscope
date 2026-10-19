---
id: docs-spectator-streaming-it
title: Spectator view (watch the agent cook) › Streaming it
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: Streaming it
anchor: streaming-it
url: https://dexterm.xyz/docs/spectator#streaming-it
tags:
  - docs
  - spectator
  - streaming
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

- **Capture the window**, not a port. Point your capture tool's window capture at the "watch the agent cook" window, or at the browser window if you're on the browser fallback. "Shareable" here means you capture a window on your own screen. Nothing binds a public address, and you shouldn't forward or tunnel the stream port.
- **Keep secrets off screen.** Don't show `~/.dexterm/spectator.json`, the `DEXTERM_AGENT_TOKEN` line or `dexterm agent add` output (it prints the agent's token once). `agent serve` prints the token's file path, never the token.
- **Use fixtures for a show.** `agent serve` without `--live` uses canned data, so no real coin names or market numbers appear. With `--live`, a capture shows whatever real coins the agent looks at.
- **Record and replay.** Add `--record FILE` so you can share the session afterwards. The file is redacted, so you can attach it to a bug report.
- The window and the stream show model and agent activity, not advice. Whatever an agent concludes is its own reading of tool results.
