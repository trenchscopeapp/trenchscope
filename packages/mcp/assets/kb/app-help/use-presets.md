---
id: use-presets
title: Use screener presets
kind: app-help
screen: screener
feature: presets
tags:
  - app-help
  - preset
  - presets
  - trending
  - runners
  - organic
  - graduating
  - smart
keys:
  - ]
  - right
  - l
  - [
  - left
  - h
actions:
  - preset.next
  - preset.prev
flags:
  - --preset
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

Press `]` / `[` to step through presets (Trending, Runners, Organic; Graduating ships keyless as an `approx` mcap-band proxy; Smart money needs a key and says so). The analyst can switch the feed too. One-shot at launch: `--preset <name>`.

Keys: `] / → / l` (screener), `[ / ← / h` (screener).
