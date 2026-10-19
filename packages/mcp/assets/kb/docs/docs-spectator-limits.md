---
id: docs-spectator-limits
title: Spectator view (watch the agent cook) › Limits
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: Limits
anchor: limits
url: https://dexterm.xyz/docs/spectator#limits
tags:
  - docs
  - spectator
  - limits
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

Stated plainly, as of `(generated from the app: see https://dexterm.xyz/docs/spectator#limits; app-help has the exact keys and commands)`:

- **The AGENT ACTIVITY window is a separate window with its own screen model.** Its `screen` line shows the screen the agent *asked for*, built from its navigation events, and the bus runs in its own process (`dexterm agent serve`), so that window is not a mirror of your terminal. The running terminal itself **does** move when you follow with `dexterm --spectate-mcp` (follow mode) — that is a different surface from the popup window.
- **MCP agents are shown in follow mode, which you turn on.** Agents connected through `dexterm mcp` (Claude Code, Claude Desktop, Cursor or Codex, set up with `dexterm mcp install`) appear once you run the app with `dexterm --spectate-mcp`; the terminal then follows them and a read-only stream opens. Without the flag the MCP server emits nothing. The built-in analyst drives the terminal through its own action channel and shows `analyst did X`.
- **Replay is text.** `dexterm spectate --replay` prints the session in the terminal. It does not reopen the window.
- **No stream viewer ships.** The raw stream is for your own tooling.
- **Redaction matches patterns.** It masks anything shaped like an address or a key. Other text, such as a token symbol, a filter or a number, is shown as it is.
- **The window keeps the last 200 events** and shows 80.
- **The native window is macOS-only** and needs the native shell built. Everywhere else the window opens in your browser on loopback.
